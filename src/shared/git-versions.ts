import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  canonicalChangeNoteKey,
  type ChangeNoteEntry,
  compareText,
} from "../change-note/rules.ts";
import {
  compareRepositoryVersions,
  parseRepositoryVersion,
} from "../version/rules.ts";
import { readTreeNoteFingerprints } from "./git-fingerprints.ts";
import {
  type BlobCandidate,
  diffResolvedRange,
  type GitResult,
  isNewlyAddedNote,
  isNotePath,
  resolveCommitOid,
  runReadOnlyGit,
  splitNul,
  validateCommittedNote,
} from "./git-read.ts";
import type { GateSettings } from "./settings.ts";

type VersionTag = {
  readonly tag: string;
  readonly version: string;
};

const versionTagPattern = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const replacementCharacter = "\uFFFD";

export async function latestVersionTag(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  headOid: string,
): Promise<GitResult<VersionTag | undefined>> {
  const ran = await runReadOnlyGit(programs, parsePath, root, "for-each-ref", [
    `--merged=${headOid}`,
    "--format=%(refname:short)",
    "refs/tags",
  ]);
  if (!ran.ok) return ran;
  const tags: VersionTag[] = [];
  for (const line of ran.value.split("\n")) {
    const match = versionTagPattern.exec(line);
    const version = match?.[1];
    if (version !== undefined && parseRepositoryVersion(version).ok)
      tags.push({ tag: line, version });
  }
  tags.sort((left, right) =>
    compareRepositoryVersions(left.version, right.version),
  );
  return { ok: true, value: tags.at(-1) };
}

function parseTreeCandidate(
  record: string,
  notesFolder: string,
):
  | { readonly ok: true; readonly candidate: BlobCandidate | undefined }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    } {
  const tab = record.indexOf("\t");
  if (tab < 0)
    return {
      ok: false,
      kind: "git",
      problem: "git ls-tree returned an incomplete tree record.",
    };
  const header = record.slice(0, tab);
  const path = record.slice(tab + 1);
  if (!isNotePath(notesFolder, path)) return { ok: true, candidate: undefined };
  const [mode = "", type = "", blob = ""] = header.split(" ");
  if (mode === "" || type === "" || blob === "")
    return {
      ok: false,
      kind: "git",
      problem: "git ls-tree returned an incomplete tree record.",
    };
  if (type !== "blob")
    return {
      ok: false,
      kind: "invalid",
      problem: `${path}: must be a plain file in HEAD (git entry "${header}"). Repair: replace it with a regular UTF-8 JSON file.`,
    };
  return {
    ok: true,
    candidate: {
      mode,
      blob,
      path,
      invalidUtf8Path: path.includes(replacementCharacter),
    },
  };
}

async function candidatesAtCommit(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  commitOid: string,
  notesFolder: string,
): Promise<
  | { readonly ok: true; readonly candidates: readonly BlobCandidate[] }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    }
> {
  const ran = await runReadOnlyGit(programs, parsePath, root, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    commitOid,
    "--",
    notesFolder,
  ]);
  if (!ran.ok) return { ok: false, kind: "git", problem: ran.problem };
  const candidates: BlobCandidate[] = [];
  for (const record of splitNul(ran.value)) {
    const parsed = parseTreeCandidate(record, notesFolder);
    if (!parsed.ok) return parsed;
    if (parsed.candidate !== undefined) candidates.push(parsed.candidate);
  }
  return { ok: true, candidates };
}

type NoteCandidateSet = {
  readonly candidates: readonly BlobCandidate[];
  readonly priorFingerprints: ReadonlySet<string> | undefined;
};

type NoteCandidateResult =
  | { readonly ok: true; readonly value: NoteCandidateSet }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    };

async function candidatesSinceTag(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  settings: GateSettings,
  previousTag: string,
  headOid: string,
): Promise<NoteCandidateResult> {
  const notesFolder = settings.changeNotes.folder;
  const tagOid = await resolveCommitOid(
    programs,
    parsePath,
    root,
    `refs/tags/${previousTag}`,
  );
  if (!tagOid.ok) return { ok: false, kind: "git", problem: tagOid.problem };
  const diff = await diffResolvedRange(
    programs,
    parsePath,
    root,
    `${tagOid.value}..${headOid}`,
    notesFolder,
  );
  if (!diff.ok) return { ok: false, kind: "git", problem: diff.problem };
  const candidates = diff.value
    .filter((entry) => isNewlyAddedNote(notesFolder, entry))
    .map(({ mode, blob, path, invalidUtf8Path }) => ({
      mode,
      blob,
      path,
      invalidUtf8Path,
    }));
  if (candidates.length === 0)
    return {
      ok: true,
      value: { candidates, priorFingerprints: undefined },
    };
  const prior = await readTreeNoteFingerprints(
    programs,
    parsePath,
    root,
    tagOid.value,
    settings,
  );
  if (!prior.ok) return { ok: false, kind: "git", problem: prior.problem };
  return {
    ok: true,
    value: { candidates, priorFingerprints: prior.value },
  };
}

export async function readChangeNotesSinceTag(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  settings: GateSettings,
  previousTag: string | undefined,
  headOid: string,
): Promise<
  | { readonly ok: true; readonly entries: readonly ChangeNoteEntry[] }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "git";
      readonly problem: string;
    }
> {
  const collected =
    previousTag === undefined
      ? await candidatesAtCommit(
          programs,
          parsePath,
          root,
          headOid,
          settings.changeNotes.folder,
        ).then(
          (result): NoteCandidateResult =>
            result.ok
              ? {
                  ok: true,
                  value: {
                    candidates: result.candidates,
                    priorFingerprints: undefined,
                  },
                }
              : result,
        )
      : await candidatesSinceTag(
          programs,
          parsePath,
          root,
          settings,
          previousTag,
          headOid,
        );
  if (!collected.ok) return collected;
  const { candidates, priorFingerprints } = collected.value;
  const entries: ChangeNoteEntry[] = [];
  for (const candidate of candidates) {
    const validated = await validateCommittedNote(
      programs,
      parsePath,
      root,
      settings,
      candidate,
    );
    if (!validated.ok) return validated;
    if (
      priorFingerprints !== undefined &&
      priorFingerprints.has(canonicalChangeNoteKey(validated.entry.note))
    )
      continue;
    entries.push(validated.entry);
  }
  entries.sort((left, right) => compareText(left.file, right.file));
  return { ok: true, entries: Object.freeze(entries) };
}
