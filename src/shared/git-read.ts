import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import {
  type ChangeNoteEntry,
  compareText,
  isChangeNoteFile,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  compareRepositoryVersions,
  parseRepositoryVersion,
} from "../version/rules.ts";
import {
  GATE_SETTINGS_FILE,
  type GateSettings,
  parseGateSettingsText,
} from "./settings.ts";

type GitReadCommand =
  | "for-each-ref"
  | "ls-tree"
  | "diff"
  | "cat-file"
  | "rev-parse";

type DiffEntry = {
  readonly mode: string;
  readonly blob: string;
  readonly status: string;
  readonly oldPath: string | undefined;
  readonly path: string;
  readonly invalidUtf8Path: boolean;
};

type VersionTag = {
  readonly tag: string;
  readonly version: string;
};

type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

type BlobCandidate = {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
  readonly invalidUtf8Path: boolean;
};

const gitTimeoutMilliseconds = 10_000;
const gitShutdownMilliseconds = 1_000;
const gitOutputLimitBytes = 4 * 1024 * 1024;
const versionTagPattern = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const replacementCharacter = "\uFFFD";
const commitOidPattern = /^[0-9a-f]{40,64}$/;

function isPlainGitFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

function resolveEnvExecutable(): GitResult<string> {
  const found = Bun.which("env");
  if (found === null)
    return {
      ok: false,
      problem:
        'Could not find "env" executable on PATH. Repair: ensure standard POSIX tools are available on PATH.',
    };
  return { ok: true, value: found };
}

function isolatedGitArgs(
  root: string,
  command: GitReadCommand,
  args: readonly string[],
): readonly string[] {
  return [
    "-u",
    "GIT_DIR",
    "-u",
    "GIT_WORK_TREE",
    "-u",
    "GIT_INDEX_FILE",
    "-u",
    "GIT_OBJECT_DIRECTORY",
    "-u",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "-u",
    "GIT_COMMON_DIR",
    "-u",
    "GIT_CONFIG_COUNT",
    "-u",
    "GIT_CONFIG_PARAMETERS",
    "-u",
    "GIT_CONFIG_GLOBAL",
    "-u",
    "GIT_CONFIG_SYSTEM",
    "GIT_OPTIONAL_LOCKS=0",
    "GIT_NO_LAZY_FETCH=1",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_NO_REPLACE_OBJECTS=1",
    "GIT_CONFIG_NOSYSTEM=1",
    "git",
    "-C",
    root,
    command,
    ...args,
  ];
}

async function runReadOnlyGit(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  command: GitReadCommand,
  args: readonly string[],
): Promise<GitResult<string>> {
  const envPath = resolveEnvExecutable();
  if (!envPath.ok) return envPath;
  const ran = await programs.inspect({
    executable: parsePath(envPath.value),
    args: isolatedGitArgs(root, command, args),
    timeoutMilliseconds: gitTimeoutMilliseconds,
    outputLimitBytes: gitOutputLimitBytes,
    shutdownMilliseconds: gitShutdownMilliseconds,
  });
  const details = programDetails(ran);
  if (details?.timedOut)
    return {
      ok: false,
      problem: `git ${command} timed out after ${String(gitTimeoutMilliseconds)} ms in ${root}.`,
    };
  if (ran.outputTruncated)
    return {
      ok: false,
      problem: `git ${command} exceeded the ${String(gitOutputLimitBytes)}-byte output limit in ${root}.`,
    };
  if (ran.exitCode !== 0)
    return {
      ok: false,
      problem: `git ${command} ${args.join(" ")} failed in ${root}: ${ran.stderr.trim()}`,
    };
  return { ok: true, value: ran.stdout };
}

function splitNul(output: string): readonly string[] {
  const fields: string[] = [];
  let offset = 0;
  for (
    let end = output.indexOf("\0");
    end >= 0;
    end = output.indexOf("\0", offset)
  ) {
    fields.push(output.slice(offset, end));
    offset = end + 1;
  }
  return fields;
}

