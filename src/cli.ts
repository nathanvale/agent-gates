import { contractFor, runProcess } from "agent-cli-kernel";
import { commands } from "./commands.ts";

const contract = contractFor({
  cli: "agent-gates",
  commands,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
