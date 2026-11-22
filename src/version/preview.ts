import { command, station } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import {
  accountData,
  buildPreparedAccount,
  versionOptions,
} from "./account.ts";

const previewIdentity = "agent-gates.version-preview";

export function versionPreviewCommand(
  parsePath: (value: string) => ParsedPath,
) {
  return command({
    identity: previewIdentity,
    route: ["version", "preview"],
    summary:
      "Render the next repository version account from committed change notes without writing any file.",
    input: {
      ...noInput,
      options: versionOptions,
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: unchangedSuccess,
        trigger: "The version account was rendered without writing any file.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${previewIdentity}:rendered`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
        trigger: "No git repository root was found for version preview.",
        repairAction:
          "Run inside a git repository or pass an existing git repository root to --repository.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass --repository with an existing git repository root directory.",
          },
        },
        independentObservable: `${previewIdentity}:repository-not-found`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_SETTINGS_MISSING",
        trigger: "The repository has no agent-gates.json settings file.",
        repairAction:
          "Add agent-gates.json at the repository root declaring changeNotes and versions settings.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Create agent-gates.json at the repository root, then run version preview again.",
          },
        },
        independentObservable: `${previewIdentity}:settings-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
        trigger:
          "The repository's agent-gates.json failed validation or omits versions settings.",
        repairAction:
          "Repair the field named in the error message in agent-gates.json.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix agent-gates.json and run version preview again.",
          },
        },
        independentObservable: `${previewIdentity}:settings-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "USAGE_GATES_INVALID_ARGUMENT",
        trigger: "The --lead sentence or --date calendar value is invalid.",
        repairAction:
          "Pass a non-empty single-line --lead and a real calendar YYYY-MM-DD --date.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix --lead or --date and run version preview again.",
          },
        },
        independentObservable: `${previewIdentity}:invalid-argument`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_VERSION_INVALID",
        trigger: "The computed version or rendered account failed validation.",
        repairAction:
          "Check the latest vX.Y.Z tag and version settings, then run version preview again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify repository version tags and settings, then rerun version preview.",
          },
        },
        independentObservable: `${previewIdentity}:version-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_GIT_FAILED",
        trigger: "Git failed while reading tags or committed change notes.",
        repairAction:
          "Ensure the repository is a readable git checkout with at least one commit and run again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify the git repository history and rerun version preview.",
          },
        },
        independentObservable: `${previewIdentity}:git-failed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_NOTE_INVALID",
        trigger:
          "One or more committed change notes since the latest tag are invalid.",
        repairAction:
          "Repair the invalid change note named in the message, commit it, and run version preview again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the invalid change note in HEAD and rerun version preview.",
          },
        },
        independentObservable: `${previewIdentity}:note-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: previewIdentity,
        causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE",
        trigger:
          "No consumer-facing change notes were found since the latest tag.",
        repairAction:
          "Wait until at least one consumer-facing change note lands before preparing a repository version.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Commit a consumer-facing change note before previewing a version account.",
          },
        },
        independentObservable: `${previewIdentity}:nothing-to-prepare`,
      }),
    ],
    run: async (input, context) => {
      const built = await buildPreparedAccount(
        context.programs,
        parsePath,
        input,
      );
      if (!built.ok)
        return context.result(
          { commandIdentity: previewIdentity, causeCode: built.causeCode },
          { message: built.message, data: null, effects: nothingChanged },
        );
      return context.result(
        { commandIdentity: previewIdentity, causeCode: unchangedSuccess },
        {
          message: `Previewed ${built.account.relativePath} (${built.account.version}).`,
          data: accountData(built.account, false),
          effects: nothingChanged,
        },
      );
    },
  });
}
