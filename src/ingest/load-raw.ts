/**
 * Step 2 of ingestion: COPY the landed pages from data/raw into staging.raw_trips.
 *
 * The landed files are immutable and staging is recreated on every load, so the result is
 * the same no matter how many times this runs. Only months whose manifest is complete are
 * accepted, and the loaded row count must equal the manifests' total.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { readManifest } from "./extract.js";
import { SELECT_COLUMNS } from "./socrata.js";
import { scalar } from "../db.js";

const KNOWN_COLUMNS = new Set<string>(SELECT_COLUMNS);

/** Encodes one value for COPY ... (FORMAT text). Absent JSON fields become NULL. */
export function encodeCopyText(value: unknown): string {
  if (value === undefined || value === null) return "\\N";
  if (typeof value !== "string") throw new Error(`Expected a string value, got ${JSON.stringify(value)}`);
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** Yields COPY text in chunks of ~5,000 rows (one stream write per row is needlessly slow). */
function* copyChunks(ndjson: string, sourceFile: string): Generator<string> {
  const source = encodeCopyText(sourceFile);
  let chunk: string[] = [];
  for (const line of ndjson.split("\n")) {
    if (line === "") continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      // Schema drift guard: the extractor $selects these columns, so anything else is a bug.
      if (!KNOWN_COLUMNS.has(key)) throw new Error(`${sourceFile}: unexpected field "${key}"`);
    }
    chunk.push(SELECT_COLUMNS.map((c) => encodeCopyText(row[c])).join("\t") + "\t" + source + "\n");
    if (chunk.length === 5000) {
      yield chunk.join("");
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk.join("");
}

export interface RawLoadResult {
  files: number;
  rows: number;
}

export async function loadRaw(
  client: pg.Client,
  dataDir: string,
  months: string[],
  log: (msg: string) => void,
): Promise<RawLoadResult> {
  // Refuse to load an incomplete window: a partial month would silently skew every query.
  const manifests = [];
  for (const month of months) {
    const manifest = await readManifest(join(dataDir, month, "manifest.json"));
    if (manifest?.status !== "complete") {
      throw new Error(`Month ${month} is not completely extracted. Run npm run ingest:extract first.`);
    }
    manifests.push(manifest);
  }

  const copySql =
    `COPY staging.raw_trips (${SELECT_COLUMNS.join(", ")}, source_file) FROM STDIN (FORMAT text)`;
  let files = 0;
  for (const manifest of manifests) {
    for (const page of manifest.pages) {
      const sourceFile = `${manifest.month}/${page.file}`;
      const ndjson = gunzipSync(await readFile(join(dataDir, sourceFile))).toString("utf8");
      await pipeline(Readable.from(copyChunks(ndjson, sourceFile)), client.query(copyFrom(copySql)));
      files++;
    }
    log(`raw: ${manifest.month} copied (${manifest.landedRows} rows, ${manifest.pages.length} files)`);
  }

  const expected = manifests.reduce((sum, m) => sum + m.landedRows, 0);
  const rows = Number(await scalar(client, "SELECT count(*) FROM staging.raw_trips"));
  if (rows !== expected) throw new Error(`raw: loaded ${rows} rows but manifests total ${expected}`);
  // Uniqueness of trip_id is asserted here rather than during COPY (faster, same guarantee).
  await client.query("ALTER TABLE staging.raw_trips ADD PRIMARY KEY (trip_id)");
  await client.query("ANALYZE staging.raw_trips");
  return { files, rows };
}

/** Seeds oltp.community_areas from the committed CSV. The pipeline never calls the API for names. */
export async function loadCommunityAreaSeed(client: pg.Client, csvPath: string): Promise<number> {
  await pipeline(
    createReadStream(csvPath),
    client.query(copyFrom("COPY oltp.community_areas (community_area_id, name) FROM STDIN (FORMAT csv, HEADER true)")),
  );
  return Number(await scalar(client, "SELECT count(*) FROM oltp.community_areas"));
}
