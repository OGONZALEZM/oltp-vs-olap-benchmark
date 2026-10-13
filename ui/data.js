// Data loader for the results page: turns results/benchmark.json into the three views the page
// shows. Plain ES module with no dependencies, so the browser and the integration test load the
// same code.

/** Main configs, in chart order. B-jit is a sensitivity row and is not charted. */
export const CHART_CONFIGS = ["A", "B", "B-MV", "C-3t", "C-8t"];

/** Plan files exist for every main config plus the sensitivity rows. */
export const PLAN_CONFIGS = [...CHART_CONFIGS, "B-jit"];

const HEADLINES = [
  { id: "model", title: "Model", label: "A→B (model)", from: "A", to: "B",
    note: "Postgres 3NF → Postgres star, same engine" },
  { id: "engine", title: "Engine", label: "B→C (engine, 3 threads)", from: "B", to: "C-3t",
    note: "Postgres star → DuckDB star, same SQL, 3 threads each" },
  { id: "preagg", title: "Pre-aggregation", label: "B→B-MV (pre-agg, round-trip bound)", from: "B", to: "B-MV",
    note: "Fact table → materialized views. Bounded by client round trip: a lower bound on the work removed, not a precise factor" },
];

function fail(msg) {
  throw new Error(`benchmark.json: ${msg}`);
}

function num(v, where) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`expected a number at ${where}`);
  return v;
}

/**
 * @param {unknown} raw parsed results/benchmark.json
 */
export function parseBenchmark(raw) {
  if (!raw || typeof raw !== "object") fail("not an object");
  const r = /** @type {any} */ (raw);
  if (!Array.isArray(r.queries) || r.queries.length === 0) fail("missing queries");
  if (!Array.isArray(r.results)) fail("missing results");
  if (!r.speedups || typeof r.speedups !== "object") fail("missing speedups");

  const queries = r.queries.map((q) => ({ id: String(q.id), title: String(q.title) }));
  const labels = Object.fromEntries((r.configs ?? []).map((c) => [c.id, String(c.label).replace(/\s+/g, " ").trim()]));

  /** @type {Record<string, Record<string, {warm: number, restart: number | null, min: number, p95: number}>>} */
  const cells = {};
  for (const q of queries) {
    cells[q.id] = {};
    for (const c of CHART_CONFIGS) {
      const e = r.results.find((x) => x.query === q.id && x.config === c);
      if (!e) fail(`no result for ${q.id} ${c}`);
      cells[q.id][c] = {
        warm: num(e.warm?.medianMs, `${q.id}/${c}/warm.medianMs`),
        restart: e.restart == null ? null : num(e.restart.medianMs, `${q.id}/${c}/restart.medianMs`),
        min: num(e.warm?.minMs, `${q.id}/${c}/warm.minMs`),
        p95: num(e.warm?.p95Ms, `${q.id}/${c}/warm.p95Ms`),
      };
    }
  }

  const headlines = HEADLINES.map((h) => {
    const perQuery = queries.map((q) => {
      const s = r.speedups[q.id];
      if (!s) fail(`missing speedups for ${q.id}`);
      return {
        query: q.id,
        warm: num(s.warm?.[h.label], `speedups.${q.id}.warm["${h.label}"]`),
        restart: s.restart?.[h.label] == null ? null : num(s.restart[h.label], `speedups.${q.id}.restart["${h.label}"]`),
      };
    });
    const warm = perQuery.map((p) => p.warm);
    const restart = perQuery.map((p) => p.restart).filter((v) => v != null);
    return {
      ...h,
      warmMin: Math.min(...warm),
      warmMax: Math.max(...warm),
      restartMin: restart.length ? Math.min(...restart) : null,
      restartMax: restart.length ? Math.max(...restart) : null,
      perQuery,
    };
  });

  const plans = [];
  for (const q of queries) for (const c of PLAN_CONFIGS) plans.push({ query: q.id, config: c, path: `results/plans/${q.id}_${c}.txt` });

  const m = r.metadata ?? {};
  return {
    queries,
    labels,
    cells,
    headlines,
    plans,
    meta: {
      commit: m.git?.commit ?? null,
      dirty: m.git?.dirty ?? null,
      startedAt: m.startedAt ?? null,
      runs: m.parameters?.runs ?? null,
      factRows: r.metadata?.rowCounts?.["star.fact_trips"] ?? null,
      host: m.host ?? null,
    },
  };
}

/** Formats a ratio the way the docs do: whole numbers from 10x up, one decimal below. */
export function formatRatio(v) {
  return v >= 10 ? `${Math.round(v)}x` : `${v.toFixed(1)}x`;
}

export function formatRange(lo, hi) {
  const a = formatRatio(lo);
  const b = formatRatio(hi);
  return a === b ? a : `${a.slice(0, -1)}–${b}`;
}
