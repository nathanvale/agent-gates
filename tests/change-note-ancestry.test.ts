import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  git,
  makeCustomRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

function makeBaseRepo() {
  const { repo, stateDir } = makeCustomRepo(sandbox, {
    changeNotes: {
      folder: "change-notes",
      shippedFolders: ["src"],
      affects: ["cli"],
    },
  });
  commitFiles(repo, "base note", {
    "change-notes/2026-11-20-old.json": `${JSON.stringify(
      {
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier base fix with full pretty-printed formatting.",
        action: null,
      },
      null,
      2,
    )}\n`,
    "src/app.ts": "export const v = 1;\n",
  });
  return { repo, stateDir };
}

function checkMain(repo: string, stateDir: string) {
  return runGatesCli(
    ["change-note", "check", "--base", "main", "--repository", repo, "--json"],
    { cwd: repo, stateDir },
  );
}

describe("Per-commit ancestry tracking (copy-then-edit, merged renames, destination reuse)", () => {
  test("P1-1: copy unchanged base note in commit 1 then edit its summary in commit 2 still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "copy-then-edit");
    copyFileSync(
      join(repo, "change-notes/2026-11-20-old.json"),
      join(repo, "change-notes/2026-11-22-copied.json"),
    );
    git(repo, "add", "change-notes/2026-11-22-copied.json");
    git(repo, "commit", "-q", "-m", "copy untouched base note");

    commitFiles(repo, "tweak copied note and edit shipped code", {
      "change-notes/2026-11-22-copied.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier base fix with full pretty-printed formatting!",
        action: null,
      }),
      "src/app.ts": "export const v = 2;\n",
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-2: side-branch rename + minify + summary edit merged via --no-ff still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "side-rename");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-merged-disguise.json",
    );
    git(repo, "commit", "-q", "-m", "side step 1 rename");
    commitFiles(repo, "side step 2 minify and tweak", {
      "change-notes/2026-11-22-merged-disguise.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier base fix with full pretty-printed formatting!",
        action: null,
      }),
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "pr-branch");
    commitFiles(repo, "pr branch shipped edit", {
      "src/app.ts": "export const v = 2;\n",
    });
    git(repo, "merge", "-q", "--no-ff", "side-rename", "-m", "merge side");

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P2-3: destination reuse after A -> B -> C allows a genuinely new note created at B", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "reuse-dest");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-middle.json",
    );
    git(repo, "commit", "-q", "-m", "rename A to B");
    git(
      repo,
      "mv",
      "change-notes/2026-11-22-middle.json",
      "change-notes/2026-11-22-final.json",
    );
    git(repo, "commit", "-q", "-m", "rename B to C");
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-middle.json",
      `${JSON.stringify(
        {
          kind: "added",
          breaking: false,
          affects: ["cli"],
          summary: "Brand new feature written at former path B.",
          action: null,
        },
        null,
        2,
      )}\n`,
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(repo, "add", "change-notes/2026-11-22-middle.json", "src/app.ts");
    git(repo, "commit", "-q", "-m", "add brand new note at B");

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(0);
  });

  test("P1-1 (r7): --no-ff merge whose tree equals the side parent still preserves rename ancestry", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "side-only");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-side-disguise.json",
    );
    git(repo, "commit", "-q", "-m", "side rename");
    commitFiles(repo, "side minify, edit summary, edit src", {
      "change-notes/2026-11-22-side-disguise.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier base fix with full pretty-printed formatting!",
        action: null,
      }),
      "src/app.ts": "export const v = 2;\n",
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "empty-side-diff-merge");
    git(repo, "merge", "-q", "--no-ff", "side-only", "-m", "merge side-only");

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-2 (r7): partial rename with edit in commit 1 then minify in commit 2 still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "partial-rename");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-partial.json",
    );
    commitFiles(repo, "partial rename with minor summary tweak", {
      "change-notes/2026-11-22-partial.json": `${JSON.stringify(
        {
          kind: "fixed",
          breaking: false,
          affects: ["cli"],
          summary: "Earlier base fix with updated pretty-printed formatting.",
          action: null,
        },
        null,
        2,
      )}\n`,
    });
    commitFiles(repo, "minify renamed note and edit shipped code", {
      "change-notes/2026-11-22-partial.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier base fix with updated pretty-printed formatting!",
        action: null,
      }),
      "src/app.ts": "export const v = 2;\n",
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });
});
