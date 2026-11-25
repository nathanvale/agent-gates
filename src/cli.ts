import { contractFor, runProcess } from "agent-cli-kernel";
import { commands } from "./commands.ts";
import { causes } from "./shared/causes.ts";

const contract = contractFor({
  cli: "agent-gates",
  commands,
  causes,
  installedAddons: [],
});

await runProcess(contract)(process.argv.slice(2));
