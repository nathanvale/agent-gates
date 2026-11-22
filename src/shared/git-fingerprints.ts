import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteKey,
  isChangeNoteFile,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  type DiffEntry,
  diffResolvedRange,
  type GitResult,
  hasInvalidUtf8Decoding,
  isNotePath,
  isPlainGitFileMode,
  readCommittedGateSettings,
  runReadOnlyGit,
  splitNul,
} from "./git-read.ts";
import type { GateSettings } from "./settings.ts";

export type BaseNoteHistory = {
  readonly fingerprints: ReadonlySet<string>;
  readonly ancestorPaths: ReadonlySet<string>;
};

type CommitAncestry = {
  readonly paths: Set<string>;
  readonly blobs: Set<string>;
  readonly fingerprints: Set<string>;
};

async function readBlobFingerprint(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  path: string,
  blob: string,
  allowedAffects: ReadonlySet<string>,
): Promise<GitResult<string | undefined>> {
  const content = await runReadOnlyGit(programs, parsePath, root, "cat-file", [
    "blob",
    blob,
  ]);
  if (!content.ok) return content;
  if (hasInvalidUtf8Decoding(blob, content.value))
    return { ok: true, value: undefined };
  const parsed = parseChangeNote(path, content.value, allowedAffects);
  return {
    ok: true,
    value: parsed.ok ? canonicalChangeNoteKey(parsed.note) : undefined,
  };
}

function parseTreeNoteRecord(
  record: string,
  notesFolder: string,
):
  | {
      readonly path: string;
      readonly blob: string;
      readonly validName: boolean;
    }
  | undefined {
  const tab = record.indexOf("\t");
  if (tab < 0) return undefined;
  const path = record.slice(tab + 1);
  if (!isNotePath(notesFolder, path)) return undefined;
  const [mode = "", type = "", blob = ""] = record.slice(0, tab).split(" ");
  if (type !== "blob" || !isPlainGitFileMode(mode) || blob === "")
    return undefined;
  const file = path.slice(notesFolder.length + 1);
  return {
    path,
    blob,
    validName: !file.includes("/") && isChangeNoteFile(file),
  };
}

async function collectFolderNotes(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  commitOid: string,
  notesFolder: string,
  allowedAffects: ReadonlySet<string>,
  state: CommitAncestry,
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
    const entry = parseTreeNoteRecord(record, notesFolder);
    if (entry === undefined) continue;
    state.paths.add(entry.path);
    state.blobs.add(entry.blob);
    if (!entry.validName) continue;
    const fp = await readBlobFingerprint(
      programs,
      parsePath,
      root,
      entry.path,
      entry.blob,
      allowedAffects,
    );
    if (!fp.ok) return fp;
    if (fp.value !== undefined) state.fingerprints.add(fp.value);
  }
  return { ok: true, value: undefined };
}

async function recordEditedAncestor(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  next: CommitAncestry,
  path: string,
  blob: string,
  allowedAffects: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (blob === "") return { ok: true, value: undefined };
  next.blobs.add(blob);
  if (!path.endsWith(".json")) return { ok: true, value: undefined };
  const fp = await readBlobFingerprint(
    programs,
    parsePath,
    root,
    path,
    blob,
    allowedAffects,
  );
  if (!fp.ok) return fp;
  if (fp.value !== undefined) next.fingerprints.add(fp.value);
  return { ok: true, value: undefined };
}

async function applyNonAddEntry(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parent: CommitAncestry,
  next: CommitAncestry,
  entry: DiffEntry,
  allowedAffects: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (entry.status === "D") {
    next.paths.delete(entry.path);
    return { ok: true, value: undefined };
  }
  if (entry.status.startsWith("R")) {
    if (entry.oldPath === undefined || !parent.paths.has(entry.oldPath))
      return { ok: true, value: undefined };
    next.paths.delete(entry.oldPath);
    next.paths.add(entry.path);
    return recordEditedAncestor(
      programs,
      parsePath,
      root,
      next,
      entry.path,
      entry.blob,
      allowedAffects,
    );
  }
  if (entry.status === "M" && parent.paths.has(entry.path))
    return recordEditedAncestor(
      programs,
      parsePath,
      root,
      next,
      entry.path,
      entry.blob,
      allowedAffects,
    );
  return { ok: true, value: undefined };
}

async function applyAddedEntry(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  next: CommitAncestry,
  entry: DiffEntry,
  allowedAffects: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (!isPlainGitFileMode(entry.mode) || entry.blob === "")
    return { ok: true, value: undefined };
  if (next.blobs.has(entry.blob)) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
    return { ok: true, value: undefined };
  }
  if (!entry.path.endsWith(".json")) return { ok: true, value: undefined };
  const fp = await readBlobFingerprint(
    programs,
    parsePath,
    root,
    entry.path,
    entry.blob,
    allowedAffects,
  );
  if (!fp.ok) return fp;
  if (fp.value !== undefined && next.fingerprints.has(fp.value)) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
  }
  return { ok: true, value: undefined };
}

