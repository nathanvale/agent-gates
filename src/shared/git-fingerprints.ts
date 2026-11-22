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

export type BaseNoteHistory = {
  readonly fingerprints: ReadonlySet<string>;
  readonly ancestorPaths: ReadonlySet<string>;
};

type LogStep =
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly newPath: string;
    }
  | {
      readonly kind: "copy";
      readonly oldPath: string;
      readonly newPath: string;
    }
  | {
      readonly kind: "add";
      readonly mode: string;
      readonly blob: string;
      readonly path: string;
    };

type CommitSection = {
  readonly commit: string;
  readonly parents: readonly string[];
  readonly steps: readonly LogStep[];
};

const sectionMarker = "\u0001";

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

function parseStepAt(
  fields: readonly string[],
  index: number,
  header: string,
): { readonly step: LogStep | undefined; readonly nextIndex: number } {
  const [, mode = "", , blob = "", status = ""] = header.split(" ");
  if (status.startsWith("R") || status.startsWith("C")) {
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    const step =
      oldPath !== undefined && newPath !== undefined
        ? {
            kind: status.startsWith("R")
              ? ("rename" as const)
              : ("copy" as const),
            oldPath,
            newPath,
          }
        : undefined;
    return { step, nextIndex: index + 3 };
  }
  const path = fields[index + 1];
  if (status === "D" && path !== undefined)
    return { step: { kind: "delete", path }, nextIndex: index + 2 };
  if (status === "A" && path !== undefined)
    return { step: { kind: "add", mode, blob, path }, nextIndex: index + 2 };
  return { step: undefined, nextIndex: index + 2 };
}

function parseSectionHeader(trimmed: string):
  | {
      readonly commit: string;
      readonly parents: readonly string[];
      readonly steps: LogStep[];
    }
  | undefined {
  const [commit = "", ...parents] = trimmed
    .slice(1)
    .trim()
    .split(" ")
    .filter((part) => part !== "");
  return commit === "" ? undefined : { commit, parents, steps: [] };
}

function parseLogSections(rawLogOutput: string): readonly CommitSection[] {
  const fields = splitNul(rawLogOutput);
  const sections: {
    readonly commit: string;
    readonly parents: readonly string[];
    readonly steps: LogStep[];
  }[] = [];
  let current: (typeof sections)[number] | undefined;
  let index = 0;
  while (index < fields.length) {
    const token = fields[index] ?? "";
    const trimmed = token.startsWith("\n") ? token.slice(1) : token;
    if (trimmed.startsWith(sectionMarker)) {
      current = parseSectionHeader(trimmed);
      if (current !== undefined) sections.push(current);
      index += 1;
      continue;
    }
    if (!trimmed.startsWith(":")) {
      index += 1;
      continue;
    }
    const parsed = parseStepAt(fields, index, trimmed);
    if (current !== undefined && parsed.step !== undefined)
      current.steps.push(parsed.step);
    index = parsed.nextIndex;
  }
  return sections;
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

async function applyOneStep(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parentSet: ReadonlySet<string>,
  nextSet: Set<string>,
  step: LogStep,
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
): Promise<GitResult<undefined>> {
  if (step.kind === "delete") {
    nextSet.delete(step.path);
    return { ok: true, value: undefined };
  }
  if (step.kind === "rename") {
    if (parentSet.has(step.oldPath)) {
      nextSet.delete(step.oldPath);
      nextSet.add(step.newPath);
    }
    return { ok: true, value: undefined };
  }
  if (step.kind === "copy") {
    if (parentSet.has(step.oldPath)) nextSet.add(step.newPath);
    return { ok: true, value: undefined };
  }
  if (
    !step.path.endsWith(".json") ||
    !isPlainGitFileMode(step.mode) ||
    step.blob === ""
  )
    return { ok: true, value: undefined };
  const matched = await matchesBaseFingerprint(
    programs,
    parsePath,
    root,
    step.path,
    step.blob,
    allowedAffects,
    fingerprints,
  );
  if (!matched.ok) return matched;
  if (matched.value) nextSet.add(step.path);
  return { ok: true, value: undefined };
}

async function applySectionSteps(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  parentSet: ReadonlySet<string>,
  steps: readonly LogStep[],
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
): Promise<GitResult<Set<string>>> {
  const nextSet = new Set(parentSet);
  for (const step of steps) {
    const applied = await applyOneStep(
      programs,
      parsePath,
      root,
      parentSet,
      nextSet,
      step,
      allowedAffects,
      fingerprints,
    );
    if (!applied.ok) return applied;
  }
  return { ok: true, value: nextSet };
}

function mergeCommitAncestry(
  ancestryByCommit: Map<string, Set<string>>,
  commit: string,
  nextSet: Set<string>,
): void {
  const existing = ancestryByCommit.get(commit);
  if (existing === undefined) {
    ancestryByCommit.set(commit, nextSet);
    return;
  }
  for (const path of nextSet) existing.add(path);
}

async function trackAncestryGraph(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  fromOid: string,
  toOid: string,
  allowedAffects: ReadonlySet<string>,
  fingerprints: ReadonlySet<string>,
  basePaths: ReadonlySet<string>,
): Promise<GitResult<ReadonlySet<string>>> {
  if (basePaths.size === 0 || fromOid === toOid)
    return { ok: true, value: basePaths };
  const log = await runReadOnlyGit(programs, parsePath, root, "log", [
    "-m",
    "--topo-order",
    "--reverse",
    "--raw",
    "--no-abbrev",
    "--find-renames",
    "--find-copies-harder",
    "-C100%",
    "--ignore-submodules=none",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "-z",
    "--format=%x01%H %P",
    `${fromOid}..${toOid}`,
  ]);
  if (!log.ok) return log;
  const ancestryByCommit = new Map<string, Set<string>>([
    [fromOid, new Set(basePaths)],
  ]);
  const parentCursors = new Map<string, number>();
  for (const section of parseLogSections(log.value)) {
    const cursor = parentCursors.get(section.commit) ?? 0;
    parentCursors.set(section.commit, cursor + 1);
    const parentOid = section.parents[cursor];
    const parentSet =
      (parentOid !== undefined ? ancestryByCommit.get(parentOid) : undefined) ??
      basePaths;
    const next = await applySectionSteps(
      programs,
      parsePath,
      root,
      parentSet,
      section.steps,
      allowedAffects,
      fingerprints,
    );
    if (!next.ok) return next;
    mergeCommitAncestry(ancestryByCommit, section.commit, next.value);
  }
  return { ok: true, value: ancestryByCommit.get(toOid) ?? basePaths };
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
  const headScan = await collectFolderNotes(
    programs,
    parsePath,
    root,
    treeCommitOid,
    settings.changeNotes.folder,
    settings.changeNotes.affects,
    fingerprints,
    basePaths,
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
    basePaths,
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
