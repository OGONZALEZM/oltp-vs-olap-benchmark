/**
 * Builds config C: copies the star tables from Postgres (config B) into data/olap.duckdb,
 * row for row, into the DDL of sql/duckdb/schema.sql.
 *
 * Primary path: DuckDB's postgres extension (ATTACH ... READ_ONLY, INSERT ... SELECT).
 * Fallback (if ATTACH fails, or forced): Postgres has no native Parquet writer, so each table
 * is exported with COPY ... TO STDOUT (FORMAT csv), converted to Parquet by DuckDB with the
 * exact column types of the target table, and the Parquet file is loaded.
 *
 * The file is deleted and rebuilt on every run (idempotent).
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type pg from "pg";
import { to as copyTo } from "pg-copy-streams";

/** Load order (dimensions first) and the physical order of each table, identical to config B. */
export const STAR_TABLES: Array<{ name: string; orderBy: string }> = [
  { name: "dim_date", orderBy: "date_key" },
  { name: "dim_time", orderBy: "time_key" },
  { name: "dim_company", orderBy: "company_key" },
  { name: "dim_payment", orderBy: "payment_key" },
  { name: "dim_area", orderBy: "area_key" },
  { name: "dim_taxi", orderBy: "taxi_key" },
  // (date_key, time_key, trip_id) is the same order as oltp.trips / star.fact_trips
  // (trip_start_timestamp, trip_id). DuckDB compares VARCHAR bytewise, like COLLATE "C".
  { name: "fact_trips", orderBy: "date_key, time_key, trip_id" },
];

export interface BuildDuckdbOptions {
  duckdbPath: string;
  postgresUrl: string;
  schemaSql: string;
  exportDir: string;
  forceFallback?: boolean;
  log?: (msg: string) => void;
}

export interface DuckdbBuildReport {
  version: string;
  threads: string;
  method: "attach" | "parquet-fallback";
  attachError: string | null;
  tables: Record<string, number>;
  factChecksum: FactChecksum;
  ms: number;
}

/** Exact cross-config check: row count, sum of trip_total in cents, sum of trip_seconds. */
export interface FactChecksum {
  rows: string;
  totalCents: string;
  seconds: string;
}

export const FACT_CHECKSUM_SQL = (table: string) =>
  `SELECT count(*)::VARCHAR AS rows, CAST(sum(trip_total * 100) AS BIGINT)::VARCHAR AS "totalCents", ` +
  `CAST(sum(trip_seconds) AS BIGINT)::VARCHAR AS seconds FROM ${table}`;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function rowsOf(conn: DuckDBConnection, sql: string) {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson();
}

export async function buildDuckdb(pgClient: pg.Client, opts: BuildDuckdbOptions): Promise<DuckdbBuildReport> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  await mkdir(dirname(opts.duckdbPath), { recursive: true });
  await rm(opts.duckdbPath, { force: true });
  await rm(`${opts.duckdbPath}.wal`, { force: true });

  const instance = await DuckDBInstance.create(opts.duckdbPath);
  const conn = await instance.connect();
  try {
    await conn.run(await readFile(opts.schemaSql, "utf8"));

    let method: DuckdbBuildReport["method"] = "attach";
    let attachError: string | null = null;
    try {
      if (opts.forceFallback) throw new Error("fallback forced with --duckdb-fallback");
      await conn.run("INSTALL postgres; LOAD postgres;");
      await conn.run(`ATTACH ${sqlString(opts.postgresUrl)} AS pg (TYPE postgres, READ_ONLY)`);
    } catch (err) {
      method = "parquet-fallback";
      attachError = (err as Error).message;
      log(`duckdb: ATTACH unavailable (${attachError}); using Parquet fallback`);
    }

    for (const { name, orderBy } of STAR_TABLES) {
      const columns = (await rowsOf(conn,
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_catalog = current_database() AND table_schema = 'main' AND table_name = ${sqlString(name)}
         ORDER BY ordinal_position`,
      )) as Array<{ column_name: string; data_type: string }>;
      const colList = columns.map((c) => c.column_name).join(", ");

      if (method === "attach") {
        await conn.run(`INSERT INTO ${name} (${colList}) SELECT ${colList} FROM pg.star.${name} ORDER BY ${orderBy}`);
      } else {
        const csv = resolve(join(opts.exportDir, `${name}.csv`));
        const parquet = resolve(join(opts.exportDir, `${name}.parquet`));
        await mkdir(opts.exportDir, { recursive: true });
        await pipeline(
          pgClient.query(copyTo(`COPY (SELECT ${colList} FROM star.${name} ORDER BY ${orderBy}) TO STDOUT (FORMAT csv, HEADER true)`)),
          createWriteStream(csv),
        );
        const types = columns.map((c) => `${sqlString(c.column_name)}: ${sqlString(c.data_type)}`).join(", ");
        await conn.run(
          `COPY (SELECT * FROM read_csv(${sqlString(csv)}, header = true, auto_detect = false, columns = {${types}}))
           TO ${sqlString(parquet)} (FORMAT parquet)`,
        );
        await conn.run(`INSERT INTO ${name} (${colList}) SELECT ${colList} FROM read_parquet(${sqlString(parquet)}) ORDER BY ${orderBy}`);
      }
      log(`duckdb: ${name} loaded (${method})`);
    }
    if (method === "attach") await conn.run("DETACH pg");
    await conn.run("CHECKPOINT");

    const tables: Record<string, number> = {};
    for (const { name } of STAR_TABLES) {
      tables[name] = Number((await rowsOf(conn, `SELECT count(*) AS n FROM ${name}`))[0]!.n);
    }
    const [meta] = (await rowsOf(conn, "SELECT version() AS version, current_setting('threads') AS threads")) as Array<{
      version: string;
      threads: string;
    }>;
    const [factChecksum] = (await rowsOf(conn, FACT_CHECKSUM_SQL("fact_trips"))) as unknown as FactChecksum[];
    return {
      version: meta!.version,
      threads: String(meta!.threads),
      method,
      attachError,
      tables,
      factChecksum: factChecksum!,
      ms: Date.now() - t0,
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
