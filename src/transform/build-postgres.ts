/**
 * Builds configs A (schema oltp) and B (schema star) in Postgres from the landed raw pages:
 *   schemas -> staging.raw_trips (COPY) -> clean/reject -> oltp (+ seed) -> star -> VACUUM ANALYZE
 * Every run drops and recreates the three schemas, so the load is idempotent by construction.
 * Each stage checks row conservation against the previous one and fails loudly otherwise.
 */
import type pg from "pg";
import { loadCommunityAreaSeed, loadRaw } from "../ingest/load-raw.js";
import { runSqlFile, scalar } from "../db.js";

export const PINNED_SETTINGS = [
  "work_mem",
  "max_parallel_workers_per_gather",
  "shared_buffers",
  "maintenance_work_mem",
  "max_wal_size",
  "jit",
] as const;

export interface PostgresBuildReport {
  serverVersion: string;
  settings: Record<string, string>;
  tables: Record<string, number>;
  rejectedByReason: Record<string, number>;
  timingsMs: Record<string, number>;
}

export interface BuildPostgresOptions {
  dataDir: string;
  months: string[];
  seedCsv: string;
  sqlDir?: string;
  log?: (msg: string) => void;
}

const count = async (client: pg.Client, table: string) =>
  Number(await scalar(client, `SELECT count(*) FROM ${table}`));

function assertEqual(what: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${what}: got ${actual}, expected ${expected}`);
}

export async function buildPostgres(client: pg.Client, opts: BuildPostgresOptions): Promise<PostgresBuildReport> {
  const sql = opts.sqlDir ?? "sql";
  const log = opts.log ?? (() => {});
  const timingsMs: Record<string, number> = {};
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const result = await fn();
    timingsMs[name] = Date.now() - t0;
    log(`pg: ${name} done in ${(timingsMs[name] / 1000).toFixed(1)}s`);
    return result;
  };

  await step("schemas", async () => {
    for (const f of ["staging/schema.sql", "oltp/schema.sql", "star/schema.sql"]) await runSqlFile(client, `${sql}/${f}`);
  });

  const raw = await step("copy raw", () => loadRaw(client, opts.dataDir, opts.months, log));

  await step("clean", async () => {
    await runSqlFile(client, `${sql}/staging/clean.sql`);
    await client.query("ANALYZE staging.clean_trips");
  });
  const clean = await count(client, "staging.clean_trips");
  const rejected = await count(client, "staging.rejected_trips");
  assertEqual("clean + rejected vs raw", clean + rejected, raw.rows);

  await step("seed community areas", async () => {
    assertEqual("community areas seeded", await loadCommunityAreaSeed(client, opts.seedCsv), 77);
  });

  await step("load oltp", () => runSqlFile(client, `${sql}/oltp/load.sql`));
  assertEqual("oltp.trips vs clean", await count(client, "oltp.trips"), clean);
  await step("oltp constraints + indexes", () => runSqlFile(client, `${sql}/oltp/constraints.sql`));

  await step("load star", () => runSqlFile(client, `${sql}/star/load.sql`));
  assertEqual("star.fact_trips vs oltp.trips", await count(client, "star.fact_trips"), clean);
  await step("star constraints + indexes", () => runSqlFile(client, `${sql}/star/constraints.sql`));

  // ANALYZE after every load, plus FREEZE so hint bits and the visibility map are already set:
  // otherwise the first benchmark query would pay for writing them, polluting cold-run timings.
  const benchTables = await tablesIn(client, ["oltp", "star"]);
  await step("vacuum (freeze, analyze)", async () => {
    for (const t of benchTables) await client.query(`VACUUM (FREEZE, ANALYZE) ${t}`);
  });

  const tables: Record<string, number> = {};
  for (const t of await tablesIn(client, ["staging", "oltp", "star"])) tables[t] = await count(client, t);

  const { rows: reasonRows } = await client.query<{ reason: string; n: string }>(
    "SELECT reason, count(*) AS n FROM staging.rejected_trips GROUP BY reason ORDER BY reason",
  );
  const { rows: settingRows } = await client.query<{ name: string; value: string }>(
    "SELECT name, current_setting(name) AS value FROM pg_settings WHERE name = ANY($1) ORDER BY name",
    [PINNED_SETTINGS],
  );

  return {
    serverVersion: await scalar(client, "SHOW server_version"),
    settings: Object.fromEntries(settingRows.map((r) => [r.name, r.value])),
    tables,
    rejectedByReason: Object.fromEntries(reasonRows.map((r) => [r.reason, Number(r.n)])),
    timingsMs,
  };
}

async function tablesIn(client: pg.Client, schemas: string[]): Promise<string[]> {
  const { rows } = await client.query<{ t: string }>(
    `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
     WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'
     ORDER BY array_position($1, table_schema::text), table_name`,
    [schemas],
  );
  return rows.map((r) => r.t);
}
