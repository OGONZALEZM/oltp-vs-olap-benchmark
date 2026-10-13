# Benchmark review #4 — raw output

Final consistency review, run as the registered `benchmark-reviewer` agent type (a subagent with its
own context) with a neutral prompt: check that every number and claim in README, DESIGN,
docs/BENCHMARK.md, AI_WORKFLOW.md and the UI matches `results/benchmark.json` and the code.
Reviewed HEAD `64d2a00`; results from the clean run of `8908555`. Read-only. Under the stopping
rule, findings could only lead to documentation fixes. The reviewer's output is reproduced
verbatim below.

---

## Final consistency review: HEAD 64d2a00, results from the clean run of 8908555

**Summary:** nothing is blocking. Every published timing, ratio, range, plan quote, row count and cleaning count matches `results/benchmark.json`, `results/plans/`, the code and the live database. I found 2 important issues and 9 minor ones; all of them are documentation fixes.

I modified no files and did not run the benchmark or the load. The Postgres queries I ran were all inside `BEGIN READ ONLY` transactions, plus `\d` catalog reads. `npm run typecheck` passes, and `npx vitest run tests/unit tests/integration/ui.test.ts` passes (3 files, 24/24 tests).

### Important

**1. The results page shows the engine ratio without the "engine plus platform" caveat.**
- **Where:** `ui/data.js:14-15` (tile note: "Postgres star → DuckDB star, same SQL, 3 threads each") and `ui/index.html:122-124`.
- **Evidence:** README:29, DESIGN:74-75 and BENCHMARK:80-84 all say B→C includes VM vs native execution. Review #2 finding 1 (ai-log:148-153) was exactly that the README headline had dropped this caveat. The page shows "9.6–21x" as the Engine tile with no caveat.
- **Fix:** add "Postgres in the OrbStack VM, DuckDB native: engine plus platform" to the engine tile note, or as a badge like the pre-aggregation one.

**2. The 10x-data plan contradicts the project's own explanation of q3.**
- **Where:** `DESIGN.md:102-104`: "partition `fact_trips` by month ... so q3's quarter filter prunes partitions".
- **Evidence:** q3's filter is on `dim_date` (`sql/queries/star/q3_tips_by_payment_company.sql`). BENCHMARK:156-160 and the plan `q3_B.txt` show Postgres does not push a dimension filter into the fact scan (it uses a hash join on `date_key`). Partition pruning has the same limit: plan-time pruning needs constants on the partition key, and run-time pruning does not happen under a hash join. As written, q3 would still scan every partition.
- **Fix:** say pruning requires the explicit `f.date_key BETWEEN ...` predicate that BENCHMARK:161-163 describes (and deliberately does not apply), or reword to "queries that filter on the fact's `date_key`".

### Minor

**3. BENCHMARK says every number comes from the final run, but several do not** (`docs/BENCHMARK.md:3-4`). These come from earlier runs, an isolated test or review #1, all consistent with ai-log and the reviews:
- "q2 B warm 340–558 ms" (:52) is from the 8c320e1 run.
- "18.0 vs 25.4 ms", "0.5 vs 2.4 ms" (:54-55) and "17.7–18.4 ms" (:56) are from isolated timing checks.
- "0.2–0.5 ms" (:74) is from 8c320e1 (B-MV warm medians there were 0.23–0.48).
- "1.2–2.5x" and "1.8x / 13%" (:99-100) are from review #1.
- "3,075 in API profiling" (:172) is from API profiling.

Fix: "Results come from `results/benchmark.json` ...; figures that explain how the method evolved come from earlier runs and are sourced in ai-log.md."

**4. Warm medians are still above restart medians in 2 of 8 Postgres cells, and no document says so.**
- **Evidence:** q1 B is 361.7 warm vs 360.4 restart; q4 B is 345.9 vs 343.3. BENCHMARK:49-53 presents the 6-of-8 problem as fixed, and README:29 / DESIGN:75 keep calling pre-warming "the best case for Postgres's buffer cache".
- The gaps are under 1% (noise), but ai-log:228 sets the rule that "a 'best case' label needs evidence from the data".
- **Fix:** one sentence in BENCHMARK (Spread and noise): "In the final run, B's warm medians are within 1% of its restart medians (2 of 8 A/B cells are slightly above). Pre-warming shows no measurable benefit because the VM page cache already serves restart runs."

