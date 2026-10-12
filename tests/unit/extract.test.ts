import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monthRange } from "../../src/ingest/config.js";
import { extractMonth, runExtract, type MonthManifest } from "../../src/ingest/extract.js";
import { fetchPage, monthWhere, type RawTrip, type SoqlFetcher } from "../../src/ingest/socrata.js";

const tripId = (i: number) => createHash("sha1").update(String(i)).digest("hex");

/** In-memory SoQL endpoint supporting the two query shapes the extractor sends. */
function fakeApi(byMonth: Record<string, RawTrip[]>, opts: { failOnCall?: number; countOverride?: number } = {}) {
  const sorted = Object.fromEntries(
    Object.entries(byMonth).map(([m, rows]) => [m, [...rows].sort((a, b) => a.trip_id!.localeCompare(b.trip_id!))]),
  );
  let calls = 0;
  const fetcher: SoqlFetcher = async (params) => {
    calls++;
    if (calls === opts.failOnCall) throw new Error("simulated network failure");
    const month = /'(\d{4}-\d{2})-01T/.exec(params.$where!)![1]!;
    const rows = sorted[month] ?? [];
    if (params.$select?.startsWith("count(")) return [{ n: String(opts.countOverride ?? rows.length) }];
    const cursor = /trip_id > '([0-9a-f]{40})'/.exec(params.$where!)?.[1];
    return rows.filter((r) => !cursor || r.trip_id! > cursor).slice(0, Number(params.$limit));
  };
  return { fetcher, calls: () => calls };
}

const makeRows = (month: string, n: number, offset = 0): RawTrip[] =>
  Array.from({ length: n }, (_, i) => ({
    trip_id: tripId(offset + i),
    trip_start_timestamp: `${month}-01T00:15:00.000`,
    trip_total: "10.5",
    company: "Flash Cab",
  }));

async function landedRows(dir: string): Promise<RawTrip[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson.gz")).sort();
  const rows: RawTrip[] = [];
  for (const f of files) {
    const text = gunzipSync(await readFile(join(dir, f))).toString("utf8");
    rows.push(...text.trim().split("\n").map((l) => JSON.parse(l) as RawTrip));
  }
  return rows;
}

const readManifest = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as MonthManifest;

const quiet = () => {};
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "extract-test-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("monthRange", () => {
  it("is inclusive and crosses year boundaries", () => {
    expect(monthRange("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(monthRange("2025-01", "2025-01")).toEqual(["2025-01"]);
  });
  it("rejects bad input", () => {
    expect(() => monthRange("2025-13", "2025-14")).toThrow(/Invalid start/);
    expect(() => monthRange("2025-06", "2025-01")).toThrow(/after/);
  });
});

describe("monthWhere", () => {
  it("is a half-open interval that rolls over December", () => {
    expect(monthWhere("2024-12")).toBe(
      "trip_start_timestamp >= '2024-12-01T00:00:00' AND trip_start_timestamp < '2025-01-01T00:00:00'",
    );
  });
});

describe("fetchPage", () => {
  it("refuses to interpolate a malformed cursor into SoQL", async () => {
    const { fetcher } = fakeApi({});
    await expect(fetchPage(fetcher, "2025-01", "x' OR 1=1 --", 10)).rejects.toThrow(/trip_id format/);
  });
});

