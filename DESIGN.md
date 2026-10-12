# Design

## Data

Source: Chicago Data Portal, Taxi Trips (2024-), dataset `ajtu-isnz`, Socrata API. Default
window Jan–Jun 2025 (3,313,460 raw trips), configurable with `--start` / `--end`.

### Data notes

- **Taxi count: 3,075 in API profiling vs 3,074 in `oltp.taxis`.** The API's
  `count(distinct taxi_id)` counts the literal sentinel `"NA"` as a taxi. H1 2025 has exactly one
  `"NA"` row, so there are 3,074 real taxi hashes. Cleaning maps `"NA"` to an unknown taxi (NULL
  in A, the `Unknown` member `taxi_key = 0` in B/C), so `dim_taxi` has 3,075 rows (3,074 + Unknown).
  No taxi was lost to rejected rows: every hash seen in `staging.rejected_trips` also appears in a
  clean trip. Checked with:
  ```sql
  SELECT count(DISTINCT taxi_id),                                   -- 3075
         count(DISTINCT taxi_id) FILTER (WHERE taxi_id <> 'NA'),    -- 3074
         count(*) FILTER (WHERE taxi_id = 'NA')                     -- 1
  FROM staging.raw_trips;
  ```
- `trip_id` is unique across the whole dataset; there are no duplicate keys to remove.
- Revenue is `trip_total`. It is not the sum of fare + tips + tolls + extras (38% of rows differ by
  an unpublished surcharge) and is never recomputed.
- Census tracts (~55% suppressed) and centroids are not ingested: they are functionally
  determined by the community area and no query needs them.
- Community area names come from the committed seed `sql/seed/community_areas.csv`
  (Boundaries – Community Areas, `igwz-8jzy`).

### Cleaning rules

Applied once in `sql/staging/clean.sql`, so all three configs see the same rows. A row failing
several rules is recorded under the first one, in this order.

| Rule | Rejected (H1 2025) |
|---|---:|
| `null_amounts`: any of fare, tips, tolls, extras, trip_total missing | 6,249 |
| `end_before_start`: end timestamp before start | 3 |
| `trip_total_over_1000` | 383 |
| `trip_seconds_over_6h` (> 21,600 s) | 1,944 |
| **Total** | **8,579** (0.26%) |

Kept on purpose: zero miles and zero seconds (common, not clearly wrong). Company spelling
variants are merged by a canonical key (lowercase, no `.`/`,`, collapsed whitespace, no trailing
`llc`/`inc`); in H1 2025 this merges 3 companies spelled 2 ways each.

## Benchmark method

`npm run bench` runs five rows over the same four questions:

| Row | Engine | Model | Notes |
|---|---|---|---|
| A | Postgres 16 | OLTP 3NF (`oltp`) | FK + start-timestamp indexes |
| B | Postgres 16 | Star (`star.fact_trips`) | btree on fact FKs (parity with A) |
| B-MV | Postgres 16 | Materialized views over the star | pre-aggregation; build time reported separately |
| C threads=3 | DuckDB | Star (same SQL files as B) | **primary C row**: matches Postgres's per-query budget (leader + 2 parallel workers) |
| C threads=8 | DuckDB | Star | DuckDB default, reported as a separate row |

A→B isolates the model (same engine), B→C the engine (same model, same SQL text), B→B-MV the
effect of pre-aggregation. Postgres settings are pinned in `docker-compose.yml`
(`work_mem=64MB`, `max_parallel_workers_per_gather=2`, `jit=off`, `shared_buffers=1GB`) and
recorded in `results/benchmark.json`, together with versions, row counts, the host chip and RAM
(`sysctl`) and the Docker VM's CPUs and memory.

- **Verification first.** Each query runs once in every config and its result is compared with
  config A (numbers within absolute tolerance 1e-6, text exactly; q3 is compared after sorting by
  its text key because the engines collate text differently). Any mismatch aborts the run before
  timing.
- **Warm:** 1 untimed warm-up, then 10 timed runs on the same connection; median and nearest-rank
  p95 (with 10 samples, p95 is the slowest run).
- **Restart cold:** before every timed cold run the Postgres container is restarted (emptying
  `shared_buffers` and backend caches) and a new connection opened; DuckDB gets a fresh read-only
  instance (empty buffer pool). **This is not a true cold cache:** Docker runs inside the OrbStack
  VM, whose OS page cache survives container restarts, so table files are likely still in VM
  memory. Likewise DuckDB runs on the macOS host and `data/olap.duckdb` stays in the host page
  cache. Cold numbers therefore measure an empty database buffer cache, not disk reads. Clearing
  the VM page cache would require restarting the VM or dropping caches as root inside it, which
  was out of scope.
- **Timing scope:** wall clock around a single query call after the connection is open (send,
  execute, receive a small result). Postgres timings include a loopback round trip into the VM;
  DuckDB runs in-process. Both include parse and plan time.
- **Plans** (`results/plans/`): `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` and DuckDB
  `EXPLAIN ANALYZE`, captured in a separate untimed pass after one untimed execution.
- **Physical order:** `oltp.trips`, `star.fact_trips` and the DuckDB fact table are all loaded in
  (start timestamp, trip_id) order, so no config gets a clustering advantage.
