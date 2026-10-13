# AI usage log

Live log. One entry every time the AI generates something that had to be corrected, or a check
(test, benchmark-reviewer, manual review) catches an error. This is the raw material for
`AI_WORKFLOW.md`.

Entry times are the Bogotá time (America/Bogota) of the commit that carried the work or its fix.
The stack decision predates the repository and uses the first commit's time.

## Template

### [time] Short title
- **Prompt / context:** what was asked.
- **What the AI generated:** summary.
- **What was wrong:** the concrete error.
- **How it was caught:** test, verification query, EXPLAIN, manual review, subagent.
- **Fix:** what changed (commit).

---

## Monday 2026-10-12

### 12:43 Stack and data source selection
- **Prompt / context:** initial analysis of the assessment with Claude.
- **Decision:** PokéAPI was ruled out (a catalog with no time dimension and no transactions; the
  fact table would have been 100% synthetic) in favor of Chicago Taxi Trips (2024-), real data
  with time, geography and payments. TypeScript over Python and Kotlin for speed of verification
  under a same-day deadline.
- **Benchmark design:** three configs (Postgres 3NF / Postgres star / DuckDB star) to separate the
  effect of the model from the effect of the engine.

### 12:46 CLAUDE.md data assumptions checked against the live API
- **Prompt / context:** before any schema, fetch the `ajtu-isnz` column dictionary and a 5-row
  sample, and flag mismatches with what CLAUDE.md assumes.
- **What the AI generated:** the data-source section of CLAUDE.md (written from general knowledge
  of the dataset, not from the API).
- **What was wrong:**
  1. "Expect negative miles/fares": there are none; every amount column has min 0. The real issues
     are zeros (8.4% zero miles, 1.3% zero seconds), outliers (fare up to 9,999.75, trips up to
     86,400 s) and 107 trips whose end precedes their start.
  2. "Expect duplicates": `trip_id` is unique over all 18,658,792 rows. Content-level repeats
     (same taxi, start, end, total) exist but are plausibly real trips at 15-min rounding.
  3. Revenue: `trip_total` ≠ `fare + tips + tolls + extras` in 38% of Jan 2025 rows (an
     unpublished surcharge). Revenue must be `trip_total`, never recomputed.
  4. `community_areas` cannot be filled from this dataset: it has only numbers 1–77, no names.
  5. `company` is dirty: 46 raw values, 3 entities spelled 7 ways (LLC/Inc/punctuation/spacing).
  6. `taxi_id` is a 128-char hash (not 40) with a literal `"NA"` sentinel in 13 rows; 17% of taxis
     serve more than one company, so company belongs on the trip, not the taxi.
  7. Census tracts are suppressed in ~55% of rows, not "in some cases"; tract and centroid columns
     are functionally determined by tract/area, so keeping them on `trips` would break 3NF.
  8. `$offset` pagination works but is not stable under in-place dataset updates nor resumable by
     key; keyset pagination on `trip_id` is.
  9. Dictionary `cachedContents.cardinality` equals the row count for every column: unreliable.
  10. Plan B (date-shifted replication) is unnecessary: a 50k-row page takes ~6 s with an explicit
      `$select`.
- **How it was caught:** column dictionary + SoQL aggregate queries (counts, distincts, `CASE`
  sums, `GROUP BY ... HAVING`) against the live API before writing any schema.
- **Fix:** CLAUDE.md data-source section rewritten to match the real data; decisions (window,
  cleaning rules, pagination, revenue definition, query 2 semantics, index parity) recorded there.
  Community area names seeded from `igwz-8jzy` into `sql/seed/community_areas.csv`.

### 13:52 Load step: two SQL bugs caught by the Testcontainers integration test
- **Prompt / context:** write step 3.2 (compose, staging/OLTP/star DDL, COPY loader, DuckDB copy).
- **What the AI generated:** `sql/oltp/load.sql` and `src/transform/build-duckdb.ts`.
- **What was wrong:**
  1. `SELECT DISTINCT x ... ORDER BY x COLLATE "C"` (payment types, taxis) is invalid in Postgres:
     the collated ORDER BY expression is not in the DISTINCT select list.
  2. The DuckDB loader read column names from `information_schema.columns` filtered only by
     table name. After `ATTACH`ing Postgres, the attached `star.*` tables appear there too, so
     every column came back twice ("Duplicate column name in INSERT").
  3. (Test bug, not code) the company-merge fixture had a 1-1-1 tie between spellings, so the
     tie-break legitimately picked the double-space variant.
- **How it was caught:** `tests/integration/load.test.ts` against a real Postgres 16 container,
  before the first real load.
- **Fix:** `GROUP BY` instead of `DISTINCT`; filter `information_schema` to
  `table_catalog = current_database() AND table_schema = 'main'`; fixture makes the expected
  spelling the majority while still covering the comma and double-space variants.

