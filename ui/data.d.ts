export const CHART_CONFIGS: string[];
export const PLAN_CONFIGS: string[];

export interface Cell {
  warm: number;
  restart: number | null;
  min: number;
  p95: number;
}

export interface Headline {
  id: "model" | "engine" | "preagg";
  title: string;
  label: string;
  from: string;
  to: string;
  note: string;
  warmMin: number;
  warmMax: number;
  restartMin: number | null;
  restartMax: number | null;
  perQuery: Array<{ query: string; warm: number; restart: number | null }>;
}

export interface Benchmark {
  queries: Array<{ id: string; title: string }>;
  labels: Record<string, string>;
  cells: Record<string, Record<string, Cell>>;
  headlines: Headline[];
  plans: Array<{ query: string; config: string; path: string }>;
  meta: {
    commit: string | null;
    dirty: boolean | null;
    startedAt: string | null;
    runs: number | null;
    factRows: number | null;
    host: unknown;
  };
}

export function parseBenchmark(raw: unknown): Benchmark;
export function formatRatio(v: number): string;
export function formatRange(lo: number, hi: number): string;