function mergeCommitAncestry(
  ancestryByCommit: Map<string, CommitAncestry>,
  commit: string,
  next: CommitAncestry,
): void {
  const existing = ancestryByCommit.get(commit);
  if (existing === undefined) {
    ancestryByCommit.set(commit, next);
    return;
  }
  for (const path of next.paths) existing.paths.add(path);
  for (const blob of next.blobs) existing.blobs.add(blob);
  for (const fp of next.fingerprints) existing.fingerprints.add(fp);
}

function parseRevListParents(
  output: string,
): readonly { readonly commit: string; readonly parents: readonly string[] }[] {
  const rows: {
    readonly commit: string;
    readonly parents: readonly string[];
  }[] = [];
  for (const line of output.split("\n")) {
    const [commit = "", ...parents] = line
      .trim()
      .split(" ")
      .filter((part) => part !== "");
    if (commit !== "") rows.push({ commit, parents });
  }
  return rows;
}

async function applyParentEdge(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parentOid: string,
  commitOid: string,
  parentState: CommitAncestry,
  allowedAffects: ReadonlySet<string>,
): Promise<GitResult<CommitAncestry>> {
  const diff = await diffResolvedRange(
    programs,
    parsePath,
    root,
    `${parentOid}..${commitOid}`,
  );
  if (!diff.ok) return diff;
  const next: CommitAncestry = {
    paths: new Set(parentState.paths),
    blobs: new Set(parentState.blobs),
    fingerprints: new Set(parentState.fingerprints),
  };
  for (const entry of diff.value) {
    if (entry.status === "A") continue;
    const applied = await applyNonAddEntry(
      programs,
      parsePath,
      root,
      parentState,
      next,
      entry,
      allowedAffects,
    );
    if (!applied.ok) return applied;
  }
  for (const entry of diff.value) {
    if (entry.status !== "A") continue;
    const applied = await applyAddedEntry(
      programs,
      parsePath,
      root,
      next,
      entry,
      allowedAffects,
    );
    if (!applied.ok) return applied;
  }
  return { ok: true, value: next };
}

async function trackAncestryGraph(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  fromOid: string,
  toOid: string,
  allowedAffects: ReadonlySet<string>,
  baseState: CommitAncestry,
): Promise<GitResult<CommitAncestry>> {
  if (baseState.paths.size === 0 || fromOid === toOid)
    return { ok: true, value: baseState };
  const listed = await runReadOnlyGit(programs, parsePath, root, "rev-list", [
    "--topo-order",
    "--reverse",
    "--parents",
    `${fromOid}..${toOid}`,
  ]);
  if (!listed.ok) return listed;
  const ancestryByCommit = new Map<string, CommitAncestry>([
    [fromOid, baseState],
  ]);
  for (const { commit, parents } of parseRevListParents(listed.value)) {
    for (const parentOid of parents) {
      const parentState = ancestryByCommit.get(parentOid) ?? baseState;
      const next = await applyParentEdge(
        programs,
        parsePath,
        root,
        parentOid,
        commit,
        parentState,
        allowedAffects,
      );
      if (!next.ok) return next;
      mergeCommitAncestry(ancestryByCommit, commit, next.value);
    }
  }
  return {
    ok: true,
    value: ancestryByCommit.get(toOid) ?? baseState,
  };
}

export async function readTreeNoteHistory(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  treeCommitOid: string,
  headOid: string,
  settings: GateSettings,
): Promise<GitResult<BaseNoteHistory>> {
  const baseState: CommitAncestry = {
    paths: new Set(),
    blobs: new Set(),
    fingerprints: new Set(),
  };
  const headScan = await collectFolderNotes(
    programs,
    parsePath,
    root,
    treeCommitOid,
    settings.changeNotes.folder,
    settings.changeNotes.affects,
    baseState,
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
  const combinedAffects = new Set(settings.changeNotes.affects);
  if (priorSettings.ok) {
    for (const word of priorSettings.settings.changeNotes.affects)
      combinedAffects.add(word);
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
        baseState,
      );
      if (!priorScan.ok) return priorScan;
    }
  }
  const finalState = await trackAncestryGraph(
    programs,
    parsePath,
    root,
    treeCommitOid,
    headOid,
    combinedAffects,
    baseState,
  );
  if (!finalState.ok) return finalState;
  return {
    ok: true,
    value: {
      fingerprints: finalState.value.fingerprints,
      ancestorPaths: finalState.value.paths,
    },
  };
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
