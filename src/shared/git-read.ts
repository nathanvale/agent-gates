import { createHash } from "node:crypto";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import {
  type ChangeNoteEntry,
  isChangeNoteFile,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  GATE_SETTINGS_FILE,
  type GateSettings,
  parseGateSettingsText,
} from "./settings.ts";

type GitReadCommand =
  | "for-each-ref"
  | "diff"
  | "cat-file"
  | "ls-tree"
  | "rev-parse"
  | "merge-base"
  | "log";

type DiffEntry = {
  readonly mode: string;
  readonly blob: string;
  readonly status: string;
  readonly oldPath: string | undefined;
  readonly path: string;
  readonly invalidUtf8Path: boolean;
};

export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

export type BlobCandidate = {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
  readonly invalidUtf8Path: boolean;
};

const gitTimeoutMilliseconds = 10_000;
const gitShutdownMilliseconds = 1_000;
const gitOutputLimitBytes = 4 * 1024 * 1024;
const replacementCharacter = "\uFFFD";
const commitOidPattern = /^[0-9a-f]{40,64}$/;

const clearedGitEnvNames = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

const utf8BomBytes = Buffer.from([0xef, 0xbb, 0xbf]);

function gitBlobHash(algorithm: "sha1" | "sha256", bytes: Buffer): string {
  return createHash(algorithm)
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest("hex");
}

function hasInvalidUtf8Decoding(blobOid: string, text: string): boolean {
  if (!text.includes(replacementCharacter)) return false;
  const algorithm = blobOid.length === 64 ? "sha256" : "sha1";
  const encoded = Buffer.from(text, "utf8");
  if (gitBlobHash(algorithm, encoded) === blobOid) return false;
  const withBom = Buffer.concat([utf8BomBytes, encoded]);
  return gitBlobHash(algorithm, withBom) !== blobOid;
}

export function isPlainGitFileMode(mode: string): boolean {
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
    ...clearedGitEnvNames.flatMap((name) => ["-u", name]),
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

export async function runReadOnlyGit(
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

export function splitNul(output: string): readonly string[] {
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
  const isPair = status.startsWith("R") || status.startsWith("C");
  const oldPath = isPair ? fields[index + 1] : undefined;
  const path = isPair ? fields[index + 2] : fields[index + 1];
  if ((isPair && oldPath === undefined) || path === undefined)
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
        oldPath,
        path,
        invalidUtf8Path: path.includes(replacementCharacter),
      },
      nextIndex: index + (isPair ? 3 : 2),
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

export async function resolveCommitOid(
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

export async function diffResolvedRange(
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
    "--ignore-submodules=none",
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
  headOid: string,
): Promise<
  GitResult<{
    readonly baseOid: string;
    readonly entries: readonly DiffEntry[];
  }>
> {
  const baseOid = await resolveCommitOid(programs, parsePath, root, base);
  if (!baseOid.ok) return baseOid;
  const entries = await diffResolvedRange(
    programs,
    parsePath,
    root,
    `${baseOid.value}...${headOid}`,
  );
  if (!entries.ok) return entries;
  return {
    ok: true,
    value: { baseOid: baseOid.value, entries: entries.value },
  };
}

function failCommittedSettings(
  causeCode:
    | "DOMAIN_GATES_SETTINGS_MISSING"
    | "DOMAIN_GATES_SETTINGS_INVALID"
    | "DOMAIN_GATES_GIT_FAILED",
  message: string,
) {
  return { ok: false as const, causeCode, message };
}

export async function readCommittedGateSettings(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  headOid: string,
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
    headOid,
    "--",
    GATE_SETTINGS_FILE,
  ]);
  if (!listed.ok)
    return failCommittedSettings("DOMAIN_GATES_GIT_FAILED", listed.problem);
  const first = splitNul(listed.value)[0];
  if (first === undefined)
    return failCommittedSettings(
      "DOMAIN_GATES_SETTINGS_MISSING",
      `Missing ${GATE_SETTINGS_FILE} in git HEAD. Repair: commit ${GATE_SETTINGS_FILE} at the repository root declaring changeNotes settings.`,
    );
  const tab = first.indexOf("\t");
  const header = tab >= 0 ? first.slice(0, tab) : "";
  const [mode = "", type = "", blob = ""] = header.split(" ");
  if (type !== "blob" || !isPlainGitFileMode(mode) || blob === "")
    return failCommittedSettings(
      "DOMAIN_GATES_SETTINGS_INVALID",
      `${GATE_SETTINGS_FILE} must be a plain file in git HEAD (mode ${mode}). Repair: commit a regular UTF-8 JSON file at ${GATE_SETTINGS_FILE}.`,
    );
  const content = await runReadOnlyGit(programs, parsePath, root, "cat-file", [
    "blob",
    blob,
  ]);
  if (!content.ok)
    return failCommittedSettings("DOMAIN_GATES_GIT_FAILED", content.problem);
  if (hasInvalidUtf8Decoding(blob, content.value))
    return failCommittedSettings(
      "DOMAIN_GATES_SETTINGS_INVALID",
      `${GATE_SETTINGS_FILE} in git HEAD is not valid UTF-8 text. Repair: commit ${GATE_SETTINGS_FILE} as valid UTF-8 JSON.`,
    );
  const parsed = parseGateSettingsText(content.value);
  if (!parsed.ok)
    return failCommittedSettings(
      parsed.kind === "missing"
        ? "DOMAIN_GATES_SETTINGS_MISSING"
        : "DOMAIN_GATES_SETTINGS_INVALID",
      parsed.problem,
    );
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
  if (hasInvalidUtf8Decoding(candidate.blob, blob.value))
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