### 19:49 Reviewer findings on the AI-generated benchmark
- **What the AI generated:** `src/bench/`, `sql/queries/`, the method section of DESIGN.md.
- **What was wrong (caught by benchmark-reviewer, confirmed against plans and catalog):**
  Numbers are review #1's original numbering (`docs/reviews/review-1-benchmark-reviewer.md`).
  An earlier version of this entry used its own numbering (1–4, with 4 split into a–d) and listed
  "results not from a clean tree" as a fifth item; that was never a review finding, and review #1's
  real finding 5 (the `jit=on` load report) was folded into item 4 without its number.
  - **#1 No README** (blocking for reproducibility). Fixed: README.md with prerequisites, command
    order, expected results and troubleshooting; `bench` preflight with clear errors (0529b0b).
  - **#2 "Warm" Postgres was not warm.** Both fact tables exceed `shared_buffers / 4`, so seq
    scans use a ring buffer and never cache them; warm plans showed `read=58591`. Fixed with
    `pg_prewarm` per config before warm runs and plan capture; all plans now show hits only.
  - **#3 A→B contradicted "the model matters", and q2's star query grouped by text.** B's q2
    grouped by `a.community_area_id, a.area_name`. In `dim_area` the primary key is `area_key`
    (`community_area_id` is only UNIQUE), so Postgres hashed the text `area_name` on every row,
    while A grouped by `community_areas`' primary key alone (functional dependency drops `name`).
    An unfair per-row cost on B, not a model effect. Fixed: `GROUP BY a.area_key, ...`; plan now
    shows `Group Key: a.area_key`. B is still 0.9x of A on q2: the asymmetry was real but not the
    whole story. The missing results section was added to DESIGN.md ("Results and why").
  - **#4 Plan timings contradicted measurements.** `EXPLAIN ANALYZE` per-node timing in the VM
    inflated times 1.2–2.5x unevenly (q2 plans implied B 1.8x faster; measured A 13% faster).
    Fixed: `TIMING OFF`, plans labelled as shape/rows/buffers only.
  - **#5 Load-report metadata showed `jit=on`** from a load before `jit=off` was pinned. Fixed:
    reload before the final run.
  - **#6 B-MV ratios were round-trip bound without saying so.** Fixed: `SELECT 1` baseline
    recorded, ratio labelled "round-trip bound", DESIGN note.
  - **#7 B→C did not mention VM vs native execution.** Partly fixed: DESIGN note added, but the
    README headline and DESIGN's conclusion still called the gap "conservative" (review #2).
- **Not a finding:** results were re-run from a clean tree before committing them (1e8bf35). The
  earlier version of this entry listed that as an item; it was good practice, not a review
  finding.
- **How it was caught:** benchmark-reviewer subagent reading `results/plans/` and catalog sizes.
- **Fix:** commits aee7472 (code) and the following docs commit; results re-run from a clean tree.

### 19:58 Benchmark reviewed: benchmark-reviewer ran as a general-purpose agent
- **Prompt / context:** run the `benchmark-reviewer` subagent on the first benchmark (commit 20a4c9e).
- **What happened:** the reviewer definition lived in `docs/benchmark-reviewer.md`, not in
  `.claude/agents/`, so it was not a registered agent type. The first review ran as a
  general-purpose agent with that file's instructions passed verbatim (read-only).
- **Fix:** moved to `.claude/agents/benchmark-reviewer.md`. Agent definitions are loaded when a
  session starts, so the type could not be invoked in the session that moved it.
- **Status:** second review **done** as the registered `benchmark-reviewer` agent type in a fresh
  session, with no context from the session that wrote the code. See the review #2 entry below.
  Raw outputs: `docs/reviews/review-1-benchmark-reviewer.md`,
  `docs/reviews/review-2-benchmark-reviewer.md`.

## Tuesday 2026-10-13

### 06:19 CLAUDE.md moved to the repository root
- **What was wrong:** the project context lived in `docs/CLAUDE.md`. Claude Code only loads
  `CLAUDE.md` automatically from the repository root (and parent directories), so sessions did not
  get it at start: it had to be read explicitly, and every subagent prompt had to point at
  `docs/CLAUDE.md` by hand.
- **How it was caught:** while preparing the prompt for the fresh-session benchmark review, which
  needed the non-standard path spelled out.
- **Fix:** `git mv docs/CLAUDE.md CLAUDE.md`; benchmark-reviewer now points at the root file;
  README layout lists `CLAUDE.md`, `docs/ai-log.md` and the reviewer agent. Historical log entries
  above keep the name as written at the time.

