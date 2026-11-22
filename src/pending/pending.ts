import { command, station } from "agent-cli-kernel";
import {
  causes,
  type GatesState,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";

const identity = "agent-gates.pending";

export function pendingCommand(state: GatesState, stateFolder: string) {
  return command({
    identity,
    route: ["pending"],
    summary:
      "List unfinished agent-gates file writes recorded in the state folder.",
    input: noInput,
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
            text: "Review any unfinished gate writes before retrying a blocked path.",
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
          "Inspect the state folder named in the message and repair it before running agent-gates again.",
        guidance: {
          handoff: {
            owner: "operator",
            reason: "The gate state folder cannot be read.",
            inspect: [
              {
                kind: "instruction",
                text: "Inspect the gate state folder named in the message.",
              },
            ],
          },
        },
        independentObservable: `${identity}:state-unavailable`,
      }),
    ],
    run: async (_input, context) => {
      const report = state.report();
      if (!report.ok && report.reason === "missing")
        return context.result(
          { commandIdentity: identity, causeCode: unchangedSuccess },
          {
            message: "0 unfinished operations.",
            data: { stateFolder, unfinished: [] },
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
            message: `The gate state folder at ${stateFolder} is ${report.reason}.`,
            data: null,
            effects: nothingChanged,
          },
        );
      const unfinished = await Promise.all(
        report.unfinished.map(async (entry) => {
          const history = await state.history(entry.operationId);
          const target = history.ok
            ? history.history.scope.resources[0]?.keys[0]
            : undefined;
          return {
            operationId: entry.operationId,
            commandIdentity: entry.commandIdentity,
            runId: entry.runId,
            target: target?.startsWith("key:") ? target.slice(4) : null,
            effects: [...entry.effects],
          };
        }),
      );
      return context.result(
        { commandIdentity: identity, causeCode: unchangedSuccess },
        {
          message: `${String(unfinished.length)} unfinished operations.`,
          data: { stateFolder, unfinished },
          effects: nothingChanged,
        },
      );
    },
  });
}