function parseOneDiffRecord(
  fields: readonly string[],
  index: number,
  range: string,
): GitResult<{ readonly entry: DiffEntry; readonly nextIndex: number }> {
  const header = fields[index] ?? "";
  const [, mode = "", , blob = "", status = ""] = header.split(" ");
  if (mode === "" || blob === "" || status === "")
    return {
      ok: false,
      problem: `git diff ${range} returned an incomplete record.`,
    };
  if (status.startsWith("R") || status.startsWith("C")) {
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    if (oldPath === undefined || newPath === undefined)
      return {
        ok: false,
        problem: `git diff ${range} returned an incomplete rename record.`,
      };
    return {
      ok: true,
      value: {
        entry: {
          mode,
          blob,
          status,
          oldPath,
          path: newPath,
          invalidUtf8Path: newPath.includes(replacementCharacter),
        },
        nextIndex: index + 3,
      },
    };
  }
  const rawPath = fields[index + 1];
  if (rawPath === undefined)
    return {
      ok: false,
      problem: `git diff ${range} returned an incomplete record.`,
    };
  return {
    ok: true,
    value: {
      entry: {
        mode,
        blob,
        status,
        oldPath: undefined,
        path: rawPath,
        invalidUtf8Path: rawPath.includes(replacementCharacter),
      },
      nextIndex: index + 2,
    },
  };
}

function parseDiffEntries(
  output: string,
  range: string,
): GitResult<readonly DiffEntry[]> {
  const fields = splitNul(output);
  const entries: DiffEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const parsed = parseOneDiffRecord(fields, index, range);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value.entry);
    index = parsed.value.nextIndex;
  }
  return { ok: true, value: entries };
}

async function resolveCommitOid(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  revision: string,
): Promise<GitResult<string>> {
  if (revision.startsWith("-"))
    return {
      ok: false,
      problem: `Invalid git revision "${revision}". Repair: pass a branch, tag, or commit name that does not start with "-".`,
    };
  const ran = await runReadOnlyGit(programs, parsePath, root, "rev-parse", [
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  if (!ran.ok) return ran;
  const oid = ran.value.trim();
  if (!commitOidPattern.test(oid))
    return {
      ok: false,
      problem: `Could not resolve "${revision}" to a git commit.`,
    };
  return { ok: true, value: oid };
}

async function diffResolvedRange(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  range: string,
  pathFilter?: string,
): Promise<GitResult<readonly DiffEntry[]>> {
  const args = [
    "--raw",
    "--no-abbrev",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "-z",
    range,
    ...(pathFilter === undefined ? [] : ["--", pathFilter]),
  ];
  const ran = await runReadOnlyGit(programs, parsePath, root, "diff", args);
  if (!ran.ok) return ran;
  return parseDiffEntries(ran.value, range);
}

export async function diffBaseToHead(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  base: string,
): Promise<GitResult<readonly DiffEntry[]>> {
  const baseOid = await resolveCommitOid(programs, parsePath, root, base);
  if (!baseOid.ok) return baseOid;
  const headOid = await resolveCommitOid(programs, parsePath, root, "HEAD");
  if (!headOid.ok) return headOid;
  return diffResolvedRange(
    programs,
    parsePath,
    root,
    `${baseOid.value}...${headOid.value}`,
  );
}

export async function readCommittedGateSettings(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
): Promise<
  | { readonly ok: true; readonly settings: GateSettings }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_GATES_SETTINGS_MISSING"
        | "DOMAIN_GATES_SETTINGS_INVALID"
        | "DOMAIN_GATES_GIT_FAILED";
      readonly message: string;
    }
> {
  const listed = await runReadOnlyGit(programs, parsePath, root, "ls-tree", [
    "-z",
    "--full-tree",
    "HEAD",
    "--",
    GATE_SETTINGS_FILE,
  ]);
  if (!listed.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_GIT_FAILED",
      message: listed.problem,
    };
  const first = splitNul(listed.value)[0];
  if (first === undefined)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_SETTINGS_MISSING",
      message: `Missing ${GATE_SETTINGS_FILE} in git HEAD. Repair: commit ${GATE_SETTINGS_FILE} at the repository root declaring changeNotes settings.`,
    };
  const tab = first.indexOf("\t");
  const header = tab >= 0 ? first.slice(0, tab) : "";
  const [mode = "", type = "", blob = ""] = header.split(" ");
  if (type !== "blob" || !isPlainGitFileMode(mode) || blob === "")
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
      message: `${GATE_SETTINGS_FILE} must be a plain file in git HEAD (mode ${mode}). Repair: commit a regular UTF-8 JSON file at ${GATE_SETTINGS_FILE}.`,
    };
  const content = await runReadOnlyGit(programs, parsePath, root, "cat-file", [
    "blob",
    blob,
  ]);
  if (!content.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_GIT_FAILED",
      message: content.problem,
    };
  if (content.value.includes(replacementCharacter))
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
      message: `${GATE_SETTINGS_FILE} in git HEAD is not valid UTF-8 text. Repair: commit ${GATE_SETTINGS_FILE} as valid UTF-8 JSON.`,
    };
  const parsed = parseGateSettingsText(content.value);
  if (!parsed.ok)
    return {
      ok: false,
      causeCode:
        parsed.kind === "missing"
          ? "DOMAIN_GATES_SETTINGS_MISSING"
          : "DOMAIN_GATES_SETTINGS_INVALID",
      message: parsed.problem,
    };
  return { ok: true, settings: parsed.settings };
}

