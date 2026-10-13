# AI workflow

How this project was built with AI assistance, what the AI got wrong, and how each error was
caught. Sources: [docs/ai-log.md](docs/ai-log.md) (live log), [docs/reviews/](docs/reviews/) (raw
reviewer output) and the git history.

## Tools and setup

- **Claude Code** (Claude Opus, VS Code extension) wrote the code, SQL and docs.
- **`CLAUDE.md`** holds the project context: the hard constraints, the verified data facts, the
  approved cleaning rules and the benchmark rules. It is loaded at the start of every session.
- **`benchmark-reviewer` subagent** (`.claude/agents/`): a read-only reviewer for fairness and
  correctness. Review #2 ran in a session other than the one that wrote the code, so the reviewer
  had none of its context. Reviews #3 and #4 ran in the same session, as subagents with their own
  context and a neutral prompt that did not say what had changed.
- **Testcontainers** integration tests against a real Postgres 16, with no database mocks.
- **`docs/ai-log.md`**: one entry for every AI output that had to be corrected, written when it
  happened.

**Way of working:**
- The AI proposed a plan for each step, I approved or changed it, and only then was code written.
- One commit per logical step, made only after my approval.
- Nothing counted as done until it had been run and the output seen.

## Key prompts (verbatim)

1. **Verify before building** (first prompt):
   > Read CLAUDE.md. Before writing any code, fetch the column dictionary for dataset ajtu-isnz and
   > pull a sample of 5 rows from the API to confirm real column names, types and nulls. Based on
   > that, propose: (1) the 3NF OLTP schema, (2) the star schema, and (3) a paginated, idempotent
   > ingestion strategy with estimated volume and runtime. Flag any mismatch between what
   > CLAUDE.md assumes and what the real data shows. Do not write any files yet.

2. **Decisions after review #1** (first line of a longer prompt). Quoted because this is where an
   unsupported claim entered the project (see error 6 below):
   > Finding 2: pre-warm with pg_prewarm, one table at a time, immediately before each config’s
   > warm runs. Rationale for DESIGN.md: this gives Postgres its best case, so the engine gap we
   > report is conservative.

3. **Independent review, read-only:**
   > Run the benchmark-reviewer agent on the benchmark at HEAD. Postgres is running on port 5433
   > for read-only checks. The results in results/ come from a clean run of commit aee7472. Report
   > its findings verbatim with severities. Don’t fix anything.

4. **Stopping rule, set before the final run:**
   > Stopping rule: if the idle check gives DuckDB about 18 ms and Postgres stays tight, the next
   > full run is final whatever it shows; remaining noise gets documented, not tuned. Keep the
   > headline statistic as decided.

## Main AI errors and how each was caught

| # | What the AI produced | What was wrong | Caught by |
|---|---|---|---|
| 1 | Data assumptions in CLAUDE.md, from general knowledge | Negative fares, duplicate trips, revenue as a sum of parts, a 40-char taxi id: all false | Live API profiling (SoQL aggregates) before any schema |
| 2 | Load step (SQL and the DuckDB loader) | `DISTINCT` with a collated `ORDER BY`; duplicate columns after `ATTACH` (in `build-duckdb.ts`) | Testcontainers integration test |
| 3 | Star q2 | Grouped by a text column; A grouped by a primary key | Reviewer #1, reading the plans |
| 4 | "Warm" Postgres runs | Fact tables bypassed `shared_buffers` (ring buffer, `read=` in the plans) | Reviewer #1 |
| 5 | Plans with per-node timing | Timing overhead inflated times 1.2–2.5x, unevenly | Reviewer #1 |
| 6 | "The engine gap is conservative" | Unsupported: VM vs native and JIT were uncontrolled. It came from my prompt (prompt 2) and the AI repeated it in the code and docs | Reviewer #2, fresh session |
| 7 | ai-log numbering | Diverged from the review's numbering, so one finding became untraceable | Reviewer #2; fixed by committing the raw reviews |
| 8 | "B with jit=on" taken literally | JIT never engaged, because B's plan costs were under the threshold | The AI's own `jitUsed` check in the smoke run. The AI deviated from the instruction, and the deviation is logged |
| 9 | Back-to-back timed runs | Thermal throttling on a fanless laptop: warm medians above restart medians in 6 of 8 cells | Reviewer #3, neutral prompt |
| 10 | The fix for 9 (a pause before every run) | Added a 2–7 ms CPU wake-up cost to every sample, which biased the result against DuckDB | The AI compared the run with the previous one before committing, then ran an isolated timing test |

**Patterns:**
- The AI's errors came from plausible defaults: assumed data, a ready-made justification, a fix
  that solved one bias and added another.
- Most were caught by evidence the setup already produced: plans, a sample-by-sample comparison of
  two series, the `jitUsed` flag. Re-reading the code would not have found them.
- A reviewer without the author's context caught the claims that the authoring session took for
  granted.

## How the results were verified

- **The same answers everywhere, before any timing.** Every query's result in every config is
  compared with config A (numbers within 1e-6, text exactly), or the run aborts. `load` also fails
  unless A, B and C have identical fact checksums.
- **Provenance.** Every published run was made from a clean commit, and `results/benchmark.json`
  records that commit and `dirty: false`. Results are committed separately from code.
- **The plans back the claims.** No Postgres plan reads from disk, every B-jit plan contains JIT,
  and each plan detail `docs/BENCHMARK.md` quotes is checked against `results/plans/`.
- **Four independent reviews**, with their raw output committed. Each finding was fixed or
  documented. Reviews #2 and #3 verified the previous fixes; review #4 checked that every number
  and claim in the docs and UI matches the results and the code.
- **Methodology changed only for a demonstrated cause**, never because of where the results
  pointed:
  - pre-warming, because plans showed `read=` buffers;
  - the cool-down, because of the drifting samples;
  - pausing per block, because of the isolated wake-up timing.
- **Decided before the final run:** the headline statistic (warm median, with the restart median
  and warm min beside it) and the stopping rule. The final run was published as measured, and the
  remaining B-MV noise is documented in [docs/BENCHMARK.md](docs/BENCHMARK.md).
