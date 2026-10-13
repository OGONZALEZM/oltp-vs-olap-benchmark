/**
 * npm run ui [-- --port 8080]
 *
 * Minimal static server for ui/: the page fetches results/benchmark.json and results/plans/*.txt,
 * which browsers block over file://. Serves only ui/ and results/, read-only.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const ALLOWED = ["ui", "results"];

export function createUiServer(root: string): Server {
  const base = resolve(root);
  return createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (path === "/" || path === "/ui") {
      res.writeHead(302, { location: "/ui/" }).end();
      return;
    }
    const rel = normalize(path.endsWith("/") ? `${path}index.html` : path).replace(/^[/\\]+/, "");
    const file = join(base, rel);
    if (!file.startsWith(base + sep) || !ALLOWED.includes(rel.split(/[/\\]/)[0]!)) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8080" } } });
  const port = Number(values.port);
  createUiServer(process.cwd()).listen(port, "127.0.0.1", () => {
    console.log(`Results UI: http://localhost:${port}/ui/  (Ctrl+C to stop)`);
  });
}
