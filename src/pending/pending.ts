import { command, station } from "agent-cli-kernel";
import {
  causes,
  type GatesState,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import { discoverRepositoryRoot } from "../shared/settings.ts";

const identity = "agent-gates.pending";

export function pendingCommand(state: GatesState) {
  return command({
    identity,
    route: ["pending"],
    summary:
      "List unfinished agent-gates file writes recorded for the current repository.",
    input: {
      ...noInput,
      options: [
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
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: unchangedSuccess,
        trigger: "The gate state folder was read or does not exist yet.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Review any unfinished gate writes for this repository before retrying a blocked path.",
          },
        },
        independentObservable: `${identity}:listed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity: identity,
        causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE",
        trigger: "The gate state folder is unreadable or corrupt.",
        repairAction:
          "Inspect the gate state folder configured by AGENT_GATES_STATE (or the default state location) and repair it before running agent-gates again.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The gate state folder cannot be read.",
            inspect: [
              {
                kind: "instruction",
                text: "Inspect the gate state folder configured by AGENT_GATES_STATE.",
              },
            ],
          },
        },
        independentObservable: `${identity}:state-unavailable`,
      }),
    ],
    run: async (input, context) => {
      const report = state.report();
      if (!report.ok && report.reason === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: "0 unfinished operations.",
            data: { unfinished: [] },
            effects: nothingChanged,
          },
        );
      if (!report.ok)
        return context.result(
          {
            commandIdentity: identity,
            causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE",
          },
          {
            message: `The gate state folder is ${report.reason}. Repair: inspect the folder named by AGENT_GATES_STATE (or the default state location) and repair it before running agent-gates again.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const repoResult = discoverRepositoryRoot(
        input["--repository"],
        process.cwd(),
      );
      if (!repoResult.ok)
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: "0 unfinished operations.",
            data: { unfinished: [] },
            effects: nothingChanged,
          },
        );
      const repoPrefix = `key:${repoResult.root}:`;
      const allEntries = await Promise.all(
        report.unfinished.map(async (entry) => {
          const history = await state.history(entry.operationId);
          const rawKey = history.ok
            ? history.history.scope.resources[0]?.keys[0]
            : undefined;
          if (rawKey === undefined || !rawKey.startsWith(repoPrefix))
            return undefined;
          return {
            operationId: entry.operationId,
            commandIdentity: entry.commandIdentity,
            runId: entry.runId,
            target: rawKey.slice(repoPrefix.length),
            effects: [...entry.effects],
          };
        }),
      );
      const unfinished = allEntries.filter((entry) => entry !== undefined);
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `${String(unfinished.length)} unfinished operations.`,
          data: { unfinished },
          effects: nothingChanged,
        },
      );
    },
  });
}
