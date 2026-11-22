import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteFingerprint,
  isChangeNoteFile,
} from "../change-note/rules.ts";
import {
  type DiffEntry,
  diffResolvedRange,
  gitOutputLimitBytes,
  type GitResult,
  hasInvalidUtf8Decoding,
  isNotePath,
  isPlainGitFileMode,
  readCommittedGateSettings,
  runReadOnlyGit,
  splitNul,
} from "./git-read.ts";
import { GATE_SETTINGS_FILE, type GateSettings } from "./settings.ts";

type BaseNoteHistory = {
  readonly fingerprints: ReadonlySet<string>;
  readonly ancestorPaths: ReadonlySet<string>;
};

type GitReader = {
  readonly programs: ProgramsCapability;
  readonly parsePath: (value: string) => ParsedPath;
  readonly root: string;
};

type CommitAncestry = {
  readonly paths: Set<string>;
  readonly oversizedPaths: Set<string>;
  readonly oversizedBlobs: Set<string>;
  readonly blobs: Set<string>;
  readonly fingerprints: Set<string>;
};

type FingerprintRead =
  | { readonly kind: "ok"; readonly fingerprint: string | undefined }
  | { readonly kind: "oversized"; readonly byteSize: string };

function cloneAncestry(source?: CommitAncestry): CommitAncestry {
  return {
    paths: new Set(source?.paths),
    oversizedPaths: new Set(source?.oversizedPaths),
    oversizedBlobs: new Set(source?.oversizedBlobs),
    blobs: new Set(source?.blobs),
    fingerprints: new Set(source?.fingerprints),
  };
}

function oversizedFailure(
  path: string,
  byteSize = `>=${String(gitOutputLimitBytes)}`,
): GitResult<never> {
  return {
    ok: false,
    problem: `${path}: exceeds the ${String(gitOutputLimitBytes)}-byte change note read limit (${byteSize} bytes), so note ancestry cannot be verified. Repair: keep change notes under ${String(gitOutputLimitBytes)} bytes.`,
  };
}

const okVoid: GitResult<undefined> = { ok: true, value: undefined };

function gitRun(
  git: GitReader,
  command: "cat-file" | "ls-tree" | "rev-list",
  args: readonly string[],
) {
  return runReadOnlyGit(git.programs, git.parsePath, git.root, command, args);
}

function readSettingsAt(git: GitReader, commitOid: string) {
  return readCommittedGateSettings(
    git.programs,
    git.parsePath,
    git.root,
    commitOid,
  );
}

async function readBlobFingerprint(
  git: GitReader,
  blob: string,
): Promise<GitResult<FingerprintRead>> {
  const sized = await gitRun(git, "cat-file", ["-s", blob]);
  if (!sized.ok) return sized;
  const rawSize = sized.value.trim();
  const byteSize = Number(rawSize);
  if (!Number.isFinite(byteSize) || byteSize >= gitOutputLimitBytes)
    return { ok: true, value: { kind: "oversized", byteSize: rawSize } };
  const content = await gitRun(git, "cat-file", ["blob", blob]);
  if (!content.ok) return content;
  if (hasInvalidUtf8Decoding(blob, content.value))
    return { ok: true, value: { kind: "ok", fingerprint: undefined } };
  return {
    ok: true,
    value: {
      kind: "ok",
      fingerprint: canonicalChangeNoteFingerprint(content.value),
    },
  };
}

