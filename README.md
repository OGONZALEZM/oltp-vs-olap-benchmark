# OLTP vs OLAP on real Chicago taxi data

A reproducible benchmark of the same four analytical questions over 3.3 million real taxi trips
(Chicago Data Portal, Jan–Jun 2025), in three configurations:

| Config | Engine | Model |
|---|---|---|
| A | PostgreSQL 16 | Normalized OLTP (3NF) |
| B | PostgreSQL 16 | Star schema (+ materialized views as a separate row, B-MV) |
| C | DuckDB | Same star schema, columnar (threads=3 primary row, threads=8 secondary) |

A→B isolates the effect of the **data model**, B→C the effect of the **engine**. Every query's
result is checked to be the same across all configs (numbers within 1e-6, text exactly) before
anything is timed.

## Results (Apple M3, 16 GB; Postgres in an OrbStack VM)

Each cell is **warm median (restart median / warm min)** in ms, 10 runs each. Warm runs are
pre-warmed; restart runs start from an empty buffer pool. The full results (p95, the JIT
sensitivity row, plans and metadata) are in `results/benchmark.json`.

| Query | A 3NF | B star | B-MV | C (3 threads) | C (8 threads) |
|---|---:|---:|---:|---:|---:|
| q1 Trips, revenue and average fare per month | 596.0 (599.5 / 588.9) | 361.7 (360.4 / 354.4) | 1.0 (1.3 / 0.8) | 17.9 (20.0 / 16.9) | 8.2 (9.8 / 7.8) |
| q2 Top 10 pickup areas by revenue (known areas) | 340.0 (358.3 / 337.5) | 342.8 (350.3 / 334.6) | 1.0 (1.4 / 0.9) | 35.6 (37.3 / 35.3) | 18.3 (20.0 / 17.3) |
| q3 Average tip by payment type and company, one quarter | 307.1 (352.3 / 305.0) | 352.4 (367.2 / 349.8) | 1.2 (1.7 / 0.9) | 19.4 (20.9 / 19.2) | 10.6 (13.5 / 10.4) |
| q4 Day-of-week x hour: trips and average duration | 480.0 (482.3 / 467.6) | 345.9 (343.3 / 333.2) | 1.1 (1.5 / 0.9) | 16.4 (18.7 / 16.3) | 8.0 (9.9 / 7.9) |

- **The model alone (A→B) gives 0.9–1.6x on warm medians (1.0–1.7x on restart medians) in Postgres.** A star schema does not change how a row store reads data.
- **The engine (B→C) gives 9.6–21x on warm medians (9.4–18x on restart medians) at the same 3-thread budget, and 19–44x (18–37x) with DuckDB's default 8 threads.** Caveat: Postgres runs inside the OrbStack Linux VM and DuckDB natively on the host, so B→C is engine plus platform. Postgres is pre-warmed into its buffer cache: pre-warming guarantees buffer hits but showed little or no measurable benefit, because the VM page cache already served the data (restart medians within 6% in 7 of 8 A/B cells). Native vs VM is not controlled; JIT is bounded by a sensitivity row.
- **Forcing JIT on for B gives 0.9x of B's warm medians** (below 1x means slower with JIT), so the pinned `jit=off` does not explain the engine gap.
- **Materialized views (B-MV) remove the query work entirely.** Their times are within about 1 ms of the client round-trip floor, and they are reported as their own row.


Design decisions and the reasoning behind these numbers: [DESIGN.md](DESIGN.md). Measurement
method, noise, caveats and per-query plans: [docs/BENCHMARK.md](docs/BENCHMARK.md).

## What the data looked like, and what we decided

Before any schema was written, the live API was profiled using the column dictionary plus aggregate
queries. Several assumptions in the initial project context turned out to be wrong, and the
design follows the real data instead. Each figure below names its scope:
- **full dataset:** all 18,658,792 trips from Jan 2024 to the start of Oct 2026, as of profiling
  in Oct 2026;
- **Jan 2025:** one sampled month;
- **H1 2025:** the benchmark window.

Full data notes and the cleaning table: [docs/BENCHMARK.md](docs/BENCHMARK.md).

### Data findings

| Finding | What it meant for the design |
|---|---|
| `trip_id` is unique across all rows (full dataset). Repeated (taxi, start, end, total) tuples exist, but at 15-minute rounding they are plausibly real trips. | `trip_id` is the key (primary key in A, degenerate dimension in B). There is no content-based dedupe. Ingestion is idempotent through per-month manifests and keyset pagination. |
| No negative amounts (full dataset). The real issues are zeros, outliers and impossible trips: 8.4% zero miles and 1.3% zero seconds; fares up to 9,999.75 and trips up to 24 hours; 107 trips that end before they start. | Reject outliers and impossible trips. Keep zeros, which are common and not clearly wrong. |
| `trip_total` is not the sum of its components in 38% of rows (Jan 2025). | Revenue is always `trip_total`, never recomputed. |
| Census tracts are suppressed in about 55% of rows (full dataset). | Tracts and centroids are left out of every model; no query needs them. |
| Community areas arrive as numbers 1–77, with no names. | Names seeded once from the city's Boundaries dataset (`igwz-8jzy`) and committed as a CSV, so the pipeline depends on one API, not two. |
| The same company appears under several spellings: 46 raw values (full dataset). | A canonical key (lowercase, no punctuation, collapsed whitespace, no trailing `llc`/`inc`) merges them. In H1 2025 that merges 3 companies spelled 2 ways each. |
| 17% of taxis drove for more than one company (H1 2025: 523 of 3,075). | `company` belongs to the trip, not to the taxi. |
| Timestamps carry no time zone and are rounded to 15 minutes. | Duration comes from `trip_seconds`, not from end minus start. The time dimension has 96 fifteen-minute slots. |
| Some taxi IDs are the literal string `"NA"` (13 rows in the full dataset, 1 in H1 2025). | Mapped to no taxi: NULL in A, an Unknown row (key 0) in the star schema. |

