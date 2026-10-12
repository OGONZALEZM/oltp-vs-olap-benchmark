export interface Stats {
  n: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty sample");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile: the smallest sample with at least p% of samples <= it. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) throw new Error("percentile of empty sample");
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.max(rank, 1) - 1]!;
}

export function summarize(samplesMs: number[]): Stats {
  return {
    n: samplesMs.length,
    medianMs: median(samplesMs),
    p95Ms: percentile(samplesMs, 95),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    samplesMs,
  };
}
