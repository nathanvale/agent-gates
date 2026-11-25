import { expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/cli.ts");

export function assertNoEcho(
  ran: { readonly stdout: string; readonly stderr: string },
  secrets: readonly string[],
): void {
  const combined = `${ran.stdout}\n${ran.stderr}`;
  for (const secret of secrets) {
    expect(combined).not.toContain(secret);
  }
}

export type CliRunOptions = {
  readonly cwd: string;
  readonly pathPrefix?: string;
};

export function invokeHistoryScan(
  options: CliRunOptions,
  ...argv: string[]
): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const pathValue =
    options.pathPrefix === undefined
      ? (process.env.PATH ?? "")
      : `${options.pathPrefix}:${process.env.PATH ?? ""}`;
  const child = Bun.spawnSync(
    [process.execPath, "run", cli, "history", "scan", ...argv],
    {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: pathValue,
      },
    },
  );
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

export function invokeHistoryScanJson(
  options: CliRunOptions,
  ...argv: string[]
): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: unknown;
} {
  const ran = invokeHistoryScan(options, ...argv, "--json");
  const parsed: unknown = JSON.parse(ran.stdout);
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout,
    stderr: ran.stderr,
    envelope: parsed,
  };
}

export function writeFakeGh(binDir: string, scriptBody: string): string {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "gh");
  writeFileSync(scriptPath, `#!/bin/sh\n${scriptBody}\n`, "utf8");
  chmodSync(scriptPath, 0o755);
  return binDir;
}
