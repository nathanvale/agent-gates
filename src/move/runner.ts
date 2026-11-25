import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  discoverTestFileCount,
  listTree,
  readBlobText,
  resolveCommit,
  resolveGitDir,
  resolveToolBinaries,
} from "./git.ts";
import type { ToolBinaries } from "./git.ts";
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
  normalizeFolder,
  orderFindings,
  parseCommitSpec,
} from "./rules.ts";
import type {
  MoveFinding,
  MoveKind,
  NotCheckedItem,
  TreeEntry,
} from "./rules.ts";

export type RawMoveInput = {
  readonly source: string;
  readonly sourceCommit: string;
  readonly sourceFolder: string | undefined;
  readonly destination: string;
  readonly destinationCommit: string;
  readonly destinationFolder: string | undefined;
  readonly kind: string | undefined;
};

type ResolvedInputs = {
  readonly sourceRepo: string;
  readonly destinationRepo: string;
  readonly sameRepository: boolean;
  readonly sourceFolder: string;
  readonly destinationFolder: string;
  readonly sourceBefore: string;
  readonly sourceAfter: string | null;
  readonly destBefore: string | null;
  readonly destAfter: string;
  readonly kind: MoveKind;
  readonly binaries: ToolBinaries;
};

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

async function resolveSameRepository(
  programs: ProgramsCapability,
  git: ParsedPath,
  sourceRepo: string,
  destinationRepo: string,
): Promise<
  | { readonly ok: true; readonly sameRepository: boolean }
  | { readonly ok: false; readonly reason: string }
> {
  const sourceGitDir = await resolveGitDir(programs, git, sourceRepo);
  if (!sourceGitDir.ok) return sourceGitDir;
  const destGitDir = await resolveGitDir(programs, git, destinationRepo);
  if (!destGitDir.ok) return destGitDir;
  return {
    ok: true,
    sameRepository: sourceGitDir.gitDir === destGitDir.gitDir,
  };
}

async function resolveOptionalCommit(
  programs: ProgramsCapability,
  git: ParsedPath,
  repo: string,
  rev: string | null,
): Promise<
  | { readonly ok: true; readonly commit: string | null }
  | { readonly ok: false; readonly reason: string }
> {
  if (rev === null) return { ok: true, commit: null };
  return resolveCommit(programs, git, repo, rev);
}

async function resolveInputs(
  programs: ProgramsCapability,
  parsePath: (raw: string) => ParsedPath,
  raw: RawMoveInput,
): Promise<
  | { readonly ok: true; readonly resolved: ResolvedInputs }
  | { readonly ok: false; readonly reason: string }
> {
  const binariesResult = resolveToolBinaries(parsePath);
  if (!binariesResult.ok) return binariesResult;

  const sourceFolder = normalizeFolder(raw.sourceFolder, "--source-folder");
  if (!sourceFolder.ok) return sourceFolder;

  const destFolder = normalizeFolder(
    raw.destinationFolder,
    "--destination-folder",
  );
  if (!destFolder.ok) return destFolder;

  const sourceSpec = parseCommitSpec(raw.sourceCommit, "--source-commit");
  if (!sourceSpec.ok) return sourceSpec;

  const destSpec = parseCommitSpec(
    raw.destinationCommit,
    "--destination-commit",
  );
  if (!destSpec.ok) return destSpec;

  const git = binariesResult.binaries.git;
  const sourceBefore = await resolveCommit(
    programs,
    git,
    raw.source,
    sourceSpec.spec.first,
  );
  if (!sourceBefore.ok) return sourceBefore;

  const sourceAfter = await resolveOptionalCommit(
    programs,
    git,
    raw.source,
    sourceSpec.spec.second,
  );
  if (!sourceAfter.ok) return sourceAfter;

  const destBefore = await resolveOptionalCommit(
    programs,
    git,
    raw.destination,
    destSpec.spec.second === null ? null : destSpec.spec.first,
  );
  if (!destBefore.ok) return destBefore;

  const destAfter = await resolveCommit(
    programs,
    git,
    raw.destination,
    destSpec.spec.second ?? destSpec.spec.first,
  );
  if (!destAfter.ok) return destAfter;

  const sameRepo = await resolveSameRepository(
    programs,
    git,
    raw.source,
    raw.destination,
  );
  if (!sameRepo.ok) return sameRepo;

  return {
    ok: true,
    resolved: {
      sourceRepo: raw.source,
      destinationRepo: raw.destination,
      sameRepository: sameRepo.sameRepository,
      sourceFolder: sourceFolder.folder,
      destinationFolder: destFolder.folder,
      sourceBefore: sourceBefore.commit,
      sourceAfter: sourceAfter.commit,
      destBefore: destBefore.commit,
      destAfter: destAfter.commit,
      kind: raw.kind === "copy" ? "copy" : "move",
      binaries: binariesResult.binaries,
    },
  };
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
    resolved.binaries.git,
    resolved.sourceRepo,
    resolved.sourceAfter,
    "",
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
        resolved.binaries.git,
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
    if (!entry.repoPath.toLowerCase().endsWith(".md")) continue;
    const blob = await readBlobText(
      programs,
      resolved.binaries.git,
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
  return {
    findings: findBrokenMarkdownLinks(
      movedMarkdown,
      destAllEntries.map((entry) => entry.repoPath),
    ),
    notChecked,
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
): Promise<MoveEvaluation> {
  const resolvedResult = await resolveInputs(programs, parsePath, raw);
  if (!resolvedResult.ok) return resolvedResult;
  const resolved = resolvedResult.resolved;

  const sourceTree = await listTree(
    programs,
    resolved.binaries.git,
    resolved.sourceRepo,
    resolved.sourceBefore,
    resolved.sourceFolder,
  );
  if (!sourceTree.ok) return sourceTree;

  const destFolderTree = await listTree(
    programs,
    resolved.binaries.git,
    resolved.destinationRepo,
    resolved.destAfter,
    resolved.destinationFolder,
  );
  if (!destFolderTree.ok) return destFolderTree;

  const destAllTree =
    resolved.destinationFolder === ""
      ? destFolderTree
      : await listTree(
          programs,
          resolved.binaries.git,
          resolved.destinationRepo,
          resolved.destAfter,
          "",
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
