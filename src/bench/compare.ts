/**
 * Result verification across configs. Values are normalized (numeric strings, bigints and
 * floats all become numbers) and compared with an explicit absolute tolerance: Postgres returns
 * exact numeric averages, DuckDB returns DOUBLE averages, so they differ in the last few bits.
 * Counts and sums are exact in every engine and must match within the same tolerance.
 */
export const ABS_TOLERANCE = 1e-6;

type Cell = number | string | boolean | null;

const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export function normalizeValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return NUMERIC_RE.test(v) ? Number(v) : v;
  return String(v);
}

export interface NormalizedResult {
  columns: string[];
  rows: Cell[][];
}

export function normalizeRows(rows: Array<Record<string, unknown>>, columns?: string[]): NormalizedResult {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return { columns: cols, rows: rows.map((r) => cols.map((c) => normalizeValue(r[c]))) };
}

function cellsEqual(a: Cell, b: Cell): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= ABS_TOLERANCE;
  return a === b;
}

/**
 * Compares `other` against the reference result. When the query's row order is presentation
 * only (e.g. ordered by text, where engines collate differently), both sides are sorted by
 * `sortKey` columns first; otherwise row order must match exactly.
 */
export function compareResults(
  reference: NormalizedResult,
  other: NormalizedResult,
  sortKey?: string[],
): { ok: true } | { ok: false; reason: string } {
  if (reference.columns.join(",") !== other.columns.join(",")) {
    return { ok: false, reason: `columns differ: [${reference.columns}] vs [${other.columns}]` };
  }
  if (reference.rows.length !== other.rows.length) {
    return { ok: false, reason: `row count differs: ${reference.rows.length} vs ${other.rows.length}` };
  }
  const order = (r: NormalizedResult) => {
    if (!sortKey) return r.rows;
    const idx = sortKey.map((k) => r.columns.indexOf(k));
    if (idx.includes(-1)) throw new Error(`sort key [${sortKey}] not in columns [${r.columns}]`);
    const key = (row: Cell[]) => JSON.stringify(idx.map((i) => row[i]));
    return [...r.rows].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  };
  const ref = order(reference);
  const oth = order(other);
  for (let i = 0; i < ref.length; i++) {
    for (let j = 0; j < reference.columns.length; j++) {
      if (!cellsEqual(ref[i]![j]!, oth[i]![j]!)) {
        return {
          ok: false,
          reason: `row ${i}, column ${reference.columns[j]}: ${JSON.stringify(ref[i]![j])} vs ${JSON.stringify(oth[i]![j])}`,
        };
      }
    }
  }
  return { ok: true };
}
