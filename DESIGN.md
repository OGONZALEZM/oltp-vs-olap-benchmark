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
- **Warm:** immediately before each Postgres config's warm runs, `pg_prewarm` loads that config's
  tables and secondary indexes into `shared_buffers`, one relation at a time (A: 15 relations,
  592 MB; B: 18 relations, 548 MB; primary-key indexes excluded: 280 MB each, unused by the four
  queries and too large to fit alongside). Then 1 untimed warm-up and 10 timed runs on the same
  connection; min, median and nearest-rank p95 (with 10 samples, p95 is the slowest run).
  *Why pre-warm:* both fact tables are larger than `shared_buffers / 4`, so Postgres scans them
  through a small ring buffer and never keeps them cached; without pre-warming, "warm" Postgres
  would really be served from the VM's OS page cache. Pre-warming is the **best case for
  Postgres's buffer cache; native vs VM is not controlled, and JIT is bounded by a sensitivity
  row** (see below), so it does not make the engine gap conservative. Every saved Postgres plan
  shows only `shared hit` buffers, no `read`.
- **Ordering and cool-down:** the benchmark runs query by query. Within a query, configs run in
  round-robin order, rotated by one config per query (recorded as `order` in
  `results/benchmark.json`), so no config always runs last. Each (query, config) is one block,
  pre-warmed immediately before it. Runs of different configs are not interleaved, because A and
  B do not fit in `shared_buffers` together and interleaving would evict the pre-warmed tables.
  A 2 s idle pause (`--cooldown-ms`) precedes every timed run, warm and restart.
  *Why (thermal note):* the host is a fanless MacBook Air. In the run before this change, configs
  ran one after another with back-to-back timed runs, and Postgres warm medians came out *higher*
  than restart medians in 6 of 8 A/B cells: the restart runs, which had idle time between them,
  were tight, while the warm samples drifted (q2 B warm 340–558 ms, restart 345–379 ms). Sustained
  load appears to throttle the machine, so without pauses the timings depend on the order of the
  runs more than on the cache.
- **Restart (empty buffer pool):** before every timed restart run the Postgres container is
  restarted (emptying `shared_buffers` and backend caches) and a new connection opened; DuckDB
  gets a fresh read-only instance (empty buffer pool). **This is not a cold cache:** Docker runs inside the OrbStack
  VM, whose OS page cache survives container restarts, so table files are likely still in VM
  memory. Likewise DuckDB runs on the macOS host and `data/olap.duckdb` stays in the host page
  cache. Restart numbers therefore measure an empty database buffer pool, not disk reads. Clearing
  the VM page cache would require restarting the VM or dropping caches as root inside it, which
  was out of scope.
- **Timing scope:** wall clock around a single query call after the connection is open (send,
  execute, receive a small result and turn it into JS row objects; the same scope for both
  engines). Both include parse and plan time. Postgres timings include a
  loopback round trip into the VM; DuckDB runs in-process. The floor is measured with `SELECT 1`
  timed the same way (median 0.23 ms Postgres, 0.16 ms DuckDB) and recorded in
  `results/benchmark.json`. B-MV warm medians (0.2–0.5 ms) sit at that floor, so **B→B-MV ratios are
  bounded by client round trip** and say "pre-aggregation removes essentially all query work",
  not a precise factor.
- **B→C is engine plus platform.** Postgres runs inside the OrbStack Linux VM (8 vCPU, 7.8 GiB);
  DuckDB runs natively on the macOS host (Apple M3, 4 performance + 4 efficiency cores). The
  B→C ratio therefore also contains VM-vs-native execution and scheduling differences. VM
  overhead slows Postgres, so it can only make the measured gap larger than the pure engine gap,
  by an amount this setup does not measure. B→C is not a pure engine number.
- **JIT sensitivity (B-jit).** `jit=off` is pinned for A and B (JIT compile time is noisy on short
  aggregates). To bound what that choice costs Postgres, B is also timed warm with
  `SET jit = on, jit_above_cost = 0`, verified like the other configs and reported in its own
  `sensitivity` section, never in the A/B/C ratios. JIT has to be forced: B's plan costs
  (83k–89k) are below the default `jit_above_cost` of 100,000, so `jit=on` at default thresholds
  would not engage JIT on B at all. Inlining and optimization keep their default thresholds.
  `jitUsed` records whether each captured plan actually contained a JIT section. The row covers
  B only: at default thresholds JIT *would* engage on A for q1 and q4 (plan costs about 109k and
  106k, above 100,000). A→B is compared at equal settings (`jit=off` for both), so what JIT would
  do for A is not measured.
