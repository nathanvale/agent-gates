import { runProcess } from "agent-cli-kernel";
import { programsAddon } from "agent-cli-kernel/addons/programs";
import { contract } from "./commands.ts";

await runProcess(contract, {
  addons: { programs: programsAddon() },
})(process.argv.slice(2));