export function isNotePath(notesFolder: string, path: string): boolean {
  const prefix = `${notesFolder}/`;
  return path.startsWith(prefix) && path !== `${prefix}README.md`;
}

export function isNewlyAddedNote(
  notesFolder: string,
  entry: DiffEntry,
): boolean {
  if (!isNotePath(notesFolder, entry.path)) return false;
  if (entry.status === "A") return true;
  if (
    entry.status.startsWith("R") &&
    entry.oldPath !== undefined &&
    !isNotePath(notesFolder, entry.oldPath)
  )
    return true;
  return false;
}

export async function validateCommittedNote(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  settings: GateSettings,
  candidate: BlobCandidate,
): Promise<
  | { readonly ok: true; readonly entry: ChangeNoteEntry }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    }
> {
  const notesFolder = settings.changeNotes.folder;
  if (candidate.invalidUtf8Path)
    return {
      ok: false,
      kind: "invalid",
      problem: `${notesFolder}/: filename is not valid UTF-8 text. Repair: rename the note to a valid UTF-8 ${notesFolder}/YYYY-MM-DD-<kebab-slug>.json filename.`,
    };
  const file = candidate.path.slice(notesFolder.length + 1);
  if (file.includes("/") || !isChangeNoteFile(file))
    return {
      ok: false,
      kind: "invalid",
      problem: `${candidate.path}: filename must match ${notesFolder}/YYYY-MM-DD-<kebab-slug>.json with a valid date. Repair: rename the note to start with a valid ISO date and lowercase kebab-case slug.`,
    };
  if (!isPlainGitFileMode(candidate.mode))
    return {
      ok: false,
      kind: "invalid",
      problem: `${candidate.path}: must be a plain file in HEAD (git mode ${candidate.mode}). Repair: replace ${candidate.path} with a regular UTF-8 JSON file.`,
    };
  const blob = await runReadOnlyGit(programs, parsePath, root, "cat-file", [
    "blob",
    candidate.blob,
  ]);
  if (!blob.ok) return { ok: false, kind: "git", problem: blob.problem };
  if (blob.value.includes(replacementCharacter))
    return {
      ok: false,
      kind: "invalid",
      problem: `${candidate.path}: is not valid UTF-8 text. Repair: save ${candidate.path} as UTF-8 JSON.`,
    };
  const parsed = parseChangeNote(
    candidate.path,
    blob.value,
    settings.changeNotes.affects,
  );
  if (!parsed.ok)
    return { ok: false, kind: "invalid", problem: parsed.problem };
  return { ok: true, entry: Object.freeze({ file, note: parsed.note }) };
}