function parseTreeNoteRecord(record: string, notesFolder: string) {
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
  git: GitReader,
  commitOid: string,
  notesFolder: string,
  state: CommitAncestry,
): Promise<GitResult<undefined>> {
  const listed = await gitRun(git, "ls-tree", [
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
    const fp = await readBlobFingerprint(git, entry.blob);
    if (!fp.ok) return fp;
    if (fp.value.kind === "oversized")
      return oversizedFailure(entry.path, fp.value.byteSize);
    if (fp.value.fingerprint !== undefined)
      state.fingerprints.add(fp.value.fingerprint);
  }
  return okVoid;
}

function isInAnyNoteFolder(
  noteFolders: ReadonlySet<string>,
  path: string,
): boolean {
  for (const folder of noteFolders) {
    if (isNotePath(folder, path)) return true;
  }
  return false;
}

async function recordTrackedBlob(
  git: GitReader,
  next: CommitAncestry,
  entry: DiffEntry,
  refuseOversized: boolean,
): Promise<GitResult<undefined>> {
  if (!isPlainGitFileMode(entry.mode) || entry.blob === "") return okVoid;
  const fp = await readBlobFingerprint(git, entry.blob);
  if (!fp.ok) return fp;
  if (fp.value.kind === "oversized") {
    if (refuseOversized) return oversizedFailure(entry.path, fp.value.byteSize);
    next.oversizedBlobs.add(entry.blob);
    return okVoid;
  }
  next.blobs.add(entry.blob);
  if (fp.value.fingerprint !== undefined)
    next.fingerprints.add(fp.value.fingerprint);
  return okVoid;
}

function applyRenamePaths(
  parent: CommitAncestry,
  next: CommitAncestry,
  oldPath: string,
  newPath: string,
): "ancestor" | "oversized" | "none" {
  if (parent.paths.has(oldPath)) {
    next.paths.delete(oldPath);
    next.paths.add(newPath);
    return "ancestor";
  }
  if (parent.oversizedPaths.has(oldPath)) {
    next.oversizedPaths.delete(oldPath);
    next.oversizedPaths.add(newPath);
    return "oversized";
  }
  return "none";
}

async function applyNonAddEntry(
  git: GitReader,
  parent: CommitAncestry,
  next: CommitAncestry,
  entry: DiffEntry,
  noteFolders: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (entry.status === "D") {
    next.paths.delete(entry.path);
    next.oversizedPaths.delete(entry.path);
    return okVoid;
  }
  if (entry.status.startsWith("R")) {
    if (entry.oldPath === undefined) return okVoid;
    const tracked = applyRenamePaths(parent, next, entry.oldPath, entry.path);
    if (tracked === "none") return okVoid;
    return recordTrackedBlob(
      git,
      next,
      entry,
      tracked === "ancestor" || isInAnyNoteFolder(noteFolders, entry.path),
    );
  }
  if (entry.status !== "M" && entry.status !== "T") return okVoid;
  const isAncestor = parent.paths.has(entry.path);
  if (!isAncestor && !parent.oversizedPaths.has(entry.path)) return okVoid;
  return recordTrackedBlob(
    git,
    next,
    entry,
    isAncestor || isInAnyNoteFolder(noteFolders, entry.path),
  );
}

function trackOversizedEntry(
  next: CommitAncestry,
  entry: DiffEntry,
  noteFolders: ReadonlySet<string>,
  byteSize?: string,
): GitResult<undefined> {
  if (isInAnyNoteFolder(noteFolders, entry.path))
    return oversizedFailure(entry.path, byteSize);
  next.oversizedPaths.add(entry.path);
  next.oversizedBlobs.add(entry.blob);
  return okVoid;
}

async function applyUntrackedEntry(
  git: GitReader,
  next: CommitAncestry,
  entry: DiffEntry,
  noteFolders: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (!isPlainGitFileMode(entry.mode) || entry.blob === "") return okVoid;
  if (next.blobs.has(entry.blob)) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
    return okVoid;
  }
  if (next.oversizedBlobs.has(entry.blob))
    return trackOversizedEntry(next, entry, noteFolders);
  const fp = await readBlobFingerprint(git, entry.blob);
  if (!fp.ok) return fp;
  if (fp.value.kind === "oversized")
    return trackOversizedEntry(next, entry, noteFolders, fp.value.byteSize);
  if (
    fp.value.fingerprint !== undefined &&
    next.fingerprints.has(fp.value.fingerprint)
  ) {
    next.paths.add(entry.path);
    next.blobs.add(entry.blob);
  }
  return okVoid;
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
  for (const path of next.oversizedPaths) existing.oversizedPaths.add(path);
  for (const blob of next.oversizedBlobs) existing.oversizedBlobs.add(blob);
  for (const blob of next.blobs) existing.blobs.add(blob);
  for (const fp of next.fingerprints) existing.fingerprints.add(fp);
}

