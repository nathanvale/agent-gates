import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { parseTreeOutput } from "./rules.ts";
import type { TreeEntry } from "./rules.ts";
import { parseBunTestDiscovery, resolveBunTestScript } from "./test-script.ts";

const defaultTimeoutMs = 15_000;
const defaultShutdownMs = 1_000;
export const defaultTreeOutputLimitBytes = 16_777_216;
const blobOutputLimitBytes = 4_194_304;
const testOutputLimitBytes = 2_097_152;

export const strippedGitEnvVars = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

const unsetGitEnvArgs = strippedGitEnvVars.flatMap((name) => ["-u", name]);

export type ToolBinaries = {
  readonly env: ParsedPath;
  readonly git: ParsedPath;
  readonly bun: ParsedPath;
};

export function resolveToolBinaries(
  parsePath: (raw: string) => ParsedPath,
):
  | { readonly ok: true; readonly binaries: ToolBinaries }
  | { readonly ok: false; readonly reason: string } {
  const env = Bun.which("env");
  if (env === null) {
    return { ok: false, reason: "env executable not found on PATH." };
  }
  const git = Bun.which("git");
  if (git === null) {
    return { ok: false, reason: "git executable not found on PATH." };
  }
  return {
    ok: true,
    binaries: {
      env: parsePath(env),
      git: parsePath(git),
      bun: parsePath(process.execPath),
    },
  };
}

async function runGitWithEnv(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  extraEnv: readonly string[],
  args: readonly string[],
  outputLimitBytes: number,
) {
  return programs.inspect({
    executable: binaries.env,
    args: [...unsetGitEnvArgs, ...extraEnv, binaries.git, ...args],
    timeoutMilliseconds: defaultTimeoutMs,
    outputLimitBytes,
    shutdownMilliseconds: defaultShutdownMs,
  });
}

async function runGit(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  args: readonly string[],
  outputLimitBytes: number,
) {
  return runGitWithEnv(
    programs,
    binaries,
    [],
    ["-C", repo, ...args],
    outputLimitBytes,
  );
}

async function resolveGitDirByFlag(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  flag: "--git-common-dir" | "--git-dir",
): Promise<
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    binaries,
    repo,
    ["rev-parse", "--path-format=absolute", flag],
    65_536,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: `Cannot resolve git directory for ${repo}: ${detail}`,
    };
  }
  return { ok: true, gitDir: result.stdout.trim() };
}

export async function resolveGitDir(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
): Promise<
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly reason: string }
> {
  return resolveGitDirByFlag(programs, binaries, repo, "--git-common-dir");
}

async function resolveRepoGitDir(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
): Promise<
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly reason: string }
> {
  return resolveGitDirByFlag(programs, binaries, repo, "--git-dir");
}

async function resolveRepoTopLevel(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
): Promise<string> {
  const result = await runGit(
    programs,
    binaries,
    repo,
    ["rev-parse", "--show-toplevel"],
    65_536,
  );
  if (result.exitCode !== 0) return repo;
  const topLevel = result.stdout.trim();
  return topLevel.length > 0 ? topLevel : repo;
}

export async function resolveCommit(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  rev: string,
): Promise<
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    binaries,
    repo,
    ["rev-parse", "--verify", `${rev}^{commit}`],
    65_536,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: `Cannot resolve commit ${rev} in ${repo}: ${detail}`,
    };
  }
  return { ok: true, commit: result.stdout.trim() };
}

export async function listTree(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  commit: string,
  folder: string,
  outputLimitBytes = defaultTreeOutputLimitBytes,
): Promise<
  | { readonly ok: true; readonly entries: readonly TreeEntry[] }
  | { readonly ok: false; readonly reason: string }
> {
  const args =
    folder === ""
      ? ["ls-tree", "-r", "-z", "--full-tree", commit]
      : ["ls-tree", "-r", "-z", "--full-tree", commit, "--", folder];
  const result = await runGit(programs, binaries, repo, args, outputLimitBytes);
  if (result.outputTruncated) {
    return {
      ok: false,
      reason: `Git tree listing at ${commit} in ${repo} exceeded the ${String(outputLimitBytes)} byte output limit.`,
    };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: `Cannot list git tree at ${commit} in ${repo}: ${detail}`,
    };
  }
  return { ok: true, entries: parseTreeOutput(result.stdout, folder) };
}

