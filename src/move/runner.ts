import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  discoverTestFileCount,
  listTree,
  readBlobText,
  resolveCommit,
  resolveToolBinaries,
} from "./git.ts";
import type { ToolBinaries } from "./git.ts";
import {
  collectMovedPathTargets,
  compareTrees,
  findBrokenMarkdownLinks,
  findSourceKeptBlobs,
  findSourceStaleReferences,
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

  return {
    ok: true,
    resolved: {
      sourceRepo: raw.source,
      destinationRepo: raw.destination,
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
  | { readonly ok: true; readonly findings: readonly MoveFinding[] }
  | { readonly ok: false; readonly reason: string }
> {
  if (resolved.kind !== "move" || resolved.sourceAfter === null) {
    return { ok: true, findings: [] };
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
  const textFiles: { readonly repoPath: string; readonly text: string }[] = [];
  if (targets.length > 0) {
    for (const entry of sourceAfterTree.entries) {
      const text = await readBlobText(
        programs,
        resolved.binaries.git,
        resolved.sourceRepo,
        entry.hash,
      );
      if (text !== null) {
        textFiles.push({ repoPath: entry.repoPath, text });
      }
    }
  }
  return {
    ok: true,
    findings: [
      ...findSourceStaleReferences(textFiles, targets),
      ...findSourceKeptBlobs(sourceEntries, sourceAfterTree.entries),
    ],
  };
}

async function checkDestinationMarkdownLinks(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
  sourceEntries: readonly TreeEntry[],
  destFolderEntries: readonly TreeEntry[],
  destAllEntries: readonly TreeEntry[],
): Promise<readonly MoveFinding[]> {
  const sourceRelatives = new Set(
    sourceEntries.map((entry) => entry.relativePath),
  );
  const movedMarkdown: { readonly repoPath: string; readonly text: string }[] =
    [];
  for (const entry of destFolderEntries) {
    if (!sourceRelatives.has(entry.relativePath)) continue;
    if (!entry.repoPath.toLowerCase().endsWith(".md")) continue;
    const text = await readBlobText(
      programs,
      resolved.binaries.git,
      resolved.destinationRepo,
      entry.hash,
    );
    if (text !== null) {
      movedMarkdown.push({ repoPath: entry.repoPath, text });
    }
  }
  return findBrokenMarkdownLinks(
    movedMarkdown,
    destAllEntries.map((entry) => entry.repoPath),
  );
}

async function checkDestinationTests(
  programs: ProgramsCapability,
  resolved: ResolvedInputs,
): Promise<
  | { readonly ok: true; readonly findings: readonly MoveFinding[] }
  | { readonly ok: false; readonly reason: string }
> {
  if (resolved.destBefore === null) {
    return { ok: true, findings: [] };
  }
  const before = await discoverTestFileCount(
    programs,
    resolved.binaries,
    resolved.destinationRepo,
    resolved.destBefore,
  );
  if (!before.ok) return before;

  const after = await discoverTestFileCount(
    programs,
    resolved.binaries,
    resolved.destinationRepo,
    resolved.destAfter,
  );
  if (!after.ok) return after;

  if (after.count < before.count) {
    return {
      ok: true,
      findings: [
        {
          cause: "DOMAIN_MOVE_TEST_DROPPED",
          path: resolved.destinationRepo,
          beforeCount: before.count,
          afterCount: after.count,
        },
      ],
    };
  }
  return { ok: true, findings: [] };
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

  const testResult = await checkDestinationTests(programs, resolved);
  if (!testResult.ok) return testResult;

  const markdownFindings = await checkDestinationMarkdownLinks(
    programs,
    resolved,
    sourceTree.entries,
    destFolderTree.entries,
    destAllTree.entries,
  );

  const findings = orderFindings([
    ...compareTrees(sourceTree.entries, destFolderTree.entries),
    ...markdownFindings,
    ...sourceAfterResult.findings,
    ...testResult.findings,
  ]);

  return {
    ok: true,
    kind: resolved.kind,
    files: sourceTree.entries.map((entry) => ({
      path: entry.relativePath,
      hash: entry.hash,
    })),
    findings,
    notChecked: collectNotChecked(resolved),
  };
}