**5. "Both read every row" is contradicted by q3.**
- **Where:** `DESIGN.md:67` ("Both configs read every row") and `docs/BENCHMARK.md:138` ("Both A and B scan the full 3.3M-row table").
- **Evidence:** `q3_A.txt` range-scans the timestamp index (623,752 × 3 = 1.87M of 3.30M rows; 37,423 vs 53,194 buffers). Both documents state this exception a few lines later.
- **Fix:** "Both configs read every row except A on q3, which range-scans its timestamp index."

**6. B's index parity is overstated.**
- **Where:** `DESIGN.md:40-41` ("btree indexes on its FKs, mirroring A") and `docs/BENCHMARK.md:15`.
- **Evidence:** `sql/star/constraints.sql` declares 7 FKs but creates 6 indexes; `time_key` (`fact_time_fk`) has none. A indexes all 5 of its FKs plus `trip_start_timestamp`. No query needs a `time_key` index, so the benchmark is unaffected.
- **Fix:** "btree indexes on every FK except `time_key` (6 indexes, matching A's 6)".

**7. The results page headlines a B-MV ratio that the docs deliberately never quote.**
- **Where:** `ui/data.js:16-17`. The tile shows "293–358x" (restart "213–278x").
- **Evidence:** DESIGN:78 and BENCHMARK:71-73 say the B→B-MV ratio is "not a precise factor". Across committed runs it swung from about 660–1,500x (review #1) to about 300x purely from round-trip and wake-up noise (B-MV medians 0.23–0.48 ms in 8c320e1 vs 1.0–1.2 ms now). The badge helps, but the large number is the most noise-sensitive figure in the project.
- **Fix:** make the tile value "≈1 ms (round-trip floor 0.2 ms)" and move the ratio to the small text, or keep it but drop "lower bound" from the note and match the docs' wording.

**8. The README load time has no source.**
- **Where:** `README.md:70` ("~6.5 min").
- **Evidence:** the load report the final run used (`metadata.loadReport`, loadedAt 2026-10-13T00:54Z) has stage timings summing to 320 s, plus 5 s for DuckDB, about 5.4 min. No recorded total says 6.5 min; the console "Total" line is not persisted.
- **Fix:** "~5.5 min", or persist the total in `load-report.json`.

**9. README describes the idle pause too broadly.**
- **Where:** `README.md:71` ("a 10 s idle pause before each (query, config) block").
- **Evidence:** `src/bench/index.ts:166` pauses only before warm blocks; restart blocks get no pause (:183-199), as BENCHMARK:46-48 says correctly.
- **Fix:** "before each warm (query, config) block".

**10. AI_WORKFLOW claims more than the records show.**
- **Line 13** says review #3 ran in a separate session. `docs/reviews/review-3-benchmark-reviewer.md:3` and ai-log:199-201 record only "registered agent, neutral prompt", with no session claim. Fix: drop #3 from the sentence or add the fact to the review header.
- **Line 79-80** says "each plan detail DESIGN quotes is checked". Since 4db5c00, the quoted plan details are in `docs/BENCHMARK.md`. Fix: say BENCHMARK.md.
- **Line 81-82** says "the next review verified the fixes". No committed review verifies review #3's fixes (cooldown, per-block pause). Fix: "reviews #2 and #3 verified the previous fixes."
- **Line 54** (nit): error 2's second bug was in `src/transform/build-duckdb.ts`, not load SQL.

**11. Small inaccuracies on the results page and elsewhere:**
- `ui/index.html:123` says "Restart medians in brackets", but tiles show them on a "restart:" line.
- `ui/index.html:127` hardcodes "10 runs each" although `meta.runs` is available.
- README prerequisites (:45-47) don't mention that the page loads Chart.js from a CDN (README:88 does).
- README:12-13 says results are "identical". The check uses an absolute tolerance of 1e-6 (README:74 and AI_WORKFLOW:75 say this correctly).
- ai-log:256 says "As committed, the af3ab95 results would have..." and then "never committed". Should read "Had they been committed".
- ai-log:195 ("B-jit 0.9–1.2x, within noise") is correct for the 8c320e1 run, but the final run is a consistent 0.86–0.93x. A "(final run: 0.9x)" note would avoid confusion.

### Checked and consistent
- **Headline tables** (README:23-26, DESIGN:59-62): all 60 cells (warm median, restart median, warm min) match `results` exactly. The DESIGN ratio columns match `speedups`.
- **Ranges:**
  - A→B: 0.87–1.65 warm, 0.96–1.66 restart, quoted as 0.9–1.6x / 1.0–1.7x.
  - B→C at 3 threads: 9.62–21.06 warm, 9.39–18.36 restart, quoted as 9.6–21x / 9.4–18x.
  - B→C at 8 threads: 18.76–44.20 warm, 17.51–36.64 restart, quoted as 19–44x / 18–37x.
  - B-jit: 0.86–0.93, quoted as 0.9x with correct direction wording.
- **Spread** (BENCHMARK:107-115):
  - The table matches min/median/p95.
  - Medians above minimums: up to 2.7% (A), 3.8% (B), 5.9% (C-3t), 5.4% (C-8t).
  - Largest p95/median is 1.26 for the A/B/C rows.
  - B-MV medians are up to 27.2% above their minimums.
- **Other run figures:**
  - Floor: 0.20 ms Postgres, 0.18 ms DuckDB.
  - MV build: 1,884 ms, quoted as 1.9 s.
  - Bench duration: 7 min 4 s.
  - Pre-warm: A 15 relations / 592 MB, B 18 relations / 548 MB; PK indexes are 280 MB each in the live catalog.
  - Host and VM specs match the metadata.
- **Plans:**
  - No Postgres plan contains `read=`.
  - All 4 B-jit plans contain `JIT:`; no A or B plan does.
  - B costs are 83.5k–89.2k; A q1 is 109,296 and A q4 is 105,570.
  - The group keys quoted for q1, q2 and q4 match.
  - The q3 quotes (`trips_start_ts_idx`, rows=623752 loops=3, rows=1101627 loops=3, 37,423 vs 53,194 hits, the `dim_date` filter) match, and 43.4% of rows fall outside Q2 per the live data.
  - The DuckDB q3 plan shows `Dynamic Filters: optional: date_key>=20250401 AND optional: date_key<=20250630`.
- **Method text vs code:**
  - Round-robin order and its rotation match `order` in the JSON.
  - The pause comes before warm blocks only; there is 1 warm-up and 10 timed runs on one connection.
  - Postgres is restarted before every restart run, and DuckDB gets a fresh READ_ONLY instance.
  - The timing scope (row conversion inside the clock, connection setup outside) matches the docs.
  - Nearest-rank p95; the tolerance of 1e-6 and the q3 sort key match.
  - The plan pass is pre-warmed, runs one untimed execution, and uses TIMING OFF.
  - All three fact tables are loaded in the same physical order.
  - The method strings in `benchmark.json` match the docs.
- **Provenance:**
  - All three committed results files record `dirty: false`, for aee7472, 8c320e1 and 8908555.
  - No load, transform, SQL or bench code changed between aee7472 (the load) and HEAD; only `src/ui/serve.ts` and `package.json` changed after 8908555.
  - ai-log entry times match the commit times.
- **Data facts:**
  - Raw trips 3,313,460, clean 3,304,881, rejected 8,579 (0.26%), with the per-reason counts and the order of the rules in `clean.sql` as documented.
  - 69 pages; raw data 406 MB, DuckDB file 127 MB, database 4,287 MB.
  - Taxis: 3,075 distinct / 3,074 real / 1 `NA`; no rejected taxi hash is missing from `oltp.taxis`.
  - Companies: 39 raw spellings become 36 companies, i.e. 3 companies with 2 spellings each.
  - dim_date has 181 rows, dim_area 78, dim_taxi 3,075.
- **Cross-document history:**
  - AI_WORKFLOW errors 1, 3-9 and 10's figures (2–7 ms, 6 of 8 cells, 1.2–2.5x) match ai-log and reviews #1-#3.
  - The stopping rule and the headline statistic were decided before the final run, per ai-log.
- **README options and prerequisites:** the defaults (runs 10, warmup 1, restart-runs 10, cooldown 10000, quarter 2025-Q2, concurrency 3, page size 50000, port 8080) and Node ≥ 20.12 match the code and `package.json`.
- **UI:** `formatRange` reproduces the documented model and engine ranges exactly. The page reads only `benchmark.json` and the plans.

### Relevant files
- /Users/oscargonzalez/Documents/oltp-vs-olap/ui/data.js
- /Users/oscargonzalez/Documents/oltp-vs-olap/ui/index.html
- /Users/oscargonzalez/Documents/oltp-vs-olap/DESIGN.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/docs/BENCHMARK.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/README.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/AI_WORKFLOW.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/docs/ai-log.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/sql/star/constraints.sql
- /Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/index.ts
- /Users/oscargonzalez/Documents/oltp-vs-olap/results/benchmark.json
- /Users/oscargonzalez/Documents/oltp-vs-olap/results/plans/q3_A.txt
- /Users/oscargonzalez/Documents/oltp-vs-olap/results/plans/q3_B.txt
