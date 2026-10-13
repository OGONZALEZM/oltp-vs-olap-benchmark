# Benchmark details

Measurement method, noise and caveats behind the results in [DESIGN.md](../DESIGN.md). Every
number here comes from `results/benchmark.json` (final run, commit `8908555`); plans are in
`results/plans/`. How the method evolved, and why, is in [ai-log.md](ai-log.md) and the raw
reviews in [reviews/](reviews/).

## Method

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
  A 10 s idle pause (`--cooldown-ms`) precedes each warm block; then the untimed warm-up run
  (which also wakes the CPU) and 10 back-to-back timed runs. Restart runs get no extra pause: the
  restart itself is idle time.
  *Why (thermal note):* the host is a fanless MacBook Air. With configs run one after another and
  no pauses, Postgres warm medians came out *higher* than restart medians in 6 of 8 A/B cells:
  the restart runs, which had idle time between them, were tight, while the warm samples drifted
  (q2 B warm 340–558 ms, restart 345–379 ms). Sustained load appears to throttle the machine.
  A 2 s pause before *every* timed run fixed that but added the CPU's wake-up cost to each sample:
  the same query timed back to back vs after a 2 s pause took 18.0 vs 25.4 ms in DuckDB and
  0.5 vs 2.4 ms on B-MV, a fixed 2–7 ms that matters only for short queries. Pausing per block
  keeps the cool-down without that cost (check: DuckDB q1 17.7–18.4 ms, Postgres B q1 median
  1–4% above its minimum).
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
  timed the same way (median 0.20 ms Postgres, 0.18 ms DuckDB) and recorded in
  `results/benchmark.json`. B-MV warm medians (1.0–1.2 ms) are within about 1 ms of that
  floor, so **B→B-MV ratios are bounded by client round trip and noise** and say
  "pre-aggregation removes essentially all query work", not a precise factor.
  *Residual noise, documented and not tuned:* B-MV warm medians were 0.2–0.5 ms in the run with
  no pauses and 1.0–1.2 ms in the final run, with medians up to 27% above their minimums. The
  floor itself is measured back to back before the warm blocks, without a pause. A likely
  explanation is that sub-millisecond queries never keep the CPU busy, so the warm-up after the
  10 s pause does not keep it at full clock, but this was not isolated. It moves B-MV by under
  1 ms and does not affect A, B or C.
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

## Spread and noise

Spread of the warm runs, min / median / p95 in ms (10 runs; p95 is the slowest run).
Warm medians sit up to 3% (A), 4% (B), 6% (C-3t) and 5% (C-8t)
above their minimums; the largest p95/median ratio is 1.3x.

| Query | A 3NF | B star | C 3 threads | C 8 threads |
|---|---:|---:|---:|---:|
| q1 | 588.9 / 596.0 / 618.3 | 354.4 / 361.7 / 412.2 | 16.9 / 17.9 / 19.7 | 7.8 / 8.2 / 10.2 |
| q2 | 337.5 / 340.0 / 392.1 | 334.6 / 342.8 / 401.3 | 35.3 / 35.6 / 36.2 | 17.3 / 18.3 / 23.0 |
| q3 | 305.0 / 307.1 / 341.3 | 349.8 / 352.4 / 397.0 | 19.2 / 19.4 / 19.9 | 10.4 / 10.6 / 11.0 |
| q4 | 467.6 / 480.0 / 548.9 | 333.2 / 345.9 / 387.2 | 16.3 / 16.4 / 16.9 | 7.9 / 8.0 / 9.4 |

Every sample is in `results/benchmark.json`. The *Ordering and cool-down* and *Timing scope*
entries above describe the thermal and wake-up findings and the residual B-MV noise.

## JIT sensitivity: JIT does not explain the gap (B-jit 0.9x of B)

B timed warm with JIT forced on (`jit = on, jit_above_cost = 0`); every captured plan contains a
JIT section. Warm medians in ms (min / p95 for B-jit):

| Query | B (jit=off) | B-jit | B-jit min / p95 | B→B-jit | JIT in plan |
|---|---:|---:|---:|---:|---|
| q1 | 361.7 | 420.5 | 399.8 / 447.9 | 0.9x | yes |
| q2 | 342.8 | 378.0 | 360.0 / 415.2 | 0.9x | yes |
| q3 | 352.4 | 381.0 | 376.0 / 436.9 | 0.9x | yes |
| q4 | 345.9 | 387.9 | 375.9 / 429.6 | 0.9x | yes |

B-jit runs at 0.9x of B's warm median (above 1x means faster with JIT); B's own warm
medians sit up to 4% above their minimums. At default thresholds JIT would not engage on B at all. The row bounds JIT for
B only; A is not covered (see *JIT sensitivity* under Method).

## Per-query plans: why A→B is small (0.9–1.6x warm, 1.0–1.7x restart)

Both A and B scan the full 3.3M-row table in a row store; a star schema does not change how many
bytes Postgres reads per row. What changes is per-row work, and it cuts both ways:

- **q1, q4: B wins (1.6x and 1.4x warm, 1.7x and 1.4x restart).**
  A computes `EXTRACT(year/month/isodow/hour ...)` from the timestamp on every row
  (`Group Key: ((EXTRACT(year FROM trip_start_timestamp))::integer), ...`);
  B joins small precomputed dimensions and groups by their columns (`Group Key: d.year, d.month`).
- **q2: roughly even (1.0x warm, 1.0x restart).**
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
  A touches fewer buffers (37,423 vs 53,194 shared hits), but the difference does not show up
  as a robust time difference between the two configs.

## Data notes and cleaning

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
