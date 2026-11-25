import { command } from "agent-cli-kernel";
import { changelogEarlier } from "./changelog/earlier.ts";
import { noInput, nothingChanged, unchangedSuccess } from "./shared/causes.ts";

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

export const commands = [status, changelogEarlier] as const;