export type BlobReadResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "unreadable"; readonly reason: string };

export async function readBlobText(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  hash: string,
): Promise<BlobReadResult> {
  const result = await runGit(
    programs,
    binaries,
    repo,
    ["cat-file", "blob", hash],
    blobOutputLimitBytes,
  );
  if (result.stdout.includes("\0")) {
    return { kind: "binary" };
  }
  if (result.outputTruncated) {
    return { kind: "unreadable", reason: "exceeded 4 MiB read limit" };
  }
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || `exit code ${String(result.exitCode)}`;
    return { kind: "unreadable", reason: detail };
  }
  return { kind: "text", text: result.stdout };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exportCommitTree(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  destinationRepo: string,
  commit: string,
  workDir: string,
  treeDir: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  const gitDirResult = await resolveRepoGitDir(
    programs,
    binaries,
    destinationRepo,
  );
  if (!gitDirResult.ok) return gitDirResult;

  const tempIndex = join(workDir, "export.index");
  const indexEnv = [`GIT_INDEX_FILE=${tempIndex}`];

  const readTreeResult = await runGitWithEnv(
    programs,
    binaries,
    indexEnv,
    [`--git-dir=${gitDirResult.gitDir}`, "read-tree", commit],
    65_536,
  );
  if (readTreeResult.exitCode !== 0) {
    const detail = readTreeResult.stderr.trim() || readTreeResult.stdout.trim();
    return {
      ok: false,
      reason: `Cannot export commit ${commit} from ${destinationRepo}: ${detail}`,
    };
  }

  const checkoutResult = await runGitWithEnv(
    programs,
    binaries,
    indexEnv,
    [
      `--git-dir=${gitDirResult.gitDir}`,
      `--work-tree=${treeDir}`,
      "checkout-index",
      "-a",
      "-f",
    ],
    65_536,
  );
  if (checkoutResult.exitCode !== 0) {
    const detail = checkoutResult.stderr.trim() || checkoutResult.stdout.trim();
    return {
      ok: false,
      reason: `Cannot export commit ${commit} from ${destinationRepo}: ${detail}`,
    };
  }
  return { ok: true };
}

export type TestDiscoveryResult =
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export async function discoverTestFileCount(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  destinationRepo: string,
  commit: string,
): Promise<TestDiscoveryResult> {
  const workDir = await mkdtemp(join(tmpdir(), "agent-gates-move-"));
  try {
    const treeDir = join(workDir, "tree");
    await mkdir(treeDir, { recursive: true });

    const exported = await exportCommitTree(
      programs,
      binaries,
      destinationRepo,
      commit,
      workDir,
      treeDir,
    );
    if (!exported.ok) {
      return { kind: "failed", reason: exported.reason };
    }

    const repoRoot = await resolveRepoTopLevel(
      programs,
      binaries,
      destinationRepo,
    );
    const sourceNodeModules = resolve(repoRoot, "node_modules");
    const targetNodeModules = join(treeDir, "node_modules");
    if (
      (await pathExists(sourceNodeModules)) &&
      !(await pathExists(targetNodeModules))
    ) {
      await symlink(sourceNodeModules, targetNodeModules, "dir");
    }

    const packageJsonText = await readOptionalFile(
      join(treeDir, "package.json"),
    );
    const resolvedScript = resolveBunTestScript(packageJsonText);
    if (resolvedScript.kind === "unsupported") {
      return { kind: "unsupported", reason: resolvedScript.reason };
    }

    const testResult = await programs.inspect({
      executable: binaries.bun,
      args: ["test", "--cwd", treeDir, "-t", "(?!)", ...resolvedScript.args],
      timeoutMilliseconds: defaultTimeoutMs,
      outputLimitBytes: testOutputLimitBytes,
      shutdownMilliseconds: defaultShutdownMs,
    });

    const combinedOutput = `${testResult.stdout}\n${testResult.stderr}`;
    const parsed = parseBunTestDiscovery(combinedOutput);
    if (!parsed.ok) {
      return { kind: "failed", reason: parsed.reason };
    }
    return { kind: "count", count: parsed.count };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