function parseRevListParents(output: string) {
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

async function recordIntermediateSettingsFolder(
  git: GitReader,
  commitOid: string,
  entries: readonly DiffEntry[],
  next: CommitAncestry,
  noteFolders: Set<string>,
): Promise<GitResult<undefined>> {
  const touched = entries.some(
    (entry) =>
      entry.path === GATE_SETTINGS_FILE || entry.oldPath === GATE_SETTINGS_FILE,
  );
  if (!touched) return okVoid;
  const commitSettings = await readSettingsAt(git, commitOid);
  if (
    !commitSettings.ok &&
    commitSettings.causeCode === "DOMAIN_GATES_GIT_FAILED"
  )
    return { ok: false, problem: commitSettings.message };
  if (commitSettings.ok) {
    const folder = commitSettings.settings.changeNotes.folder;
    noteFolders.add(folder);
    for (const oversizedPath of next.oversizedPaths) {
      if (isNotePath(folder, oversizedPath))
        return oversizedFailure(oversizedPath);
    }
  }
  return okVoid;
}

async function applyParentEdge(
  git: GitReader,
  parentOid: string,
  commitOid: string,
  parentState: CommitAncestry,
  noteFolders: Set<string>,
): Promise<GitResult<CommitAncestry>> {
  const diff = await diffResolvedRange(
    git.programs,
    git.parsePath,
    git.root,
    `${parentOid}..${commitOid}`,
  );
  if (!diff.ok) return diff;
  const next = cloneAncestry(parentState);
  const recorded = await recordIntermediateSettingsFolder(
    git,
    commitOid,
    diff.value,
    next,
    noteFolders,
  );
  if (!recorded.ok) return recorded;
  for (const entry of diff.value) {
    if (entry.status === "A") continue;
    const applied = await applyNonAddEntry(
      git,
      parentState,
      next,
      entry,
      noteFolders,
    );
    if (!applied.ok) return applied;
  }
  for (const entry of diff.value) {
    const skipped =
      entry.status === "D" ||
      next.paths.has(entry.path) ||
      next.oversizedPaths.has(entry.path);
    if (skipped) continue;
    const applied = await applyUntrackedEntry(git, next, entry, noteFolders);
    if (!applied.ok) return applied;
  }
  return { ok: true, value: next };
}

async function trackAncestryGraph(
  git: GitReader,
  fromOid: string,
  toOid: string,
  noteFolders: Set<string>,
  baseState: CommitAncestry,
): Promise<GitResult<CommitAncestry>> {
  if (baseState.paths.size === 0 || fromOid === toOid)
    return { ok: true, value: baseState };
  const listed = await gitRun(git, "rev-list", [
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
        git,
        parentOid,
        commit,
        parentState,
        noteFolders,
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

async function readTreeNoteHistory(
  git: GitReader,
  treeCommitOid: string,
  headOid: string,
  settings: GateSettings,
): Promise<GitResult<BaseNoteHistory>> {
  const baseState = cloneAncestry();
  const headScan = await collectFolderNotes(
    git,
    treeCommitOid,
    settings.changeNotes.folder,
    baseState,
  );
  if (!headScan.ok) return headScan;
  const priorSettings = await readSettingsAt(git, treeCommitOid);
  if (
    !priorSettings.ok &&
    priorSettings.causeCode === "DOMAIN_GATES_GIT_FAILED"
  )
    return { ok: false, problem: priorSettings.message };
  const noteFolders = new Set([settings.changeNotes.folder]);
  if (priorSettings.ok) {
    noteFolders.add(priorSettings.settings.changeNotes.folder);
    if (
      priorSettings.settings.changeNotes.folder !== settings.changeNotes.folder
    ) {
      const priorScan = await collectFolderNotes(
        git,
        treeCommitOid,
        priorSettings.settings.changeNotes.folder,
        baseState,
      );
      if (!priorScan.ok) return priorScan;
    }
  }
  const finalState = await trackAncestryGraph(
    git,
    treeCommitOid,
    headOid,
    noteFolders,
    baseState,
  );
  if (!finalState.ok) return finalState;
  return {
    ok: true,
    value: {
      fingerprints: finalState.value.fingerprints,
      ancestorPaths: new Set([
        ...finalState.value.paths,
        ...finalState.value.oversizedPaths,
      ]),
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
    { programs, parsePath, root },
    mergeBase.value.trim(),
    headOid,
    settings,
  );
}
