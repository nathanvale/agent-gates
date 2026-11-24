import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const rumdlBin = join(repoRoot, "node_modules/.bin/rumdl");

export const rumdlWarmupTimeoutMs = 30_000;

interface RumdlRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runRumdl(cwd: string, args: readonly string[]): RumdlRunResult {
  const run = Bun.spawnSync([rumdlBin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

export function warmRumdl(): void {
  const result = runRumdl(repoRoot, ["--version"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(
      `rumdl --version exited with code ${String(result.exitCode)}${suffix}`,
    );
  }
}
