/**
 * Step 1 of ingestion: land raw pages from the Socrata API on disk.
 *
 * Layout per month:  <dataDir>/YYYY-MM/NNNN.ndjson.gz  +  <dataDir>/YYYY-MM/manifest.json
 *
 * Idempotency:
 * - Pages are keyset-paginated on trip_id (unique), so a page is fully determined by its cursor.
 * - Every file is written to a temp path and renamed, so a crash never leaves a partial page.
 * - The manifest is rewritten (atomically) after each page; a re-run resumes from the last
 *   recorded cursor. A page landed but not yet recorded is simply fetched and overwritten again.
 * - A month is "complete" only when its landed rows equal the API count(*) for that month.
 *   Complete months are verified (sha256 of every page) and skipped.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { loadExtractConfig, type ExtractConfig } from "./config.js";
import {
  SELECT_COLUMNS,
  assertTripId,
  fetchMonthCount,
  fetchPage,
  httpFetcher,
  monthWhere,
  type SoqlFetcher,
} from "./socrata.js";

export interface PageEntry {
  index: number;
  file: string;
  rows: number;
  firstTripId: string;
  lastTripId: string;
  bytes: number;
  sha256: string;
}

export interface MonthManifest {
  month: string;
  where: string;
  select: string[];
  status: "in_progress" | "complete";
  expectedRows: number;
  landedRows: number;
  startedAt: string;
  completedAt: string | null;
  pages: PageEntry[];
}

export interface MonthResult {
  month: string;
  rows: number;
  pagesFetched: number;
  skipped: boolean;
  ms: number;
}

type Log = (msg: string) => void;

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readManifest(path: string): Promise<MonthManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as MonthManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Re-hash every recorded page; a missing or altered file means the landing zone is corrupt. */
async function verifyPages(dir: string, manifest: MonthManifest): Promise<void> {
  for (const page of manifest.pages) {
    const buf = await readFile(join(dir, page.file)).catch(() => null);
    if (!buf || sha256(buf) !== page.sha256) {
      throw new Error(
        `${manifest.month}: page ${page.file} is missing or does not match its manifest sha256. ` +
          `Delete ${dir} to re-extract this month.`,
      );
    }
  }
}

export async function extractMonth(
  fetcher: SoqlFetcher,
  month: string,
  dataDir: string,
  pageSize: number,
  log: Log,
): Promise<MonthResult> {
  const t0 = Date.now();
  const dir = join(dataDir, month);
  const manifestPath = join(dir, "manifest.json");
  await mkdir(dir, { recursive: true });

  let manifest = await readManifest(manifestPath);
  if (manifest && manifest.select.join(",") !== SELECT_COLUMNS.join(",")) {
    throw new Error(`${month}: manifest was written with different columns. Delete ${dir} to re-extract.`);
  }
  if (manifest) await verifyPages(dir, manifest);

  if (manifest?.status === "complete") {
    log(`${month}: complete (${manifest.landedRows} rows, ${manifest.pages.length} pages), skipping`);
    return { month, rows: manifest.landedRows, pagesFetched: 0, skipped: true, ms: Date.now() - t0 };
  }

  const expectedRows = await fetchMonthCount(fetcher, month);
  manifest ??= {
    month,
    where: monthWhere(month),
    select: [...SELECT_COLUMNS],
    status: "in_progress",
    expectedRows,
    landedRows: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    pages: [],
  };
  manifest.expectedRows = expectedRows;

  let cursor = manifest.pages.at(-1)?.lastTripId ?? null;
  if (cursor) log(`${month}: resuming after page ${manifest.pages.length - 1}, cursor ${cursor.slice(0, 12)}…`);

  let pagesFetched = 0;
  while (true) {
    const tPage = Date.now();
    const rows = await fetchPage(fetcher, month, cursor, pageSize);
    if (rows.length === 0) break;

    // Sanity-check the keyset contract: ids are valid, strictly increasing and past the cursor.
    let prev = cursor;
    for (const row of rows) {
      const id = row.trip_id ?? "";
      assertTripId(id);
      if (prev !== null && id <= prev) {
        throw new Error(`${month}: trip_id ordering violated (${id} after ${prev})`);
      }
      prev = id;
    }

    const index = manifest.pages.length;
    const file = `${String(index).padStart(4, "0")}.ndjson.gz`;
    const gz = gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeAtomic(join(dir, file), gz);

    const firstTripId = rows[0]!.trip_id!;
    const lastTripId = rows.at(-1)!.trip_id!;
    manifest.pages.push({ index, file, rows: rows.length, firstTripId, lastTripId, bytes: gz.length, sha256: sha256(gz) });
    manifest.landedRows += rows.length;
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    pagesFetched++;

    log(
      `${month}: page ${file} ${rows.length} rows in ${((Date.now() - tPage) / 1000).toFixed(1)}s ` +
        `(${manifest.landedRows}/${expectedRows})`,
    );
    cursor = lastTripId;
    if (rows.length < pageSize) break;
  }

  if (manifest.landedRows !== expectedRows) {
    throw new Error(
      `${month}: landed ${manifest.landedRows} rows but the API reports ${expectedRows}. ` +
        `The dataset may have changed during extraction; delete ${dir} and re-run.`,
    );
  }
  manifest.status = "complete";
  manifest.completedAt = new Date().toISOString();
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  log(`${month}: complete, ${manifest.landedRows} rows`);
  return { month, rows: manifest.landedRows, pagesFetched, skipped: false, ms: Date.now() - t0 };
}

/** Extracts all months with a small worker pool. Failures in one month don't stop the others. */
export async function runExtract(
  config: Pick<ExtractConfig, "months" | "dataDir" | "pageSize" | "concurrency">,
  fetcher: SoqlFetcher,
  log: Log = console.log,
): Promise<{ results: MonthResult[]; failures: Array<{ month: string; error: Error }> }> {
  const queue = [...config.months];
  const results: MonthResult[] = [];
  const failures: Array<{ month: string; error: Error }> = [];

  const worker = async () => {
    for (let month = queue.shift(); month; month = queue.shift()) {
      try {
        results.push(await extractMonth(fetcher, month, config.dataDir, config.pageSize, log));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log(`${month}: FAILED: ${error.message}`);
        failures.push({ month, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, config.months.length) }, worker));

  results.sort((a, b) => a.month.localeCompare(b.month));
  return { results, failures };
}

async function main(): Promise<void> {
  const config = loadExtractConfig();
  const log: Log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  log(
    `extract ${config.months[0]}..${config.months.at(-1)} (${config.months.length} months) ` +
      `into ${config.dataDir}, page size ${config.pageSize}, concurrency ${config.concurrency}, ` +
      `app token ${config.appToken ? "set" : "not set"}`,
  );

  const t0 = Date.now();
  const fetcher = httpFetcher({ appToken: config.appToken, log });
  const { results, failures } = await runExtract(config, fetcher, log);

  console.log("\nmonth     rows      pages  status");
  for (const r of results) {
    console.log(`${r.month}  ${String(r.rows).padStart(9)}  ${String(r.pagesFetched).padStart(5)}  ${r.skipped ? "skipped (complete)" : `fetched in ${(r.ms / 1000).toFixed(0)}s`}`);
  }
  for (const f of failures) console.log(`${f.month}  FAILED: ${f.error.message}`);
  const total = results.reduce((sum, r) => sum + r.rows, 0);
  console.log(`total     ${String(total).padStart(9)}  in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