- **Plans** (`results/plans/`): `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF)` and DuckDB
  `EXPLAIN ANALYZE`, captured in a separate untimed pass in the warm state (pre-warmed, then one
  untimed execution). **Plans document shape, row counts and buffers only; their times are not
  results.** With per-node timing on, instrumentation inside the VM inflated Postgres execution
  times 1.2–2.5x, unevenly across plans (an earlier capture made B look 1.8x faster than A on q2
  while measurements showed A 13% faster), hence `TIMING OFF`.
- **Physical order:** `oltp.trips`, `star.fact_trips` and the DuckDB fact table are all loaded in
  (start timestamp, trip_id) order, so no config gets a clustering advantage.

## Results and why

Each cell is **warm median (restart median / warm min)** in ms, 10 runs each, after verification.
Ratios are of warm medians, with the ratio of restart medians in parentheses. Postgres warm runs
are pre-warmed; restart runs start from an empty buffer pool. p95 and every sample are in
`results/benchmark.json`.

| Query | A 3NF | B star | B-MV | C 3 threads | C 8 threads | A→B | B→C (3t) | B→C (8t) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| q1 Trips, revenue and average fare per month | 584.5 (633.0 / 567.4) | 403.5 (364.9 / 357.7) | 0.2 (1.2 / 0.2) | 18.9 (20.2 / 17.4) | 7.9 (10.9 / 7.8) | 1.4x (1.7x) | 21x (18x) | 51x (33x) |
| q2 Top 10 pickup areas by revenue (known areas) | 393.6 (347.2 / 335.8) | 437.5 (350.1 / 340.3) | 0.2 (1.4 / 0.2) | 35.9 (37.4 / 35.6) | 22.0 (20.3 / 18.2) | 0.9x (1.0x) | 12x (9.4x) | 20x (17x) |
| q3 Average tip by payment type and company, one quarter | 340.7 (357.9 / 301.5) | 363.1 (361.8 / 352.8) | 0.5 (1.9 / 0.4) | 18.8 (20.3 / 18.4) | 16.8 (12.3 / 13.1) | 0.9x (1.0x) | 19x (18x) | 22x (29x) |
| q4 Day-of-week x hour: trips and average duration | 586.8 (478.7 / 477.3) | 365.0 (347.1 / 331.2) | 0.5 (1.7 / 0.4) | 16.4 (18.8 / 16.2) | 9.7 (11.6 / 9.4) | 1.6x (1.4x) | 22x (18x) | 38x (30x) |

Spread of the warm runs, min / median / p95 in ms (10 runs; p95 is the slowest run).
Warm medians sit up to 23% (A), 29% (B), 9% (C-3t) and 28% (C-8t)
above their minimums; the largest p95/median ratio is 2.0x.

| Query | A 3NF | B star | C 3 threads | C 8 threads |
|---|---:|---:|---:|---:|
| q1 | 567.4 / 584.5 / 747.2 | 357.7 / 403.5 / 818.1 | 17.4 / 18.9 / 23.9 | 7.8 / 7.9 / 8.5 |
| q2 | 335.8 / 393.6 / 535.8 | 340.3 / 437.5 / 558.4 | 35.6 / 35.9 / 39.2 | 18.2 / 22.0 / 27.8 |
| q3 | 301.5 / 340.7 / 470.2 | 352.8 / 363.1 / 505.4 | 18.4 / 18.8 / 20.0 | 13.1 / 16.8 / 19.3 |
| q4 | 477.3 / 586.8 / 876.3 | 331.2 / 365.0 / 562.2 | 16.2 / 16.4 / 16.6 | 9.4 / 9.7 / 10.8 |

### The model alone barely helps in Postgres (A→B 0.9–1.6x warm, 1.0–1.7x restart)

Both A and B scan the full 3.3M-row table in a row store; a star schema does not change how many
bytes Postgres reads per row. What changes is per-row work, and it cuts both ways:

- **q1, q4: B wins (1.4x and 1.6x warm, 1.7x and 1.4x restart).**
  A computes `EXTRACT(year/month/isodow/hour ...)` from the timestamp on every row
  (`Group Key: ((EXTRACT(year FROM trip_start_timestamp))::integer), ...`);
  B joins small precomputed dimensions and groups by their columns (`Group Key: d.year, d.month`).