### 06:40 Review #2: "conservative engine gap" claim unsupported
- **Prompt / context:** run the registered `benchmark-reviewer` agent in a fresh session on HEAD
  (5da5b70; results from a clean run of aee7472), read-only, then have it verify review #1's fixes.
  Raw output: `docs/reviews/review-2-benchmark-reviewer.md`.
- **What the AI generated:** the claim that the B→C engine gap is "conservative" (README headline,
  DESIGN.md method and conclusion, `metadata.method.warm` in `results/benchmark.json`). The claim
  **originated in the planning conversation**, as the justification for pre-warming Postgres, not
  in the code: no measurement backs it, and it was then copied into the code and docs as a
  conclusion.
- **What was wrong:**
  - **#1 (important)** Pre-warming is Postgres's best case for its buffer cache, but three other
    factors that favour DuckDB are uncontrolled: Postgres runs in the OrbStack VM while DuckDB
    runs natively; `jit=off` is pinned (q1_A's plan cost is above `jit_above_cost`); DuckDB's
    memory limit is larger. DESIGN.md even cited "the VM caveat above" as a reason the gap was
    conservative, which reads it backwards: VM overhead makes the gap larger. The README headline
    dropped the VM caveat. The 10–23x conclusion stands; the word "conservative" does not.
  - **#2 (minor)** Timing scope differed: Postgres's clock covered `pg` building row objects,
    DuckDB's `getRowObjectsJson()` ran after the clock stopped.
  - **#3 (minor)** One pass, configs in fixed order, n=10 (p95 is the slowest run).
  - **#4 (minor)** "Cold" only empties the database buffer pool; the VM/host page cache stays
    warm. Already documented; the label overstated it.
  - **#5 (minor)** README gaps: network is also needed during `load` (`INSTALL postgres`), and
    the "Start over" volume name assumed the Compose project name.
  - **Fix verification of review #1:** all fixed except #7 (VM vs native), partly fixed (same
    root cause as #1 above). The reviewer could not trace review #1's finding 5 because the raw
    review was never committed and this log used its own numbering; resolved by committing
    `docs/reviews/review-1-benchmark-reviewer.md` and renumbering the entry above.
- **How it was caught:** the independent reviewer, which had no context from the planning
  conversation, read the claim against DESIGN.md's own VM caveat and `docker-compose.yml`.
- **Fix:**
  - Reword "conservative" everywhere to "best case for Postgres's buffer cache; native vs VM and
    JIT are not controlled", and put the VM caveat in the README headline.
  - Add a warm-only sensitivity row, B with `jit=on`, reported outside the main ratios.
  - Move DuckDB's row conversion inside the timed window.
  - Report min alongside median and p95.
  - Rename "cold" to "restart (empty buffer pool)".
  - Fix both README gaps.
  - List DuckDB inside the same VM, round-robin ordering and more runs in DESIGN.md's "What I
    left out and why".
  - Re-run the benchmark from a clean commit.

### 06:44 B-jit row: JIT forced with jit_above_cost=0 instead of the literal jit=on
- **Prompt / context:** Oscar asked for "a B row with jit=on, warm only" as the sensitivity check
  for review #2 finding 1.
- **What the AI did:** implemented it literally first (`SET jit = on`), then checked the smoke
  run's plans for a `JIT:` section before trusting the row.
- **What was wrong with the literal instruction:** no B plan used JIT. B's plan costs (83k–89k) are
  below Postgres's default `jit_above_cost` of 100,000, so `jit=on` alone never engages JIT on
  B, and the row would have re-measured B with JIT off while being labelled "jit=on". It would
  have "shown" that JIT doesn't matter without ever running JIT.
- **How it was caught:** the bench records `jitUsed` per query from the captured plan; the smoke
  run reported "JIT in plan: no" for all four queries. A manual `EXPLAIN` with
  `jit_above_cost = 0` confirmed JIT was available and engaged once the threshold was removed.
- **Fix / decision:** deviated from the instruction, and said so before committing: B-jit uses
  `SET jit = on, jit_above_cost = 0` (inlining and optimization keep their default thresholds),
  as review #2 suggested ("JIT forced on"). DESIGN.md records that at default thresholds JIT
  doesn't engage on B at all. Oscar confirmed the deviation was correct. Result: every B-jit plan
  contains a JIT section; B-jit is 0.9–1.2x of B, within noise (commits 8c320e1, 2693772).
- **Lesson:** a sensitivity row has to prove its setting actually took effect. Record evidence
  from the plan, not just the `SET`.

### 07:07 Review #3: warm Postgres timings were thermal noise, not cache
- **Prompt / context:** third `benchmark-reviewer` run on HEAD 53abfc1 with a neutral prompt that
  did not list what had changed. Raw output: `docs/reviews/review-3-benchmark-reviewer.md`.
- **What the AI generated:** the measurement loop (configs one after another, timed runs back to
  back) and the headline built only on warm medians, presented as Postgres's best case.
- **What was wrong:**
  - **#1 (important)** In the 8c320e1 run, Postgres warm medians were *higher* than restart
    (empty buffer pool) medians in 6 of 8 A/B cells. Restart samples were tight; warm samples
    drifted (q2 B warm 340–558 ms, restart 345–379 ms). The host is a fanless MacBook Air: warm
    runs keep 3 cores busy for about 18 s per config, while restart runs get idle time between
    them. So the warm series measured run order and heat, not the cache. Quoted on restart
    medians, B→C at 3 threads fell from 12–22x to 9.4–18x, which also undercut DESIGN's
    "VM overhead cannot account for a 10x gap". "q3: A wins (0.9x)" was 0.99x on restart.
  - **#2 (minor)** "DuckDB medians within 9% of their minimums" held only for C-3t; C-8t reached
    +28%.
  - **#3 (minor)** The JIT sensitivity row covers B only, but at default thresholds JIT would
    engage on A (q1 and q4 costs about 109k and 106k).
  - **#4 (minor)** The committed `benchmark.json` carried the old JIT wording (fixed by the next
    run).
