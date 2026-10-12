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
