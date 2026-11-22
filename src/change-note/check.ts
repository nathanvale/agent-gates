import { command, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import {
  diffRange,
  isNewlyAddedNote,
  isNotePath,
  validateCommittedNote,
} from "../shared/git-read.ts";
import {
  type GateSettings,
  isShippedPath,
  resolveRepositoryAndSettings,
} from "../shared/settings.ts";

const identity = "agent-gates.change-note-check";

async function validateBranchNotes(
  programs: ProgramsCapability,
  parsePath: (value: string) => ParsedPath,
  root: string,
  settings: GateSettings,
  entries: readonly {
    readonly mode: string;
    readonly blob: string;
    readonly status: string;
    readonly oldPath: string | undefined;
    readonly path: string;
    readonly invalidUtf8Path: boolean;
  }[],
) {
  const problems: string[] = [];
  const validatedNotes: string[] = [];
  for (const entry of entries) {
    const checked = await validateCommittedNote(
      programs,
      parsePath,
      root,
      settings,
      entry,
    );
    if (!checked.ok) {
      if (checked.kind === "git")
        return {
          ok: false as const,
          causeCode: "DOMAIN_GATES_GIT_FAILED" as const,
          message: checked.problem,
        };
      problems.push(checked.problem);
    } else {
      validatedNotes.push(entry.path);
    }
  }
  if (problems.length > 0)
    return {
      ok: false as const,
      causeCode: "DOMAIN_GATES_NOTE_INVALID" as const,
      message: problems.join(" "),
    };
  return { ok: true as const, validatedNotes };
}

export function changeNoteCheckCommand(
  parsePath: (value: string) => ParsedPath,
) {
  return command({
    identity,
    route: ["change-note", "check"],
    summary:
      "Check committed change notes against a base revision and refuse shipped changes without a note.",
    input: {
      ...noInput,
      options: [
        {
          name: "--base",
          aliases: [],
          summary:
            "Base git revision to diff against HEAD (defaults to origin/main).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 256,
            choices: null,
            pattern: null,
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
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger:
          "All changed notes are valid and any shipped path change includes a new change note.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${identity}:passed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
        trigger: "No repository root was found for the gate.",
        repairAction:
          "Run inside a repository or pass an existing directory to --repository.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass --repository with an existing repository root directory.",
          },
        },
        independentObservable: `${identity}:repository-not-found`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_SETTINGS_MISSING",
        trigger: "The repository has no agent-gates.json settings file.",
        repairAction:
          "Add agent-gates.json at the repository root declaring changeNotes settings.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Create agent-gates.json at the repository root, then run change-note check again.",
          },
        },
        independentObservable: `${identity}:settings-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
        trigger: "The repository's agent-gates.json failed validation.",
        repairAction:
          "Repair the field named in the error message in agent-gates.json.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix agent-gates.json and run change-note check again.",
          },
        },
        independentObservable: `${identity}:settings-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_GIT_FAILED",
        trigger:
          "Git could not read the diff against the base revision or read committed blobs.",
        repairAction:
          "Ensure the repository is a valid git checkout and the base revision exists locally, then run change-note check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify the git repository and --base revision, then rerun change-note check.",
          },
        },
        independentObservable: `${identity}:git-failed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_NOTE_INVALID",
        trigger:
          "One or more committed change notes failed filename, UTF-8, mode, or schema checks.",
        repairAction:
          "Repair the invalid change note named in the message, commit it, and run change-note check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the invalid change note in git HEAD and rerun change-note check.",
          },
        },
        independentObservable: `${identity}:note-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_NOTE_MISSING",
        trigger:
          "One or more shipped paths changed without adding a change note.",
        repairAction:
          "Run change-note add to write a change note (use kind none if there is no consumer effect), commit it, and run change-note check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Add and commit a change note with agent-gates change-note add, then rerun change-note check.",
          },
        },
        independentObservable: `${identity}:note-missing`,
      }),
    ],
    run: async (input, context) => {
      const resolved = resolveRepositoryAndSettings(
        input["--repository"],
        process.cwd(),
      );
      if (!resolved.ok)
        return context.result(
          { commandIdentity: identity, causeCode: resolved.causeCode },
          { message: resolved.message, data: null, effects: nothingChanged },
        );
      const settings = resolved.settings;
      const base = input["--base"] ?? "origin/main";
      const notesFolder = settings.changeNotes.folder;

      const diff = await diffRange(
        context.programs,
        parsePath,
        resolved.root,
        `${base}...HEAD`,
      );
      if (!diff.ok)
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_GATES_GIT_FAILED" },
          {
            message: `${diff.problem} Repair: ensure the base revision exists locally and run again.`,
            data: null,
            effects: nothingChanged,
          },
        );

      const entries = diff.value;
      const noteEntries = entries.filter(
        (entry) => entry.status !== "D" && isNotePath(notesFolder, entry.path),
      );
      const addedNotes = entries
        .filter((entry) => isNewlyAddedNote(notesFolder, entry))
        .map((entry) => entry.path);

      const validated = await validateBranchNotes(
        context.programs,
        parsePath,
        resolved.root,
        settings,
        noteEntries,
      );
      if (!validated.ok)
        return context.result(
          { commandIdentity: identity, causeCode: validated.causeCode },
          { message: validated.message, data: null, effects: nothingChanged },
        );

      const shippedFiles = entries
        .filter(
          (entry) =>
            isShippedPath(settings, entry.path) ||
            (entry.oldPath !== undefined &&
              isShippedPath(settings, entry.oldPath)),
        )
        .map((entry) =>
          isShippedPath(settings, entry.path)
            ? entry.path
            : (entry.oldPath ?? entry.path),
        );

      if (shippedFiles.length > 0 && addedNotes.length === 0)
        return context.result(
          { commandIdentity: identity, causeCode: "DOMAIN_GATES_NOTE_MISSING" },
          {
            message: `This branch changes ${String(shippedFiles.length)} shipped path(s) (first: ${shippedFiles[0] ?? ""}) without adding a change note under ${notesFolder}/. Repair: add ${notesFolder}/YYYY-MM-DD-<slug>.json (use "kind": "none" if there is no consumer effect).`,
            data: null,
            effects: nothingChanged,
          },
        );

      const detail =
        shippedFiles.length === 0
          ? `${String(entries.length)} changed file(s), none on a shipped path`
          : `${String(shippedFiles.length)} shipped path(s) covered by ${addedNotes.join(", ")}`;
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `Change notes gate passed (${detail}).`,
          data: {
            repository: resolved.root,
            base,
            changedFileCount: entries.length,
            shippedFiles,
            addedNotes,
            validatedNotes: validated.validatedNotes,
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
