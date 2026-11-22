import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteKey,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  isNotePath,
  isPlainGitFileMode,
  readCommittedGateSettings,
  runReadOnlyGit,
  splitNul,
  type GitResult,
} from "./git-read.ts";
import type { GateSettings } from "./settings.ts";

async function collectFolderNoteFingerprints(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  commitOid: string,
  notesFolder: string,
  allowedAffects: ReadonlySet<string>,
  fingerprints: Set<string>,
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

export async function readTreeNoteFingerprints(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  treeCommitOid: string,
  settings: GateSettings,
): Promise<GitResult<ReadonlySet<string>>> {
  const fingerprints = new Set<string>();
  const headScan = await collectFolderNoteFingerprints(
    programs,
    parsePath,
    root,
    treeCommitOid,
    settings.changeNotes.folder,
    settings.changeNotes.affects,
    fingerprints,
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
      const priorScan = await collectFolderNoteFingerprints(
        programs,
        parsePath,
        root,
        treeCommitOid,
        priorSettings.settings.changeNotes.folder,
        priorSettings.settings.changeNotes.affects,
        fingerprints,
      );
      if (!priorScan.ok) return priorScan;
    }
  }
  return { ok: true, value: fingerprints };
}

export async function readBaseNoteFingerprints(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  baseOid: string,
  headOid: string,
  settings: GateSettings,
): Promise<GitResult<ReadonlySet<string>>> {
  const mergeBase = await runReadOnlyGit(
    programs,
    parsePath,
    root,
    "merge-base",
    [baseOid, headOid],
  );
  if (!mergeBase.ok) return mergeBase;
  return readTreeNoteFingerprints(
    programs,
    parsePath,
    root,
    mergeBase.value.trim(),
    settings,
  );
}
