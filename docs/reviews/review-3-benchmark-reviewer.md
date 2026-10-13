# Benchmark review #3 — raw output

Third review, run as the registered `benchmark-reviewer` agent type with a neutral prompt that did
not list what had changed. Reviewed HEAD `53abfc1`; the results in `results/` came from a clean
run of `8c320e1`. Read-only. The reviewer's output is reproduced verbatim below.

---

## Benchmark review #3: HEAD 53abfc1, results from run 8c320e1

**Summary:** nothing blocks the benchmark. Results are equivalent across configs, the OLTP side is properly indexed, no config does less work, and the plans support DESIGN.md. There is one important problem: the headline warm medians for Postgres come from the noisier of the two measurement series, so the reported B→C range is too high at its low end. There are three minor findings. I modified no files, ran only read-only queries (`default_transaction_read_only=on`; DuckDB opened `READ_ONLY`), and did not run the benchmark.

**Provenance:** metadata says commit 8c320e1 with `dirty: false`. The run started 7 s after that commit. Between 8c320e1 and HEAD the only code change is one wording string in `src/bench/index.ts:274`. `results/benchmark.json` was not hand-edited after the run.

### Findings

**1. Important: the headline numbers come from the noisy series, and the data contradict "warm is the best case for Postgres".**
- **Where:** `README.md:19-27`, `DESIGN.md:69-79`, `:122-127`, `:155`, `:169-178`; `src/bench/index.ts:145-163`.
- **Evidence:** in `results/benchmark.json`, the Postgres restart runs (empty buffer pool) have a lower median than the warm runs in 6 of 8 A/B cells. The restart samples are tight; the warm samples are not:
  - q2 B: warm `[340, 474, 372, 433, 459, 558, 427, 442, 493, 352]`, restart `[350, 348, 345, 350, 361, 361, 379, 352, 350, 347]`.
  - q4 A: warm median 586.8 ms, restart median 478.7 ms.
  - Pre-warming shows no measurable benefit, so the extra warm-run time is not about the cache. A likely cause is the host, Mac15,13 (a fanless MacBook Air M3). Warm runs execute back to back with 3 cores busy for about 18 s per config, while restart runs get seconds of idle time between them. DuckDB 8-thread runs drift the same way: q2 C-8t climbs from 18.8 to 27.8 ms, and q3 C-8t falls from 19.3 to 13.1 ms.
- **How the ratios move:**

| Ratio | Warm medians (published) | Restart medians | Warm minimums |
|---|---|---|---|
| B→C, 3 threads | 12.2–22.3x | 9.4–18.4x | 9.6–20.6x |
| A→B, q4 | 1.61x | 1.38x | — |
| A→B, q3 | — | 0.99x | — |

  - The B→C low end falls below 10x on q2, which matters for "cannot account for a 10x gap" (`DESIGN.md:211`).
  - DESIGN.md:155 says "q3: A wins (0.9x)", but restart gives 0.99x. A reading fewer buffers (37,424 vs 53,194) is real, but the size of the win is not robust.
- **Why it matters:** the direction holds, but the magnitudes and the "best case" wording rest on the series with the most noise, and that noise varies systematically by config.
- **Fix:**
  - Put the restart medians (or warm minimums) next to the warm medians in the headline, and quote B→C as about 9–22x.
  - Add the observation "Postgres warm medians exceeded restart medians in 6/8 cells".
  - Optionally add a cool-down between warm runs or run configs round-robin, then re-run.

**2. Minor: "DuckDB medians sit within 9% of their minimums" is true only for C-3t.**
- **Where:** `DESIGN.md:130-131`.
- **Evidence:** C-8t q2 is 18.2 → 22.0 ms (+21%) and q3 is 13.1 → 16.8 ms (+28%). The C-8t q3 restart median (12.3 ms) is below its warm minimum.
- **Fix:** say "C-3t" explicitly, or give the C-8t spread too.

