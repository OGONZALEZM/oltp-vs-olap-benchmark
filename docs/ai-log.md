# AI usage log

Live log. One entry every time the AI generates something that had to be corrected, or a check
(test, benchmark-reviewer, manual review) catches an error. This is the raw material for
`AI_WORKFLOW.md`.

## Template

### [time] Short title
- **Prompt / context:** what was asked.
- **What the AI generated:** summary.
- **What was wrong:** the concrete error.
- **How it was caught:** test, verification query, EXPLAIN, manual review, subagent.
- **Fix:** what changed (commit).

---

### 09:15 Stack and data source selection
- **Prompt / context:** initial analysis of the assessment with Claude.
- **Decision:** PokéAPI was ruled out (a catalog with no time dimension and no transactions; the
  fact table would have been 100% synthetic) in favor of Chicago Taxi Trips (2024-), real data
  with time, geography and payments. TypeScript over Python and Kotlin for speed of verification
  under a same-day deadline.
- **Benchmark design:** three configs (Postgres 3NF / Postgres star / DuckDB star) to separate the
  effect of the model from the effect of the engine.

### 12:45 CLAUDE.md data assumptions checked against the live API
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

### 13:45 Load step: two SQL bugs caught by the Testcontainers integration test
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

### 19:10 Benchmark reviewed: benchmark-reviewer ran as a general-purpose agent
- **Prompt / context:** run the `benchmark-reviewer` subagent on the first benchmark (commit 20a4c9e).
- **What happened:** the reviewer definition lived in `docs/benchmark-reviewer.md`, not in
  `.claude/agents/`, so it was not a registered agent type. The first review ran as a
  general-purpose agent with that file's instructions passed verbatim (read-only).
- **Fix:** moved to `.claude/agents/benchmark-reviewer.md`; the second review runs as the
  registered type.

### 19:10 Reviewer findings on the AI-generated benchmark
- **What the AI generated:** `src/bench/`, `sql/queries/`, the method section of DESIGN.md.
- **What was wrong (caught by benchmark-reviewer, confirmed against plans and catalog):**
  1. **q2 star grouping by text.** B's q2 grouped by `a.community_area_id, a.area_name`. In
     `dim_area` the primary key is `area_key` (`community_area_id` is only UNIQUE), so Postgres
     hashed the text `area_name` on every row, while A grouped by `community_areas`' primary key
     alone (functional dependency drops `name`). An unfair per-row cost on B, not a model effect.
     Fixed: `GROUP BY a.area_key, ...`; plan now shows `Group Key: a.area_key`. B is still 0.9x
     of A on q2: the asymmetry was real but not the whole story.
  2. **"Warm" Postgres was not warm.** Both fact tables exceed `shared_buffers / 4`, so seq scans
     use a ring buffer and never cache them; warm plans showed `read=58591`. Fixed with
     `pg_prewarm` per config before warm runs and plan capture; all plans now show hits only.
  3. **Plan timings contradicted measurements.** `EXPLAIN ANALYZE` per-node timing in the VM
     inflated times 1.2–2.5x unevenly (q2 plans implied B 1.8x faster; measured A 13% faster).
     Fixed: `TIMING OFF`, plans labelled as shape/rows/buffers only.
  4. No README (reproducibility check blocking); load-report metadata showed `jit=on` from a load
     before `jit=off` was pinned; B-MV ratios were round-trip bound without saying so; B→C did not
     mention VM vs native execution. Fixed: README, reload before the final run, `SELECT 1`
     baseline recorded, DESIGN notes.
- **How it was caught:** benchmark-reviewer subagent reading `results/plans/` and catalog sizes.
- **Fix:** commits aee7472 (code) and the following docs commit; results re-run from a clean tree.
