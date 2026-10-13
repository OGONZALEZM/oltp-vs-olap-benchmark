/**
 * npm run bench [-- --runs 10 --warmup 1 --restart-runs 10 --cooldown-ms 2000 --quarter 2025-Q2 --skip-restart]
 *
 * Phases (each config runs alone; nothing else queries the engines meanwhile):
 *   1. Build materialized views for B-MV (build time reported).
 *   2. Verify: every query returns the same result in every config (main and sensitivity), or
 *      the benchmark fails.
 *   3. Warm: per query, configs in round-robin order (rotated by one per query); per (query,
 *      config) block, `warmup` untimed runs then `runs` timed runs. Sensitivity configs (B-jit)
 *      are timed warm only and reported in their own section.
 *   4. Restart (empty buffer pool): same order; Postgres container restarted before every timed
 *      run; DuckDB opened fresh. Main configs only.
 *   Every timed run (warm and restart) is preceded by a `cooldown-ms` idle pause, so a fanless
 *   host does not heat up over a block and penalize whichever config runs late in it.
 *   5. Plans: EXPLAIN (ANALYZE, BUFFERS) / EXPLAIN ANALYZE in a separate, untimed pass.
 * Output: results/benchmark.json, results/plans/*.txt and a console summary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { connect, databaseUrl, runSqlFile, scalar } from "../db.js";
import { loadDotEnv } from "../ingest/config.js";
import { PINNED_SETTINGS } from "../transform/build-postgres.js";
import { ABS_TOLERANCE, compareResults, normalizeRows, type NormalizedResult } from "./compare.js";
import { CONFIGS, QUERIES, SENSITIVITY_CONFIGS, loadQuerySql, quarterParams, type ConfigDef, type ConfigId } from "./queries.js";
import { existsSync } from "node:fs";
import { DuckSession, PgSession, prewarm, restartPostgres, type PrewarmedRelation, type Session } from "./sessions.js";
import { summarize, type Stats } from "./stats.js";
import { dockerInfo, gitInfo, hostInfo } from "./system.js";

const DUCKDB_PATH = "data/olap.duckdb";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "oltp-vs-olap-pg";

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function openSession(config: ConfigDef): Promise<Session> {
  return config.engine === "postgres"
    ? PgSession.open(databaseUrl(), config.searchPath!, config.settings)
    : DuckSession.open(DUCKDB_PATH, config.threads!);
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      warmup: { type: "string", default: "1" },
      "restart-runs": { type: "string", default: "10" },
      "cooldown-ms": { type: "string", default: "2000" },
      quarter: { type: "string", default: "2025-Q2" },
      "skip-restart": { type: "boolean", default: false },
    },
    strict: true,
  });
  const runs = Number(values.runs);
  const warmup = Number(values.warmup);
  const restartRuns = values["skip-restart"] ? 0 : Number(values["restart-runs"]);
  const cooldownMs = Number(values["cooldown-ms"]);
  const cooldown = () => (cooldownMs > 0 ? sleep(cooldownMs) : Promise.resolve());
  /** Round-robin: query i runs the configs starting from config i, so no config is always last. */
  const rotated = <T>(xs: T[], i: number): T[] => xs.map((_, j) => xs[(i + j) % xs.length]!);
  const params = quarterParams(values.quarter!);
  const startedAt = new Date().toISOString();

  // Every (config, query) SQL text, rendered once.
  const ALL_CONFIGS = [...CONFIGS, ...SENSITIVITY_CONFIGS];
  const sqlText = new Map<string, string>();
  const key = (c: ConfigId, q: string) => `${c}:${q}`;
  for (const c of ALL_CONFIGS) for (const q of QUERIES) sqlText.set(key(c.id, q.id), await loadQuerySql(c, q, params));

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
  for (const c of ALL_CONFIGS) {
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
    for (const c of ALL_CONFIGS.filter((c) => c.id !== "A")) {
      const cmp = compareResults(ref, results.get(key(c.id, q.id))!, q.sortKey);
      if (!cmp.ok) failures.push(`${q.id} ${c.id} vs A: ${cmp.reason}`);
    }
    verification[q.id] = { rows: ref.rows.length, comparedTo: "A", configs: ALL_CONFIGS.map((c) => c.id) };
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`VERIFY FAILED ${f}`);
    throw new Error("Result verification failed: configs disagree. No timings were taken.");
  }
  log(`verify: all ${QUERIES.length} queries match across ${ALL_CONFIGS.length} configs (abs tolerance ${ABS_TOLERANCE})`);

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

  // 3. Warm runs, query by query with configs in round-robin order. Each Postgres (query, config)
  // block is pre-warmed into shared_buffers immediately before it: A and B together do not fit in
  // 1 GB, so runs of different configs cannot be interleaved without evicting each other.
  const warm = new Map<string, Stats>();
  const prewarmed: Record<string, PrewarmedRelation[]> = {};
  const order: Record<string, string[]> = {};
  for (const [qi, q] of QUERIES.entries()) {
    const configs = rotated(ALL_CONFIGS, qi);
    order[q.id] = configs.map((c) => c.id);
    for (const c of configs) {
      if (c.prewarm) prewarmed[c.id] = await prewarm(databaseUrl(), c.prewarm.schema, c.prewarm.relkinds);
      const s = await openSession(c);
      try {
        const sql = sqlText.get(key(c.id, q.id))!;
        for (let i = 0; i < warmup; i++) await s.time(sql);
        const samples: number[] = [];
        for (let i = 0; i < runs; i++) {
          await cooldown();
          samples.push((await s.time(sql)).ms);
        }
        warm.set(key(c.id, q.id), summarize(samples));
        log(`warm ${c.id.padEnd(5)} ${q.id}: median ${warm.get(key(c.id, q.id))!.medianMs.toFixed(1)} ms`);
      } finally {
        await s.close();
      }
    }
  }
  for (const [id, rels] of Object.entries(prewarmed)) log(`prewarm ${id}: ${rels.length} relations, ${rels.reduce((s, r) => s + r.mb, 0).toFixed(0)} MB`);

  // 4. Restart (empty buffer pool) runs: one restart (Postgres) or fresh instance (DuckDB) per
  // timed run. Main configs only, same round-robin order.
  const restart = new Map<string, Stats>();
  if (restartRuns > 0) {
    for (const [qi, q] of QUERIES.entries()) {
      for (const c of rotated(CONFIGS, qi)) {
        const sql = sqlText.get(key(c.id, q.id))!;
        const samples: number[] = [];
        for (let i = 0; i < restartRuns; i++) {
          if (c.engine === "postgres") await restartPostgres(PG_CONTAINER, databaseUrl());
          const s = await openSession(c);
          try {
            await cooldown();
            samples.push((await s.time(sql)).ms);
          } finally {
            await s.close();
          }
        }
        restart.set(key(c.id, q.id), summarize(samples));
        log(`restart ${c.id.padEnd(4)} ${q.id}: median ${restart.get(key(c.id, q.id))!.medianMs.toFixed(1)} ms`);
      }
    }
  }

  // 5. Plans, in a separate untimed pass, in the same warm state as the warm runs (pre-warmed,
  // then one untimed execution).
  await mkdir("results/plans", { recursive: true });
  const jitUsed: Record<string, boolean> = {};
  for (const c of ALL_CONFIGS) {
    if (c.prewarm) await prewarm(databaseUrl(), c.prewarm.schema, c.prewarm.relkinds);
    const s = await openSession(c);
    try {
      for (const q of QUERIES) {
        const sql = sqlText.get(key(c.id, q.id))!;
        await s.time(sql);
        const plan = await s.explain(sql);
        if (c.settings?.jit === "on") jitUsed[q.id] = /^JIT:/m.test(plan);
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
  const speedups: Record<string, { warm: Record<string, number | null>; restart: Record<string, number | null> }> = {};
  for (const q of QUERIES) {
    speedups[q.id] = { warm: {}, restart: {} };
    for (const [label, from, to] of SPEEDUPS) {
      speedups[q.id]!.warm[label] = ratio(warm, from, to, q.id);
      speedups[q.id]!.restart[label] = restartRuns > 0 ? ratio(restart, from, to, q.id) : null;
    }
  }

  // Sensitivity rows: warm only, compared with the main config they vary (B-jit vs B).
  const sensitivity = SENSITIVITY_CONFIGS.map((c) => ({
    config: c.id,
    label: c.label,
    baseConfig: "B" as ConfigId,
    settings: c.settings ?? {},
    results: QUERIES.map((q) => ({
      query: q.id,
      warm: warm.get(key(c.id, q.id))!,
      /** > 1 means the sensitivity setting made the query faster than B. */
      ratioFromBase: ratio(warm, "B", c.id, q.id),
      jitUsed: c.settings?.jit === "on" ? (jitUsed[q.id] ?? false) : null,
    })),
  }));

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
      parameters: { runs, warmup, restartRuns, cooldownMs, quarter: values.quarter },
      method: {
        timing: "Wall clock around one query call, after the connection is open: send, execute, receive the (small) result and turn it into JS row objects (same scope for both engines). Postgres timings include a loopback round trip into the Docker VM; DuckDB is in-process.",
        ordering: `Query by query; within a query, configs run in round-robin order (rotated by one config per query; see \`order\`), each as one block of warm-up plus timed runs. Runs of different configs are not interleaved: A and B do not fit in shared_buffers together, so interleaving would evict the pre-warmed tables. A ${cooldownMs} ms idle pause precedes every timed run (warm and restart): without it, on the fanless host, back-to-back runs appear to heat the machine (in an earlier run, Postgres warm medians exceeded restart medians in 6 of 8 A/B cells) and inflate the medians of whichever config runs late.`,
        statistics: "min, median and nearest-rank p95 of the timed runs (with 10 runs, p95 is the slowest run)",
        warm: `${warmup} untimed warm-up run(s), then ${runs} timed runs on the same connection. Immediately before each Postgres config's warm runs, its tables and secondary indexes are loaded into shared_buffers with pg_prewarm, one relation at a time (primary-key indexes excluded: unused and too large to fit alongside). This is the best case for Postgres's buffer cache; native vs VM is not controlled, and JIT is bounded by a sensitivity row (B-jit).`,
        restart: "Restart (empty buffer pool): the Postgres container is restarted before every timed run (empties shared_buffers and backend caches) and a new connection is opened; DuckDB gets a fresh read-only instance (empty buffer pool). The OrbStack VM's OS page cache survives container restarts and the DuckDB file stays in the host page cache, so this is not a cold cache: it measures an empty database buffer pool, not disk reads.",
        plans: "Captured in a separate, untimed pass in the warm state (pre-warmed, then one untimed execution): EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF) for Postgres, EXPLAIN ANALYZE for DuckDB. Plans document shape, row counts and buffers; their times are not results.",
        roundTrip: "SELECT 1 timed like a query, per engine. Rows whose median is close to this floor (B-MV) are bounded by client round trip and parse/plan time, not by query work.",
        verification: `Before timing, every query's result in every config (main and sensitivity) is compared with config A; numbers within absolute tolerance ${ABS_TOLERANCE}, text exactly. q3 rows are compared after sorting by (payment_type, company) because text collation differs between engines.`,
        materializedViews: "B-MV reads pre-aggregated materialized views. Their build cost is reported separately and is not part of any query timing.",
        platform: "Postgres runs inside the OrbStack Linux VM; DuckDB runs natively on the macOS host. B→C ratios therefore contain engine plus VM-vs-native execution, which is not controlled.",
        sensitivity: "Sensitivity rows vary one pinned setting of a main config (B-jit: B with SET jit = on, jit_above_cost = 0; at the default jit_above_cost of 100000 no B plan qualifies for JIT), are verified like the main configs, timed warm only, and never used in the A/B/C ratios. jitUsed records whether the plan captured for that query actually contained a JIT section.",
      },
    },
    materializedViewBuildMs: mvBuildMs,
    roundTripBaselineMs: roundTripBaseline,
    prewarmed,
    order,
    verification,
    configs: CONFIGS.map(({ id, label, engine, threads }) => ({ id, label, engine, threads: threads ?? null })),
    queries: QUERIES.map(({ id, title }) => ({ id, title })),
    results: QUERIES.flatMap((q) =>
      CONFIGS.map((c) => ({ query: q.id, config: c.id, warm: warm.get(key(c.id, q.id))!, restart: restart.get(key(c.id, q.id)) ?? null })),
    ),
    speedups,
    sensitivity,
  };
  await writeFile("results/benchmark.json", JSON.stringify(output, null, 2));

  // Console summary.
  const col = (v?: number) => (v == null ? "        -" : v.toFixed(1).padStart(9));
  const x = (v: number | null | undefined) => (v == null ? "      -" : `${v.toFixed(1)}x`.padStart(7));
  const header = ["warm min", "warm med", "warm p95", "rst min", "rst med", "rst p95"].map((h) => h.padStart(9)).join(" ");
  for (const q of QUERIES) {
    console.log(`\n${q.id}: ${q.title}`);
    console.log(`  ${"config".padEnd(40)} ${header}   (ms)`);
    for (const c of ALL_CONFIGS) {
      const w = warm.get(key(c.id, q.id));
      const r = restart.get(key(c.id, q.id));
      console.log(`  ${c.label.padEnd(40)} ${[w?.minMs, w?.medianMs, w?.p95Ms, r?.minMs, r?.medianMs, r?.p95Ms].map(col).join(" ")}`);
    }
  }
  console.log(`\nSpeedups (ratio of medians, warm / restart)`);
  console.log(`  ${"query".padEnd(6)}${SPEEDUPS.map(([l]) => l.padStart(26)).join("")}`);
  for (const q of QUERIES) {
    const cells = SPEEDUPS.map(([l]) => `${x(speedups[q.id]!.warm[l])} / ${x(speedups[q.id]!.restart[l])}`.padStart(26));
    console.log(`  ${q.id.padEnd(6)}${cells.join("")}`);
  }
  for (const sens of sensitivity) {
    console.log(`\nSensitivity ${sens.config} vs ${sens.baseConfig} (warm median ratio; > 1 = faster than ${sens.baseConfig})`);
    for (const r of sens.results) console.log(`  ${r.query.padEnd(6)}${x(r.ratioFromBase)}${r.jitUsed == null ? "" : `   JIT in plan: ${r.jitUsed ? "yes" : "no"}`}`);
  }
  console.log(`\nB-MV build time (not in any timing): ${(mvBuildMs / 1000).toFixed(1)}s`);
  console.log(`Round-trip floor (SELECT 1 median): postgres ${roundTripBaseline.postgres!.medianMs.toFixed(2)} ms, duckdb ${roundTripBaseline.duckdb!.medianMs.toFixed(2)} ms`);
  console.log("Results: results/benchmark.json, plans: results/plans/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