- **q2: roughly even (0.9x warm, 1.0x restart).**
  Both now group by a primary key (`Group Key: ca.community_area_id` in A,
  `Group Key: a.area_key` in B). The first version of B grouped by
  `a.community_area_id, a.area_name`, hashing a text column on every row, because
  `community_area_id` is only `UNIQUE` in `dim_area`, not its primary key. It now groups by
  `area_key` (dim_area's PK) and Postgres drops the dependent columns from the group key, the same
  functional-dependency rule A benefits from. DuckDB has no functional-dependency grouping, so
  the shared SQL still lists the dependent columns; DuckDB groups by all three.
- **q3: roughly even (0.9x warm, 1.0x restart), despite different plans.**
  A range-scans its timestamp index for the quarter
  (`Parallel Index Scan using trips_start_ts_idx ... actual rows=623752 loops=3`). B cannot use
  the quarter filter on the fact table: the predicate is on `dim_date`
  (`Filter: ((year = 2025) AND (quarter = 2))`), and Postgres does not push a dimension filter
  into the fact scan, so it reads the whole fact table (`Parallel Seq Scan on fact_trips ...
  actual rows=1101627 loops=3`, i.e. all 3.3M rows) and discards the 43% outside the quarter
  in the hash join.
  **Standard mitigation (not applied):** add an explicit range predicate on the fact's own key,
  `AND f.date_key BETWEEN 20250401 AND 20250630`, which lets Postgres use `fact_date_idx`. It is
  not applied because it changes the query's shape between configs (the question is stated on the
  date dimension), and because DuckDB derives it on its own: its plan shows a dynamic filter
  pushed into the fact scan (`Dynamic Filters: optional: date_key>=20250401 AND optional:
  date_key<=20250630`).
  A touches fewer buffers (37,424 vs 53,194 shared hits), but the difference does not show up
  as a robust time difference between the two configs.

### The engine is where the gap is (B→C 12–22x warm, 9.4–18x restart, at equal thread budget)

Same star schema, same SQL text, same rows, same physical order, and DuckDB limited to Postgres's
per-query budget of 3 threads: DuckDB is 12–22x faster on warm medians and 9.4–18x on restart
medians; 20–51x and 17–33x with its default 8 threads. A
columnar engine reads only the columns a query touches (a handful of 2–8 byte columns instead of
~130-byte rows), runs vectorized aggregation over them, and pushes join filters into scans.
Postgres was pre-warmed, which is the best case for Postgres's buffer cache; native vs VM is not
controlled, and JIT is bounded by a sensitivity row (next section). VM overhead makes the
measured gap larger than the pure engine gap by an unmeasured amount: the number is engine plus
platform, not a conservative lower bound.

### JIT does not explain the gap (B-jit 0.9–1.2x of B)

B timed warm with JIT forced on (`jit = on, jit_above_cost = 0`); every captured plan contains a
JIT section. Warm medians in ms (min / p95 for B-jit):

| Query | B (jit=off) | B-jit | B-jit min / p95 | B→B-jit | JIT in plan |
|---|---:|---:|---:|---:|---|
| q1 | 403.5 | 419.9 | 405.0 / 493.6 | 1.0x | yes |
| q2 | 437.5 | 365.0 | 355.8 / 452.4 | 1.2x | yes |
| q3 | 363.1 | 405.5 | 379.3 / 493.1 | 0.9x | yes |
| q4 | 365.0 | 408.2 | 378.5 / 446.8 | 0.9x | yes |

B-jit runs at 0.9–1.2x of B's warm median (above 1x means faster with JIT); B's own warm
medians sit up to 29% above their minimums. At default thresholds JIT would not engage on B at all. The row bounds JIT for
B only; A is not covered (see the method section).

### Pre-aggregation removes the work entirely (B-MV)

The materialized views hold the answers at the questions' grain (built in ~2.3 s), so each query
reads a few hundred rows at most and its time is the client round trip (B-MV warm medians 0.2–0.5 ms
vs a 0.23 ms `SELECT 1` floor). This is a different trade-off (freshness and maintenance for
speed) and is reported as its own row, never as the same work as querying the fact table.

## What I left out and why

The deadline was one day; each item below would make the numbers more robust or the project more
complete, but none changes the direction of the result.

- **DuckDB inside the same VM.** B→C compares Postgres in the OrbStack VM with DuckDB native on
  the host. Running the DuckDB CLI in a container over the same file would separate engine from
  platform. Left out: one more runtime to set up and verify.
- **More runs.** 10 timed runs per query make p95 the slowest run. More runs (e.g. 50) and an
  interquartile range would give a real tail estimate. min is reported alongside median and p95
  as a cheap check on noise.
- **A second, larger volume.** The window is configurable (`--start` / `--end`), but only the
  default Jan–Jun 2025 window (3.3M trips) was benchmarked. A run at, say, all of 2024–2025 would
  show how each config scales, and whether the 1 GB `shared_buffers` best case still holds.
- **ClickHouse.** A second columnar engine (server, not embedded) would show whether the B→C gap
  is about columnar storage in general or DuckDB in particular. Out of scope by the brief.
- **An orchestrator** (Airflow, Dagster). The pipeline is three idempotent npm scripts; a
  scheduler adds nothing to a one-shot benchmark.
- **Cloud deployment.** Everything runs locally for reproducibility on one machine; a cloud run
  would add network and noisy-neighbour variance.
- **The UI** (`ui/`, a static page reading `results/benchmark.json`). Not built; the console
  summary, README tables and `results/benchmark.json` carry the results.
