import { changing, station } from "agent-cli-kernel";
import {
  causes,
  completedSuccess,
  type GatesState,
  noInput,
  nothingChanged,
  pendingStep,
  stationWords,
  unresolvedRepair,
} from "../shared/causes.ts";
import {
  checkWritableTarget,
  confirmFileContent,
  writeExclusiveFile,
} from "../shared/file-write.ts";
import { resolveRepositoryAndSettings } from "../shared/settings.ts";
import {
  changeNoteKinds,
  formatChangeNoteJson,
  isValidIsoDate,
  isValidSlug,
  parseChangeNote,
  todayLocalIsoDate,
} from "./rules.ts";

const identity = "agent-gates.change-note-add";

type AddInput = {
  readonly "--slug": string;
  readonly "--kind": string;
  readonly "--summary": string;
  readonly "--breaking"?: boolean | undefined;
  readonly "--affects"?: readonly string[] | undefined;
  readonly "--action"?: string | undefined;
  readonly "--date"?: string | undefined;
  readonly "--repository"?: string | undefined;
};

function prepareNoteWrite(input: AddInput) {
  const resolved = resolveRepositoryAndSettings(
    input["--repository"],
    process.cwd(),
  );
  if (!resolved.ok) return resolved;
  const { root, settings } = resolved;
  const date = input["--date"] ?? todayLocalIsoDate();
  if (!isValidIsoDate(date))
    return {
      ok: false as const,
      causeCode: "DOMAIN_GATES_NOTE_INVALID" as const,
      message: `Invalid date "${date}". Repair: pass --date YYYY-MM-DD with a real calendar date.`,
    };
  if (!isValidSlug(input["--slug"]))
    return {
      ok: false as const,
      causeCode: "DOMAIN_GATES_NOTE_INVALID" as const,
      message: `Invalid slug "${input["--slug"]}". Repair: use lowercase letters, digits, and single hyphens.`,
    };
  const file = `${date}-${input["--slug"]}.json`;
  const relativePath = `${settings.changeNotes.folder}/${file}`;
  const candidateJson = JSON.stringify({
    kind: input["--kind"],
    breaking: input["--breaking"] === true,
    affects: input["--affects"] ?? [],
    summary: input["--summary"],
    action: input["--action"] ?? null,
  });
  const parsed = parseChangeNote(
    relativePath,
    candidateJson,
    settings.changeNotes.affects,
  );
  if (!parsed.ok)
    return {
      ok: false as const,
      causeCode: "DOMAIN_GATES_NOTE_INVALID" as const,
      message: parsed.problem,
    };
  const targetCheck = checkWritableTarget(
    root,
    settings.changeNotes.folder,
    file,
  );
  if (!targetCheck.ok)
    return {
      ok: false as const,
      causeCode: "DOMAIN_GATES_FILE_EXISTS" as const,
      message: targetCheck.problem,
    };
  return {
    ok: true as const,
    root,
    folder: settings.changeNotes.folder,
    file,
    relativePath,
    note: parsed.note,
    content: formatChangeNoteJson(parsed.note),
  };
}

function transactionRefusalCause(kind: string) {
  if (kind === "held-lock") return "DOMAIN_GATES_CHANGE_HELD" as const;
  if (kind === "unresolved-case")
    return "DOMAIN_GATES_CHANGE_UNRESOLVED" as const;
  return "DOMAIN_GATES_STATE_UNAVAILABLE" as const;
}

