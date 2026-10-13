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
- Column dictionary: `https://data.cityofchicago.org/api/views/ajtu-isnz/columns.json`.
  **Verify real column names and types against this dictionary before writing any schema.**
  Do not assume names from memory. Its `cachedContents.cardinality` stats are unreliable.
- Optional app token in `SOCRATA_APP_TOKEN` (`.env`) to avoid throttling.
- **Window:** Jan–Jun 2025 by default (3,313,460 raw trips, two full quarters). Configurable via
  `INGEST_START_MONTH` / `INGEST_END_MONTH` (env) or `--start` / `--end` (CLI), `YYYY-MM`,
  inclusive, so the benchmark can be re-run at a larger volume.
- **Pagination:** keyset, not `$offset`: `$where=<month range> AND trip_id > :cursor`,
  `$order=trip_id`, `$limit=50000`, explicit `$select` of the columns we keep. Each page lands as
  `data/raw/YYYY-MM/NNNN.ndjson.gz` (temp file + rename) with a per-month manifest (cursor range,
  row count, sha256). A month is complete when its rows equal the API `count(*)`; re-runs skip
  complete months and resume incomplete ones from the last cursor.
- **Wire format:** null fields are omitted from the JSON object (not `null`); all numbers arrive as
  strings; timestamps have no time zone (Chicago local time) and are rounded to 15 minutes.

### Verified data facts (live API, Oct 2026)

- `trip_id` (40-char hex) is unique across all 18.66M rows: no duplicates by key. Repeated
  (taxi, start, end, total) tuples exist but are plausibly real trips; do not dedupe on content.
- `taxi_id` is a 128-char hash with a literal `"NA"` sentinel (13 rows) → unknown taxi.
  17% of taxis serve more than one company, so company is an attribute of the trip.
- Amounts (`fare`, `tips`, `tolls`, `extras`, `trip_total`) have **no negatives** (min 0); they are
  null together in 0.19% of rows. Zero miles (8.4%) and zero seconds (1.3%) are common.
- **Revenue is `trip_total`.** It is not the sum of fare + tips + tolls + extras (38% of rows
  differ: an unpublished surcharge). Never recompute it.
- Census tracts are suppressed in ~55% of rows. Tract → community area and tract/area → centroid
  are functional dependencies, so tracts and centroids are **not ingested** (no query needs them,
  and they would break 3NF on `trips`).
- Community areas are numbers 1–77 only. Names come from the committed seed
  `sql/seed/community_areas.csv` (fetched once from Boundaries – Community Areas, `igwz-8jzy`,
  fields `area_numbe`, `community`). The pipeline reads the CSV, never the API.
- `company` has 46 raw values with spelling variants of the same entity (LLC/Inc/punctuation/
  spacing). Canonicalize: lowercase, strip punctuation, collapse whitespace, drop a trailing
  `llc`/`inc`.
- Durations come from `trip_seconds`; end − start is rounded to 15 minutes.

### Cleaning rules (approved)

Rejected rows go to `staging.rejected_trips` with a reason; counts are reported. Every rule is
also documented in `DESIGN.md`.

- Reject: null amounts; `trip_end_timestamp < trip_start_timestamp`; `trip_total > 1000`;
  `trip_seconds > 21600` (6 h).
- Keep: zero miles, zero seconds.
- Map `taxi_id = "NA"` to unknown taxi.

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
  as the same work as the query on the fact table. Missing area/taxi map to an `Unknown` member
  (key 0). **Index parity:** btree indexes on the `fact_trips` foreign keys (at minimum
  `date_key`), mirroring A's FK indexes.
- **C:** the same star schema loaded into DuckDB via `ATTACH` of Postgres (`CREATE TABLE AS`), so
  C holds exactly B's rows. Fallback if `ATTACH` fails: export the star tables to Parquet and load
  those.
- The star is built from the OLTP tables, so all three configs see the same cleaned rows.
- `ANALYZE` after every load. `work_mem` and `max_parallel_workers_per_gather` are pinned in
  `docker-compose.yml`, identical for A and B, and recorded in the benchmark metadata.

## Analytical queries (same questions across all three configs)

1. Trips, total revenue and average fare per month.
2. Top 10 pickup community areas by revenue, with their average ticket, **excluding unknown
   areas**. This is the question's semantics, written explicitly in every config, not a patch to
   make results match.
3. Average tip by payment type and company, filtered to one quarter (2025-Q2 for the default
   window).
4. Day-of-week × hour matrix: trip volume and average duration (`trip_seconds`).

Revenue is always `trip_total`.

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
sql/oltp/  sql/star/  sql/duckdb/  sql/queries/  sql/seed/
data/          (git-ignored: raw pages + manifests, olap.duckdb)
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
