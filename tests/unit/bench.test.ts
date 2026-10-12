import { describe, expect, it } from "vitest";
import { compareResults, normalizeRows } from "../../src/bench/compare.js";
import { quarterParams, renderSql } from "../../src/bench/queries.js";
import { median, percentile } from "../../src/bench/stats.js";

describe("stats", () => {
  it("median handles odd and even sample sizes", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("p95 is nearest-rank: with 10 samples it is the maximum", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 50)).toBe(5);
  });
});

describe("compareResults", () => {
  const pg = normalizeRows([{ year: 2025, month: 1, trips: "424113", revenue: "11223344.55", avg_fare: "17.123456789012345678" }]);
  it("treats Postgres numeric strings and DuckDB doubles as equal within tolerance", () => {
    const duck = normalizeRows([{ year: 2025, month: 1, trips: "424113", revenue: "11223344.55", avg_fare: 17.12345678901234 }]);
    expect(compareResults(pg, duck)).toEqual({ ok: true });
  });
  it("fails on a real difference and says where", () => {
    const off = normalizeRows([{ year: 2025, month: 1, trips: "424114", revenue: "11223344.55", avg_fare: 17.1234567 }]);
    expect(compareResults(pg, off)).toMatchObject({ ok: false, reason: expect.stringContaining("column trips") });
  });
  it("fails on different columns or row counts", () => {
    expect(compareResults(pg, normalizeRows([{ yr: 2025 }])).ok).toBe(false);
    expect(compareResults(pg, normalizeRows([])).ok).toBe(false);
  });
  it("is order-sensitive unless a sort key is given", () => {
    const a = normalizeRows([{ k: "B", v: 1 }, { k: "a", v: 2 }]);
    const b = normalizeRows([{ k: "a", v: 2 }, { k: "B", v: 1 }]);
    expect(compareResults(a, b).ok).toBe(false);
    expect(compareResults(a, b, ["k"])).toEqual({ ok: true });
  });
});

describe("query parameters", () => {
  it("renders quarter bounds as half-open timestamp literals", () => {
    expect(quarterParams("2025-Q2")).toEqual({
      quarter_start: "TIMESTAMP '2025-04-01 00:00:00'",
      quarter_end: "TIMESTAMP '2025-07-01 00:00:00'",
      quarter_year: "2025",
      quarter: "2",
    });
    expect(quarterParams("2024-Q4").quarter_end).toBe("TIMESTAMP '2025-01-01 00:00:00'");
  });
  it("refuses unknown placeholders", () => {
    expect(() => renderSql("WHERE x = {{nope}}", {})).toThrow(/nope/);
  });
});
