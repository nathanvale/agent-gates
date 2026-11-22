import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeMessage,
  git,
  initGitRepo,
  makeCustomRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

function checkBase(repo: string, stateDir: string) {
  return runGatesCli(
    ["change-note", "check", "--base", "main", "--repository", repo, "--json"],
    { cwd: repo, stateDir },
  );
}

describe("User-story catch tests for change-note and root discovery (R1, R5, R8, R17, R19, R23, R26, R27)", () => {
  test("US 4 & US 20 & R27: non-git cwd refuses cleanly, decoy agent-gates.json outside .git is ignored, nested subdir works", () => {
    const outer = sandbox.folder("decoy-outer-");
    const stateDir = join(outer, "state");
    writeTreeFile(
      outer,
      "agent-gates.json",
      JSON.stringify({
        changeNotes: {
          folder: "decoy-notes",
          shippedFolders: ["src"],
          affects: ["decoy"],
        },
      }),
    );

    const nonGit = join(outer, "plain-dir");
    mkdirSync(nonGit, { recursive: true });
    const nonGitCheck = runGatesCli(["change-note", "check", "--json"], {
      cwd: nonGit,
      stateDir,
    });
    expect(nonGitCheck.exitCode).toBe(3);
    expect(nonGitCheck.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND" },
    });
    expect(envelopeMessage(nonGitCheck.envelope)).toContain("Repair:");

    const innerRepo = join(outer, "inner-repo");
    initGitRepo(innerRepo);
    commitFiles(innerRepo, "init", { "README.md": "# No settings\n" });
    const nested = join(innerRepo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    const mustRefuseDecoy = runGatesCli(
      ["change-note", "check", "--base", "main", "--json"],
      { cwd: nested, stateDir },
    );
    expect(mustRefuseDecoy.exitCode).toBe(3);
    expect(mustRefuseDecoy.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_SETTINGS_MISSING" },
    });

    commitFiles(innerRepo, "add real settings", {
      "agent-gates.json": JSON.stringify({
        changeNotes: {
          folder: "change-notes",
          shippedFolders: ["src"],
          affects: ["cli"],
        },
      }),
    });
    const fromNested = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "nested-write",
        "--kind",
        "added",
        "--affects",
        "cli",
        "--summary",
        "Added from deep subdir.",
        "--date",
        "2026-11-22",
        "--json",
      ],
      { cwd: nested, stateDir },
    );
    expect(fromNested.exitCode).toBe(0);
    expect(
      existsSync(join(innerRepo, "change-notes/2026-11-22-nested-write.json")),
    ).toBe(true);
  });

  test("US 5, 6, 8, 9 & R1, R5, R8, R17: README exempt, missing notes dir passes, rename hole closed, breakng typo refused, 3-dot diff ignores base-only commits, none with affects passes", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFiles: ["pkg.json"],
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });

    git(repo, "checkout", "-b", "docs-no-notes-dir");
    commitFiles(repo, "edit docs only", { "README.md": "# Updated\n" });
    expect(checkBase(repo, stateDir).exitCode).toBe(0);

    git(repo, "checkout", "main");
    commitFiles(repo, "add readme and base note", {
      "change-notes/README.md": "# Notes\n",
      "change-notes/2026-11-20-old.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Old fix.",
        action: null,
      }),
    });

    git(repo, "checkout", "-b", "readme-only");
    commitFiles(repo, "edit notes readme", {
      "change-notes/README.md": "# Notes v2\n",
      "docs/guide.md": "# Guide\n",
    });
    expect(checkBase(repo, stateDir).exitCode).toBe(0);

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "rename-bypass");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-20-renamed.json",
    );
    writeTreeFile(repo, "src/index.ts", "export const x = 1;\n");
    git(repo, "add", "src/index.ts");
    git(repo, "commit", "-q", "-m", "rename old note and edit shipped file");
    const renameBlocked = checkBase(repo, stateDir);
    expect(renameBlocked.exitCode).toBe(3);
    expect(renameBlocked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "typo-breakng");
    commitFiles(repo, "typo field", {
      "change-notes/2026-11-22-typo.json": JSON.stringify({
        kind: "changed",
        breaking: false,
        breakng: true,
        affects: ["cli"],
        summary: "Typo.",
        action: null,
      }),
    });
    const typoRefused = checkBase(repo, stateDir);
    expect(typoRefused.exitCode).toBe(3);
    expect(envelopeMessage(typoRefused.envelope)).toContain("breakng");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "three-dot-branch");
    commitFiles(repo, "doc edit on branch", { "README.md": "# Branch doc\n" });
    git(repo, "checkout", "main");
    commitFiles(repo, "shipped edit on main after branching", {
      "src/main-only.ts": "export const m = 1;\n",
    });
    git(repo, "checkout", "three-dot-branch");
    expect(checkBase(repo, stateDir).exitCode).toBe(0);

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "none-with-affects");
    commitFiles(repo, "shipped edit with none note carrying affects", {
      "src/internal.ts": "export const i = 1;\n",
      "change-notes/2026-11-22-internal-affects.json": JSON.stringify({
        kind: "none",
        breaking: false,
        affects: ["cli"],
        summary: "Internal refactor on cli.",
        action: null,
      }),
    });
    expect(checkBase(repo, stateDir).exitCode).toBe(0);
  });

  test("US 19, 23, 25 & R26: wiki custom folder with zero template leak, help self-describes commands, and agent-gates's own settings gate src/", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "notes",
        shippedFolders: ["wiki"],
        affects: ["guides"],
      },
    });
    git(repo, "checkout", "-b", "wiki-edit");
    commitFiles(repo, "edit wiki", { "wiki/intro.md": "# Intro\n" });

    const missing = checkBase(repo, stateDir);
    expect(missing.exitCode).toBe(3);
    const missingMsg = envelopeMessage(missing.envelope).toLowerCase();
    expect(missingMsg).not.toContain("template");
    expect(missingMsg).not.toContain("bootstrap");
    expect(missingMsg).not.toContain("change-notes");
    expect(missingMsg).toContain("notes/");

    const added = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "intro-guide",
        "--kind",
        "added",
        "--affects",
        "guides",
        "--summary",
        "Added intro guide.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(added.exitCode).toBe(0);
    git(repo, "add", "notes/2026-11-22-intro-guide.json");
    git(repo, "commit", "-q", "-m", "add wiki note");
    expect(checkBase(repo, stateDir).exitCode).toBe(0);

    const rootHelp = runGatesCli(["--help"], { cwd: repo, stateDir });
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain("change-note-add");
    expect(rootHelp.stdout).toContain("change-note-check");

    const selfSettings = readFileSync(
      join(import.meta.dir, "../agent-gates.json"),
      "utf8",
    );
    const selfRepo = join(sandbox.folder("gates-self-"), "self-repo");
    initGitRepo(selfRepo);
    commitFiles(selfRepo, "init self", {
      "agent-gates.json": selfSettings,
      "src/commands.ts": "export const x = 1;\n",
    });
    git(selfRepo, "checkout", "-b", "unguarded-edit");
    commitFiles(selfRepo, "edit shipped src without note", {
      "src/commands.ts": "export const x = 2;\n",
    });
    const selfBlocked = checkBase(selfRepo, stateDir);
    expect(selfBlocked.exitCode).toBe(3);
    expect(selfBlocked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });
});
