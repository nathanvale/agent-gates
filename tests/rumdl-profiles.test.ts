import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  findRumdlProfileDrift,
  findRumdlSelectionOverrides,
  parseEffectiveEnabledRules,
  parseOffRuleCatalog,
  parseOfferedRumdlRules,
  parseProfileEnabledRules,
  parseRumdlCheckRules,
} from "./support/rumdl-drift.ts";
import {
  rumdlWarmupTimeoutMs,
  runRumdl,
  warmRumdl,
} from "./support/rumdl-runner.ts";
import { testFolder } from "./support/test-folder.ts";

const repoRoot = resolve(import.meta.dir, "..");
const docsProfile = join(repoRoot, "config/rumdl-docs.toml");
const notesProfile = join(repoRoot, "config/rumdl-notes.toml");
const offRulesFile = join(repoRoot, "config/rumdl-off-rules.json");

const expectedDocsEnabledRules = [
  "MD001",
  "MD003",
  "MD004",
  "MD005",
  "MD007",
  "MD009",
  "MD010",
  "MD011",
  "MD012",
  "MD014",
  "MD018",
  "MD019",
  "MD020",
  "MD021",
  "MD022",
  "MD023",
  "MD024",
  "MD025",
  "MD026",
  "MD027",
  "MD028",
  "MD029",
  "MD030",
  "MD031",
  "MD032",
  "MD034",
  "MD035",
  "MD036",
  "MD037",
  "MD038",
  "MD039",
  "MD040",
  "MD042",
  "MD045",
  "MD046",
  "MD047",
  "MD048",
  "MD049",
  "MD050",
  "MD051",
  "MD052",
  "MD053",
  "MD054",
  "MD055",
  "MD056",
  "MD057",
  "MD058",
  "MD059",
  "MD062",
  "MD064",
  "MD065",
  "MD066",
  "MD067",
  "MD068",
  "MD069",
  "MD075",
  "MD077",
  "MD081",
  "MD086",
  "MD092",
  "MD094",
] as const;

const expectedNotesEnabledRules = [
  "MD001",
  "MD003",
  "MD004",
  "MD005",
  "MD007",
  "MD009",
  "MD010",
  "MD011",
  "MD012",
  "MD014",
  "MD018",
  "MD019",
  "MD020",
  "MD021",
  "MD022",
  "MD023",
  "MD024",
  "MD025",
  "MD026",
  "MD027",
  "MD028",
  "MD029",
  "MD030",
  "MD031",
  "MD032",
  "MD034",
  "MD035",
  "MD036",
  "MD037",
  "MD038",
  "MD039",
  "MD040",
  "MD042",
  "MD045",
  "MD046",
  "MD047",
  "MD048",
  "MD049",
  "MD050",
  "MD052",
  "MD053",
  "MD054",
  "MD055",
  "MD056",
  "MD057",
  "MD058",
  "MD059",
  "MD062",
  "MD064",
  "MD065",
  "MD066",
  "MD067",
  "MD068",
  "MD069",
  "MD075",
  "MD077",
  "MD081",
  "MD086",
  "MD092",
  "MD094",
] as const;

const created: string[] = [];
beforeAll(() => {
  warmRumdl();
}, rumdlWarmupTimeoutMs);
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

function selectionOverrides(profilePath: string) {
  const args = ["config", "--config", profilePath, "--output", "json"];
  return findRumdlSelectionOverrides(
    basename(profilePath),
    readFileSync(profilePath, "utf8"),
    runRumdl(repoRoot, args).stdout,
  );
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
  const rules = parseRumdlCheckRules(broken.stdout);
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
  const rules = parseRumdlCheckRules(broken.stdout);
  expect(rules).toContain("MD004");
  expect(rules).toContain("MD057");
});

test("rumdl-docs.toml and rumdl-notes.toml pin their complete enabled rule lists", () => {
  const cases = [
    {
      name: "rumdl-docs.toml",
      path: docsProfile,
      expected: expectedDocsEnabledRules,
    },
    {
      name: "rumdl-notes.toml",
      path: notesProfile,
      expected: expectedNotesEnabledRules,
    },
  ] as const;

  for (const profile of cases) {
    const enabledFromToml = parseProfileEnabledRules(
      readFileSync(profile.path, "utf8"),
      profile.name,
    );
    expect(enabledFromToml).toEqual([...profile.expected]);

    const effective = runRumdl(repoRoot, [
      "config",
      "--config",
      profile.path,
      "--output",
      "json",
    ]);
    expect(effective.exitCode).toBe(0);
    expect(effective.stderr).toBe("");
    expect(parseEffectiveEnabledRules(effective.stdout, profile.name)).toEqual([
      ...profile.expected,
    ]);
    expect(selectionOverrides(profile.path)).toEqual([]);
  }
});

