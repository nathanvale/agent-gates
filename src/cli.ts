import { runProcess } from "agent-cli-kernel";
import { createAgentGates } from "./commands.ts";

const { contract, setup } = createAgentGates(process.env);
await runProcess(contract, setup)(process.argv.slice(2));
