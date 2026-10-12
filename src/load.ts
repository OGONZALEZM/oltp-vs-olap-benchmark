/**
 * Full load, end to end: data/raw -> Postgres (configs A and B) -> DuckDB (config C).
 * Prints row counts per table and rejected rows by reason, checks that the three configs hold
 * the same trips, and writes data/load-report.json.
 *
 *   npm run load [-- --start YYYY-MM --end YYYY-MM] [--skip-duckdb] [--duckdb-fallback]
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connect, databaseUrl } from "./db.js";
import { loadDotEnv, resolveMonths } from "./ingest/config.js";
import { buildDuckdb, FACT_CHECKSUM_SQL, type FactChecksum } from "./transform/build-duckdb.js";
import { buildPostgres } from "./transform/build-postgres.js";

async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      start: { type: "string" },
      end: { type: "string" },
      "data-dir": { type: "string" },
      "skip-duckdb": { type: "boolean" },
      "duckdb-fallback": { type: "boolean" },
    },
    strict: true,
  });
  const months = resolveMonths(values.start, values.end);
  const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  log(`load ${months[0]}..${months.at(-1)} (${months.length} months) into ${databaseUrl().replace(/:[^:@/]+@/, ":***@")}`);

  const t0 = Date.now();
  const client = await connect();
  try {
    const pgReport = await buildPostgres(client, {
      dataDir: values["data-dir"] ?? "data/raw",
      months,
      seedCsv: "sql/seed/community_areas.csv",
      log,
    });

    const checksums: Record<string, FactChecksum> = {
      "A oltp.trips": (await client.query<FactChecksum>(FACT_CHECKSUM_SQL("oltp.trips"))).rows[0]!,
      "B star.fact_trips": (await client.query<FactChecksum>(FACT_CHECKSUM_SQL("star.fact_trips"))).rows[0]!,
    };

    let duckReport = null;
    if (!values["skip-duckdb"]) {
      duckReport = await buildDuckdb(client, {
        duckdbPath: "data/olap.duckdb",
        postgresUrl: databaseUrl(),
        schemaSql: "sql/duckdb/schema.sql",
        exportDir: "data/export",
        forceFallback: values["duckdb-fallback"],
        log,
      });
      checksums["C duckdb fact_trips"] = duckReport.factChecksum;
      for (const [table, n] of Object.entries(duckReport.tables)) {
        const pgCount = pgReport.tables[`star.${table}`];
        if (pgCount !== n) throw new Error(`duckdb ${table}: ${n} rows, Postgres star.${table}: ${pgCount}`);
      }
    }

    console.log("\nRows per table");
    for (const [t, n] of Object.entries(pgReport.tables)) console.log(`  ${t.padEnd(26)} ${String(n).padStart(9)}`);
    if (duckReport) {
      for (const [t, n] of Object.entries(duckReport.tables)) console.log(`  ${`duckdb.${t}`.padEnd(26)} ${String(n).padStart(9)}`);
    }
    console.log("\nRejected rows by reason");
    for (const [r, n] of Object.entries(pgReport.rejectedByReason)) console.log(`  ${r.padEnd(26)} ${String(n).padStart(9)}`);
    console.log("\nFact checksums (rows / trip_total cents / trip_seconds)");
    for (const [k, c] of Object.entries(checksums)) console.log(`  ${k.padEnd(26)} ${c.rows} / ${c.totalCents} / ${c.seconds}`);
    console.log(`\nPostgres ${pgReport.serverVersion}: ${Object.entries(pgReport.settings).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (duckReport) console.log(`DuckDB ${duckReport.version}: threads=${duckReport.threads}, loaded via ${duckReport.method}`);

    const distinct = new Set(Object.values(checksums).map((c) => `${c.rows}/${c.totalCents}/${c.seconds}`));
    if (distinct.size !== 1) throw new Error("Fact checksums differ between configs");
    console.log(`\nAll configs hold identical trips. Total ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    await writeFile(
      "data/load-report.json",
      JSON.stringify({ loadedAt: new Date().toISOString(), months, postgres: pgReport, duckdb: duckReport, checksums }, null, 2),
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