test("a profile that switches a rule through anything but global.enable is refused with the cause and the repair", () => {
  const docsToml = readFileSync(docsProfile, "utf8");
  const inGlobal = (line: string) =>
    docsToml.replace("[global]\n", `[global]\n${line}\n`);
  const repair =
    "from config/rumdl-docs.toml and change global.enable instead; a rule taken out of global.enable needs a reason in config/rumdl-off-rules.json.";
  const declared = (key: string) =>
    `rumdl-docs.toml: global.${key} is declared, but global.enable is the only rule selector this profile may use. Remove global.${key} ${repair}`;
  const resolved = (label: string, value = '["MD092"]') =>
    `rumdl-docs.toml: rumdl resolves ${label} to ${value}, so the pinned global.enable list is not what runs. Remove whatever sets it (a global list, "enabled" in a rule section, or a [per-file-ignores] table) ${repair}`;
  const cases: readonly (readonly [string, readonly string[]])[] = [
    [inGlobal('disable = ["MD092"]'), [declared("disable")]],
    [
      inGlobal('extend_disable = ["MD092"]'),
      [declared("extend_disable"), resolved("global.extend-disable")],
    ],
    [`${docsToml}\n[MD092]\nenabled = false\n`, [resolved("global.disable")]],
    [
      `${docsToml}\n[per-file-ignores]\n"**/*.md" = ["MD092"]\n`,
      [resolved("per-file-ignores", '{"**/*.md":["MD092"]}')],
    ],
  ];

  for (const [planted, expected] of cases) {
    const dir = fixture({ "rumdl-docs.toml": planted });
    expect(selectionOverrides(join(dir, "rumdl-docs.toml"))).toEqual(expected);
  }
});

test("every rule offered by rumdl is either enabled or listed as off with a reason in both profiles", () => {
  const listed = runRumdl(repoRoot, [
    "rule",
    "--output-format",
    "json",
    "--no-config",
  ]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stderr).toBe("");
  const offeredRules = parseOfferedRumdlRules(listed.stdout);
  const catalog = parseOffRuleCatalog(readFileSync(offRulesFile, "utf8"));
  expect(Object.keys(catalog.profiles).sort()).toEqual([
    "rumdl-docs.toml",
    "rumdl-notes.toml",
  ]);

  const issues = [
    ...findRumdlProfileDrift(
      "rumdl-docs.toml",
      offeredRules,
      parseProfileEnabledRules(
        readFileSync(docsProfile, "utf8"),
        "rumdl-docs.toml",
      ),
      catalog,
    ),
    ...findRumdlProfileDrift(
      "rumdl-notes.toml",
      offeredRules,
      parseProfileEnabledRules(
        readFileSync(notesProfile, "utf8"),
        "rumdl-notes.toml",
      ),
      catalog,
    ),
  ];

  expect(issues.join("\n")).toBe("");
});

test("drift audit names the rule and decision for unknown codes, new rules, overlap, and stale off entries", () => {
  const offered = [
    { code: "MD001", name: "heading-increment", summary: "Heading increment" },
    { code: "MD013", name: "line-length", summary: "Line length" },
    { code: "MD033", name: "no-inline-html", summary: "Inline HTML" },
    { code: "MD998", name: "future-rule", summary: "Future rule from bump" },
  ] as const;

  const issues = findRumdlProfileDrift(
    "rumdl-notes.toml",
    offered,
    ["MD001", "MD999"],
    {
      shared: {
        MD001: "overlap",
        MD013: "unwrapped prose",
        MD033: "   ",
        MD997: "removed upstream",
      },
      profiles: {
        "rumdl-notes.toml": {
          MD013: "duplicate",
        },
      },
    },
  );

  expect(issues).toEqual([
    'rumdl-notes.toml: off rule MD013 appears in both shared and profiles["rumdl-notes.toml"] — keep one owner in config/rumdl-off-rules.json.',
    "rumdl-notes.toml: enabled rule MD999 is not offered by rumdl — remove or rename MD999 in config/rumdl-notes.toml.",
    "rumdl-notes.toml: rule MD001 is both enabled in config/rumdl-notes.toml and listed as off in config/rumdl-off-rules.json — decide whether to keep MD001 enabled (remove from off list) or disable it (remove from global.enable).",
    'rumdl-notes.toml: off rule MD033 has an empty reason — write a one-line reason or "not yet decided" in config/rumdl-off-rules.json.',
    "rumdl-notes.toml: off rule MD997 is no longer offered by rumdl — remove MD997 from config/rumdl-off-rules.json.",
    "rumdl-notes.toml: offered rule MD998 (future-rule: Future rule from bump) is neither enabled nor listed as off — enable MD998 in config/rumdl-notes.toml or add a one-line reason in config/rumdl-off-rules.json.",
  ]);
});
