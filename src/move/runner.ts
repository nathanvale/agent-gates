import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { discoverTestFileCount, listTree, readBlobText } from "./git.ts";
import { resolveInputs } from "./inputs.ts";
import type {
  MoveCheckOptions,
  RawMoveInput,
  ResolvedInputs,
} from "./inputs.ts";
import {
  collectDestinationRecordPaths,
  collectMovedPathTargets,
  findSourceStaleReferences,
  isDestinationEntry,
} from "./references.ts";
import {
  compareTrees,
  findBrokenMarkdownLinks,
  findSourceKeptBlobs,
  isMarkdownPath,
  orderFindings,
  symlinkMode,
} from "./rules.ts";
import type {
  MoveFinding,
  MoveKind,
  NotCheckedItem,
  TreeEntry,
} from "./rules.ts";

export type { MoveCheckOptions } from "./inputs.ts";

export type MoveEvaluation =
  | {
      readonly ok: true;
      readonly kind: MoveKind;
      readonly files: readonly {
        readonly path: string;
        readonly hash: string;
      }[];
      readonly findings: readonly MoveFinding[];
      readonly notChecked: readonly NotCheckedItem[];
    }
  | { readonly ok: false; readonly reason: string };

function emptyFolderReason(
  optionName: string,
  folder: string,
  commit: string,
  repo: string,
): string {
  const folderDetail = folder === "" ? "repository root" : `"${folder}"`;
  return `No tracked files found for ${optionName} (${folderDetail}) at ${commit} in ${repo}.`;
}

async function checkSourceAfter(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
  sourceEntries: readonly TreeEntry[],
): Promise<
  | {
      readonly ok: true;
      readonly findings: readonly MoveFinding[];
      readonly notChecked: readonly NotCheckedItem[];
    }
  | { readonly ok: false; readonly reason: string }
> {
  if (resolved.kind !== "move" || resolved.sourceAfter === null) {
    return { ok: true, findings: [], notChecked: [] };
  }
  const sourceAfterTree = await listTree(
    programs,
    resolved.binaries,
    resolved.sourceRepo,
    resolved.sourceAfter,
    "",
    resolved.treeOutputLimitBytes,
  );
  if (!sourceAfterTree.ok) return sourceAfterTree;

  const targets = collectMovedPathTargets(
    sourceEntries,
    sourceAfterTree.entries,
    resolved.sourceFolder,
  );
  const sourceRelatives = new Set(
    sourceEntries.map((entry) => entry.relativePath),
  );
  const checkedEntries = resolved.sameRepository
    ? sourceAfterTree.entries.filter(
        (entry) =>
          !isDestinationEntry(
            entry.repoPath,
            resolved.destinationFolder,
            sourceRelatives,
          ),
      )
    : sourceAfterTree.entries;
  const textFiles: { readonly repoPath: string; readonly text: string }[] = [];
  const notChecked: NotCheckedItem[] = [];
  if (targets.length > 0) {
    for (const entry of checkedEntries) {
      const blob = await readBlobText(
        programs,
        resolved.binaries,
        resolved.sourceRepo,
        entry.hash,
      );
      if (blob.kind === "text") {
        textFiles.push({ repoPath: entry.repoPath, text: blob.text });
      } else if (blob.kind === "unreadable") {
        notChecked.push({
          check: "source-references",
          reason: `Could not read ${entry.repoPath} in full: ${blob.reason}.`,
        });
      }
    }
  }
  const destinationRecordPaths = collectDestinationRecordPaths(
    sourceEntries,
    resolved.sourceFolder,
    resolved.destinationFolder,
  );
  return {
    ok: true,
    findings: [
      ...findSourceStaleReferences(textFiles, targets, destinationRecordPaths),
      ...findSourceKeptBlobs(sourceEntries, checkedEntries),
    ],
    notChecked,
  };
}

