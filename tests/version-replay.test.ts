import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeData,
  git,
  makeVersionRepo,
  runGatesCli,
} from "./support/git-repo.ts";
import { studyNotes } from "./support/replay-notes-fixture.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

const expectedAccount = [
  "# Template version 0.2.0 (2026-11-21)",
  "",
  "Generated repositories gain the verify-cli pointer skill and drop check:write.",
  "",
  "Affects: bootstrap, generated-repository, kernel-pin (1 breaking change, 2 consumer updates; 1 internal change omitted).",
  "",
  "## Breaking Changes",
  "",
  "- **generated-repository:** Removed check:write script alias. (`2026-11-21-breaking.json`)",
  "  - **Action:** Use bun run format instead.",
  "",
  "## Added",
  "",
  "- **kernel-pin, bootstrap:** Added verify-cli pointer skill. (`2026-11-21-added.json`)",
  "  - **Action:** Copy .agents/skills/verify-cli/SKILL.md.",
  "",
  "## Fixed",
  "",
  "- **generated-repository:** Ignored .worktrees/ in generated .gitignore. (`2026-11-21-fixed.json`)",
  "  - **Action:** Add .worktrees/ to .gitignore.",
  "",
].join("\n");

describe("CLI version math and 20-note per-PR replay (zero src imports)", () => {
  test("R14: version preview and prepare render exact grouped Markdown, trim lead whitespace, and omit kind none", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-seed.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Initial release.",
        action: null,
      }),
    });
    git(repo, "tag", "v0.1.0");
    commitFiles(repo, "add mixed notes", {
      "change-notes/2026-11-21-internal.json": JSON.stringify({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Internal test cleanup.",
        action: null,
      }),
      "change-notes/2026-11-21-fixed.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["generated-repository"],
        summary: "Ignored .worktrees/ in generated .gitignore.",
        action: "Add .worktrees/ to .gitignore.",
      }),
      "change-notes/2026-11-21-added.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["kernel-pin", "bootstrap"],
        summary: "Added verify-cli pointer skill.",
        action: "Copy .agents/skills/verify-cli/SKILL.md.",
      }),
      "change-notes/2026-11-21-breaking.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["generated-repository"],
        summary: "Removed check:write script alias.",
        action: "Use bun run format instead.",
      }),
    });

    const lead =
      "  Generated repositories gain the verify-cli pointer skill and drop check:write.  ";
    const preview = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        lead,
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(preview.exitCode).toBe(0);
    const previewData = envelopeData(preview.envelope);
    expect(previewData.version).toBe("0.2.0");
    expect(previewData.text).toBe(expectedAccount);

    const prepared = runGatesCli(
      [
        "version",
        "prepare",
        "--lead",
        lead,
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(prepared.exitCode).toBe(0);
    expect(readFileSync(join(repo, "versions/v0.2.0.md"), "utf8")).toBe(
      expectedAccount,
    );
    expect(String(previewData.text)).not.toContain("Internal test cleanup.");
  });

  test("R10, R11, R12, R20, R21: ignores malformed version tags and obeys 0.x caret boundaries through the CLI", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-seed.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Seed.",
        action: null,
      }),
    });
    for (const ignored of [
      "0.99.0",
      "v01.0.0",
      "v0.1.0-beta.1",
      "v0.2.0+build.1",
    ])
      git(repo, "tag", ignored);
    git(repo, "tag", "v0.1.0");

    commitFiles(repo, "breaking after 0.1.0", {
      "change-notes/2026-11-21-break.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["bootstrap"],
        summary: "Removed old option.",
        action: "Remove the old flag.",
      }),
    });
    const to020 = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Breaking 0.x bump.",
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(to020.exitCode).toBe(0);
    expect(envelopeData(to020.envelope).version).toBe("0.2.0");
    expect(Bun.semver.satisfies("0.2.0", "^0.1.0")).toBe(false);
    git(repo, "tag", "v0.2.0");

    commitFiles(repo, "added and fixed after 0.2.0", {
      "change-notes/2026-11-21-add.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Added feature.",
        action: null,
      }),
      "change-notes/2026-11-21-fix.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Fixed edge case.",
        action: null,
      }),
    });
    const to021 = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Patch 0.x bump.",
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(to021.exitCode).toBe(0);
    expect(envelopeData(to021.envelope).version).toBe("0.2.1");
    expect(Bun.semver.satisfies("0.2.1", "^0.2.0")).toBe(true);
    git(repo, "tag", "v0.2.1");

    commitFiles(repo, "changed after 0.2.1", {
      "change-notes/2026-11-21-change.json": JSON.stringify({
        kind: "changed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Adjusted message.",
        action: null,
      }),
    });
    const to022 = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Changed 0.x bump.",
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(to022.exitCode).toBe(0);
    expect(envelopeData(to022.envelope).version).toBe("0.2.2");
    git(repo, "tag", "v0.2.2");
    git(repo, "tag", "v0.10.0");

    commitFiles(repo, "fix after 0.10.0", {
      "change-notes/2026-11-21-after-ten.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Fix after 0.10.0.",
        action: null,
      }),
    });
    const to0101 = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Numeric sort picks v0.10.0 over v0.2.2.",
        "--date",
        "2026-11-21",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(to0101.exitCode).toBe(0);
    expect(envelopeData(to0101.envelope)).toMatchObject({
      previousTag: "v0.10.0",
      version: "0.10.1",
    });
  });

  test("R13: per-PR CLI replay of all 20 study notes starts at 0.1.0, refuses all 14 internal PRs, and follows 0.x caret bumps", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox);
    const trajectory: string[] = [];
    let refusedNoneCount = 0;

    for (const item of studyNotes) {
      commitFiles(repo, `PR #${String(item.pr)}`, {
        [`change-notes/${item.file}`]: `${JSON.stringify(item.note, null, 2)}\n`,
      });
      const prepared = runGatesCli(
        [
          "version",
          "prepare",
          "--lead",
          `Release for PR #${String(item.pr)}.`,
          "--date",
          "2026-11-21",
          "--repository",
          repo,
          "--json",
        ],
        { cwd: repo, stateDir },
      );
      if (item.note.kind === "none") {
        expect(prepared.exitCode).toBe(3);
        expect(prepared.envelope).toMatchObject({
          result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
        });
        refusedNoneCount += 1;
      } else {
        expect(prepared.exitCode).toBe(0);
        const data = envelopeData(prepared.envelope);
        const version = String(data.version);
        const relativePath = String(data.relativePath);
        trajectory.push(`#${String(item.pr)}->${version}`);
        git(repo, "add", "--", relativePath);
        git(repo, "commit", "-q", "-m", `Cut v${version}`);
        git(repo, "tag", `v${version}`);
      }
    }

    expect(refusedNoneCount).toBe(14);
    expect(trajectory).toEqual([
      "#131->0.1.0",
      "#134->0.1.1",
      "#135->0.2.0",
      "#140->0.2.1",
      "#141->0.2.2",
      "#142->0.2.3",
    ]);
  });
});
