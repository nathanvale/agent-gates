import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  type ChangeNoteEntry,
  formatLocalIsoDate,
  isValidIsoDate,
} from "../change-note/rules.ts";
import {
  readCommittedGateSettings,
  resolveCommitOid,
} from "../shared/git-read.ts";
import {
  latestVersionTag,
  readChangeNotesSinceTag,
} from "../shared/git-versions.ts";
import {
  discoverRepositoryRoot,
  type GateSettings,
  type VersionSettings,
} from "../shared/settings.ts";
import {
  nextRepositoryVersion,
  normalizeLead,
  renderVersionAccount,
} from "./rules.ts";

function ensureRepair(message: string, fallbackRepair: string): string {
  return message.includes("Repair:")
    ? message
    : `${message} Repair: ${fallbackRepair}`;
}

export type PreparedAccount = {
  readonly repository: string;
  readonly versions: VersionSettings;
  readonly previousTag: string | null;
  readonly previousVersion: string | null;
  readonly version: string;
  readonly date: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly consumerCount: number;
  readonly internalCount: number;
  readonly text: string;
};

type PrepareFailure = {
  readonly ok: false;
  readonly causeCode:
    | "DOMAIN_GATES_REPOSITORY_NOT_FOUND"
    | "DOMAIN_GATES_SETTINGS_MISSING"
    | "DOMAIN_GATES_SETTINGS_INVALID"
    | "DOMAIN_GATES_VERSION_INVALID"
    | "DOMAIN_GATES_GIT_FAILED"
    | "DOMAIN_GATES_NOTE_INVALID"
    | "DOMAIN_GATES_NOTHING_TO_PREPARE";
  readonly message: string;
};

export const versionOptions = [
  {
    name: "--lead",
    aliases: [],
    summary: "Single-line one-sentence lead summary for the version account.",
    required: true,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 1024,
      choices: null,
      pattern: null,
    },
  },
  {
    name: "--date",
    aliases: [],
    summary:
      "ISO date YYYY-MM-DD for the version heading (defaults to today on this machine).",
    required: false,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 10,
      maxLength: 10,
      choices: null,
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    },
  },
  {
    name: "--repository",
    aliases: [],
    summary:
      "Target repository folder (defaults to walking upward to the git root).",
    required: false,
    repeatable: false,
    value: {
      kind: "string",
      minLength: 1,
      maxLength: 4096,
      choices: null,
      pattern: null,
    },
  },
] as const;

async function validateVersionInputs(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  input: {
    readonly "--lead": string;
    readonly "--date"?: string | undefined;
    readonly "--repository"?: string | undefined;
  },
): Promise<
  | {
      readonly ok: true;
      readonly root: string;
      readonly headOid: string;
      readonly settings: GateSettings;
      readonly versions: VersionSettings;
      readonly lead: string;
      readonly date: string;
    }
  | PrepareFailure
> {
  const repoResult = discoverRepositoryRoot(
    input["--repository"],
    process.cwd(),
  );
  if (!repoResult.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
      message: repoResult.problem,
    };
  const headOid = await resolveCommitOid(
    programs,
    parsePath,
    repoResult.root,
    "HEAD",
  );
  if (!headOid.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_GIT_FAILED",
      message: ensureRepair(
        headOid.problem,
        "ensure the repository has at least one commit and run again.",
      ),
    };
  const resolved = await readCommittedGateSettings(
    programs,
    parsePath,
    repoResult.root,
    headOid.value,
  );
  if (!resolved.ok)
    return {
      ok: false,
      causeCode: resolved.causeCode,
      message: ensureRepair(
        resolved.message,
        "ensure git can read committed files in HEAD and run again.",
      ),
    };
  const versions = resolved.settings.versions;
  if (versions === undefined)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
      message:
        'agent-gates.json has no "versions" section, so this repository does not prepare repository versions. Repair: add a "versions" object with "folder" (and optional "heading") to agent-gates.json.',
    };
  const leadResult = normalizeLead(input["--lead"]);
  if (!leadResult.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_VERSION_INVALID",
      message: leadResult.problem,
    };
  const date = input["--date"] ?? formatLocalIsoDate(new Date());
  if (!isValidIsoDate(date))
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_VERSION_INVALID",
      message: `Invalid date "${date}". Repair: pass --date YYYY-MM-DD with a real calendar date.`,
    };
  return {
    ok: true,
    root: repoResult.root,
    headOid: headOid.value,
    settings: resolved.settings,
    versions,
    lead: leadResult.value,
    date,
  };
}