describe("extractMonth", () => {
  it("lands every row exactly once across pages, in trip_id order", async () => {
    const source = makeRows("2025-01", 25);
    const { fetcher } = fakeApi({ "2025-01": source });

    const result = await extractMonth(fetcher, "2025-01", dataDir, 10, quiet);

    const dir = join(dataDir, "2025-01");
    const rows = await landedRows(dir);
    const manifest = await readManifest(dir);
    expect(result.rows).toBe(25);
    expect(manifest.status).toBe("complete");
    expect(manifest.pages.map((p) => p.rows)).toEqual([10, 10, 5]);
    expect(rows.map((r) => r.trip_id)).toEqual(source.map((r) => r.trip_id).sort());
  });

  it("terminates when the row count is an exact multiple of the page size", async () => {
    const { fetcher } = fakeApi({ "2025-01": makeRows("2025-01", 20) });
    const result = await extractMonth(fetcher, "2025-01", dataDir, 10, quiet);
    expect(result.rows).toBe(20);
    expect((await readManifest(join(dataDir, "2025-01"))).pages).toHaveLength(2);
  });

  it("resumes after a crash without duplicating rows, producing the same files as a clean run", async () => {
    const source = makeRows("2025-01", 35);

    // Call 1 is count(*), calls 2-3 land pages 0-1, call 4 dies.
    const crashing = fakeApi({ "2025-01": source }, { failOnCall: 4 });
    await expect(extractMonth(crashing.fetcher, "2025-01", dataDir, 10, quiet)).rejects.toThrow(/simulated/);
    const partial = await readManifest(join(dataDir, "2025-01"));
    expect(partial.status).toBe("in_progress");
    expect(partial.pages).toHaveLength(2);

    const resumed = fakeApi({ "2025-01": source });
    await extractMonth(resumed.fetcher, "2025-01", dataDir, 10, quiet);
    const manifest = await readManifest(join(dataDir, "2025-01"));
    const rows = await landedRows(join(dataDir, "2025-01"));
    expect(manifest.status).toBe("complete");
    expect(rows).toHaveLength(35);
    expect(new Set(rows.map((r) => r.trip_id)).size).toBe(35);

    const cleanDir = await mkdtemp(join(tmpdir(), "extract-clean-"));
    try {
      await extractMonth(fakeApi({ "2025-01": source }).fetcher, "2025-01", cleanDir, 10, quiet);
      const clean = await readManifest(join(cleanDir, "2025-01"));
      expect(manifest.pages.map((p) => p.sha256)).toEqual(clean.pages.map((p) => p.sha256));
    } finally {
      await rm(cleanDir, { recursive: true, force: true });
    }
  });

  it("skips a complete month without calling the API", async () => {
    await extractMonth(fakeApi({ "2025-01": makeRows("2025-01", 15) }).fetcher, "2025-01", dataDir, 10, quiet);
    const second = fakeApi({ "2025-01": makeRows("2025-01", 15) });
    const result = await extractMonth(second.fetcher, "2025-01", dataDir, 10, quiet);
    expect(result.skipped).toBe(true);
    expect(second.calls()).toBe(0);
  });

  it("refuses to mark a month complete when landed rows differ from the API count", async () => {
    const { fetcher } = fakeApi({ "2025-01": makeRows("2025-01", 15) }, { countOverride: 16 });
    await expect(extractMonth(fetcher, "2025-01", dataDir, 10, quiet)).rejects.toThrow(/landed 15 rows but the API reports 16/);
    expect((await readManifest(join(dataDir, "2025-01"))).status).toBe("in_progress");
  });

  it("detects a tampered page file", async () => {
    await extractMonth(fakeApi({ "2025-01": makeRows("2025-01", 15) }).fetcher, "2025-01", dataDir, 10, quiet);
    await writeFile(join(dataDir, "2025-01", "0000.ndjson.gz"), "corrupt");
    await expect(
      extractMonth(fakeApi({ "2025-01": makeRows("2025-01", 15) }).fetcher, "2025-01", dataDir, 10, quiet),
    ).rejects.toThrow(/does not match its manifest/);
  });
});

describe("runExtract", () => {
  it("keeps going when one month fails and reports it", async () => {
    const api = fakeApi({ "2025-01": makeRows("2025-01", 5), "2025-02": makeRows("2025-02", 7, 100) });
    const flaky: SoqlFetcher = async (params) => {
      if (params.$where?.startsWith("trip_start_timestamp >= '2025-02")) throw new Error("boom");
      return api.fetcher(params);
    };
    const { results, failures } = await runExtract(
      { months: ["2025-01", "2025-02"], dataDir, pageSize: 10, concurrency: 2 },
      flaky,
      quiet,
    );
    expect(results.map((r) => [r.month, r.rows])).toEqual([["2025-01", 5]]);
    expect(failures.map((f) => f.month)).toEqual(["2025-02"]);
  });
});
