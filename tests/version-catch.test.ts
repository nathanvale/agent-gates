import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeData,
  envelopeMessage,
  git,
  makeCustomRepo,
  makeVersionRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

function runVersion(
  subcommand: "prepare" | "preview",
  repo: string,
  stateDir: string,
  lead: string,
  date: string,
) {
  return runGatesCli(
    [
      "version",
      subcommand,
      "--lead",
      lead,
      "--date",
      date,
      "--repository",
      repo,
      "--json",
    ],
    { cwd: repo, stateDir },
  );
}

describe("User-story catch tests for versions (US 10-15, US 19, US 23, R9, R14, R21, R24, R26)", () => {
  test("R21, R24: ignores non-version and unmerged tags, and applies 1.0.0+ rules (breaking -> major, added -> minor, fixed -> patch)", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-first.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Initial feature.",
        action: null,
      }),
    });
    git(repo, "tag", "glossary-split-20261120");
    git(repo, "tag", "v0.2.0");

    git(repo, "checkout", "-b", "side-branch");
    commitFiles(repo, "side commit", {
      "change-notes/2026-11-21-side.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Unmerged feature.",
        action: null,
      }),
    });
    git(repo, "tag", "v9.0.0");

    git(repo, "checkout", "main");
    commitFiles(repo, "main 1.2.3", {
      "change-notes/2026-11-21-second.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Stable.",
        action: null,
      }),
    });
    git(repo, "tag", "v1.2.3");

    commitFiles(repo, "fixed note", {
      "change-notes/2026-11-22-fix.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Bug fix.",
        action: null,
      }),
    });
    const patchCut = runVersion(
      "prepare",
      repo,
      stateDir,
      "Patch release.",
      "2026-11-22",
    );
    expect(patchCut.exitCode).toBe(0);
    expect(envelopeData(patchCut.envelope).version).toBe("1.2.4");

    commitFiles(repo, "added note", {
      "change-notes/2026-11-22-add.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Minor feature.",
        action: null,
      }),
    });
    const minorCut = runVersion(
      "prepare",
      repo,
      stateDir,
      "Minor release.",
      "2026-11-22",
    );
    expect(minorCut.exitCode).toBe(0);
    expect(envelopeData(minorCut.envelope).version).toBe("1.3.0");

    commitFiles(repo, "breaking note", {
      "change-notes/2026-11-22-break.json": JSON.stringify({
        kind: "changed",
        breaking: true,
        affects: ["bootstrap"],
        summary: "Breaking change.",
        action: "Update callers.",
      }),
    });
    const majorCut = runVersion(
      "prepare",
      repo,
      stateDir,
      "Major release.",
      "2026-11-22",
    );
    expect(majorCut.exitCode).toBe(0);
    expect(envelopeData(majorCut.envelope).version).toBe("2.0.0");
  });

  test("US 10 & R21: renaming a pre-tag change note does not count it again for the next version", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-breaking.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["bootstrap"],
        summary: "Earlier breaking change.",
        action: "Update callers.",
      }),
    });
    git(repo, "tag", "v0.1.0");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-breaking.json",
      "change-notes/2026-11-20-breaking-renamed.json",
    );
    git(repo, "commit", "-q", "-m", "rename released note");

    const refused = runVersion(
      "prepare",
      repo,
      stateDir,
      "Should not re-prepare renamed note.",
      "2026-11-22",
    );
    expect(refused.exitCode).toBe(3);
    expect(refused.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });
  });

  test("US 11, 12, 14 & R9, R14, R21: 0.1.3+breaking -> 0.2.0, 0.9.9 -> 0.10.0 -> 0.11.0, huge tag ignored, executable + BOM tolerated, preview works when account exists", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
      versions: { folder: "versions", heading: "Custom heading" },
    });

    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(
        JSON.stringify({
          kind: "added",
          breaking: false,
          affects: ["cli"],
          summary: "BOM executable note.",
          action: null,
        }),
      ),
    ]);
    writeTreeFile(repo, "change-notes/2026-11-20-bom.json", bom);
    chmodSync(join(repo, "change-notes/2026-11-20-bom.json"), 0o755);
    git(repo, "add", "change-notes/2026-11-20-bom.json");
    git(repo, "commit", "-q", "-m", "bom executable note");
    for (const tag of [
      "v99999999999999999999.0.0",
      "release-1",
      "0.5.0",
      "v01.2.3",
      "v1.0.0-alpha.1",
      "v0.1.3",
    ])
      git(repo, "tag", tag);

    commitFiles(repo, "fixed + breaking on 0.1.3", {
      "change-notes/2026-11-21-a-fixed.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Minor fix.",
        action: "Check logs.",
      }),
      "change-notes/2026-11-21-z-breaking.json": JSON.stringify({
        kind: "changed",
        breaking: true,
        affects: ["cli"],
        summary: "Breaking shift.",
        action: "Migrate config.",
      }),
    });

    const cut020 = runVersion(
      "prepare",
      repo,
      stateDir,
      "Breaking shift on 0.1.3 resets patch.",
      "2026-11-21",
    );
    expect(cut020.exitCode).toBe(0);
    expect(envelopeData(cut020.envelope).version).toBe("0.2.0");
    const accountText = readFileSync(join(repo, "versions/v0.2.0.md"), "utf8");
    expect(accountText).toContain("# Custom heading 0.2.0 (2026-11-21)");
    expect(accountText).toContain("Check logs.");
    expect(accountText).toContain("Migrate config.");

    const previewExisting = runVersion(
      "preview",
      repo,
      stateDir,
      "Breaking shift on 0.1.3 resets patch.",
      "2026-11-21",
    );
    expect(previewExisting.exitCode).toBe(0);
    expect(envelopeData(previewExisting.envelope)).toMatchObject({
      version: "0.2.0",
      written: false,
    });

    git(repo, "tag", "v0.9.9");
    commitFiles(repo, "breaking 1", {
      "change-notes/2026-11-22-b1.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["cli"],
        summary: "Drop A.",
        action: "Stop using A.",
      }),
    });
    expect(
      envelopeData(
        runVersion("prepare", repo, stateDir, "Stays in 0.10.0.", "2026-11-22")
          .envelope,
      ).version,
    ).toBe("0.10.0");
    git(repo, "tag", "v0.10.0");

    commitFiles(repo, "breaking 2", {
      "change-notes/2026-11-22-b2.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["cli"],
        summary: "Drop B.",
        action: "Stop using B.",
      }),
    });
    expect(
      envelopeData(
        runVersion("prepare", repo, stateDir, "Stays in 0.11.0.", "2026-11-22")
          .envelope,
      ).version,
    ).toBe("0.11.0");
  });

  test("US 15, 19, 23 & R26: omits versions section cleanly, and help exposes no tag/commit/push flags", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "notes",
        shippedFolders: ["wiki"],
        affects: ["guides"],
      },
    });
    const noVersions = runVersion(
      "prepare",
      repo,
      stateDir,
      "Wiki has no versions section.",
      "2026-11-22",
    );
    expect(noVersions.exitCode).toBe(3);
    expect(noVersions.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_SETTINGS_INVALID" },
    });
    expect(envelopeMessage(noVersions.envelope)).toContain("versions");

    const rootHelp = runGatesCli(["--help"], { cwd: repo, stateDir });
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain("version-prepare");
    expect(rootHelp.stdout).toContain("version-preview");

    const prepareHelp = runGatesCli(["version", "prepare", "--help"], {
      cwd: repo,
      stateDir,
    });
    expect(prepareHelp.exitCode).toBe(0);
    expect(prepareHelp.stdout).not.toContain("--tag");
    expect(prepareHelp.stdout).not.toContain("--commit");
    expect(prepareHelp.stdout).not.toContain("--push");
  });
});