async function readDestinationSymlinks(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
  destAllEntries: readonly TreeEntry[],
): Promise<{
  readonly symlinks: ReadonlyMap<string, string>;
  readonly notChecked: readonly NotCheckedItem[];
}> {
  const symlinks = new Map<string, string>();
  const notChecked: NotCheckedItem[] = [];
  for (const entry of destAllEntries) {
    if (entry.mode !== symlinkMode) continue;
    const blob = await readBlobText(
      programs,
      resolved.binaries,
      resolved.destinationRepo,
      entry.hash,
    );
    if (blob.kind === "text") {
      symlinks.set(entry.repoPath, blob.text);
    } else if (blob.kind === "unreadable") {
      notChecked.push({
        check: "markdown-links",
        reason: `Could not read symlink ${entry.repoPath}: ${blob.reason}.`,
      });
    }
  }
  return { symlinks, notChecked };
}

async function checkDestinationMarkdownLinks(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
  sourceEntries: readonly TreeEntry[],
  destFolderEntries: readonly TreeEntry[],
  destAllEntries: readonly TreeEntry[],
): Promise<{
  readonly findings: readonly MoveFinding[];
  readonly notChecked: readonly NotCheckedItem[];
}> {
  const sourceRelatives = new Set(
    sourceEntries.map((entry) => entry.relativePath),
  );
  const movedMarkdown: { readonly repoPath: string; readonly text: string }[] =
    [];
  const notChecked: NotCheckedItem[] = [];
  for (const entry of destFolderEntries) {
    if (!sourceRelatives.has(entry.relativePath)) continue;
    if (entry.mode === symlinkMode) continue;
    if (!isMarkdownPath(entry.repoPath)) continue;
    const blob = await readBlobText(
      programs,
      resolved.binaries,
      resolved.destinationRepo,
      entry.hash,
    );
    if (blob.kind === "text") {
      movedMarkdown.push({ repoPath: entry.repoPath, text: blob.text });
    } else if (blob.kind === "unreadable") {
      notChecked.push({
        check: "markdown-links",
        reason: `Could not read ${entry.repoPath} in full: ${blob.reason}.`,
      });
    }
  }
  if (movedMarkdown.length === 0) {
    return { findings: [], notChecked };
  }
  const symlinkResult = await readDestinationSymlinks(
    programs,
    resolved,
    destAllEntries,
  );
  return {
    findings: findBrokenMarkdownLinks(
      movedMarkdown,
      destAllEntries,
      symlinkResult.symlinks,
    ),
    notChecked: [...notChecked, ...symlinkResult.notChecked],
  };
}

async function checkDestinationTests(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
): Promise<
  | {
      readonly kind: "ok";
      readonly findings: readonly MoveFinding[];
      readonly notChecked: readonly NotCheckedItem[];
    }
  | { readonly kind: "failed"; readonly reason: string }
> {
  if (resolved.destBefore === null) {
    return { kind: "ok", findings: [], notChecked: [] };
  }
  const before = await discoverTestFileCount(
    programs,
    resolved.binaries,
    resolved.destinationRepo,
    resolved.destBefore,
  );
  if (before.kind === "failed") return before;
  if (before.kind === "unsupported") {
    return {
      kind: "ok",
      findings: [],
      notChecked: [{ check: "test-discovery", reason: before.reason }],
    };
  }

  const after = await discoverTestFileCount(
    programs,
    resolved.binaries,
    resolved.destinationRepo,
    resolved.destAfter,
  );
  if (after.kind === "failed") return after;
  if (after.kind === "unsupported") {
    return {
      kind: "ok",
      findings: [],
      notChecked: [{ check: "test-discovery", reason: after.reason }],
    };
  }

  if (after.count < before.count) {
    return {
      kind: "ok",
      findings: [
        {
          cause: "DOMAIN_MOVE_TEST_DROPPED",
          path: resolved.destinationRepo,
          beforeCount: before.count,
          afterCount: after.count,
        },
      ],
      notChecked: [],
    };
  }
  return { kind: "ok", findings: [], notChecked: [] };
}

