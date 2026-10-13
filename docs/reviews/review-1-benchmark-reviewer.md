# Benchmark review #1 — raw findings

First run of the benchmark-reviewer instructions, executed as a general-purpose agent (the
definition was not yet registered under `.claude/agents/`). Reviewed commit `20a4c9e`.
Read-only: no fixes were applied by the reviewer. Numbering below is the reviewer's original
numbering; the fix commits and `docs/ai-log.md` should reference these numbers.

## Results at the time of review (warm, ratio of medians)

| Query | A→B (model) | B→C, 3 threads (engine) | B→C, 8 threads | B→B-MV |
|---|---|---|---|---|
| q1 | 1.6× | 20× | 45× | ~1,300× |
| q2 | 0.9× | 12× | 18× | ~1,500× |
| q3 | 0.9× | 18× | 23× | ~660× |
| q4 | 1.3× | 22× | 37× | ~690× |

## Findings

**1. Blocking — no README.md.** Check 6 ("reproducible by following the README") fails.
Undocumented: Docker/Compose, Node ≥ 20.12, port 5433, the `docker restart` dependency on the
container name, network access for extract, and the command order. `bench` on an empty database
fails with a cryptic "relation does not exist".

**2. Important — "warm" Postgres never holds the fact tables in shared_buffers.** Both tables
(458 MB and 415 MB) are larger than a quarter of the 1 GB buffer cache, so sequential scans use a
small recycled ring buffer instead of caching them. The plans show it: `q1_B hit=144 read=53014`.
Warm and cold differ only slightly for A and B. Skew: q3_A's index scan does fill the cache,
which partly warms q4_A.

**3. Important — DESIGN.md has no results section, and A→B contradicts "the model matters".**
B is slower on q2 and q3. The plans explain why:
- q3: A uses the timestamp index; B scans the whole fact table because Postgres can't push the
  dim_date filter into the scan (DuckDB can).
- q2: B groups by the text `area_name`, while A groups by a primary key alone.

**4. Important — saved plan timings contradict measured timings.** Per-row timing inside the VM
inflates them 1.2–2.5×, unevenly. The q2 plans make B look 1.8× faster, while measurements show A
is 13% faster.

**5. Minor — the embedded load report says jit=on.** The load ran before jit was pinned off; the
data isn't affected.

**6. Minor — B-MV medians (0.3–0.5 ms) are mostly client round trip.** Actual execution is
0.02–0.2 ms.

**7. Minor — B→C also includes running inside the VM versus natively on the host**, not just the
engine.

## Confirmed fine

- Verification logic, query semantics, and that the three configs hold the same data.
- No straw man: A has proper indexes and q3 actually uses one.
- Every config does equivalent work; B and C run identical SQL files.
- The statistics method, the pinned settings, and the same physical row order in all three fact
  tables.

## Mapping to the ai-log numbering

| Original # | Finding | ai-log # |
|---|---|---|
| 1 | No README | 4a |
| 2 | Warm Postgres not cached | 2 |
| 3 | No results section / q2 text grouping | 1 (+ DESIGN results section) |
| 4 | Plan timings inflated | 3 |
| 5 | Load report jit=on | 4b |
| 6 | B-MV bounded by round trip | 4c |
| 7 | VM vs native | 4d |

The ai-log's item "5 — results not from a clean tree" was not a finding of this review.
