import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  commitMarkerPrefix,
  parseAddedPaths,
  parseCommitMessages,
  parseOriginSlug,
} from "./rules.ts";
import type { CommitAddedPath, CommitMeta } from "./rules.ts";

const defaultTimeoutMs = 30_000;
const defaultShutdownMs = 1_000;
const smallOutputLimitBytes = 262_144;
const messagesOutputLimitBytes = 16_777_216;
const diffOutputLimitBytes = 67_108_864;
const gitLogConfigArgs: readonly string[] = [
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.renames=true",
];

export function resolveGitBinary(
  parsePath: (raw: string) => ParsedPath,
):
  | { readonly ok: true; readonly git: ParsedPath }
  | { readonly ok: false; readonly reason: string } {
  const git = Bun.which("git");
  if (git === null) {
    return { ok: false, reason: "git executable not found on PATH." };
  }
  return { ok: true, git: parsePath(git) };
}

async function runGit(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
  args: readonly string[],
  outputLimitBytes: number,
) {
  return programs.inspect({
    executable: git,
    args: ["-C", cwd, ...args],
    timeoutMilliseconds: defaultTimeoutMs,
    outputLimitBytes,
    shutdownMilliseconds: defaultShutdownMs,
  });
}

export async function verifyGitRepository(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
    cwd,
    ["rev-parse", "--git-dir"],
    smallOutputLimitBytes,
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `Current folder is not a git repository (git rev-parse exited with code ${String(result.exitCode)}). Run \`git rev-parse --git-dir\` to see the detail.`,
    };
  }
  return { ok: true };
}

export async function resolveRangeCommits(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
  base: string,
  head: string,
): Promise<
  | { readonly ok: true; readonly commits: readonly CommitMeta[] }
  | {
      readonly ok: false;
      readonly kind: "range-missing" | "precondition";
      readonly reason: string;
    }
> {
  const rangeEnds: readonly { readonly label: string; readonly rev: string }[] =
    [
      { label: "base", rev: base },
      { label: "head", rev: head },
    ];
  for (const end of rangeEnds) {
    const verified = await runGit(
      programs,
      git,
      cwd,
      ["rev-parse", "--verify", `${end.rev}^{commit}`],
      smallOutputLimitBytes,
    );
    if (verified.exitCode !== 0) {
      return {
        ok: false,
        kind: "range-missing",
        reason: `Cannot resolve the ${end.label} commit in --range (git rev-parse exited with code ${String(verified.exitCode)}). Run \`git rev-parse --verify <ref>^{commit}\` to see the detail. The working tree is never scanned.`,
      };
    }
  }

  const logResult = await runGit(
    programs,
    git,
    cwd,
    [
      ...gitLogConfigArgs,
      "log",
      "--no-color",
      "-z",
      "--format=%H%x00%h%x00%B",
      `${base}..${head}`,
    ],
    messagesOutputLimitBytes,
  );
  if (logResult.outputTruncated) {
    return {
      ok: false,
      kind: "precondition",
      reason: "Commit message log output exceeded the 16 MiB read limit.",
    };
  }
  if (logResult.exitCode !== 0) {
    return {
      ok: false,
      kind: "precondition",
      reason: `git log failed while reading commit messages (exit code ${String(logResult.exitCode)}). Run \`git log --oneline <base>..<head>\` to see the detail.`,
    };
  }

  const commits = parseCommitMessages(logResult.stdout);
  if (commits.length === 0) {
    return {
      ok: false,
      kind: "range-missing",
      reason:
        "The --range selects no commits. The working tree is never scanned.",
    };
  }

  return { ok: true, commits };
}

export async function readRangeAddedPaths(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
  base: string,
  head: string,
): Promise<
  | { readonly ok: true; readonly paths: readonly CommitAddedPath[] }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
    cwd,
    [
      ...gitLogConfigArgs,
      "log",
      `--format=${commitMarkerPrefix}%h`,
      "--name-status",
      "-z",
      "-M",
      "-C",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-merges=cc",
      `${base}..${head}`,
    ],
    messagesOutputLimitBytes,
  );
  if (result.outputTruncated) {
    return {
      ok: false,
      reason: "Commit path listing exceeded the 16 MiB read limit.",
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `git log --name-status failed while reading commit paths (exit code ${String(result.exitCode)}). Run \`git log --name-status <base>..<head>\` to see the detail.`,
    };
  }
  return parseAddedPaths(result.stdout);
}

export async function readRangeDiff(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
  base: string,
  head: string,
): Promise<
  | { readonly ok: true; readonly diff: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
    cwd,
    [
      ...gitLogConfigArgs,
      "log",
      `--format=${commitMarkerPrefix}%H%x00%h`,
      "-p",
      "--unified=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--text",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "--diff-merges=cc",
      `${base}..${head}`,
    ],
    diffOutputLimitBytes,
  );
  if (result.outputTruncated) {
    return {
      ok: false,
      reason: "Commit diff output exceeded the 64 MiB read limit.",
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `git log diff failed while reading commit patches (exit code ${String(result.exitCode)}). Run \`git log -p <base>..<head>\` to see the detail.`,
    };
  }
  return { ok: true, diff: result.stdout };
}

export async function readOriginSlug(
  programs: ProgramsCapability,
  git: ParsedPath,
  cwd: string,
): Promise<
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runGit(
    programs,
    git,
    cwd,
    ["remote", "get-url", "origin"],
    smallOutputLimitBytes,
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `Cannot read origin remote for pull request scan (git remote get-url exited with code ${String(result.exitCode)}). Run \`git remote get-url origin\` to see the detail.`,
    };
  }
  const slug = parseOriginSlug(result.stdout);
  if (slug === null) {
    return {
      ok: false,
      reason:
        "Cannot parse owner/repo from the origin remote URL. Run `git remote get-url origin` to inspect it.",
    };
  }
  return { ok: true, slug };
}
