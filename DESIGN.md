# Design

The same four analytical questions over 3.3M real Chicago taxi trips, in three configurations:
Postgres 3NF (A), Postgres star schema (B) and DuckDB star schema (C). A→B isolates the effect of
the **model**, B→C the effect of the **engine**. Measurement method, noise, caveats and per-query
plans: [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Data source and API

- **Why this dataset.** Chicago Data Portal, Taxi Trips (2024-), `ajtu-isnz`: real transactions
  with time, geography, companies and payments, so the fact table and its skew are real. PokéAPI
  was ruled out: a catalog with no time dimension or transactions, where the fact table would have
  been synthetic.
- **How it is read.** Socrata SODA API with keyset pagination on `trip_id` (50k rows per page),
  which unlike `$offset` is stable and resumable. Pages land as gzipped NDJSON with per-month
  manifests; a month is complete when its rows equal the API's `count(*)`.
- **Window:** Jan–Jun 2025, 3,313,460 raw trips, configurable with `--start` / `--end`.
- **Checked against the live API, not assumed:** `trip_id` is unique; amounts are never
  negative; revenue is `trip_total` (it differs from the sum of its parts in 38% of rows, so it is
  never recomputed).

## Modeling decisions

- **Clean once, upstream of all configs.** Rejects go to `staging.rejected_trips` with a reason:
  null amounts, end before start, `trip_total` above 1,000, trips over 6 h. That is 8,579 rows
  (0.26%). Zero miles and zero seconds are kept. Company variants are merged by a canonical key.
- **A, 3NF.** `trips` with FKs to `companies`, `taxis`, `payment_types` and `community_areas`.
  - Company is an attribute of the trip, because 17% of taxis serve more than one company.
  - The `"NA"` taxi sentinel becomes NULL.
  - Tracts and centroids are not ingested: they depend on the community area, so storing them on
    `trips` would break 3NF, and no query needs them.
  - Indexes on every FK and on `trip_start_timestamp`. A properly indexed OLTP side, not a straw
    man; q3 uses the timestamp index.
- **B, star.** One fact row per trip. Dimensions:
  - `dim_date` and `dim_time` (hour and 15-minute slot);
  - `dim_company` and `dim_payment`;
  - `dim_area`, role-playing for pickup and dropoff;
  - `dim_taxi`.

  Missing areas and taxis map to an `Unknown` member (key 0). The fact table has btree indexes on
  its FKs except `time_key` (6 indexes, matching A's 6; no query needs `time_key`). B is built from A's tables, so both hold the same cleaned rows.
- **B-MV.** Materialized views at each question's grain, reported as their own row with their
  build time. Pre-aggregation is never presented as the same work as querying the fact table.
- **C, DuckDB.** The same star tables, copied from Postgres with `ATTACH` (Parquet as the
  fallback), and queried with the same SQL files as B. `load` fails unless A, B and C have
  identical fact checksums.
- **Fair comparison.** Settings are pinned and identical for A and B, all three fact tables have
  the same row order, DuckDB's primary row uses Postgres's 3-thread budget, and every result must
  match across configs before anything is timed.

## Results

Each cell is the **warm median (restart median / warm min)** in ms, 10 runs each. Postgres is
pre-warmed into its buffer cache; restart runs start with an empty buffer pool. Ratios use warm
medians, with restart medians in parentheses.

| Query | A 3NF | B star | B-MV | C 3 threads | C 8 threads | A→B | B→C (3t) |
|---|---:|---:|---:|---:|---:|---:|---:|
| q1 Monthly trips, revenue, avg fare | 596.0 (599.5 / 588.9) | 361.7 (360.4 / 354.4) | 1.0 (1.3 / 0.8) | 17.9 (20.0 / 16.9) | 8.2 (9.8 / 7.8) | 1.6x (1.7x) | 20x (18x) |
| q2 Top 10 pickup areas by revenue | 340.0 (358.3 / 337.5) | 342.8 (350.3 / 334.6) | 1.0 (1.4 / 0.9) | 35.6 (37.3 / 35.3) | 18.3 (20.0 / 17.3) | 1.0x (1.0x) | 9.6x (9.4x) |
| q3 Avg tip by payment and company, Q2 | 307.1 (352.3 / 305.0) | 352.4 (367.2 / 349.8) | 1.2 (1.7 / 0.9) | 19.4 (20.9 / 19.2) | 10.6 (13.5 / 10.4) | 0.9x (1.0x) | 18x (18x) |
| q4 Day-of-week × hour matrix | 480.0 (482.3 / 467.6) | 345.9 (343.3 / 333.2) | 1.1 (1.5 / 0.9) | 16.4 (18.7 / 16.3) | 8.0 (9.9 / 7.9) | 1.4x (1.4x) | 21x (18x) |

**Three effects, three sizes:**

1. **The model barely matters in a row store (A→B 0.9–1.6x).**
   - Both configs read every row, except A on q3, which range-scans its timestamp index.
   - The star wins only where it replaces per-row `EXTRACT` with precomputed dimensions (q1, q4).
   - q2 and q3 are roughly even. On q3 the plans differ (A range-scans its timestamp index; B scans
     the whole fact table because Postgres does not push the `dim_date` filter into it), but the
     times stay close.
2. **The engine is where the gap is (B→C 9.6–21x warm, 9.4–18x restart; 19–44x with 8 threads).**
   - Same schema, SQL, rows and thread budget.
   - DuckDB reads only the needed columns, aggregates vectorized and pushes join filters into scans.
   - Caveat: Postgres runs in the OrbStack VM and DuckDB natively, so B→C is engine plus platform.
     Pre-warming guarantees buffer hits but showed little or no measurable benefit, because the VM
     page cache already served the data (details in docs/BENCHMARK.md). Native vs VM is not
     controlled; JIT is bounded by a sensitivity row (forcing JIT made B 0.9x, i.e. slower).
3. **Pre-aggregation removes the work (B-MV about 1 ms, near the client round-trip floor).** It
   trades freshness and maintenance (a 1.9 s rebuild) for speed. It is a different design, not a
   faster query.

## What I left out and why

The deadline was one day; none of these would change the direction of the result.

- **DuckDB inside the same VM**, to separate engine from platform: one more runtime to set up and
  verify.
- **More runs** (e.g. 50, with an interquartile range): with 10, p95 is just the slowest run.
- **A second, larger volume:** the window is configurable, but only H1 2025 was measured.
- **ClickHouse:** out of scope by the brief. It would show whether the gap is columnar storage in
  general or DuckDB in particular.
- **An orchestrator** (Airflow, Dagster): three idempotent npm scripts are enough for a one-shot
  benchmark.
- **Cloud deployment:** local runs keep it reproducible on one machine.

## What I would change with 10x the data

About 33M trips: roughly 4–5 GB per fact table in Postgres, and about 1.3 GB in DuckDB at today's
compression.

- **Postgres no longer fits in its buffer cache.** The fact table would be several times
  `shared_buffers`, so warm runs become I/O-bound. I would partition `fact_trips` by month (range
  partitions, BRIN on `date_key`). Pruning needs a predicate on the fact's own `date_key`: q3 as
  written filters `dim_date`, which Postgres does not push into the fact scan, so it would also
  need the explicit `f.date_key BETWEEN ...` range described in docs/BENCHMARK.md.
- **Pre-aggregation becomes the default serving path.** Refresh by appending only new months'
  aggregates, instead of rebuilding the materialized views.
- **Extract and load in Parquet.** Write pages as Parquet, load DuckDB straight from them, and
  `COPY` into Postgres in parallel per month. Drop the staging copy after cleaning.
- **Measure on a dedicated Linux host** with both engines on the same OS, removing the thermal
  and VM caveats instead of documenting them.
- **Add a server-side columnar engine** (ClickHouse, or DuckDB over Parquet in object storage) and
  compare it on the same star.
