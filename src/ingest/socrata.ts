import { setTimeout as sleep } from "node:timers/promises";

export const ENDPOINT = "https://data.cityofchicago.org/resource/ajtu-isnz.json";

/**
 * Columns we keep, verified against the column dictionary. Census tracts and centroid
 * columns are dropped on purpose: tracts are suppressed in ~55% of rows and both are
 * functionally determined by the community area (see CLAUDE.md).
 */
export const SELECT_COLUMNS = [
  "trip_id",
  "taxi_id",
  "trip_start_timestamp",
  "trip_end_timestamp",
  "trip_seconds",
  "trip_miles",
  "pickup_community_area",
  "dropoff_community_area",
  "fare",
  "tips",
  "tolls",
  "extras",
  "trip_total",
  "payment_type",
  "company",
] as const;

/** A raw row as the API sends it: every value is a string and null fields are omitted. */
export type RawTrip = Partial<Record<(typeof SELECT_COLUMNS)[number], string>>;

const TRIP_ID_RE = /^[0-9a-f]{40}$/;

export function assertTripId(id: string): void {
  if (!TRIP_ID_RE.test(id)) throw new Error(`Unexpected trip_id format: "${id}"`);
}

/** Half-open month interval on the floating (no time zone) start timestamp. */
export function monthWhere(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return (
    `trip_start_timestamp >= '${month}-01T00:00:00' ` +
    `AND trip_start_timestamp < '${next}-01T00:00:00'`
  );
}

/** Fetches JSON for a set of SoQL parameters. Injected so tests can run without the network. */
export type SoqlFetcher = (params: Record<string, string>) => Promise<unknown>;

export interface HttpFetcherOptions {
  appToken?: string | undefined;
  maxAttempts?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function httpFetcher(opts: HttpFetcherOptions = {}): SoqlFetcher {
  const maxAttempts = opts.maxAttempts ?? 6;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const log = opts.log ?? (() => {});

  return async (params) => {
    const url = `${ENDPOINT}?${new URLSearchParams(params)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.appToken) headers["X-App-Token"] = opts.appToken;

    for (let attempt = 1; ; attempt++) {
      let retryAfterMs: number | undefined;
      let reason: string;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return await res.json();
        const body = (await res.text()).slice(0, 300);
        if (!RETRYABLE_STATUS.has(res.status)) {
          throw new NonRetryableError(`HTTP ${res.status} for ${url}: ${body}`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = retryAfter * 1000;
        reason = `HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof NonRetryableError) throw err;
        reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }

      if (attempt >= maxAttempts) {
        throw new Error(`Giving up after ${attempt} attempts (${reason}) for ${url}`);
      }
      // Exponential backoff with jitter: ~2s, 4s, 8s, 16s, 32s.
      const delay = retryAfterMs ?? 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5);
      log(`retry ${attempt}/${maxAttempts - 1} in ${Math.round(delay / 1000)}s (${reason})`);
      await sleep(delay);
    }
  };
}

class NonRetryableError extends Error {}

export async function fetchMonthCount(fetcher: SoqlFetcher, month: string): Promise<number> {
  const rows = (await fetcher({
    $select: "count(*) AS n",
    $where: monthWhere(month),
  })) as Array<{ n: string }>;
  const n = Number(rows[0]?.n);
  if (!Number.isInteger(n)) throw new Error(`Bad count response for ${month}: ${JSON.stringify(rows)}`);
  return n;
}

/** One keyset page: rows of `month` with trip_id strictly greater than `cursor`. */
export async function fetchPage(
  fetcher: SoqlFetcher,
  month: string,
  cursor: string | null,
  pageSize: number,
): Promise<RawTrip[]> {
  let where = monthWhere(month);
  if (cursor !== null) {
    assertTripId(cursor); // never interpolate anything unvalidated into SoQL
    where += ` AND trip_id > '${cursor}'`;
  }
  const rows = await fetcher({
    $select: SELECT_COLUMNS.join(","),
    $where: where,
    $order: "trip_id",
    $limit: String(pageSize),
  });
  if (!Array.isArray(rows)) throw new Error(`Expected a JSON array for ${month}, got ${typeof rows}`);
  return rows as RawTrip[];
}
