import { readFile } from "node:fs/promises";
import pg from "pg";

/** Matches docker-compose.yml (host port 5433 by default). */
export const DEFAULT_DATABASE_URL = "postgres://bench:bench@localhost:5433/bench";

export const databaseUrl = () => process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

export async function connect(url = databaseUrl()): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Runs a .sql file as one simple-protocol query. Postgres executes a multi-statement string
 * as a single implicit transaction, so a failing file leaves nothing half-applied.
 */
export async function runSqlFile(client: pg.Client, path: string): Promise<void> {
  try {
    await client.query(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
  }
}

export async function scalar<T = string>(client: pg.Client, sql: string): Promise<T> {
  const { rows } = await client.query({ text: sql, rowMode: "array" });
  return rows[0]?.[0] as T;
}
