import { parseArgs } from "node:util";
import { existsSync } from "node:fs";

export interface ExtractConfig {
  months: string[];
  dataDir: string;
  pageSize: number;
  concurrency: number;
  appToken: string | undefined;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const DEFAULT_START_MONTH = "2025-01";
export const DEFAULT_END_MONTH = "2025-06";

/** Inclusive list of YYYY-MM months between start and end. */
export function monthRange(start: string, end: string): string[] {
  const s = MONTH_RE.exec(start);
  const e = MONTH_RE.exec(end);
  if (!s) throw new Error(`Invalid start month "${start}", expected YYYY-MM`);
  if (!e) throw new Error(`Invalid end month "${end}", expected YYYY-MM`);
  if (start > end) throw new Error(`Start month ${start} is after end month ${end}`);

  const months: string[] = [];
  let year = Number(s[1]);
  let month = Number(s[2]);
  while (true) {
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    months.push(ym);
    if (ym === end) return months;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/** Precedence: CLI flag > environment variable (.env included) > default. */
export function loadExtractConfig(argv: string[] = process.argv.slice(2)): ExtractConfig {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const { values } = parseArgs({
    args: argv,
    options: {
      start: { type: "string" },
      end: { type: "string" },
      "data-dir": { type: "string" },
      "page-size": { type: "string" },
      concurrency: { type: "string" },
    },
    strict: true,
  });

  const start = values.start ?? process.env.INGEST_START_MONTH ?? DEFAULT_START_MONTH;
  const end = values.end ?? process.env.INGEST_END_MONTH ?? DEFAULT_END_MONTH;
  const pageSize = Number(values["page-size"] ?? 50_000);
  const concurrency = Number(values.concurrency ?? 3);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50_000) {
    throw new Error(`--page-size must be an integer in 1..50000, got ${values["page-size"]}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${values.concurrency}`);
  }

  return {
    months: monthRange(start, end),
    dataDir: values["data-dir"] ?? "data/raw",
    pageSize,
    concurrency,
    appToken: process.env.SOCRATA_APP_TOKEN || undefined,
  };
}