export function changeNoteAddCommand(state: GatesState) {
  return changing({
    identity,
    route: ["change-note", "add"],
    summary: "Write one validated JSON change note into the repository.",
    input: {
      ...noInput,
      options: [
        {
          name: "--slug",
          aliases: [],
          summary: "Lowercase kebab-case slug for the change note filename.",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 128,
            choices: null,
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          },
        },
        {
          name: "--kind",
          aliases: [],
          summary: "Change kind: added, changed, fixed, removed, or none.",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 16,
            choices: [...changeNoteKinds],
            pattern: null,
          },
        },
        {
          name: "--summary",
          aliases: [],
          summary: "Concise summary describing what changed for readers.",
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
          name: "--breaking",
          aliases: [],
          summary: "Mark the change as breaking (requires --action).",
          required: false,
          repeatable: false,
          value: null,
        },
        {
          name: "--affects",
          aliases: [],
          summary:
            "Affected word; repeat once per word (required unless kind is none).",
          required: false,
          repeatable: true,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 128,
            choices: null,
            pattern: null,
          },
        },
        {
          name: "--action",
          aliases: [],
          summary:
            "Concrete step a reader must take (required when --breaking is set).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 2048,
            choices: null,
            pattern: null,
          },
        },
        {
          name: "--date",
          aliases: [],
          summary:
            "ISO date YYYY-MM-DD for the filename (defaults to today on this machine).",
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
      ],
    },
    capabilities: {},
    effectClass: "repository-local",
    effects: ["change-note.write"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_GATES_CHANGE_HELD",
    unresolvedCaseCause: "DOMAIN_GATES_CHANGE_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: completedSuccess,
        trigger:
          "The change note passed validation and was written and read back.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${identity}:written`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
        trigger: "No repository root was found for the command.",
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
            text: "Create agent-gates.json at the repository root, then run change-note add again.",
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
            text: "Fix agent-gates.json and run change-note add again.",
          },
        },
        independentObservable: `${identity}:settings-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_NOTE_INVALID",
        trigger:
          "The note date, slug, breaking action, affects words, or summary violated change note rules.",
        repairAction:
          "Repair the note input named in the message and run change-note add again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Adjust the note flags to satisfy change note rules and rerun.",
          },
        },
        independentObservable: `${identity}:note-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_FILE_EXISTS",
        trigger:
          "The target change note file already exists or the change notes folder is not a plain folder.",
        repairAction:
          "Choose a different --slug or inspect the existing file before retrying.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pick a distinct --slug or remove the conflicting path.",
          },
        },
        independentObservable: `${identity}:file-exists`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_CHANGE_HELD",
        trigger:
          "Another write to the same change note path is currently running.",
        repairAction:
          "Wait for that write to finish, then run change-note add again.",
        guidance: {
          handoff: {
            owner: "human",
            reason: "Another write holds the lock for this change note path.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${identity}:held`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_CHANGE_UNRESOLVED",
        trigger: "An earlier write to this change note path never finished.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "An earlier write to this change note path did not finish.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${identity}:unresolved`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE",
        trigger: "The gate state folder cannot take a change.",
        repairAction:
          "Inspect the state folder named by AGENT_GATES_STATE and repair it before retrying.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The gate state folder refused the transaction.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${identity}:state-unavailable`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_WRITE_UNCONFIRMED",
        trigger: "The change note write could not be confirmed on read-back.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "The change note write was not confirmed after writing.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${identity}:unconfirmed`,
      }),
    ],
    run: async (input, context) => {
      const prepared = prepareNoteWrite(input);
      if (!prepared.ok)
        return context.result(
          { commandIdentity: identity, causeCode: prepared.causeCode },
          { message: prepared.message, data: null, effects: nothingChanged },
        );

      const scopeKey = `${prepared.root}:${prepared.relativePath}`;
      const outcome = await state.transaction(
        context.state,
        {
          command: identity,
          scope: { resources: [{ resource: "change-note", key: scopeKey }] },
          facts: {
            repository: prepared.root,
            relativePath: prepared.relativePath,
          },
        },
        async (transaction) => {
          await transaction.record(
            "change-note.write",
            () => {
              writeExclusiveFile(
                prepared.root,
                prepared.folder,
                prepared.file,
                prepared.content,
              );
              return Promise.resolve();
            },
            () =>
              Promise.resolve(
                confirmFileContent(
                  prepared.root,
                  prepared.folder,
                  prepared.file,
                  prepared.content,
                ),
              ),
          );
        },
      );

      if (outcome.kind !== "ran")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: transactionRefusalCause(outcome.kind),
          },
          {
            message: `Did not write ${prepared.relativePath}: ${outcome.kind}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE",
          },
          {
            message: `Did not write ${prepared.relativePath}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState !== "completed")
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_GATES_WRITE_UNCONFIRMED",
          },
          {
            message: `Write of ${prepared.relativePath} could not be confirmed.`,
            data: null,
            transaction: outcome.proof,
          },
        );

      return context.result(
        { commandIdentity: identity, causeCode: completedSuccess },
        {
          message: `Wrote ${prepared.relativePath}.`,
          data: {
            repository: prepared.root,
            file: prepared.file,
            relativePath: prepared.relativePath,
            note: prepared.note,
          },
          transaction: outcome.proof,
        },
      );
    },
  });
}