### Cleaning result (Jan–Jun 2025)

3,313,460 rows landed. 8,579 (0.26%) were rejected with a recorded reason, leaving 3,304,881 trips
in every configuration. A row failing several rules is counted under the first rule that rejects
it (rule order: null amounts, ends before start, total over $1,000, over 6 hours).

| Reason | Rows |
|---|---:|
| Null amounts | 6,249 |
| Trip over 6 hours | 1,944 |
| Trip total over $1,000 | 383 |
| Ends before it starts | 3 |

### Key decisions

- **Real data over a toy API.** PokéAPI was considered and dropped: it is a catalog with no time
  dimension and no transactions, so the fact table would have been entirely synthetic.
- **Jan–Jun 2025 as the window.** Two complete quarters (q3 filters one of them), and enough volume
  (3.3M rows) to make differences measurable without a synthetic generator. The window is
  configurable for larger runs.
- **Three configurations, not two.** Comparing a normalized Postgres against DuckDB would mix two
  variables. A→B isolates the model and B→C the engine.
- **A fair OLTP side.** Config A has indexes on every foreign key plus `trip_start_timestamp`.
  Config B has a btree on every fact FK except `time_key` (6 indexes, as A has 6). Neither has
  indexes added for a specific query.
- **Same answers before any timing.** The benchmark refuses to time anything until every query
  returns the same result in every configuration (numbers within 1e-6, text exactly).
- **Pre-aggregation reported apart.** Materialized views do different work, so they get their own
  row instead of being presented as a faster version of the same query.
- **Methodology changes need a demonstrated cause.** Each change to the measurement followed a
  cause shown independently of the results: pre-warming, the thermal pauses, and where the pauses
  go. The headline statistic was fixed before the final run.

Modeling choices in full: [DESIGN.md](DESIGN.md). How the AI was used and where it was corrected:
[AI_WORKFLOW.md](AI_WORKFLOW.md).

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
- **Network access to cdnjs.cloudflare.com** when viewing the results page (`npm run ui` loads
  Chart.js from the CDN).
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
npm run ui                    # 5. results page at http://localhost:8080/ui/
```

The steps must run in this order; `npm run bench` stops with a clear message if the databases
are not loaded yet.

| Step | What it does | Expected result | Time (M3, 16 GB) |
|---|---|---|---|
| `ingest:extract` | Keyset-paginated download, 50k rows per page, with per-month manifests. Re-runs skip finished months and resume unfinished ones. | 3,313,460 rows in 69 pages | ~15 min without an app token |
| `load` | COPY into staging → cleaning (rejects to `staging.rejected_trips`) → OLTP → star → `VACUUM (FREEZE, ANALYZE)` → DuckDB copy. Rebuilds everything from scratch on every run. | 3,304,881 trips in each config, 8,579 rejected | ~5.5 min |
| `bench` | Builds materialized views, verifies results, 1 warm-up + 10 warm runs and 10 restart (empty buffer pool) runs per query and config, plus a warm-only JIT sensitivity row for B, then captures plans. Configs run round-robin per query, with a 10 s idle pause before each warm (query, config) block. | `results/benchmark.json`, `results/plans/*.txt` | ~7 min |

`load` fails unless A, B and C end up with identical fact checksums (row count, sum of
`trip_total` in cents, sum of `trip_seconds`). `bench` fails, before timing anything, unless
every query returns the same result in every config.

### Results page

`npm run ui` serves `ui/` and `results/` from a minimal local static server (`--port N`, default
8080). The page reads `results/benchmark.json`, so it shows whatever the last `npm run bench`
wrote. It has three parts:

- the three headline ratios: model, engine, and pre-aggregation (marked as bounded by the client
  round trip);
- a log-scale bar chart of warm medians per query and config, with a table view;
- a viewer for the saved plans.

No build step; Chart.js loads from a CDN. The page can't be opened from `file://`, because
browsers block `fetch` there.

### Options

| Command | Flag / env | Default |
|---|---|---|
| `ingest:extract`, `load` | `--start YYYY-MM` / `INGEST_START_MONTH` | `2025-01` |
| `ingest:extract`, `load` | `--end YYYY-MM` / `INGEST_END_MONTH` | `2025-06` |
| `ingest:extract` | `--concurrency N`, `--page-size N` | 3, 50000 |
| `load` | `--duckdb-fallback` (load C via Parquet instead of `ATTACH`), `--skip-duckdb` | off |
| `ui` | `--port N` | 8080 |
| `bench` | `--runs N`, `--warmup N`, `--restart-runs N`, `--skip-restart`, `--cooldown-ms N`, `--quarter YYYY-QN` | 10, 1, 10, off, 10000, `2025-Q2` |

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
src/ui/        static server for the results page (npm run ui)
ui/            results page: index.html + data.js (loader for results/benchmark.json)
tests/         unit and integration (Testcontainers) tests
results/       benchmark.json and plans/ from the last run
CLAUDE.md      project context for Claude Code (loaded automatically at session start)
docs/BENCHMARK.md  measurement method, noise, caveats, per-query plans, data notes
docs/ai-log.md log of AI-generated work that was corrected, and how it was caught
docs/reviews/  raw output of each benchmark-reviewer run
.claude/agents/benchmark-reviewer.md  read-only reviewer subagent for benchmark fairness
```
