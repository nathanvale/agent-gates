import { changing, station } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
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
import {
  accountData,
  buildPreparedAccount,
  versionOptions,
} from "./account.ts";
import { pluralCount } from "./rules.ts";

const prepareIdentity = "agent-gates.version-prepare";

export function versionPrepareCommand(
  state: GatesState,
  parsePath: (value: string) => ParsedPath,
) {
  return changing({
    identity: prepareIdentity,
    route: ["version", "prepare"],
    summary:
      "Compute the next repository version from committed change notes since the latest vX.Y.Z tag and write one version account file.",
    input: {
      ...noInput,
      options: versionOptions,
    },
    capabilities: { programs: true },
    effectClass: "repository-local",
    effects: ["version-account.write"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_GATES_CHANGE_HELD",
    unresolvedCaseCause: "DOMAIN_GATES_CHANGE_UNRESOLVED",
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: completedSuccess,
        trigger: "The version account was written and confirmed on read-back.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${prepareIdentity}:written`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
        trigger: "No git repository root was found for version prepare.",
        repairAction:
          "Run inside a git repository or pass an existing git repository root to --repository.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Pass --repository with an existing git repository root directory.",
          },
        },
        independentObservable: `${prepareIdentity}:repository-not-found`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_SETTINGS_MISSING",
        trigger: "The repository has no agent-gates.json settings file.",
        repairAction:
          "Add agent-gates.json at the repository root declaring changeNotes and versions settings.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Create agent-gates.json at the repository root, then run version prepare again.",
          },
        },
        independentObservable: `${prepareIdentity}:settings-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_SETTINGS_INVALID",
        trigger:
          "The repository's agent-gates.json failed validation or omits versions settings.",
        repairAction:
          "Repair the field named in the error message in agent-gates.json.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix agent-gates.json and run version prepare again.",
          },
        },
        independentObservable: `${prepareIdentity}:settings-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_VERSION_INVALID",
        trigger: "The --lead sentence or --date value is invalid.",
        repairAction:
          "Pass a non-empty single-line --lead and a real calendar YYYY-MM-DD --date.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix --lead or --date and run version prepare again.",
          },
        },
        independentObservable: `${prepareIdentity}:version-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_GIT_FAILED",
        trigger: "Git failed while reading tags or committed change notes.",
        repairAction:
          "Ensure the repository is a readable git checkout with at least one commit and run again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Verify the git repository history and rerun version prepare.",
          },
        },
        independentObservable: `${prepareIdentity}:git-failed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_NOTE_INVALID",
        trigger:
          "One or more committed change notes since the latest tag are invalid.",
        repairAction:
          "Repair the invalid change note named in the message, commit it, and run version prepare again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix the invalid change note in HEAD and rerun version prepare.",
          },
        },
        independentObservable: `${prepareIdentity}:note-invalid`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE",
        trigger:
          "No consumer-facing change notes were found since the latest tag.",
        repairAction:
          "Wait until at least one consumer-facing change note lands before preparing a repository version.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Commit a consumer-facing change note before preparing a version account.",
          },
        },
        independentObservable: `${prepareIdentity}:nothing-to-prepare`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_FILE_EXISTS",
        trigger:
          "The target version account already exists or the versions folder is not a plain folder.",
        repairAction:
          "Inspect or cut the existing version account before preparing a new repository version.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Inspect the existing version account or folder and retry.",
          },
        },
        independentObservable: `${prepareIdentity}:file-exists`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_CHANGE_HELD",
        trigger:
          "Another version prepare for this target file is currently running.",
        repairAction:
          "Wait for that prepare to end, then run version prepare again.",
        guidance: {
          handoff: {
            owner: "human",
            reason:
              "Another version prepare holds the lock for this version account.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${prepareIdentity}:held`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_CHANGE_UNRESOLVED",
        trigger: "An earlier write to this version account never finished.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason: "An earlier version account write did not finish.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${prepareIdentity}:unresolved`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
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
        independentObservable: `${prepareIdentity}:state-unavailable`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: prepareIdentity,
        causeCode: "DOMAIN_GATES_WRITE_UNCONFIRMED",
        trigger:
          "The version account write could not be confirmed on read-back.",
        repairAction: unresolvedRepair,
        guidance: {
          handoff: {
            owner: "human",
            reason:
              "The version account write was not confirmed after writing.",
            inspect: [pendingStep],
          },
        },
        independentObservable: `${prepareIdentity}:unconfirmed`,
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
          { commandIdentity: prepareIdentity, causeCode: built.causeCode },
          { message: built.message, data: null, effects: nothingChanged },
        );
      const account = built.account;

      const targetCheck = checkWritableTarget(
        account.repository,
        account.versions.folder,
        account.fileName,
      );
      if (!targetCheck.ok)
        return context.result(
          {
            commandIdentity: prepareIdentity,
            causeCode: "DOMAIN_GATES_FILE_EXISTS",
          },
          {
            message: targetCheck.problem,
            data: null,
            effects: nothingChanged,
          },
        );

      const scopeKey = `${account.repository}:${account.relativePath}`;
      const outcome = await state.transaction(
        context.state,
        {
          command: prepareIdentity,
          scope: {
            resources: [{ resource: "version-account", key: scopeKey }],
          },
          facts: {
            repository: account.repository,
            relativePath: account.relativePath,
            version: account.version,
          },
        },
        async (transaction) => {
          await transaction.record(
            "version-account.write",
            () => {
              writeExclusiveFile(
                account.repository,
                account.versions.folder,
                account.fileName,
                account.text,
              );
              return Promise.resolve();
            },
            () =>
              Promise.resolve(
                confirmFileContent(
                  account.repository,
                  account.versions.folder,
                  account.fileName,
                  account.text,
                ),
              ),
          );
        },
      );

      if (outcome.kind !== "ran") {
        const causeCode =
          outcome.kind === "held-lock"
            ? "DOMAIN_GATES_CHANGE_HELD"
            : outcome.kind === "unresolved-case"
              ? "DOMAIN_GATES_CHANGE_UNRESOLVED"
              : "DOMAIN_GATES_STATE_UNAVAILABLE";
        return context.result(
          { commandIdentity: prepareIdentity, causeCode },
          {
            message: `Did not write ${account.relativePath}: ${outcome.kind}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      }
      if (outcome.proof.transactionState === "unchanged")
        return context.result(
          {
            commandIdentity: prepareIdentity,
            causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE",
          },
          {
            message: `Did not write ${account.relativePath}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      if (outcome.proof.transactionState !== "completed")
        return context.result(
          {
            commandIdentity: prepareIdentity,
            causeCode: "DOMAIN_GATES_WRITE_UNCONFIRMED",
          },
          {
            message: `Write of ${account.relativePath} could not be confirmed.`,
            data: null,
            transaction: outcome.proof,
          },
        );

      const omitted =
        account.internalCount > 0
          ? `, ${pluralCount(account.internalCount, "internal note")} omitted`
          : "";
      const transition =
        account.previousVersion === null
          ? `first repository version ${account.version}`
          : `${account.previousVersion} -> ${account.version}`;
      return context.result(
        { commandIdentity: prepareIdentity, causeCode: completedSuccess },
        {
          message: `Wrote ${account.relativePath} (${transition}, ${pluralCount(account.consumerCount, "consumer note")}${omitted}).`,
          data: accountData(account, true),
          transaction: outcome.proof,
        },
      );
    },
  });
}
