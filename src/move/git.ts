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
import {
  extractBunTestArgs,
  parseBunTestDiscovery,
  parseTreeOutput,
} from "./rules.ts";
import type { TreeEntry } from "./rules.ts";

const defaultTimeoutMs = 15_000;
const defaultShutdownMs = 1_000;
const treeOutputLimitBytes = 16_777_216;
const blobOutputLimitBytes = 4_194_304;
const testOutputLimitBytes = 2_097_152;

export type ToolBinaries = {
  readonly git: ParsedPath;
  readonly tar: ParsedPath;
  readonly bun: ParsedPath;
};

export function resolveToolBinaries(
  parsePath: (raw: string) => ParsedPath,
):
  | { readonly ok: true; readonly binaries: ToolBinaries }
  | { readonly ok: false; readonly reason: string } {
  const git = Bun.which("git");
  if (git === null) {
    return { ok: false, reason: "git executable not found on PATH." };
  }
  const tar = Bun.which("tar");
  if (tar === null) {
    return { ok: false, reason: "tar executable not found on PATH." };
  }
  return {
    ok: true,
    binaries: {
      git: parsePath(git),
      tar: parsePath(tar),
      bun: parsePath(process.execPath),
    },
  };
}

async function runGit(
  programs: ProgramsCapability,
  git: ParsedPath,
  repo: string,
  args: readonly string[],
  outputLimitBytes: number,
) {
  return programs.inspect({
    executable: git,
    args: ["-C", repo, ...args],
    timeoutMilliseconds: defaultTimeoutMs,
    outputLimitBytes,
    shutdownMilliseconds: defaultShutdownMs,
  });
}

export async function resolveGitDir(
  programs: ProgramsCapability,
  git: ParsedPath,
  repo: string,
): Promise<
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
    repo,
    ["rev-parse", "--absolute-git-dir"],
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

export async function resolveCommit(
  programs: ProgramsCapability,
  git: ParsedPath,
  repo: string,
  rev: string,
): Promise<
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
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
  git: ParsedPath,
  repo: string,
  commit: string,
  folder: string,
): Promise<
  | { readonly ok: true; readonly entries: readonly TreeEntry[] }
  | { readonly ok: false; readonly reason: string }
> {
  const args =
    folder === ""
      ? ["ls-tree", "-r", "-z", commit]
      : ["ls-tree", "-r", "-z", commit, "--", folder];
  const result = await runGit(programs, git, repo, args, treeOutputLimitBytes);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: `Cannot list git tree at ${commit} in ${repo}: ${detail}`,
    };
  }
  return { ok: true, entries: parseTreeOutput(result.stdout, folder) };
}

export async function readBlobText(
  programs: ProgramsCapability,
  git: ParsedPath,
  repo: string,
  hash: string,
): Promise<string | null> {
  const result = await runGit(
    programs,
    git,
    repo,
    ["cat-file", "blob", hash],
    blobOutputLimitBytes,
  );
  if (result.exitCode !== 0 || result.stdout.includes("\0")) {
    return null;
  }
  return result.stdout;
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

export async function discoverTestFileCount(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  destinationRepo: string,
  commit: string,
): Promise<
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string }
> {
  const workDir = await mkdtemp(join(tmpdir(), "agent-gates-move-"));
  try {
    const archiveFile = join(workDir, "tree.tar");
    const treeDir = join(workDir, "tree");
    await mkdir(treeDir, { recursive: true });

    const archiveResult = await runGit(
      programs,
      binaries.git,
      destinationRepo,
      ["archive", "--format=tar", `--output=${archiveFile}`, commit],
      65_536,
    );
    if (archiveResult.exitCode !== 0) {
      const detail = archiveResult.stderr.trim() || archiveResult.stdout.trim();
      return {
        ok: false,
        reason: `Cannot export commit ${commit} from ${destinationRepo}: ${detail}`,
      };
    }

    const extractResult = await programs.inspect({
      executable: binaries.tar,
      args: ["-xf", archiveFile, "-C", treeDir],
      timeoutMilliseconds: defaultTimeoutMs,
      outputLimitBytes: 65_536,
      shutdownMilliseconds: defaultShutdownMs,
    });
    if (extractResult.exitCode !== 0) {
      const detail = extractResult.stderr.trim() || extractResult.stdout.trim();
      return {
        ok: false,
        reason: `Cannot extract archive for ${commit}: ${detail}`,
      };
    }

    const sourceNodeModules = resolve(destinationRepo, "node_modules");
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
    const extraArgs = extractBunTestArgs(packageJsonText);

    const testResult = await programs.inspect({
      executable: binaries.bun,
      args: ["test", "--cwd", treeDir, "-t", "(?!)", ...extraArgs],
      timeoutMilliseconds: defaultTimeoutMs,
      outputLimitBytes: testOutputLimitBytes,
      shutdownMilliseconds: defaultShutdownMs,
    });

    const combinedOutput = `${testResult.stdout}\n${testResult.stderr}`;
    return parseBunTestDiscovery(combinedOutput);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
