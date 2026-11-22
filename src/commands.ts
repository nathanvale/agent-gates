import { command, contractFor } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { stateAddon } from "agent-cli-kernel/addons/state";
import { changeNoteAddCommand } from "./change-note/add.ts";
import { changeNoteCheckCommand } from "./change-note/check.ts";
import { pendingCommand } from "./pending/pending.ts";
import {
  causes,
  cli,
  noInput,
  nothingChanged,
  unchangedSuccess,
} from "./shared/causes.ts";
import { defaultStateFolder } from "./shared/settings.ts";

const status = command({
  identity: "agent-gates.status",
  route: ["status"],
  summary: "Report that agent-gates runs.",
  input: noInput,
  capabilities: {},
  run: (_input, context) =>
    context.result(
      { commandIdentity: "agent-gates.status", causeCode: unchangedSuccess },
      {
        message: "The command-line tool runs.",
        data: { ready: true },
        effects: nothingChanged,
      },
    ),
});

export const commands = [status] as const;

export function createAgentGates(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const stateFolder = defaultStateFolder(environment);
  const state = stateAddon({
    root: stateFolder,
    report: "agent-gates.pending",
  });
  const parsePath = (value: string): ParsedPath =>
    contract.boundary.path(value);
  const contract = contractFor({
    cli,
    commands: [
      status,
      changeNoteAddCommand(state),
      changeNoteCheckCommand(parsePath),
      pendingCommand(state, stateFolder),
    ],
    causes,
    state: state.descriptor,
    installedAddons: ["state", "programs"],
  });
  return {
    contract,
    setup: {
      addons: { programs: programsAddon() },
      emergencyRecord: state.emergencyRecord,
    },
  };
}
