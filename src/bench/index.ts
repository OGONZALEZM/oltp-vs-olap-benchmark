/**
 * npm run bench [-- --runs 10 --warmup 1 --cold-runs 10 --quarter 2025-Q2 --skip-cold]
 *
 * Phases (each config runs alone; nothing else queries the engines meanwhile):
 *   1. Build materialized views for B-MV (build time reported).
 *   2. Verify: every query returns the same result in every config, or the benchmark fails.
 *   3. Warm: per config and query, `warmup` untimed runs then `runs` timed runs.
 *   4. Restart cold: Postgres container restarted before every timed run; DuckDB opened fresh.
 *   5. Plans: EXPLAIN (ANALYZE, BUFFERS) / EXPLAIN ANALYZE in a separate, untimed pass.
 * Output: results/benchmark.json, results/plans/*.txt and a console summary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { connect, databaseUrl, runSqlFile, scalar } from "../db.js";
import { loadDotEnv } from "../ingest/config.js";
import { PINNED_SETTINGS } from "../transform/build-postgres.js";
import { ABS_TOLERANCE, compareResults, normalizeRows, type NormalizedResult } from "./compare.js";
import { CONFIGS, QUERIES, loadQuerySql, quarterParams, type ConfigDef, type ConfigId } from "./queries.js";
import { existsSync } from "node:fs";
import { DuckSession, PgSession, prewarm, restartPostgres, type PrewarmedRelation, type Session } from "./sessions.js";
import { summarize, type Stats } from "./stats.js";
import { dockerInfo, gitInfo, hostInfo } from "./system.js";

const DUCKDB_PATH = "data/olap.duckdb";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "oltp-vs-olap-pg";

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function openSession(config: ConfigDef): Promise<Session> {
  return config.engine === "postgres"
    ? PgSession.open(databaseUrl(), config.searchPath!)
    : DuckSession.open(DUCKDB_PATH, config.threads!);
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      warmup: { type: "string", default: "1" },
      "cold-runs": { type: "string", default: "10" },
      quarter: { type: "string", default: "2025-Q2" },
      "skip-cold": { type: "boolean", default: false },
    },
    strict: true,
  });
  const runs = Number(values.runs);
  const warmup = Number(values.warmup);
  const coldRuns = values["skip-cold"] ? 0 : Number(values["cold-runs"]);
  const params = quarterParams(values.quarter!);
  const startedAt = new Date().toISOString();

  // Every (config, query) SQL text, rendered once.
  const sqlText = new Map<string, string>();
  const key = (c: ConfigId, q: string) => `${c}:${q}`;
  for (const c of CONFIGS) for (const q of QUERIES) sqlText.set(key(c.id, q.id), await loadQuerySql(c, q, params));

  // 0. Preflight: fail with a clear message instead of "relation does not exist".
  const admin = await connect().catch((err: Error) => {
    throw new Error(`Cannot connect to Postgres (${err.message}). Start it with: npm run db:up`);
  });
  const loaded = await scalar<string | null>(admin, "SELECT to_regclass('oltp.trips') IS NOT NULL AND to_regclass('star.fact_trips') IS NOT NULL");
  if (!loaded || !existsSync(DUCKDB_PATH)) {
    await admin.end();
    throw new Error("Databases are not loaded. Run: npm run ingest:extract && npm run load");
  }
  await admin.query("CREATE EXTENSION IF NOT EXISTS pg_prewarm");

  // 1. Materialized views (B-MV) + metadata from Postgres.
  const tMv = performance.now();
  await runSqlFile(admin, "sql/star/materialized_views.sql");
  const mvBuildMs = performance.now() - tMv;
  for (const mv of ["mv_monthly", "mv_pickup_area", "mv_quarter_payment_company", "mv_dow_hour"]) {
    await admin.query(`VACUUM (FREEZE, ANALYZE) star.${mv}`);
  }
  log(`B-MV: materialized views built in ${(mvBuildMs / 1000).toFixed(1)}s`);

  const { rows: settingRows } = await admin.query<{ name: string; value: string }>(
    "SELECT name, current_setting(name) AS value FROM pg_settings WHERE name = ANY($1) ORDER BY name",
    [PINNED_SETTINGS],
  );
  const rowCounts: Record<string, number> = {};
  for (const t of ["oltp.trips", "oltp.companies", "oltp.payment_types", "oltp.taxis", "oltp.community_areas",
                   "star.fact_trips", "star.dim_date", "star.dim_time", "star.dim_company", "star.dim_payment",
                   "star.dim_area", "star.dim_taxi", "staging.rejected_trips"]) {
    rowCounts[t] = Number(await scalar(admin, `SELECT count(*) FROM ${t}`));
  }
  const pgVersion = await scalar<string>(admin, "SHOW server_version");
  await admin.end();

  // 2. Verification against config A, before any timing.
  log("verify: running every query once in every config");
  const results = new Map<string, NormalizedResult>();
  for (const c of CONFIGS) {
    const s = await openSession(c);
    try {
      for (const q of QUERIES) {
        const r = await s.time(sqlText.get(key(c.id, q.id))!);
        results.set(key(c.id, q.id), normalizeRows(r.rows, r.columns));
      }
    } finally {
      await s.close();
    }
  }
  const verification: Record<string, { rows: number; comparedTo: string; configs: string[] }> = {};
  const failures: string[] = [];
  for (const q of QUERIES) {
    const ref = results.get(key("A", q.id))!;
    if (ref.rows.length === 0) failures.push(`${q.id}: config A returned no rows`);
    for (const c of CONFIGS.filter((c) => c.id !== "A")) {
      const cmp = compareResults(ref, results.get(key(c.id, q.id))!, q.sortKey);
      if (!cmp.ok) failures.push(`${q.id} ${c.id} vs A: ${cmp.reason}`);
    }
    verification[q.id] = { rows: ref.rows.length, comparedTo: "A", configs: CONFIGS.map((c) => c.id) };
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`VERIFY FAILED ${f}`);
    throw new Error("Result verification failed: configs disagree. No timings were taken.");
  }
  log(`verify: all ${QUERIES.length} queries match across ${CONFIGS.length} configs (abs tolerance ${ABS_TOLERANCE})`);

  // Client round-trip floor per engine (SELECT 1), to read sub-millisecond rows (B-MV) honestly.
  const roundTripBaseline: Record<string, Stats> = {};
  for (const [engine, c] of [["postgres", CONFIGS[0]!], ["duckdb", CONFIGS.find((c) => c.id === "C-3t")!]] as const) {
    const s = await openSession(c);
    try {
      for (let i = 0; i < warmup; i++) await s.time("SELECT 1");
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) samples.push((await s.time("SELECT 1")).ms);
      roundTripBaseline[engine] = summarize(samples);
    } finally {
      await s.close();
    }
  }
  log(`round-trip floor (SELECT 1): postgres ${roundTripBaseline.postgres!.medianMs.toFixed(2)} ms, duckdb ${roundTripBaseline.duckdb!.medianMs.toFixed(2)} ms`);

  // 3. Warm runs. Postgres configs are pre-warmed into shared_buffers immediately before their runs.
  const warm = new Map<string, Stats>();
  const prewarmed: Record<string, PrewarmedRelation[]> = {};
  for (const c of CONFIGS) {
    if (c.prewarm) {
      prewarmed[c.id] = await prewarm(databaseUrl(), c.prewarm.schema, c.prewarm.relkinds);
      log(`prewarm ${c.id}: ${prewarmed[c.id]!.length} relations, ${prewarmed[c.id]!.reduce((s, r) => s + r.mb, 0).toFixed(0)} MB`);
    }
    const s = await openSession(c);
    try {
      for (const q of QUERIES) {
        const sql = sqlText.get(key(c.id, q.id))!;
        for (let i = 0; i < warmup; i++) await s.time(sql);
        const samples: number[] = [];
        for (let i = 0; i < runs; i++) samples.push((await s.time(sql)).ms);
        warm.set(key(c.id, q.id), summarize(samples));
        log(`warm ${c.id.padEnd(4)} ${q.id}: median ${warm.get(key(c.id, q.id))!.medianMs.toFixed(1)} ms`);
      }
    } finally {
      await s.close();
    }
  }

  // 4. Restart-cold runs: one restart (Postgres) or fresh instance (DuckDB) per timed run.
  const cold = new Map<string, Stats>();
  if (coldRuns > 0) {
    for (const c of CONFIGS) {
      for (const q of QUERIES) {
        const sql = sqlText.get(key(c.id, q.id))!;
        const samples: number[] = [];
        for (let i = 0; i < coldRuns; i++) {
          if (c.engine === "postgres") await restartPostgres(PG_CONTAINER, databaseUrl());
          const s = await openSession(c);
          try {
            samples.push((await s.time(sql)).ms);
          } finally {
            await s.close();
          }
        }
        cold.set(key(c.id, q.id), summarize(samples));
        log(`cold ${c.id.padEnd(4)} ${q.id}: median ${cold.get(key(c.id, q.id))!.medianMs.toFixed(1)} ms`);
      }
    }
  }

  // 5. Plans, in a separate untimed pass, in the same warm state as the warm runs (pre-warmed,
  // then one untimed execution).
  await mkdir("results/plans", { recursive: true });
  for (const c of CONFIGS) {
    if (c.prewarm) await prewarm(databaseUrl(), c.prewarm.schema, c.prewarm.relkinds);
    const s = await openSession(c);
    try {
      for (const q of QUERIES) {
        const sql = sqlText.get(key(c.id, q.id))!;
        await s.time(sql);
        const plan = await s.explain(sql);
        const note = c.engine === "postgres"
          ? "-- EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF): shape, row counts and buffers only.\n-- Plan times are not benchmark results; see results/benchmark.json.\n"
          : "-- DuckDB EXPLAIN ANALYZE: operator timings include profiling overhead; not benchmark results.\n";
        await writeFile(`results/plans/${q.id}_${c.id}.txt`, `-- ${c.label}\n-- ${q.title}\n${note}${sql}\n\n${plan}\n`);
      }
    } finally {
      await s.close();
    }
  }
  log("plans saved to results/plans/");

  // DuckDB metadata (version, settings, row counts) from a fresh read-only instance.
  const duck = await DuckSession.open(DUCKDB_PATH, 8);
  const duckMeta = (await duck.time("SELECT version() AS version, current_setting('memory_limit') AS memory_limit")).rows[0]!;
  const duckFactRows = Number((await duck.time("SELECT count(*) AS n FROM fact_trips")).rows[0]!.n);
  await duck.close();

  // Speedups (ratio of medians; > 1 means the second config is faster).
  const ratio = (m: Map<string, Stats>, from: ConfigId, to: ConfigId, q: string) => {
    const a = m.get(key(from, q));
    const b = m.get(key(to, q));
    return a && b ? a.medianMs / b.medianMs : null;
  };
  const SPEEDUPS: Array<[string, ConfigId, ConfigId]> = [
    ["A→B (model)", "A", "B"],
    ["B→C (engine, 3 threads)", "B", "C-3t"],
    ["B→C (engine, 8 threads)", "B", "C-8t"],
    ["B→B-MV (pre-agg, round-trip bound)", "B", "B-MV"],
  ];
  const speedups: Record<string, { warm: Record<string, number | null>; cold: Record<string, number | null> }> = {};
  for (const q of QUERIES) {
    speedups[q.id] = { warm: {}, cold: {} };
    for (const [label, from, to] of SPEEDUPS) {
      speedups[q.id]!.warm[label] = ratio(warm, from, to, q.id);
      speedups[q.id]!.cold[label] = coldRuns > 0 ? ratio(cold, from, to, q.id) : null;
    }
  }

  const output = {
    metadata: {
      startedAt,
      finishedAt: new Date().toISOString(),
      git: await gitInfo(),
      host: await hostInfo(),
      docker: await dockerInfo(),
      postgres: { version: pgVersion, pinnedSettings: Object.fromEntries(settingRows.map((r) => [r.name, r.value])) },
      duckdb: {
        version: duckMeta.version,
        memoryLimit: duckMeta.memory_limit,
        threadsByConfig: { "C-3t": 3, "C-8t": 8 },
        factRows: duckFactRows,
      },
      rowCounts,
      loadReport: JSON.parse(await readFile("data/load-report.json", "utf8").catch(() => "null")),
      parameters: { runs, warmup, coldRuns, quarter: values.quarter },
      method: {
        timing: "Wall clock around one query call, after the connection is open: send, execute, receive the (small) result. Postgres timings include a loopback round trip into the Docker VM; DuckDB is in-process.",
        statistics: "median and nearest-rank p95 of the timed runs",
        warm: `${warmup} untimed warm-up run(s), then ${runs} timed runs on the same connection. Immediately before each Postgres config's warm runs, its tables and secondary indexes are loaded into shared_buffers with pg_prewarm, one relation at a time (primary-key indexes excluded: unused and too large to fit alongside). This is Postgres's best case, so the reported engine gap is conservative.`,
        cold: "Restart cold: the Postgres container is restarted before every timed cold run (empties shared_buffers and backend caches) and a new connection is opened; DuckDB gets a fresh read-only instance (empty buffer pool). The OrbStack VM's OS page cache survives container restarts, so table files may still be in memory: this is not a true cold cache.",
        plans: "Captured in a separate, untimed pass in the warm state (pre-warmed, then one untimed execution): EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF) for Postgres, EXPLAIN ANALYZE for DuckDB. Plans document shape, row counts and buffers; their times are not results.",
        roundTrip: "SELECT 1 timed like a query, per engine. Rows whose median is close to this floor (B-MV) are bounded by client round trip and parse/plan time, not by query work.",
        verification: `Before timing, every query's result in every config is compared with config A; numbers within absolute tolerance ${ABS_TOLERANCE}, text exactly. q3 rows are compared after sorting by (payment_type, company) because text collation differs between engines.`,
        materializedViews: "B-MV reads pre-aggregated materialized views. Their build cost is reported separately and is not part of any query timing.",
      },
    },
    materializedViewBuildMs: mvBuildMs,
    roundTripBaselineMs: roundTripBaseline,
    prewarmed,
    verification,
    configs: CONFIGS.map(({ id, label, engine, threads }) => ({ id, label, engine, threads: threads ?? null })),
    queries: QUERIES.map(({ id, title }) => ({ id, title })),
    results: QUERIES.flatMap((q) =>
      CONFIGS.map((c) => ({ query: q.id, config: c.id, warm: warm.get(key(c.id, q.id))!, cold: cold.get(key(c.id, q.id)) ?? null })),
    ),
    speedups,
  };
  await writeFile("results/benchmark.json", JSON.stringify(output, null, 2));

  // Console summary.
  const ms = (s?: Stats) => (s ? s.medianMs.toFixed(1).padStart(9) : "        -");
  const p95 = (s?: Stats) => (s ? s.p95Ms.toFixed(1).padStart(9) : "        -");
  const x = (v: number | null | undefined) => (v == null ? "      -" : `${v.toFixed(1)}x`.padStart(7));
  for (const q of QUERIES) {
    console.log(`\n${q.id}: ${q.title}`);
    console.log(`  ${"config".padEnd(36)} ${"warm med".padStart(9)} ${"warm p95".padStart(9)} ${"cold med".padStart(9)} ${"cold p95".padStart(9)}   (ms)`);
    for (const c of CONFIGS) {
      const w = warm.get(key(c.id, q.id));
      const k = cold.get(key(c.id, q.id));
      console.log(`  ${c.label.padEnd(36)} ${ms(w)} ${p95(w)} ${ms(k)} ${p95(k)}`);
    }
  }
  console.log(`\nSpeedups (ratio of medians, warm / cold)`);
  console.log(`  ${"query".padEnd(6)}${SPEEDUPS.map(([l]) => l.padStart(26)).join("")}`);
  for (const q of QUERIES) {
    const cells = SPEEDUPS.map(([l]) => `${x(speedups[q.id]!.warm[l])} / ${x(speedups[q.id]!.cold[l])}`.padStart(26));
    console.log(`  ${q.id.padEnd(6)}${cells.join("")}`);
  }
  console.log(`\nB-MV build time (not in any timing): ${(mvBuildMs / 1000).toFixed(1)}s`);
  console.log(`Round-trip floor (SELECT 1 median): postgres ${roundTripBaseline.postgres!.medianMs.toFixed(2)} ms, duckdb ${roundTripBaseline.duckdb!.medianMs.toFixed(2)} ms`);
  console.log("Results: results/benchmark.json, plans: results/plans/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
