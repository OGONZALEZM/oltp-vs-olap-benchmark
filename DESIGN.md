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
  Postgres's buffer cache; native vs VM and JIT are not controlled** (see below), so it does not
  make the engine gap conservative. Every saved Postgres plan shows only `shared hit` buffers,
  no `read`.
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
  timed the same way (median 0.40 ms Postgres, 0.12 ms DuckDB) and recorded in
  `results/benchmark.json`. B-MV medians (0.3–0.6 ms) sit at that floor, so **B→B-MV ratios are
  bounded by client round trip** and say "pre-aggregation removes essentially all query work",
  not a precise factor.
- **B→C is engine plus platform.** Postgres runs inside the OrbStack Linux VM (8 vCPU, 7.8 GiB);
  DuckDB runs natively on the macOS host (Apple M3, 4 performance + 4 efficiency cores). The
  B→C ratio therefore also contains VM-vs-native execution and scheduling differences. VM
  overhead slows Postgres, so it can only make the measured gap larger than the pure engine gap.
  At 10–23x (3 threads) this does not change the conclusion, but it is not a pure engine number.
- **JIT sensitivity (B-jit).** `jit=off` is pinned for A and B (JIT compile time is noisy on short
  aggregates). To bound what that choice costs Postgres, B is also timed warm with
  `SET jit = on, jit_above_cost = 0`, verified like the other configs and reported in its own
  `sensitivity` section, never in the A/B/C ratios. JIT has to be forced: B's plan costs
  (83k–89k) are below the default `jit_above_cost` of 100,000, so `jit=on` at default thresholds
  would not engage JIT on B at all. Inlining and optimization keep their default thresholds.
  `jitUsed` records whether each captured plan actually contained a JIT section.
- **Plans** (`results/plans/`): `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF)` and DuckDB
  `EXPLAIN ANALYZE`, captured in a separate untimed pass in the warm state (pre-warmed, then one
  untimed execution). **Plans document shape, row counts and buffers only; their times are not
  results.** With per-node timing on, instrumentation inside the VM inflated Postgres execution
  times 1.2–2.5x, unevenly across plans (an earlier capture made B look 1.8x faster than A on q2
  while measurements showed A 13% faster), hence `TIMING OFF`.
- **Physical order:** `oltp.trips`, `star.fact_trips` and the DuckDB fact table are all loaded in
  (start timestamp, trip_id) order, so no config gets a clustering advantage.

## Results and why

Warm medians in ms (10 runs, after verification; full data incl. min, p95 and restart runs with
an empty buffer pool in `results/benchmark.json`). Postgres warm runs are pre-warmed (its best case).

| Query | A 3NF | B star | B-MV | C 3 threads | C 8 threads | A→B | B→C (3t) | B→C (8t) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| q1 Trips, revenue and average fare per month | 607.1 | 393.9 | 0.3 | 17.7 | 10.1 | 1.5x | 22.3x | 39.1x |
| q2 Top 10 pickup areas by revenue (known areas) | 345.6 | 375.2 | 0.3 | 37.2 | 18.0 | 0.9x | 10.1x | 20.8x |
| q3 Average tip by payment type and company, one quarter | 308.6 | 358.8 | 0.6 | 18.3 | 10.9 | 0.9x | 19.6x | 32.9x |
| q4 Day-of-week x hour: trips and average duration | 505.4 | 382.7 | 0.5 | 16.4 | 10.4 | 1.3x | 23.4x | 37.0x |

### The model alone barely helps in Postgres (A→B 0.9–1.5x)

Both A and B scan the full 3.3M-row table in a row store; a star schema does not change how many
bytes Postgres reads per row. What changes is per-row work, and it cuts both ways:

- **q1, q4: B wins (1.3–1.5x).** A computes `EXTRACT(year/month/isodow/hour ...)` from the
  timestamp on every row (`Group Key: ((EXTRACT(year FROM trip_start_timestamp))::integer), ...`);
  B joins small precomputed dimensions and groups by their columns (`Group Key: d.year, d.month`).
- **q2: roughly even (0.9x).** Both now group by a primary key (`Group Key: ca.community_area_id`
  in A, `Group Key: a.area_key` in B). The first version of B grouped by
  `a.community_area_id, a.area_name`, hashing a text column on every row, because
  `community_area_id` is only `UNIQUE` in `dim_area`, not its primary key. It now groups by
  `area_key` (dim_area's PK) and Postgres drops the dependent columns from the group key, the same
  functional-dependency rule A benefits from. DuckDB has no functional-dependency grouping, so
  the shared SQL still lists the dependent columns; DuckDB groups by all three.
- **q3: A wins (0.9x).** A range-scans its timestamp index for the quarter
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

### The engine is where the gap is (B→C 10–23x at equal thread budget)

Same star schema, same SQL text, same rows, same physical order, and DuckDB limited to Postgres's
per-query budget of 3 threads: DuckDB is 10–23x faster, 21–39x with its default 8 threads. A
columnar engine reads only the columns a query touches (a handful of 2–8 byte columns instead of
~130-byte rows), runs vectorized aggregation over them, and pushes join filters into scans.
Postgres was pre-warmed, which is the best case for Postgres's buffer cache; native vs VM and JIT
are not controlled. VM overhead makes the measured gap larger than the pure engine gap. It is not
large enough to explain an order of magnitude, but the number is engine plus platform, not a
conservative lower bound.

### Pre-aggregation removes the work entirely (B-MV)

The materialized views hold the answers at the questions' grain (built in ~2 s), so each query
reads a few hundred rows at most and its time is the client round trip (B-MV medians 0.3–0.6 ms
vs a 0.40 ms `SELECT 1` floor). This is a different trade-off (freshness and maintenance for
speed) and is reported as its own row, never as the same work as querying the fact table.

## What I left out and why

The deadline was one day; each item below would make the numbers more robust or the project more
complete, but none changes the direction of the result.

- **DuckDB inside the same VM.** B→C compares Postgres in the OrbStack VM with DuckDB native on
  the host. Running the DuckDB CLI in a container over the same file would separate engine from
  platform. Left out: one more runtime to set up and verify, and VM overhead cannot account for
  a 10x gap.
- **Round-robin ordering.** Configs run one after another (A, B, B-MV, C-3t, C-8t, then B-jit), in
  a single pass. Interleaving them, or repeating the whole suite, would spread laptop drift
  (thermal state, background load) across configs instead of onto whichever ran last.
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
