import { command, contractFor } from "agent-cli-kernel";
import { changelogBackfill } from "./changelog/backfill.ts";
import { createHistoryScan } from "./history/scan.ts";
import { createMoveCheck } from "./move/check.ts";
import {
  causes,
  noInput,
  nothingChanged,
  unchangedSuccess,
} from "./shared/causes.ts";

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

const moveCheck = createMoveCheck(() => contract.boundary.path);
const historyScan = createHistoryScan(() => contract.boundary.path);

export const commands = [
  status,
  changelogBackfill,
  moveCheck,
  historyScan,
] as const;

export const contract = contractFor({
  cli: "agent-gates",
  commands,
  causes,
  installedAddons: ["programs"],
});