**3. Minor: the JIT sensitivity row covers B only, but at default settings JIT would engage on A and not on B.**
- **Where:** `DESIGN.md:101-107`.
- **Evidence:** the top-level plan costs are q1_A 109,296 and q4_A 105,570, both above the default `jit_above_cost` of 100,000. All B costs are 83.5k–89.2k.
- **Why it matters:** A→B under the pinned `jit=off` is a fair comparison at equal settings, but "what that choice costs Postgres" is bounded for B only. The B-jit result (0.9–1.0x on q1/q4) suggests the effect on A is small.
- **Fix:** one sentence in DESIGN.md, or add an A-jit sensitivity row.

**4. Minor: the committed results file carries the old JIT wording.**
- **Where:** `results/benchmark.json` `metadata.method.warm`.
- **Evidence:** it still says "native vs VM and JIT are not controlled", while README, DESIGN and the code at HEAD say JIT is bounded by B-jit. This is honest provenance (no hand edit), but the file disagrees with the docs until the next run.
- **Fix:** regenerate it on the next run. Nothing else is needed.

### Checked and fine
- **Result equivalence:**
  - Verification runs every query once in every config, including B-MV and B-jit, before any timing, and aborts on mismatch (`src/bench/index.ts:96-125`). Numbers are compared within absolute tolerance 1e-6 and text exactly. Exact order is enforced for q1, q2 and q4; q3 is sorted by its unique (payment_type, company) key.
  - I re-ran q1 and q2 myself in A (psql) and C (DuckDB). Counts and revenue match exactly and averages agree to about 1e-14.
  - No time zones are involved anywhere: timestamps are `timestamp` without time zone, and dim_date and dim_time come from the same local wall time.
  - Nulls are handled the same way everywhere: unknown pickup areas are excluded explicitly in every config (92,052 rows: NULL in A, key 0 in B and C), and the 309 NULL `trip_seconds` are ignored by `avg` in A/B/C and by the `n_seconds` count in the MV.
- **No straw man:** A has an index on every FK plus `trip_start_timestamp`. The live catalog matches `sql/oltp/constraints.sql` and `sql/star/constraints.sql` exactly, with no leftover indexes. A uses its timestamp index on q3 (`Parallel Index Scan using trips_start_ts_idx`).
- **Equivalent work:**
  - Same filters and `LIMIT 10` in every q2.
  - The MVs are a separate B-MV row, rebuilt on every bench run, with build time reported.
  - The DuckDB file holds only the 7 star tables: no indexes, views or precomputed objects. Its row counts and checksums are identical to A and B.
  - Physical order is the same in all three (pg_stats correlation 0.99999 / 1.0).
- **Measurement:**
  - 1 warm-up plus 10 timed runs, with median, nearest-rank p95 and min.
  - Restart is clearly labelled "empty buffer pool, not cold".
  - Connection setup and DuckDB instance creation are outside the timer. Row conversion is inside it for both engines. The `SELECT 1` floor is recorded.
  - Thread budget is matched (C-3t vs leader + 2 workers).
- **Plans:**
  - All 16 Postgres plans show `shared hit` only, no `read`.
  - Every B-jit plan contains a JIT section.
  - Group keys quoted in DESIGN match the plans (A `EXTRACT(...)` vs B `d.year, d.month`; q2 `ca.community_area_id` vs `a.area_key`).
  - q3 B reads 1,101,627 rows × 3 loops and discards 43% in the date join, as DESIGN says.
  - The DuckDB q3 plan shows the claimed `Dynamic Filters` on `date_key`.
  - The "83k–89k" B cost claim is correct.
  - Pre-warm sizes (A 15 relations / 592 MB, B 18 relations / 548 MB) match the recorded relations.
- **Reproducibility (read-only checks):**
  - `package-lock.json` is committed and `data/` and `.env` are git-ignored.
  - `npm run typecheck` passes and `vitest run tests/unit` passes (19/19).
  - The README step order matches the scripts, and the preflight check gives clear errors.
  - The live server settings match the compose file and the metadata.
  - I did not do an end-to-end run from scratch; that was not permitted.

### Relevant files
- /Users/oscargonzalez/Documents/oltp-vs-olap/results/benchmark.json
- /Users/oscargonzalez/Documents/oltp-vs-olap/results/plans/
- /Users/oscargonzalez/Documents/oltp-vs-olap/DESIGN.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/README.md
- /Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/index.ts
- /Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/sessions.ts
- /Users/oscargonzalez/Documents/oltp-vs-olap/src/bench/compare.ts
