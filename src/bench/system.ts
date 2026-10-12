import { execFile } from "node:child_process";
import { release } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    return (await execFileP(cmd, args)).stdout.trim();
  } catch {
    return "unavailable";
  }
}

export async function hostInfo() {
  const sysctl = (key: string) => run("sysctl", ["-n", key]);
  const memBytes = Number(await sysctl("hw.memsize"));
  return {
    chip: await sysctl("machdep.cpu.brand_string"),
    ramGiB: Number.isFinite(memBytes) ? Math.round(memBytes / 2 ** 30) : null,
    logicalCpus: Number(await sysctl("hw.ncpu")),
    performanceCores: Number(await sysctl("hw.perflevel0.physicalcpu")),
    efficiencyCores: Number(await sysctl("hw.perflevel1.physicalcpu")),
    os: `Darwin ${release()}`,
    node: process.version,
  };
}

/** Postgres runs inside the Docker VM, whose CPU and memory are what Postgres actually gets. */
export async function dockerInfo() {
  const raw = await run("docker", ["info", "--format", "{{json .}}"]);
  try {
    const info = JSON.parse(raw) as { OperatingSystem: string; ServerVersion: string; NCPU: number; MemTotal: number };
    return {
      runtime: info.OperatingSystem,
      serverVersion: info.ServerVersion,
      vmCpus: info.NCPU,
      vmMemoryGiB: Math.round((info.MemTotal / 2 ** 30) * 10) / 10,
    };
  } catch {
    return { runtime: "unavailable" };
  }
}

export async function gitInfo() {
  const commit = await run("git", ["rev-parse", "HEAD"]);
  // results/ is the benchmark's own output, so it does not count as a dirty tree.
  const dirty = (await run("git", ["status", "--porcelain", "--", ".", ":!results"])) !== "";
  return { commit, dirty };
}
