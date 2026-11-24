# Repository commands

The kernel's skills are installed under `.agents/skills/` (and linked under `.claude/skills/`). Read the matching skill before working:

- Write commands on the agent-cli-kernel package: read `.agents/skills/agent-cli-kernel/SKILL.md`.
- Prove that a CLI built on agent-cli-kernel really works, the way a user meets it: read `.agents/skills/verify-cli/SKILL.md`.

Use the existing repository CLI at src/cli.ts. Add commands through src/commands.ts.
Keep domain implementation in separate files and preserve one public application CLI.

Check command: bun run check
Smoke: bun run start --help
Source packet: https://linear.app/myagentdojo/issue/MAG-170/agent-gates-first-tool-change-notes-and-versions-as-kernel-commands
Template source: 80a63a7b244d3fd87c5b63dea45cdda6d0f5de0c

## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in config/ are the template's. Change a lint rule in the template, not here.
