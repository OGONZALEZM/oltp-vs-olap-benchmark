import { readFile } from "node:fs/promises";

export interface QueryDef {
  id: string;
  file: string;
  title: string;
  /** Columns to sort by before comparing, when ORDER BY is on text (collations differ by engine). */
  sortKey?: string[];
}

export const QUERIES: QueryDef[] = [
  { id: "q1", file: "q1_monthly.sql", title: "Trips, revenue and average fare per month" },
  { id: "q2", file: "q2_top_pickup_areas.sql", title: "Top 10 pickup areas by revenue (known areas)" },
  { id: "q3", file: "q3_tips_by_payment_company.sql", title: "Average tip by payment type and company, one quarter", sortKey: ["payment_type", "company"] },
  { id: "q4", file: "q4_dow_hour.sql", title: "Day-of-week x hour: trips and average duration" },
];

export type ConfigId = "A" | "B" | "B-MV" | "C-3t" | "C-8t";

export interface ConfigDef {
  id: ConfigId;
  label: string;
  engine: "postgres" | "duckdb";
  /** Directory under sql/queries/. B and C share the same star SQL files. */
  sqlDir: "oltp" | "star" | "mv";
  searchPath?: "oltp" | "star";
  threads?: number;
}

export const CONFIGS: ConfigDef[] = [
  { id: "A", label: "A  Postgres OLTP (3NF)", engine: "postgres", sqlDir: "oltp", searchPath: "oltp" },
  { id: "B", label: "B  Postgres star (fact table)", engine: "postgres", sqlDir: "star", searchPath: "star" },
  { id: "B-MV", label: "B-MV Postgres materialized views", engine: "postgres", sqlDir: "mv", searchPath: "star" },
  // Primary C row: 3 threads = Postgres's per-query budget (leader + max_parallel_workers_per_gather=2).
  { id: "C-3t", label: "C  DuckDB star, threads=3", engine: "duckdb", sqlDir: "star", threads: 3 },
  { id: "C-8t", label: "C  DuckDB star, threads=8 (default)", engine: "duckdb", sqlDir: "star", threads: 8 },
];

/** Literal parameters for the quarter filter of q3, e.g. "2025-Q2". */
export function quarterParams(quarter: string): Record<string, string> {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw new Error(`Invalid quarter "${quarter}", expected YYYY-Q[1-4]`);
  const year = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const end = q === 4 ? `${year + 1}-01-01` : `${year}-${String(startMonth + 3).padStart(2, "0")}-01`;
  return {
    quarter_start: `TIMESTAMP '${year}-${String(startMonth).padStart(2, "0")}-01 00:00:00'`,
    quarter_end: `TIMESTAMP '${end} 00:00:00'`,
    quarter_year: String(year),
    quarter: String(q),
  };
}

/** Substitutes {{name}} placeholders with literals (literals, not bind parameters, so plans match). */
export function renderSql(template: string, params: Record<string, string>): string {
  const sql = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`No value for placeholder {{${name}}}`);
    return v;
  });
  return sql;
}

export async function loadQuerySql(config: ConfigDef, query: QueryDef, params: Record<string, string>): Promise<string> {
  return renderSql(await readFile(`sql/queries/${config.sqlDir}/${query.file}`, "utf8"), params);
}
