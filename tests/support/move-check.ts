import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { strippedGitEnvVars } from "../../src/move/git.ts";

const cli = join(import.meta.dir, "../../src/cli.ts");

function resolveGit(): string {
  const path = Bun.which("git");
  if (path === null) {
    throw new Error("git is required to run move-check tests.");
  }
  return path;
}

const gitBinary = resolveGit();

function cleanGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of strippedGitEnvVars) {
    delete env[key];
  }
  return env;
}

export function runGit(repo: string, args: readonly string[]): string {
  const child = Bun.spawnSync([gitBinary, "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    env: {
      ...cleanGitEnv(),
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (child.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(child.exitCode)}): ${child.stderr.toString()}`,
    );
  }
  return child.stdout.toString().trim();
}

export function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Test Author"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
}

export function writeFiles(
  repo: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(repo, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
}

export function commitAll(repo: string, message: string): string {
  runGit(repo, ["add", "--all"]);
  runGit(repo, ["commit", "-m", message, "--allow-empty"]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

export function blobHash(repo: string, rev: string, path: string): string {
  return runGit(repo, ["rev-parse", `${rev}:${path}`]);
}

export function repoSnapshot(repo: string) {
  return {
    status: runGit(repo, ["status", "--porcelain"]),
    head: runGit(repo, ["rev-parse", "HEAD"]),
    worktrees: runGit(repo, ["worktree", "list"]),
  };
}

function invokeMoveCheck(...argv: string[]) {
  const child = Bun.spawnSync(
    [process.execPath, "run", cli, "move", "check", ...argv],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

export function invokeMoveCheckJson(...argv: string[]) {
  const ran = invokeMoveCheck(...argv, "--json");
  const parsed: unknown = JSON.parse(ran.stdout);
  return { exitCode: ran.exitCode, stderr: ran.stderr, envelope: parsed };
}
