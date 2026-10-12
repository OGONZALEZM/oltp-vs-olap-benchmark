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
