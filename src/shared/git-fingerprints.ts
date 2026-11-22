import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteKey,
  parseChangeNote,
} from "../change-note/rules.ts";
import {
  type DiffEntry,
  diffResolvedRange,
  type GitResult,
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
  blobs: Set<string>,
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
    blobs.add(blob);
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

async function matchesBaseFingerprint(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  path: string,
  blob: string,
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
): Promise<GitResult<boolean>> {
  const content = await runReadOnlyGit(programs, parsePath, root, "cat-file", [
    "blob",
    blob,
  ]);
  if (!content.ok) return content;
  const parsed = parseChangeNote(path, content.value, allowedAffects);
  return {
    ok: true,
    value: parsed.ok && fingerprints.has(canonicalChangeNoteKey(parsed.note)),
  };
}

async function applyAddedEntry(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parent: CommitAncestry,
  next: CommitAncestry,
  entry: DiffEntry,
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (!isPlainGitFileMode(entry.mode) || entry.blob === "")
    return { ok: true, value: undefined };
  if (parent.blobs.has(entry.blob)) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
    return { ok: true, value: undefined };
  }
  if (!entry.path.endsWith(".json")) return { ok: true, value: undefined };
  const matched = await matchesBaseFingerprint(
    programs,
    parsePath,
    root,
    entry.path,
    entry.blob,
    allowedAffects,
    fingerprints,
  );
  if (!matched.ok) return matched;
  if (matched.value) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
  }
  return { ok: true, value: undefined };
}

async function applyDiffEntry(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parent: CommitAncestry,
  next: CommitAncestry,
  entry: DiffEntry,
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (entry.status === "D") {
    next.paths.delete(entry.path);
    return { ok: true, value: undefined };
  }
  if (entry.status.startsWith("R")) {
    if (entry.oldPath !== undefined && parent.paths.has(entry.oldPath)) {
      next.paths.delete(entry.oldPath);
      next.paths.add(entry.path);
      if (entry.blob !== "") next.blobs.add(entry.blob);
    }
    return { ok: true, value: undefined };
  }
  if (entry.status === "M") {
    if (parent.paths.has(entry.path) && entry.blob !== "")
      next.blobs.add(entry.blob);
    return { ok: true, value: undefined };
  }
  if (entry.status !== "A") return { ok: true, value: undefined };
  return applyAddedEntry(
    programs,
    parsePath,
    root,
    parent,
    next,
    entry,
    allowedAffects,
    fingerprints,
  );
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
  fingerprints: ReadonlySet<string>,
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
  };
  for (const entry of diff.value) {
    const applied = await applyDiffEntry(
      programs,
      parsePath,
      root,
      parentState,
      next,
      entry,
      allowedAffects,
      fingerprints,
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
  fingerprints: ReadonlySet<string>,
  baseState: CommitAncestry,
): Promise<GitResult<ReadonlySet<string>>> {
  if (baseState.paths.size === 0 || fromOid === toOid)
    return { ok: true, value: baseState.paths };
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
        fingerprints,
      );
      if (!next.ok) return next;
      mergeCommitAncestry(ancestryByCommit, commit, next.value);
    }
  }
  return {
    ok: true,
    value: ancestryByCommit.get(toOid)?.paths ?? baseState.paths,
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
  const fingerprints = new Set<string>();
  const basePaths = new Set<string>();
  const baseBlobs = new Set<string>();
  const headScan = await collectFolderNotes(
    programs,
    parsePath,
    root,
    treeCommitOid,
    settings.changeNotes.folder,
    settings.changeNotes.affects,
    fingerprints,
    basePaths,
    baseBlobs,
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
        fingerprints,
        basePaths,
        baseBlobs,
      );
      if (!priorScan.ok) return priorScan;
    }
  }
  const ancestorPaths = await trackAncestryGraph(
    programs,
    parsePath,
    root,
    treeCommitOid,
    headOid,
    combinedAffects,
    fingerprints,
    { paths: basePaths, blobs: baseBlobs },
  );
  if (!ancestorPaths.ok) return ancestorPaths;
  return {
    ok: true,
    value: { fingerprints, ancestorPaths: ancestorPaths.value },
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
