import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUiServer } from "../../src/ui/serve.js";
import { CHART_CONFIGS, parseBenchmark, type Benchmark } from "../../ui/data.js";

// Serves the repository like `npm run ui` and loads the committed results through HTTP,
// exactly as the page does.
let server: Server;
let base: string;
let data: Benchmark;

beforeAll(async () => {
  server = createUiServer(process.cwd());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/results/benchmark.json`);
  expect(res.status).toBe(200);
  data = parseBenchmark(await res.json());
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe("results UI", () => {
  it("serves the page and its loader", async () => {
    const page = await fetch(`${base}/ui/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('from "./data.js"');
    expect((await fetch(`${base}/ui/data.js`)).headers.get("content-type")).toMatch(/javascript/);
  });

  it("parses every query and main config from the current benchmark.json", () => {
    expect(data.queries.map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4"]);
    for (const q of data.queries) {
      for (const c of CHART_CONFIGS) {
        const cell = data.cells[q.id]![c]!;
        expect(cell.warm).toBeGreaterThan(0);
        expect(cell.min).toBeLessThanOrEqual(cell.warm);
        expect(cell.p95).toBeGreaterThanOrEqual(cell.warm);
      }
    }
    expect(data.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(data.meta.dirty).toBe(false);
  });

  it("headline ratios agree with the medians they summarize", () => {
    expect(data.headlines.map((h) => h.id)).toEqual(["model", "engine", "preagg"]);
    for (const h of data.headlines) {
      for (const p of h.perQuery) {
        const ratio = data.cells[p.query]![h.from]!.warm / data.cells[p.query]![h.to]!.warm;
        expect(p.warm).toBeCloseTo(ratio, 9);
      }
      expect(h.warmMin).toBeLessThanOrEqual(h.warmMax);
    }
  });

  it("every plan the viewer offers exists", async () => {
    expect(data.plans.length).toBe(4 * 6);
    for (const p of data.plans) {
      const res = await fetch(`${base}/${p.path}`);
      expect(res.status, p.path).toBe(200);
      expect(await res.text()).toMatch(/not benchmark results/);
    }
  });

  it("serves nothing outside ui/ and results/", async () => {
    for (const path of ["/package.json", "/src/ui/serve.ts", "/ui/../package.json", "/%2e%2e/package.json", "/.env"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
  });
});
