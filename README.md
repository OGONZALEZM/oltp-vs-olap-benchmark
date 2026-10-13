# OLTP vs OLAP on real Chicago taxi data

A reproducible benchmark of the same four analytical questions over 3.3 million real taxi trips
(Chicago Data Portal, Jan–Jun 2025), in three configurations:

| Config | Engine | Model |
|---|---|---|
| A | PostgreSQL 16 | Normalized OLTP (3NF) |
| B | PostgreSQL 16 | Star schema (+ materialized views as a separate row, B-MV) |
| C | DuckDB | Same star schema, columnar (threads=3 primary row, threads=8 secondary) |

A→B isolates the effect of the **data model**, B→C the effect of the **engine**. Every query's
result is checked to be identical across all configs before anything is timed.

## Results (Apple M3, 16 GB; Postgres in an OrbStack VM)

Warm median per query in ms, 10 runs. The full results (min, median and p95; restart runs with an empty buffer pool; the JIT sensitivity row; plans and metadata) are in `results/benchmark.json`.

| Query | A 3NF | B star | B-MV | C (3 threads) | C (8 threads) |
|---|---:|---:|---:|---:|---:|
| q1 Trips, revenue and average fare per month | 607.1 | 393.9 | 0.3 | 17.7 | 10.1 |
| q2 Top 10 pickup areas by revenue (known areas) | 345.6 | 375.2 | 0.3 | 37.2 | 18.0 |
| q3 Average tip by payment type and company, one quarter | 308.6 | 358.8 | 0.6 | 18.3 | 10.9 |
| q4 Day-of-week x hour: trips and average duration | 505.4 | 382.7 | 0.5 | 16.4 | 10.4 |

- **The model alone (A→B) gives 0.9–1.5x in Postgres.** A star schema does not change how a row store reads data.
- **The engine (B→C) gives 10–23x at the same 3-thread budget, and 21–39x with DuckDB's default 8 threads.** Caveat: Postgres runs inside the OrbStack Linux VM and DuckDB natively on the host, so B→C is engine plus platform. Postgres is pre-warmed into its buffer cache: this is the best case for Postgres's buffer cache; native vs VM and JIT are not controlled.
- **Materialized views (B-MV) remove the query work entirely.** Their times sit at the client round-trip floor, and they are reported as their own row.


Methodology, data cleaning and the reasoning behind these numbers: [DESIGN.md](DESIGN.md).

## Prerequisites

- **Node.js ≥ 20.12** (uses `process.loadEnvFile`) and npm.
- **Docker with Compose v2** (`docker compose up --wait`). Developed on OrbStack; Docker Desktop
  works too. The `docker` CLI must be on `PATH`: the benchmark restarts the Postgres container
  between restart runs (empty buffer pool).
- **Port 5433 free** on localhost (Postgres is published there; override with `PG_PORT` and
  `DATABASE_URL` in `.env`).
- **Network access** to `data.cityofchicago.org` for the extract step (once), and to DuckDB's
  extension repository during `load` (`INSTALL postgres` for the `ATTACH` path; without it, `load`
  falls back to exporting the star tables to Parquet).
- About 6 GB of free disk (raw pages ~0.4 GB, Postgres ~4.3 GB inside the Docker volume,
  DuckDB ~0.13 GB).

## Run it

```bash
npm ci
cp .env.example .env          # optional: add SOCRATA_APP_TOKEN to avoid API throttling

npm run ingest:extract        # 1. download Jan–Jun 2025 from the Socrata API into data/raw/
npm run db:up                 # 2. start Postgres 16 (docker-compose.yml, pinned settings)
npm run load                  # 3. build A and B in Postgres, then C in DuckDB
npm run bench                 # 4. verify results, time every query, save plans
```

The steps must run in this order; `npm run bench` stops with a clear message if the databases
are not loaded yet.

| Step | What it does | Expected result | Time (M3, 16 GB) |
|---|---|---|---|
| `ingest:extract` | Keyset-paginated download, 50k rows per page, with per-month manifests. Re-runs skip finished months and resume unfinished ones. | 3,313,460 rows in 69 pages | ~15 min without an app token |
| `load` | COPY into staging → cleaning (rejects to `staging.rejected_trips`) → OLTP → star → `VACUUM (FREEZE, ANALYZE)` → DuckDB copy. Rebuilds everything from scratch on every run. | 3,304,881 trips in each config, 8,579 rejected | ~6.5 min |
| `bench` | Builds materialized views, verifies results, 1 warm-up + 10 warm runs and 10 restart (empty buffer pool) runs per query and config, plus a warm-only JIT sensitivity row for B, then captures plans. | `results/benchmark.json`, `results/plans/*.txt` | ~5 min |

`load` fails unless A, B and C end up with identical fact checksums (row count, sum of
`trip_total` in cents, sum of `trip_seconds`). `bench` fails, before timing anything, unless
every query returns the same result in every config.

### Options

| Command | Flag / env | Default |
|---|---|---|
| `ingest:extract`, `load` | `--start YYYY-MM` / `INGEST_START_MONTH` | `2025-01` |
| `ingest:extract`, `load` | `--end YYYY-MM` / `INGEST_END_MONTH` | `2025-06` |
| `ingest:extract` | `--concurrency N`, `--page-size N` | 3, 50000 |
| `load` | `--duckdb-fallback` (load C via Parquet instead of `ATTACH`), `--skip-duckdb` | off |
| `bench` | `--runs N`, `--warmup N`, `--restart-runs N`, `--skip-restart`, `--quarter YYYY-QN` | 10, 1, 10, off, `2025-Q2` |

To benchmark a larger volume, widen the window (e.g. `--start 2024-01 --end 2025-06`) for both
`ingest:extract` and `load`; `--quarter` must fall inside the window.

### Tests

```bash
npm test             # unit tests + integration tests (Testcontainers starts its own Postgres 16)
npm run typecheck
```

### Troubleshooting

- **Port 5433 in use:** set `PG_PORT` and `DATABASE_URL` in `.env`, then `npm run db:up`.
- **Do not rename the container:** the benchmark restarts `oltp-vs-olap-pg` by name
  (override with `PG_CONTAINER` if you must).
- **API throttling / timeouts:** the extractor retries with backoff; an app token
  (`SOCRATA_APP_TOKEN`) makes it faster. Interrupted runs resume where they stopped.
- **Start over:** `docker compose down -v && rm -rf data/`. `-v` removes the `pgdata` volume
  under its real name, `<project>_pgdata`, where the Compose project name is
  `COMPOSE_PROJECT_NAME` or, by default, the checkout directory's name.

## Repository layout

```
sql/staging/   raw landing table, cleaning rules, rejected rows
sql/oltp/      config A: 3NF schema, load, FKs + indexes
sql/star/      config B: star schema, load, FKs + indexes, materialized views
sql/duckdb/    config C: the same star schema for DuckDB
sql/queries/   the four questions: oltp/ (A), star/ (B and C, identical files), mv/ (B-MV)
sql/seed/      community area names (Boundaries – Community Areas, igwz-8jzy)
src/ingest/    API extract (keyset pagination, manifests) and COPY loader
src/transform/ Postgres and DuckDB builds
src/bench/     verification, timing, plans, report
tests/         unit and integration (Testcontainers) tests
results/       benchmark.json and plans/ from the last run
CLAUDE.md      project context for Claude Code (loaded automatically at session start)
docs/ai-log.md log of AI-generated work that was corrected, and how it was caught
.claude/agents/benchmark-reviewer.md  read-only reviewer subagent for benchmark fairness
```