- **How it was caught:** the independent reviewer compared the two series sample by sample in
  `results/benchmark.json`, and noted the host model (Mac15,13) from the metadata. Earlier reviews
  had checked that warm runs were cache hits (they were), not that the warm series was stable.
- **Fix (b7a2c1b):**
  - Add a 2 s idle pause (`--cooldown-ms`) before every timed run, and run configs round-robin
    per query.
  - Decide the headline before re-running: warm median with restart median and warm min beside it.
  - Drop threshold claims and report ranges only; q3 is now "roughly even"; per-config spread;
    JIT coverage of A stated; thermal note in DESIGN.
  - Final clean run follows.
- **Lesson:** a "best case" label needs evidence from the data. Here the supposedly worse series
  (restart) was the faster and tighter one.

### 07:30 The cooldown fix introduced a bias against short queries
- **Prompt / context:** after review #3's thermal finding, the AI added a 2 s pause before every
  timed run (b7a2c1b) and ran the benchmark from a clean commit (af3ab95), intended as final.
- **What was wrong:** the pause fixed Postgres's drift but added the CPU's wake-up cost to every
  sample, which only matters for short queries. Comparing the run with the previous one (warm
  medians):

  | | Previous run, 8c320e1 (no cooldown) | af3ab95 run (2 s pause before each timed run) |
  |---|---|---|
  | Postgres A/B medians vs their minimums | up to +29% | up to +6% (thermal drift fixed) |
  | Postgres warm > restart medians | 6 of 8 cells | 2 of 8 cells |
  | B-MV q1 | 0.2 ms | 2.5 ms |
  | C-3t q1 | 18.9 ms | 25.6 ms |
  | B→C, 3 threads | 12–22x | 7.7–15x |

- **How it was caught:** the AI compared the run with the previous one before committing.
  The fast configs had slowed down although nothing about them had changed. To check the cause,
  it timed the same query 10 times per condition on one open connection:

  | | No pause | 2 s pause before each run | No pause again |
  |---|---|---|---|
  | DuckDB q1 (3 threads) | 18.0 ms | 25.4 ms | 17.7 ms |
  | B-MV q1 | 0.5 ms | 2.4 ms | 1.1 ms |

  That is a roughly fixed 2–7 ms per sample: noise on a 350 ms Postgres query, about 40% of a
  DuckDB query. As committed, the af3ab95 results would have understated B→C by about a third.
  They were discarded and never committed.
- **Fix (2f9ac50):** a 10 s pause before each (query, config) warm block instead of before each
  run. The untimed warm-up then wakes the CPU, and the 10 timed runs are back to back. Restart
  runs get no extra pause. Idle check with this pattern: DuckDB q1 17.7–18.4 ms, Postgres B q1
  median 1–4% above its minimum.
- **Each methodology change was driven by a demonstrated cause, not by the results:**
  - Pre-warming came from plans showing `read=` buffers (review #1).
  - The cooldown came from warm medians above restart medians plus drifting samples (review #3).
  - The move to per-block pauses came from the timing table above, which isolates the wake-up
    cost with nothing else changed.
  - None of the changes was chosen because it moved B→C in a preferred direction: the first
    cooldown shrank the gap, and was rejected only once its cause was shown to be a measurement
    artifact.
- **Stopping rule (set by Oscar before the next run):** the idle check passed, so the next full
  run is final whatever it shows. Remaining noise gets documented, not tuned. The headline
  statistic stays as decided before the run: warm median, with restart median and warm min beside
  it.
