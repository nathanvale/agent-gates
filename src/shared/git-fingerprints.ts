import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteKey,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  type GitResult,
  isNotePath,
  isPlainGitFileMode,
  readCommittedGateSettings,
  runReadOnlyGit,
  splitNul,
} from "./git-read.ts";
import type { GateSettings } from "./settings.ts";

type BaseNoteHistory = {
  readonly fingerprints: ReadonlySet<string>;
  readonly ancestorPaths: ReadonlySet<string>;
};

async function collectFolderNotes(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  commitOid: string,
  notesFolder: string,
  allowedAffects: ReadonlySet<string>,
  fingerprints: Set<string>,
  paths: Set<string>,
): Promise<GitResult<undefined>> {
  const listed = await runReadOnlyGit(programs, parsePath, root, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    commitOid,
    "--",
    notesFolder,
  ]);
  if (!listed.ok) return listed;
  for (const record of splitNul(listed.value)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    if (!isNotePath(notesFolder, path)) continue;
    const [mode = "", type = "", blob = ""] = record.slice(0, tab).split(" ");
    if (type !== "blob" || !isPlainGitFileMode(mode) || blob === "") continue;
    paths.add(path);
    const content = await runReadOnlyGit(
      programs,
      parsePath,
      root,
      "cat-file",
      ["blob", blob],
    );
    if (!content.ok) return content;
    const parsed = parseChangeNote(path, content.value, allowedAffects);
    if (parsed.ok) fingerprints.add(canonicalChangeNoteKey(parsed.note));
  }
  return { ok: true, value: undefined };
}

function advanceRenameAncestors(
  rawLogOutput: string,
  ancestorPaths: Set<string>,
): void {
  const fields = splitNul(rawLogOutput);
  let index = 0;
  while (index < fields.length) {
    const token = fields[index] ?? "";
    const trimmed = token.startsWith("\n") ? token.slice(1) : token;
    if (!trimmed.startsWith(":")) {
      index += 1;
      continue;
    }
    const status = trimmed.split(" ")[4] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (
        oldPath !== undefined &&
        newPath !== undefined &&
        ancestorPaths.has(oldPath)
      )
        ancestorPaths.add(newPath);
      index += 3;
      continue;
    }
    index += 2;
  }
}

async function trackRenameAncestors(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  fromOid: string,
  toOid: string,
  ancestorPaths: Set<string>,
): Promise<GitResult<undefined>> {
  if (ancestorPaths.size === 0) return { ok: true, value: undefined };
  const log = await runReadOnlyGit(programs, parsePath, root, "log", [
    "-m",
    "--first-parent",
    "--reverse",
    "--raw",
    "--no-abbrev",
    "--find-renames",
    "--find-copies",
    "--ignore-submodules=none",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "-z",
    "--format=",
    `${fromOid}..${toOid}`,
  ]);
  if (!log.ok) return log;
  advanceRenameAncestors(log.value, ancestorPaths);
  return { ok: true, value: undefined };
}

async function readTreeNoteHistory(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  treeCommitOid: string,
  headOid: string,
  settings: GateSettings,
): Promise<GitResult<BaseNoteHistory>> {
  const fingerprints = new Set<string>();
  const ancestorPaths = new Set<string>();
  const headScan = await collectFolderNotes(
    programs,
    parsePath,
    root,
    treeCommitOid,
    settings.changeNotes.folder,
    settings.changeNotes.affects,
    fingerprints,
    ancestorPaths,
  );
  if (!headScan.ok) return headScan;
  const priorSettings = await readCommittedGateSettings(
    programs,
    parsePath,
    root,
    treeCommitOid,
  );
  if (
    !priorSettings.ok &&
    priorSettings.causeCode === "DOMAIN_GATES_GIT_FAILED"
  )
    return { ok: false, problem: priorSettings.message };
  if (priorSettings.ok) {
    const sameFolder =
      priorSettings.settings.changeNotes.folder === settings.changeNotes.folder;
    const sameAffects =
      [...priorSettings.settings.changeNotes.affects].sort().join(",") ===
      [...settings.changeNotes.affects].sort().join(",");
    if (!sameFolder || !sameAffects) {
      const priorScan = await collectFolderNotes(
        programs,
        parsePath,
        root,
        treeCommitOid,
        priorSettings.settings.changeNotes.folder,
        priorSettings.settings.changeNotes.affects,
        fingerprints,
        ancestorPaths,
      );
      if (!priorScan.ok) return priorScan;
    }
  }
  const tracked = await trackRenameAncestors(
    programs,
    parsePath,
    root,
    treeCommitOid,
    headOid,
    ancestorPaths,
  );
  if (!tracked.ok) return tracked;
  return { ok: true, value: { fingerprints, ancestorPaths } };
}

export async function readBaseNoteHistory(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  baseOid: string,
  headOid: string,
  settings: GateSettings,
): Promise<GitResult<BaseNoteHistory>> {
  const mergeBase = await runReadOnlyGit(
    programs,
    parsePath,
    root,
    "merge-base",
    [baseOid, headOid],
  );
  if (!mergeBase.ok) return mergeBase;
  return readTreeNoteHistory(
    programs,
    parsePath,
    root,
    mergeBase.value.trim(),
    headOid,
    settings,
  );
}
