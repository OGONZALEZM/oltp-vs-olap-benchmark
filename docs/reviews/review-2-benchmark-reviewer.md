# Benchmark review #2 — raw output

Second review, run as the registered `benchmark-reviewer` agent type in a fresh session (no
context from the session that wrote the code). Reviewed HEAD at `5da5b70`; the results in
`results/` came from a clean run of `aee7472` (no code or SQL changed between the two).
Read-only: no files modified, no writes to Postgres, benchmark not re-run.

Two passes by the same agent, reproduced verbatim below:

1. **Fresh review** of the benchmark at HEAD. Findings are numbered 1–5 in the reviewer's order.
2. **Fix verification** of review #1's findings, using the numbering in `docs/ai-log.md` at the
   time.

Note added afterwards (not part of the reviewer's output): pass 2 reports review #1's finding 5
as untraceable because the raw text of review #1 had not been committed yet. It is now in
`docs/reviews/review-1-benchmark-reviewer.md`. Finding 5 there is the `jit=on` load report,
which pass 2 verifies as FIXED under the ai-log label "4b". Pass 2's item "5. Results re-run from
a clean tree" follows an ai-log label that was never a review finding.

---

## Pass 1 — fresh review

I found nothing that blocks the benchmark. The results are equivalent across configs, the work is the same in each, and the OLTP side is not a straw man. The one important problem is a claim in the writeup: the README and DESIGN call the B→C (engine) gap "conservative", but the setup leaves several factors favouring DuckDB uncontrolled, so that word isn't supported. The rest are minor. I made no changes to files and did no writes to Postgres. I didn't re-run the benchmark or do a from-scratch run, so reproducibility is reviewed by reading only.

Code changes since aee7472: none. `git diff aee7472 HEAD` only touches docs, CLAUDE.md, the agent file and results/, so the saved results match the code at HEAD. The tables in README.md and DESIGN.md match `results/benchmark.json` exactly, including the ratios (A→B 0.9–1.5x, B→C 10.1–23.4x at 3 threads, 20.8–39.1x at 8 threads).

## Findings

### 1. Important: "the engine gap is conservative" is not supported
- **Where:** `/Users/oscargonzalez/Documents/oltp-vs-olap/README.md:27`, `/Users/oscargonzalez/Documents/oltp-vs-olap/DESIGN.md:76-77` and `:153-154`.
- **Evidence:** pre-warming does give Postgres its best cache case. But three other factors push the gap in DuckDB's favour and are not controlled:
  - DESIGN.md:94-97 itself says Postgres runs in the OrbStack Linux VM while DuckDB runs natively on the M3 host. DESIGN.md:154 then cites "the VM caveat above" as a reason the gap is conservative, which is backwards: VM overhead makes the gap bigger.
  - `jit=off` (`docker-compose.yml:28`). Postgres's default is on, and q1_A's plan cost (109,295) is above `jit_above_cost`.
  - DuckDB's memory limit is 12.7 GiB against Postgres's 7.8 GiB VM. This doesn't matter much here, because every aggregate has at most 168 groups.
- **Why it matters:** a 10–23x gap is far too big to be explained by VM overhead, so the conclusion stands. Only the "conservative" label is unsupported, and README.md:27 also drops the VM caveat from the headline.
- **Fix:**
  - Reword to "best case for Postgres's buffer cache; native vs VM is not controlled", and add the VM caveat to the README headline.
  - Better: add one row with DuckDB inside the same VM (the duckdb CLI in a container reading the same file), and optionally a B row with JIT forced on as a sensitivity check.

### 2. Minor: timing scope differs slightly between engines
- **Where:** `/Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/sessions.ts:35-39` and `:63-67`.
- **Evidence:** for Postgres, the clock covers `pg` turning rows into JS objects. For DuckDB, `getRowObjectsJson()` runs after the clock stops.
- **Why it matters:** results are 6–168 rows, so the cost is far below 1 ms against medians of 10 ms or more. It does not change any ratio, but it is an asymmetry.
- **Fix:** move the conversion inside the timed window, or record the asymmetry in `metadata.method.timing`.

### 3. Minor: one pass, run in config order, few samples
- **Where:** `/Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/index.ts:141-159` (warm runs) and `:164-180` (cold runs).
- **Evidence:**
  - Configs run strictly one after another (A, B, B-MV, C-3t, C-8t), once, on a laptop.
  - With n=10, the nearest-rank p95 is just the slowest run. This is documented (DESIGN.md:73).
  - The outliers are large: q4 B warm p95 is 720.6 ms against a 382.7 ms median, and q3 B is 522.5 ms against 358.8 ms.
  - q2 A→B is 0.92x warm but 1.00x cold, which is within noise. DESIGN.md:127 correctly calls it "roughly even".
- **Fix:** run configs round-robin or repeat the whole suite, use more runs, and report the IQR or min alongside the median.

### 4. Minor: "cold" is really "empty buffer pool"
- **Where:** `/Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/sessions.ts:126`, `DESIGN.md:79-86`.
- **Evidence:** Postgres cold medians are within 0–20% of warm (for example q1 A: 647.7 ms cold vs 607.1 ms warm), so the files are clearly served from the VM page cache. I confirmed `shared_preload_libraries` is empty, so pg_prewarm's autoprewarm does not refill the cache after a restart, and the restart does empty `shared_buffers`.
- **Status:** this is documented honestly. It needs no fix beyond keeping the caveat next to the cold column wherever cold numbers are shown.

### 5. Minor (reproducibility): two README gaps
- **Network during `load`:** `src/transform/build-duckdb.ts:85` runs `INSTALL postgres`, which needs network during `npm run load`, but README.md:41 only mentions network for the extract step. Not blocking: the catch falls back to the Parquet path automatically.
- **Volume name:** the "Start over" step (README.md:97) hardcodes the volume `oltp-vs-olap_pgdata`. The prefix comes from the Compose project name, which defaults to the directory name, so it breaks if the repo is cloned under another name.

## Checked and fine

1. **Result equivalence.** Every config is compared with A before any timing (absolute tolerance 1e-6; text compared exactly; q3 sorted by its text key; columns and row counts must also match). I checked it independently, read-only:
   - A vs B `EXCEPT` at full numeric precision returns 0 rows for q1, q3 (all groups) and q4.
   - Joining oltp.trips to fact_trips on trip_id gives 0 mismatches on date_key, pickup area, fare, tips, trip_total and trip_seconds.
   - Timestamps have no time zone, and DuckDB receives integer date keys, so time zone and DST can't shift date buckets.
   - The q2 top 10 has no tie at the cutoff (#10 is 869,001.16, #11 is 739,795.62).
   - DuckDB returns counts and decimal sums as numeric strings and averages as doubles. These normalize correctly, and any unconvertible value would make verification fail rather than pass silently.
   - Company display names are unique in both `oltp.companies` and `dim_company`, so grouping by name doesn't merge companies.
2. **Straw man.** A has FK indexes plus a `trip_start_timestamp` index, `VACUUM (FREEZE, ANALYZE)`, and the same physical order as B. A's q3 uses its timestamp index (`Parallel Index Scan using trips_start_ts_idx`). q1, q2 and q4 aggregate the whole table, so no reasonable non-covering index would help them.
3. **Equivalent work.**
   - B and C run the same SQL files.
   - The q2 filters are equivalent: `IS NOT NULL` in A, `<> 0` in B (the FK is enforced).
   - The q3 filters are equivalent: a half-open timestamp range in A, `year/quarter` on dim_date in B.
   - `LIMIT 10` is applied in every config.
   - The materialized views are a separate B-MV row, their roughly 2 s build time is reported separately, and DESIGN.md:91-93 flags that their ratios are bounded by client round trip.
   - B losing q3 to A comes from Postgres not pushing the dimension filter into the fact scan. This is documented, along with the mitigation that was deliberately not applied.
4. **Measurement.** There is 1 warm-up plus 10 runs, with median and p95. Connection setup and `docker restart` are outside the clock. A `SELECT 1` floor is recorded. Pre-warmed sizes (592 MB and 548 MB) fit in the 1 GB `shared_buffers`, and no saved Postgres plan shows a `read=` buffer. `C-3t` matches Postgres's leader plus 2 workers (`Workers Launched: 2` in all 8 A and B plans).
5. **Plans.** The plans were captured from the exact SQL text that was timed, in the warm state. Every plan detail DESIGN quotes is present: the q1/q4 EXTRACT group keys in A, `Group Key: a.area_key` for q2 in B, A's q3 index scan with 623,752 × 3 rows, B's q3 seq scan with 1,101,627 × 3 rows (43% discarded), DuckDB's dynamic `date_key` filter, and about 131 bytes per row in the fact table.
6. **Reproducibility (read only).** The README steps match the `package.json` scripts. The bench checks that the databases are loaded before starting, and `load` fails unless A, B and C have identical fact checksums. Those checksums match in `benchmark.json`.

One note on the live database: table data hasn't changed since the load (`n_mod_since_analyze` is 0 everywhere). The index usage counters do show that queries were run after the benchmark: `fact_date_idx` shows 156 scans, yet no saved B plan uses it. That doesn't affect the saved results.

---

## Pass 2 — verification of review #1 fixes

Every finding the ai-log lists from the first review is in place at HEAD, except one that is only partly fixed: the VM-vs-native caveat. One gap: commits aee7472 and 0529b0b cite reviewer findings 1, 2, 3, 4 and 6, but finding 5 is mentioned nowhere. The original review text was never committed, so I can't tell what it was or whether it was fixed. Everything below was checked read-only: no files modified, no writes to Postgres, benchmark not re-run.

## Background checks
- **Code at HEAD matches the results.** No code or SQL changed between aee7472 and HEAD; `git diff aee7472 HEAD` touches only docs, CLAUDE.md, the agent file and results/.
- **The results come from a clean run of aee7472.** `results/benchmark.json` metadata shows `git = {commit: aee7472…, dirty: false}`. The load report's `loadedAt` is 2026-10-13T00:54:23Z and the run's `startedAt` is 00:54:24Z, so the data was reloaded just before this run.

## Findings listed in `/Users/oscargonzalez/Documents/oltp-vs-olap/docs/ai-log.md:85-105`

### 1. q2 star query grouped by text
- **Log says:** "B's q2 grouped by `a.community_area_id, a.area_name` … Postgres hashed the text `area_name` on every row, while A grouped by `community_areas`' primary key alone." Claimed fix: "`GROUP BY a.area_key, ...`; plan now shows `Group Key: a.area_key`."
- **Evidence:**
  - `sql/queries/star/q2_top_pickup_areas.sql:13` now has `GROUP BY a.area_key, a.community_area_id, a.area_name`.
  - `results/plans/q2_B.txt` lines 29 and 42 show `Group Key: a.area_key` for both the partial and the final aggregate.
  - The results stay equivalent: verification passed. Independently, the q2 top 10 has no tie at the cutoff (#10 is 869,001.16, #11 is 739,795.62).
- **Verdict: FIXED.** B is still 0.92x of A on q2, as the log says. My first report explains that this is plausibly noise: the gap is 1.00x cold.

### 2. "Warm" Postgres was not warm
- **Log says:** the fact tables exceed `shared_buffers/4`, so seq scans used a ring buffer and warm plans showed `read=58591`. Claimed fix: "`pg_prewarm` per config before warm runs and plan capture; all plans now show hits only."
- **Evidence:**
  - `src/bench/index.ts:141-145` pre-warms each config before its warm runs, and `:187` does the same before plan capture.
  - `src/bench/sessions.ts:95-117` loads the heap and secondary indexes and leaves out primary keys.
  - `results/benchmark.json` lists `prewarmed` relations as A: 15, B: 18, B-MV: 4. I recomputed the sizes: A is 592 MB and B is 548 MB, both under the 1 GB `shared_buffers`.
  - `grep -l "read=" results/plans/*.txt` matches nothing, so every Postgres plan shows hits only.
- **Verdict: FIXED.**
  - Small caveat: plans are captured in a separate pass after a fresh pre-warm, so the timed warm runs' hit-only state is inferred from the same procedure, not observed directly. The procedure is identical, so this is low risk.
  - Side effect: the fix's wording ("best case, so the engine gap is conservative", `index.ts:252`, DESIGN.md:76-77) goes further than the evidence (see 4d and finding 1 of my first report).

### 3. Plan timings contradicted measurements
- **Log says:** per-node `EXPLAIN ANALYZE` timing inflated times 1.2–2.5x unevenly. Claimed fix: "`TIMING OFF`, plans labelled as shape/rows/buffers only."
- **Evidence:**
  - `src/bench/sessions.ts:45` uses `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF)`.
  - All 12 Postgres plan files carry the "TIMING OFF … not benchmark results" header from `index.ts:194-196`.
  - None contains `actual time=`.
  - DuckDB plans carry a profiling-overhead disclaimer.
  - DESIGN.md:98-103 documents this.
- **Verdict: FIXED.** The "B looked 1.8x faster on q2" example predates this commit, so I can't verify it now.

### 4a. No README (marked blocking for reproducibility)
- **Evidence:**
  - `README.md` exists (added in 0529b0b) with prerequisites, command order, expected counts and times, options and troubleshooting.
  - Its steps map onto the `package.json` scripts.
  - The commit also added a preflight check (`src/bench/index.ts:59-68`) that gives clear errors when Postgres is down or the databases are not loaded.
- **Verdict: FIXED as a document. Whether it works end to end: CANNOT VERIFY**, because I'm not allowed to run it from scratch. The small gaps from my first report still apply:
  - network is also needed during `load` (`INSTALL postgres`), though there is a Parquet fallback;
  - the volume name in "Start over" depends on the directory name.

### 4b. Load-report metadata showed `jit=on` from an older load
- **Evidence:**
  - `benchmark.json` reports `loadReport.postgres.settings.jit = "off"` and `metadata.postgres.pinnedSettings.jit = "off"`.
  - `SHOW jit` on the live server returns `off`.
  - `docker-compose.yml:27-28` pins it.
- **Verdict: FIXED.** The reload happened before the final run, per the timestamps above.

### 4c. B-MV ratios were round-trip bound without saying so
- **Evidence:**
  - `index.ts:123-136` measures a `SELECT 1` floor per engine. `benchmark.json.roundTripBaselineMs` has Postgres at a 0.396 ms median.
  - The speedup label is now "B→B-MV (pre-agg, round-trip bound)" (`index.ts:221`).
  - `metadata.method.roundTrip` explains it, as do DESIGN.md:87-93 and :156-161 and README.md:28.
- **Verdict: FIXED.**
  - Minor: the raw 586–1408x ratios are still emitted in `speedups` and the console summary, labelled but not suppressed.
  - Minor: the B-MV q1/q2 medians (0.3 ms) are below the measured Postgres floor (0.40 ms), so the floor is itself noisy at this scale. That doesn't change the conclusion.

### 4d. B→C did not mention VM vs native execution
- **Evidence:** DESIGN.md:94-97 now says "B→C is engine plus platform." However:
  - README.md:27 states the 10–23x gap "is conservative" with no VM caveat.
  - DESIGN.md:153-154 cites "the VM caveat above" as a reason the gap is conservative. VM overhead slows Postgres, which makes the gap larger, not smaller.
- **Verdict: PARTIALLY FIXED.** The caveat exists, but the headline doesn't carry it and the conclusion reads it in the wrong direction.

### 5. Results re-run from a clean tree
- **Evidence:** `dirty: false` at aee7472; the results were committed in 1e8bf35, which says "from commit aee7472".
- **Verdict: FIXED.**

## What the log leaves out
- **Finding 5 cannot be traced.** The fix commit numbers its items (finding 2, 3, 4, 6, 1) and 0529b0b adds finding 1 for the README, but finding 5 appears in neither commit nor in `docs/ai-log.md`. The log merges several items into its item 4 without original numbers. Finding 5 may be the jit metadata or the VM note (both fixed without a number), or something dropped. **CANNOT VERIFY.** Suggested fix: save the first review's raw output (for example under `docs/`) and keep the reviewer's numbering in the ai-log entry.
- **Stale log status.** The ai-log's "Status: second review pending" (`docs/ai-log.md:81-83`) is now stale, since this review is that second pass.

## First-pass findings for reference
These were in my earlier report and are repeated here so they aren't lost:
1. **Important:** the "conservative engine gap" claim is unsupported. VM vs native, `jit=off` and the memory difference all favour DuckDB.
2. **Minor:** DuckDB's row conversion happens outside the timer while Postgres's is inside.
3. **Minor:** configs run once each, in a fixed order; with n=10, p95 is just the slowest run.
4. **Minor:** "cold" only empties the database's own buffer cache; the OS page cache stays warm. This is documented.
5. **Minor:** two small reproducibility gaps in the README.

Files involved:
- `/Users/oscargonzalez/Documents/oltp-vs-olap/docs/ai-log.md`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/index.ts`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/sessions.ts`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/sql/queries/star/q2_top_pickup_areas.sql`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/results/benchmark.json`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/results/plans/`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/README.md`
- `/Users/oscargonzalez/Documents/oltp-vs-olap/DESIGN.md`
