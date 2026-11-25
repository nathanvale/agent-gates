import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import { resolveCommit, resolveGitDir, resolveToolBinaries } from "./git.ts";
import type { ToolBinaries } from "./git.ts";
import { normalizeFolder, parseCommitSpec } from "./rules.ts";
import type { MoveKind } from "./rules.ts";

export type RawMoveInput = {
  readonly source: string;
  readonly sourceCommit: string;
  readonly sourceFolder: string | undefined;
  readonly destination: string;
  readonly destinationCommit: string;
  readonly destinationFolder: string | undefined;
  readonly kind: string | undefined;
};

export type ResolvedInputs = {
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

async function resolveSameRepository(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  sourceRepo: string,
  destinationRepo: string,
): Promise<
  | { readonly ok: true; readonly sameRepository: boolean }
  | { readonly ok: false; readonly reason: string }
> {
  const sourceGitDir = await resolveGitDir(programs, binaries, sourceRepo);
  if (!sourceGitDir.ok) return sourceGitDir;
  const destGitDir = await resolveGitDir(programs, binaries, destinationRepo);
  if (!destGitDir.ok) return destGitDir;
  return {
    ok: true,
    sameRepository: sourceGitDir.gitDir === destGitDir.gitDir,
  };
}

async function resolveOptionalCommit(
  programs: ProgramsCapability,
  binaries: ToolBinaries,
  repo: string,
  rev: string | null,
): Promise<
  | { readonly ok: true; readonly commit: string | null }
  | { readonly ok: false; readonly reason: string }
> {
  if (rev === null) return { ok: true, commit: null };
  return resolveCommit(programs, binaries, repo, rev);
}

export async function resolveInputs(
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

  const { binaries } = binariesResult;
  const sourceBefore = await resolveCommit(
    programs,
    binaries,
    raw.source,
    sourceSpec.spec.first,
  );
  if (!sourceBefore.ok) return sourceBefore;

  const sourceAfter = await resolveOptionalCommit(
    programs,
    binaries,
    raw.source,
    sourceSpec.spec.second,
  );
  if (!sourceAfter.ok) return sourceAfter;

  const destBefore = await resolveOptionalCommit(
    programs,
    binaries,
    raw.destination,
    destSpec.spec.second === null ? null : destSpec.spec.first,
  );
  if (!destBefore.ok) return destBefore;

  const destAfter = await resolveCommit(
    programs,
    binaries,
    raw.destination,
    destSpec.spec.second ?? destSpec.spec.first,
  );
  if (!destAfter.ok) return destAfter;

  const sameRepo = await resolveSameRepository(
    programs,
    binaries,
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
      binaries,
    },
  };
}
