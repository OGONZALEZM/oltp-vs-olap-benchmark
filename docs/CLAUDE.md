# Project: OLTP vs OLAP — benchmark on real Chicago taxi data

Technical assessment for spexs.ai. Demonstrate, with measurable and reproducible numbers, the
performance difference between a normalized OLTP model and an analytical (OLAP) model.

**Hard constraint: delivered TODAY.** When in doubt about scope, pick the simplest option that is
correct and record what was dropped in `DESIGN.md` → "What I left out and why".

## Stack

- Node.js 20+ with TypeScript (ESM, `tsx` to run scripts, `strict: true`).
- PostgreSQL 16 in Docker (`docker-compose.yml`).
- Embedded DuckDB via `@duckdb/node-api` (local file `data/olap.duckdb`).
- Tests: Vitest + Testcontainers (real Postgres, no database mocks).
- No ORMs: explicit SQL in `.sql` files. The SQL is the product.

## Data source

Chicago Data Portal — **Taxi Trips (2024-)**, dataset `ajtu-isnz`, Socrata (SODA) API.

- Endpoint: `https://data.cityofchicago.org/resource/ajtu-isnz.json`
- Paginate with `$limit`, `$offset` and `$order=trip_id`; filter by month with `$where`.
- Column dictionary: `https://data.cityofchicago.org/api/views/ajtu-isnz/columns.json`.
  **Verify real column names and types against this dictionary before writing any schema.**
  Do not assume names from memory.
- Optional app token in `SOCRATA_APP_TOKEN` (`.env`) to avoid throttling.
- Known data quality: Taxi ID is anonymized but consistent, census tracts are suppressed in some
  cases, timestamps are rounded to 15 minutes. Expect nulls, zero or negative miles/fares, and
  duplicates. Every cleaning rule is documented in `DESIGN.md`.
- Target volume: 2–5 million trips. If API ingestion is too slow, documented plan B: replicate
  real months with shifted dates, clearly flagged as such.

## The three benchmark configurations

| Config | Engine | Model |
|---|---|---|
| A | Postgres | Normalized OLTP (3NF) |
| B | Postgres | Star schema (+ materialized views, reported separately) |
| C | DuckDB | Star schema (columnar) |

A→B isolates the effect of the **model**. B→C isolates the effect of the **engine**. This
separation is the core argument of the project; do not blur it.

- **A (OLTP):** `trips` with FKs to `companies`, `taxis`, `payment_types`, `community_areas`.
  Reasonable indexes (FKs, `trip_start_timestamp`). The OLTP side must be done properly:
  benchmarking against an unindexed OLTP is a straw man.
- **B (star):** `fact_trips` with surrogate keys to `dim_date`, `dim_time` (hour and 15-min slot),
  `dim_company`, `dim_payment`, `dim_area` (role-playing: pickup and dropoff), `dim_taxi`.
  Materialized views are pre-aggregation: they are measured as a separate row and never presented
  as the same work as the query on the fact table.
- **C:** the same star schema loaded into DuckDB.

## Analytical queries (same questions across all three configs)

1. Trips, total revenue and average fare per month.
2. Top 10 pickup community areas by revenue, with their average ticket.
3. Average tip by payment type and company, filtered to one quarter.
4. Day-of-week × hour matrix: trip volume and average duration.

## Benchmark rules

- One reproducible command: `npm run bench`.
- N runs per query (default 10) after a warm-up; report median and p95.
- Distinguish cold and warm cache where possible, and document how it was measured.
- Save Postgres `EXPLAIN (ANALYZE, BUFFERS)` and DuckDB `EXPLAIN ANALYZE` for every query.
- **Result verification is mandatory:** before timing, check that all three configs return the
  same results for each query (explicit decimal tolerance). If they don't match, the benchmark
  fails. A fast benchmark with different results is worthless.
- Output: `results/benchmark.json` + `results/plans/*.txt` + console summary.
  Include metadata: row counts, engine versions, CPU/RAM, date.

## Expected structure

```
sql/oltp/  sql/star/  sql/duckdb/  sql/queries/
src/ingest/  src/transform/  src/bench/
tests/integration/
ui/            (static HTML that reads results/benchmark.json)
docs/ai-log.md
README.md  DESIGN.md  AI_WORKFLOW.md
```

## Way of working

- Move in small steps. Propose the plan for each step before writing code.
- **One commit per logical step**, Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`,
  `chore:`). Never one giant commit. Do not commit without Oscar's approval.
- Run what you write. Never declare something done without having executed it and seen the output.
- When Oscar corrects something the AI generated, or a check catches an error, add an entry to
  `docs/ai-log.md` (what was generated, what was wrong, how it was caught, how it was fixed).
  That log is the raw material for `AI_WORKFLOW.md`.
- Before closing out the benchmark, invoke the `benchmark-reviewer` subagent.
- All documentation, code comments and commit messages in English.

## Out of scope

ClickHouse, orchestrators (Airflow/Dagster), complex dashboards, cloud deployment.
Mentioned in `DESIGN.md` → "What I would change with 10x the data".
