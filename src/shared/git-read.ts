import { join } from "node:path";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { programDetails } from "agent-cli-kernel/addons/programs";
import {
  type ChangeNoteEntry,
  isChangeNoteFile,
  parseChangeNote,
} from "../change-note/rules.ts";
import type { GateSettings } from "./settings.ts";

type GitReadCommand = "diff" | "cat-file";

type DiffEntry = {
  readonly mode: string;
  readonly blob: string;
  readonly status: string;
  readonly oldPath: string | undefined;
  readonly path: string;
  readonly invalidUtf8Path: boolean;
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

const envExecutablePath = join("/", "usr", "bin", "env");
const gitTimeoutMilliseconds = 10_000;
const gitShutdownMilliseconds = 1_000;
const gitOutputLimitBytes = 4 * 1024 * 1024;
const replacementCharacter = "\uFFFD";

function isPlainGitFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
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
  const ran = await programs.inspect({
    executable: parsePath(envExecutablePath),
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

export async function diffRange(
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
