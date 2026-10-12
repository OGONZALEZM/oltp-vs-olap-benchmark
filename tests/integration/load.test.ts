import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "../../src/db.js";
import type { MonthManifest } from "../../src/ingest/extract.js";
import { encodeCopyText } from "../../src/ingest/load-raw.js";
import type { RawTrip } from "../../src/ingest/socrata.js";
import { buildDuckdb, FACT_CHECKSUM_SQL } from "../../src/transform/build-duckdb.js";
import { buildPostgres, type PostgresBuildReport } from "../../src/transform/build-postgres.js";

const id = (s: string) => createHash("sha1").update(s).digest("hex");
const TAXI = "a".repeat(128);
const money = { fare: "10", tips: "2", tolls: "0", extras: "1.5", trip_total: "13.5" };

// One row per behaviour under test. Absent keys = null, exactly like the API.
const FIXTURE: Record<string, RawTrip> = {
  good: {
    trip_id: id("good"), taxi_id: TAXI, trip_start_timestamp: "2025-01-05T10:15:00.000",
    trip_end_timestamp: "2025-01-05T10:30:00.000", trip_seconds: "900", trip_miles: "3.2",
    pickup_community_area: "8", dropoff_community_area: "32", ...money,
    payment_type: "Credit Card", company: "Taxicab Insurance Agency Llc",
  },
  naTaxiNoArea: {
    trip_id: id("na"), taxi_id: "NA", trip_start_timestamp: "2025-01-06T23:45:00.000",
    trip_seconds: "300", trip_miles: "0", ...money, trip_total: "8",
    payment_type: "Cash", company: "Taxicab  Insurance Agency, LLC",
  },
  sameCompany: {
    trip_id: id("same"), taxi_id: TAXI, trip_start_timestamp: "2025-01-06T00:00:00.000",
    trip_seconds: "60", ...money, payment_type: "Mobile", company: "Taxicab Insurance Agency Llc",
  },
  nullAmounts: {
    trip_id: id("null"), taxi_id: TAXI, trip_start_timestamp: "2025-01-05T11:00:00.000",
    payment_type: "Cash", company: "Flash Cab",
  },
  endBeforeStart: {
    trip_id: id("ebs"), taxi_id: TAXI, trip_start_timestamp: "2025-01-05T12:00:00.000",
    trip_end_timestamp: "2025-01-05T11:45:00.000", ...money, payment_type: "Cash", company: "Flash Cab",
  },
  // Fails two rules: the first in rule order (total) must win.
  totalAndSeconds: {
    trip_id: id("both"), taxi_id: TAXI, trip_start_timestamp: "2025-01-05T13:00:00.000",
    trip_seconds: "30000", ...money, trip_total: "1500", payment_type: "Cash", company: "Flash Cab",
  },
  tooLong: {
    trip_id: id("long"), taxi_id: TAXI, trip_start_timestamp: "2025-01-05T14:00:00.000",
    trip_seconds: "21601", ...money, payment_type: "Cash", company: "Flash Cab",
  },
};

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let dataDir: string;
let report: PostgresBuildReport;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  client = await connect(container.getConnectionUri());

  dataDir = await mkdtemp(join(tmpdir(), "load-test-"));
  const rows = Object.values(FIXTURE).sort((a, b) => a.trip_id!.localeCompare(b.trip_id!));
  await mkdir(join(dataDir, "2025-01"));
  await writeFile(join(dataDir, "2025-01", "0000.ndjson.gz"), gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  const manifest: Partial<MonthManifest> = {
    month: "2025-01", status: "complete", landedRows: rows.length,
    pages: [{ index: 0, file: "0000.ndjson.gz", rows: rows.length, firstTripId: "", lastTripId: "", bytes: 0, sha256: "" }],
  };
  await writeFile(join(dataDir, "2025-01", "manifest.json"), JSON.stringify(manifest));

  report = await buildPostgres(client, { dataDir, months: ["2025-01"], seedCsv: "sql/seed/community_areas.csv" });
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const one = async <T = Record<string, unknown>>(sql: string) => (await client.query(sql)).rows[0] as T;

describe("Postgres load (configs A and B)", () => {
  it("rejects each bad row with the first failing rule and conserves rows", () => {
    expect(report.rejectedByReason).toEqual({
      null_amounts: 1, end_before_start: 1, trip_total_over_1000: 1, trip_seconds_over_6h: 1,
    });
    expect(report.tables["staging.raw_trips"]).toBe(7);
    expect(report.tables["staging.clean_trips"]).toBe(3);
    expect(report.tables["oltp.trips"]).toBe(3);
    expect(report.tables["star.fact_trips"]).toBe(3);
    expect(report.tables["oltp.community_areas"]).toBe(77);
  });

  it("merges company spelling variants under the most frequent spelling", async () => {
    const { rows } = await client.query("SELECT canonical_name, name FROM oltp.companies");
    expect(rows).toEqual([{ canonical_name: "taxicab insurance agency", name: "Taxicab Insurance Agency Llc" }]);
  });

  it("maps the NA taxi and missing areas to NULL in A and to the Unknown member in B", async () => {
    const a = await one(`SELECT taxi_id, pickup_community_area_id FROM oltp.trips WHERE trip_id = '${id("na")}'`);
    expect(a).toEqual({ taxi_id: null, pickup_community_area_id: null });
    const b = await one(`SELECT taxi_key, pickup_area_key, dropoff_area_key, date_key, time_key FROM star.fact_trips WHERE trip_id = '${id("na")}'`);
    expect(b).toEqual({ taxi_key: 0, pickup_area_key: 0, dropoff_area_key: 0, date_key: 20250106, time_key: 95 });
    expect(report.tables["oltp.taxis"]).toBe(1);
  });

  it("records the pinned settings and runs ANALYZE", async () => {
    expect(Object.keys(report.settings)).toContain("work_mem");
    expect(Object.keys(report.settings)).toContain("max_parallel_workers_per_gather");
    const analyzed = await one<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_user_tables WHERE schemaname IN ('oltp','star') AND last_analyze IS NULL",
    );
    expect(Number(analyzed.n)).toBe(0);
  });

  it("is idempotent: a second run produces the same tables", async () => {
    const again = await buildPostgres(client, { dataDir, months: ["2025-01"], seedCsv: "sql/seed/community_areas.csv" });
    expect(again.tables).toEqual(report.tables);
    expect(again.rejectedByReason).toEqual(report.rejectedByReason);
  }, 60_000);
});

describe("DuckDB load (config C)", () => {
  for (const forceFallback of [false, true]) {
    it(`copies the star schema exactly via ${forceFallback ? "the Parquet fallback" : "ATTACH"}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "duck-test-"));
      try {
        const duck = await buildDuckdb(client, {
          duckdbPath: join(dir, "olap.duckdb"),
          postgresUrl: container.getConnectionUri(),
          schemaSql: "sql/duckdb/schema.sql",
          exportDir: join(dir, "export"),
          forceFallback,
        });
        expect(duck.method).toBe(forceFallback ? "parquet-fallback" : "attach");
        for (const [table, n] of Object.entries(duck.tables)) expect(n).toBe(report.tables[`star.${table}`]);
        expect(duck.factChecksum).toEqual(await one(FACT_CHECKSUM_SQL("star.fact_trips")));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

describe("encodeCopyText", () => {
  it("escapes COPY text specials and maps absent values to NULL", () => {
    expect(encodeCopyText(undefined)).toBe("\\N");
    expect(encodeCopyText("a\tb\\c\nd")).toBe("a\\tb\\\\c\\nd");
  });
});
