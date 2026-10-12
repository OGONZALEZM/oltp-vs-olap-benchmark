/**
 * One session per (config, engine). Timing covers sending the query, execution and receiving
 * the (small) result set: it excludes connection setup, which happens before the clock starts.
 * For Postgres this includes a loopback round trip into the OrbStack VM; DuckDB runs in-process.
 */
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import pg from "pg";

export interface Timed {
  ms: number;
  rows: Array<Record<string, unknown>>;
  columns: string[];
}

export interface Session {
  time(sql: string): Promise<Timed>;
  explain(sql: string): Promise<string>;
  close(): Promise<void>;
}

export class PgSession implements Session {
  private constructor(private client: pg.Client) {}

  static async open(url: string, searchPath: string): Promise<PgSession> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`SET search_path TO ${searchPath}`);
    return new PgSession(client);
  }

  async time(sql: string): Promise<Timed> {
    const t0 = performance.now();
    const res = await this.client.query(sql);
    const ms = performance.now() - t0;
    return { ms, rows: res.rows, columns: res.fields.map((f) => f.name) };
  }

  async explain(sql: string): Promise<string> {
    const res = await this.client.query({ text: `EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${sql}`, rowMode: "array" });
    return res.rows.map((r) => String(r[0])).join("\n");
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export class DuckSession implements Session {
  private constructor(private instance: DuckDBInstance, private conn: DuckDBConnection) {}

  /** A fresh instance has an empty DuckDB buffer pool (the OS page cache is untouched). */
  static async open(path: string, threads: number): Promise<DuckSession> {
    const instance = await DuckDBInstance.create(path, { threads: String(threads), access_mode: "READ_ONLY" });
    return new DuckSession(instance, await instance.connect());
  }

  async time(sql: string): Promise<Timed> {
    const t0 = performance.now();
    const reader = await this.conn.runAndReadAll(sql);
    const ms = performance.now() - t0;
    return { ms, rows: reader.getRowObjectsJson() as Array<Record<string, unknown>>, columns: reader.columnNames() };
  }

  async explain(sql: string): Promise<string> {
    const reader = await this.conn.runAndReadAll(`EXPLAIN ANALYZE ${sql}`);
    return (reader.getRowObjectsJson() as Array<Record<string, unknown>>)
      .map((r) => String(r.explain_value ?? ""))
      .join("\n");
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

const execFileP = promisify(execFile);

/**
 * "Restart cold" for Postgres: restarting the container empties shared_buffers and every
 * backend cache. It does NOT empty the OrbStack VM's OS page cache, which survives container
 * restarts, so table files are likely still in memory: this is not a true cold cache.
 */
export async function restartPostgres(container: string, url: string): Promise<void> {
  await execFileP("docker", ["restart", container]);
  const deadline = Date.now() + 60_000;
  while (true) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw new Error(`Postgres not ready after restart: ${(err as Error).message}`);
      await sleep(250);
    }
  }
}
