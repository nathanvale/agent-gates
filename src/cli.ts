import { commands } from "./commands.ts";
import { contractFor, runProcess } from "agent-cli-kernel";

const contract = contractFor({
  cli: "agent-gates",
  commands,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