function assembleAccount(args: {
  readonly root: string;
  readonly notesFolder: string;
  readonly versions: VersionSettings;
  readonly lead: string;
  readonly date: string;
  readonly previous:
    | { readonly tag: string; readonly version: string }
    | undefined;
  readonly entries: readonly ChangeNoteEntry[];
}): { readonly ok: true; readonly account: PreparedAccount } | PrepareFailure {
  const sinceLabel =
    args.previous === undefined
      ? "before the first repository version"
      : `since ${args.previous.tag}`;
  if (args.entries.length === 0)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE",
      message: `No new change notes found ${sinceLabel}. Repair: commit at least one consumer-facing change note under ${args.notesFolder}/ before preparing a repository version.`,
    };
  const nextVersionResult = nextRepositoryVersion(
    args.previous?.version,
    args.entries.map(({ note }) => note),
  );
  if (!nextVersionResult.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_VERSION_INVALID",
      message: nextVersionResult.problem,
    };
  const version = nextVersionResult.value;
  if (version === undefined)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE",
      message: `Only internal (kind: "none") change notes (${String(args.entries.length)}) were found ${sinceLabel}, so no repository version is prepared. Repair: wait until a consumer-facing change note lands before preparing a repository version.`,
    };
  const consumerCount = args.entries.filter(
    ({ note }) => note.kind !== "none",
  ).length;
  const rendered = renderVersionAccount({
    heading: args.versions.heading,
    version,
    date: args.date,
    lead: args.lead,
    entries: args.entries,
  });
  if (!rendered.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_VERSION_INVALID",
      message: rendered.problem,
    };
  const fileName = `v${version}.md`;
  return {
    ok: true,
    account: {
      repository: args.root,
      versions: args.versions,
      previousTag: args.previous?.tag ?? null,
      previousVersion: args.previous?.version ?? null,
      version,
      date: args.date,
      fileName,
      relativePath: `${args.versions.folder}/${fileName}`,
      consumerCount,
      internalCount: args.entries.length - consumerCount,
      text: rendered.value,
    },
  };
}

export async function buildPreparedAccount(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  input: {
    readonly "--lead": string;
    readonly "--date"?: string | undefined;
    readonly "--repository"?: string | undefined;
  },
): Promise<
  { readonly ok: true; readonly account: PreparedAccount } | PrepareFailure
> {
  const checked = await validateVersionInputs(programs, parsePath, input);
  if (!checked.ok) return checked;

  const latestTagResult = await latestVersionTag(
    programs,
    parsePath,
    checked.root,
    checked.headOid,
  );
  if (!latestTagResult.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_GIT_FAILED",
      message: ensureRepair(
        latestTagResult.problem,
        "ensure the repository tags are readable and run again.",
      ),
    };
  const previous = latestTagResult.value;
  const notesResult = await readChangeNotesSinceTag(
    programs,
    parsePath,
    checked.root,
    checked.settings,
    previous?.tag,
    checked.headOid,
  );
  if (!notesResult.ok)
    return {
      ok: false,
      causeCode:
        notesResult.kind === "git"
          ? "DOMAIN_GATES_GIT_FAILED"
          : "DOMAIN_GATES_NOTE_INVALID",
      message:
        notesResult.kind === "git"
          ? ensureRepair(
              notesResult.problem,
              "ensure git history is readable and run again.",
            )
          : notesResult.problem,
    };
  return assembleAccount({
    root: checked.root,
    notesFolder: checked.settings.changeNotes.folder,
    versions: checked.versions,
    lead: checked.lead,
    date: checked.date,
    previous,
    entries: notesResult.entries,
  });
}

export function accountData(account: PreparedAccount, written: boolean) {
  return {
    repository: account.repository,
    previousTag: account.previousTag,
    previousVersion: account.previousVersion,
    version: account.version,
    date: account.date,
    relativePath: account.relativePath,
    written,
    consumerCount: account.consumerCount,
    internalCount: account.internalCount,
    text: account.text,
  };
}