export async function latestVersionTag(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
): Promise<GitResult<VersionTag | undefined>> {
  const ran = await runReadOnlyGit(programs, parsePath, root, "for-each-ref", [
    "--merged=HEAD",
    "--format=%(refname:short)",
    "refs/tags",
  ]);
  if (!ran.ok) return ran;
  const tags: VersionTag[] = [];
  for (const line of ran.value.split("\n")) {
    const match = versionTagPattern.exec(line);
    const version = match?.[1];
    if (version !== undefined && parseRepositoryVersion(version).ok)
      tags.push({ tag: line, version });
  }
  tags.sort((left, right) =>
    compareRepositoryVersions(left.version, right.version),
  );
  return { ok: true, value: tags.at(-1) };
}

function parseTreeCandidate(
  record: string,
  notesFolder: string,
):
  | { readonly ok: true; readonly candidate: BlobCandidate | undefined }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    } {
  const tab = record.indexOf("\t");
  if (tab < 0)
    return {
      ok: false,
      kind: "git",
      problem: "git ls-tree returned an incomplete tree record.",
    };
  const header = record.slice(0, tab);
  const path = record.slice(tab + 1);
  if (!isNotePath(notesFolder, path)) return { ok: true, candidate: undefined };
  const [mode = "", type = "", blob = ""] = header.split(" ");
  if (mode === "" || type === "" || blob === "")
    return {
      ok: false,
      kind: "git",
      problem: "git ls-tree returned an incomplete tree record.",
    };
  if (type !== "blob")
    return {
      ok: false,
      kind: "invalid",
      problem: `${path}: must be a plain file in HEAD (git entry "${header}"). Repair: replace it with a regular UTF-8 JSON file.`,
    };
  return {
    ok: true,
    candidate: {
      mode,
      blob,
      path,
      invalidUtf8Path: path.includes(replacementCharacter),
    },
  };
}

async function candidatesAtHead(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  notesFolder: string,
): Promise<
  | { readonly ok: true; readonly candidates: readonly BlobCandidate[] }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    }
> {
  const ran = await runReadOnlyGit(programs, parsePath, root, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
    "--",
    notesFolder,
  ]);
  if (!ran.ok) return { ok: false, kind: "git", problem: ran.problem };
  const candidates: BlobCandidate[] = [];
  for (const record of splitNul(ran.value)) {
    const parsed = parseTreeCandidate(record, notesFolder);
    if (!parsed.ok) return parsed;
    if (parsed.candidate !== undefined) candidates.push(parsed.candidate);
  }
  return { ok: true, candidates };
}

export async function readChangeNotesSinceTag(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  settings: GateSettings,
  previousTag: string | undefined,
): Promise<
  | { readonly ok: true; readonly entries: readonly ChangeNoteEntry[] }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    }
> {
  const notesFolder = settings.changeNotes.folder;
  let candidates: readonly BlobCandidate[];
  if (previousTag === undefined) {
    const atHead = await candidatesAtHead(
      programs,
      parsePath,
      root,
      notesFolder,
    );
    if (!atHead.ok) return atHead;
    candidates = atHead.candidates;
  } else {
    const tagOid = await resolveCommitOid(
      programs,
      parsePath,
      root,
      `refs/tags/${previousTag}`,
    );
    if (!tagOid.ok) return { ok: false, kind: "git", problem: tagOid.problem };
    const headOid = await resolveCommitOid(programs, parsePath, root, "HEAD");
    if (!headOid.ok) return { ok: false, kind: "git", problem: headOid.problem };
    const diff = await diffResolvedRange(
      programs,
      parsePath,
      root,
      `${tagOid.value}..${headOid.value}`,
      notesFolder,
    );
    if (!diff.ok) return { ok: false, kind: "git", problem: diff.problem };
    candidates = diff.value
      .filter((entry) => isNewlyAddedNote(notesFolder, entry))
      .map(({ mode, blob, path, invalidUtf8Path }) => ({
        mode,
        blob,
        path,
        invalidUtf8Path,
      }));
  }
  const entries: ChangeNoteEntry[] = [];
  for (const candidate of candidates) {
    const validated = await validateCommittedNote(
      programs,
      parsePath,
      root,
      settings,
      candidate,
    );
    if (!validated.ok) return validated;
    entries.push(validated.entry);
  }
  entries.sort((left, right) => compareText(left.file, right.file));
  return { ok: true, entries: Object.freeze(entries) };
}
