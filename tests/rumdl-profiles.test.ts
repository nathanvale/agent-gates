import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { testFolder } from "./support/test-folder.ts";

const repoRoot = resolve(import.meta.dir, "..");
const rumdlBin = join(repoRoot, "node_modules/.bin/rumdl");
const docsProfile = join(repoRoot, "config/rumdl-docs.toml");
const notesProfile = join(repoRoot, "config/rumdl-notes.toml");

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = testFolder("rumdl-profile-");
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function runRumdl(cwd: string, args: readonly string[]) {
  const run = Bun.spawnSync([rumdlBin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

test("rumdl-notes.toml resolves the intended effective configuration when extended by a wiki", () => {
  const dir = fixture({
    ".rumdl.toml": `extends = ${JSON.stringify(notesProfile)}\n\n[global]\ninclude = ["wiki/**/*.md", "templates/**/*.md"]\n`,
  });
  const effective = runRumdl(dir, [
    "config",
    "--config",
    join(dir, ".rumdl.toml"),
  ]);
  expect(effective.exitCode).toBe(0);
  expect(effective.stdout).toContain('flavor = "obsidian"');
  expect(effective.stdout).toContain("cache = false");
  expect(effective.stdout).toContain("respect_gitignore = true");
  expect(effective.stdout).toContain(
    'include = ["wiki/**/*.md", "templates/**/*.md"]',
  );
  expect(effective.stdout).toContain("front-matter-title = false");
  expect(effective.stdout).toContain('front-matter-title = ""');
  expect(effective.stdout).toContain('"MD001"');
  expect(effective.stdout).toContain('"MD004"');
  expect(effective.stdout).toContain('"MD025"');
  expect(effective.stdout).toContain('"MD057"');
  expect(effective.stdout).not.toContain('"MD013"');
  expect(effective.stdout).not.toContain('"MD041"');
  expect(effective.stdout).not.toContain('"MD043"');
  expect(effective.stdout).not.toContain('"MD051"');
  expect(effective.stdout).not.toContain('"MD071"');
  expect(effective.stdout).not.toContain('"MD072"');
});

test("rumdl-docs.toml resolves the intended effective configuration when extended by a repository", () => {
  const dir = fixture({
    ".rumdl.toml": `extends = ${JSON.stringify(docsProfile)}\n`,
  });
  const effective = runRumdl(dir, [
    "config",
    "--config",
    join(dir, ".rumdl.toml"),
  ]);
  expect(effective.exitCode).toBe(0);
  expect(effective.stdout).toContain('flavor = "standard"');
  expect(effective.stdout).toContain("cache = false");
  expect(effective.stdout).toContain("respect_gitignore = true");
  expect(effective.stdout).toContain("front-matter-title = false");
  expect(effective.stdout).toContain('front-matter-title = ""');
  expect(effective.stdout).toContain('"MD051"');
  expect(effective.stdout).not.toContain('"MD013"');
  expect(effective.stdout).not.toContain('"MD041"');
  expect(effective.stdout).not.toContain('"MD043"');
  expect(effective.stdout).not.toContain('"MD071"');
  expect(effective.stdout).not.toContain('"MD072"');
});

test("rumdl-notes.toml passes clean Obsidian notes and templates and refuses planted mistakes", () => {
  const dir = fixture({
    ".rumdl.toml": `extends = ${JSON.stringify(notesProfile)}\n\n[global]\ninclude = ["wiki/**/*.md", "templates/**/*.md"]\n`,
    "wiki/people/ada.md": `---
title: "Ada Lovelace"
tags: [note]
---

# Ada Lovelace

## Context and Details

Ada Lovelace is a clean note with prose longer than eighty characters, a [[Wikilink]], and an Obsidian heading link [Section](#Context%20and%20Details).
`,
    "templates/person.md": `---
title: "{{title}}"
created: "{{date}}"
---

# {{title}}

## Context
`,
  });
  const clean = runRumdl(dir, [
    "check",
    "--config",
    join(dir, ".rumdl.toml"),
    "--output-format",
    "json",
    ".",
  ]);
  expect(clean.exitCode).toBe(0);
  expect(JSON.parse(clean.stdout)).toEqual([]);

  writeFileSync(
    join(dir, "wiki/people/broken.md"),
    `---
title: "Broken"
---

# Broken

### Skipped heading

- dash
* star

See [missing](./nope.md).
`,
  );
  const broken = runRumdl(dir, [
    "check",
    "--config",
    join(dir, ".rumdl.toml"),
    "--output-format",
    "json",
    ".",
  ]);
  expect(broken.exitCode).toBe(1);
  const rules = (JSON.parse(broken.stdout) as { rule: string }[]).map(
    (entry) => entry.rule,
  );
  expect(rules).toContain("MD001");
  expect(rules).toContain("MD004");
  expect(rules).toContain("MD057");
});

test("rumdl-docs.toml passes clean SKILL.md with front matter and refuses planted mistakes", () => {
  const dir = fixture({
    ".rumdl.toml": `extends = ${JSON.stringify(docsProfile)}\n`,
    "skills/example/SKILL.md": `---
name: example
description: Example skill with front matter and prose exceeding eighty characters in length.
---

# Example skill

## Usage

Run the tool with \`--json\` for machine-readable output.
`,
  });
  const clean = runRumdl(dir, [
    "check",
    "--config",
    join(dir, ".rumdl.toml"),
    "--output-format",
    "json",
    ".",
  ]);
  expect(clean.exitCode).toBe(0);
  expect(JSON.parse(clean.stdout)).toEqual([]);

  writeFileSync(
    join(dir, "README.md"),
    `# Broken doc

- one
* two

See [missing](./missing.md).
`,
  );
  const broken = runRumdl(dir, [
    "check",
    "--config",
    join(dir, ".rumdl.toml"),
    "--output-format",
    "json",
    ".",
  ]);
  expect(broken.exitCode).toBe(1);
  const rules = (JSON.parse(broken.stdout) as { rule: string }[]).map(
    (entry) => entry.rule,
  );
  expect(rules).toContain("MD004");
  expect(rules).toContain("MD057");
});