function collectNotChecked(
  resolved: ResolvedInputs,
): readonly NotCheckedItem[] {
  const items: NotCheckedItem[] = [];
  if (resolved.kind === "move" && resolved.sourceAfter === null) {
    items.push(
      {
        check: "source-references",
        reason: "Requires a source before..after commit range.",
        enableWith: "--source-commit <before>..<after>",
      },
      {
        check: "source-kept",
        reason: "Requires a source before..after commit range.",
        enableWith: "--source-commit <before>..<after>",
      },
    );
  }
  if (resolved.destBefore === null) {
    items.push({
      check: "test-discovery",
      reason: "Requires a destination before..after commit range.",
      enableWith: "--destination-commit <before>..<after>",
    });
  }
  return items;
}

export async function evaluateMove(
  programs: ProgramsCapability,
  parsePath: (raw: string) => ParsedPath,
  raw: RawMoveInput,
  options?: MoveCheckOptions,
): Promise<MoveEvaluation> {
  const resolvedResult = await resolveInputs(programs, parsePath, raw, options);
  if (!resolvedResult.ok) return resolvedResult;
  const { resolved } = resolvedResult;

  const sourceTree = await listTree(
    programs,
    resolved.binaries,
    resolved.sourceRepo,
    resolved.sourceBefore,
    resolved.sourceFolder,
    resolved.treeOutputLimitBytes,
  );
  if (!sourceTree.ok) return sourceTree;
  if (sourceTree.entries.length === 0) {
    return {
      ok: false,
      reason: emptyFolderReason(
        "--source-folder",
        resolved.sourceFolder,
        resolved.sourceBefore,
        resolved.sourceRepo,
      ),
    };
  }

  const destFolderTree = await listTree(
    programs,
    resolved.binaries,
    resolved.destinationRepo,
    resolved.destAfter,
    resolved.destinationFolder,
    resolved.treeOutputLimitBytes,
  );
  if (!destFolderTree.ok) return destFolderTree;
  if (destFolderTree.entries.length === 0) {
    return {
      ok: false,
      reason: emptyFolderReason(
        "--destination-folder",
        resolved.destinationFolder,
        resolved.destAfter,
        resolved.destinationRepo,
      ),
    };
  }

  const destAllTree =
    resolved.destinationFolder === ""
      ? destFolderTree
      : await listTree(
          programs,
          resolved.binaries,
          resolved.destinationRepo,
          resolved.destAfter,
          "",
          resolved.treeOutputLimitBytes,
        );
  if (!destAllTree.ok) return destAllTree;

  const sourceAfterResult = await checkSourceAfter(
    programs,
    resolved,
    sourceTree.entries,
  );
  if (!sourceAfterResult.ok) return sourceAfterResult;

  const markdownResult = await checkDestinationMarkdownLinks(
    programs,
    resolved,
    sourceTree.entries,
    destFolderTree.entries,
    destAllTree.entries,
  );

  const otherFindings = orderFindings([
    ...compareTrees(sourceTree.entries, destFolderTree.entries),
    ...markdownResult.findings,
    ...sourceAfterResult.findings,
  ]);
  const baseNotChecked: readonly NotCheckedItem[] = [
    ...collectNotChecked(resolved),
    ...sourceAfterResult.notChecked,
    ...markdownResult.notChecked,
  ];
  const files = sourceTree.entries.map((entry) => ({
    path: entry.relativePath,
    hash: entry.hash,
  }));

  const testResult = await checkDestinationTests(programs, resolved);
  if (testResult.kind === "failed") {
    if (otherFindings.length === 0) {
      return { ok: false, reason: testResult.reason };
    }
    return {
      ok: true,
      kind: resolved.kind,
      files,
      findings: otherFindings,
      notChecked: [
        ...baseNotChecked,
        { check: "test-discovery", reason: testResult.reason },
      ],
    };
  }

  return {
    ok: true,
    kind: resolved.kind,
    files,
    findings: orderFindings([...otherFindings, ...testResult.findings]),
    notChecked: [...baseNotChecked, ...testResult.notChecked],
  };
}
