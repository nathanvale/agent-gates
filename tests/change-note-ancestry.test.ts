import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeMessage,
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

  test("P1 (r8): edit ancestral note then rename+minify, and same-commit edit+reformatted copy both fail R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "edit-then-rename-minify");
    const editedPayload = {
      kind: "fixed",
      breaking: false,
      affects: ["cli"],
      summary: "Edited ancestral summary before minifying.",
      action: null,
    };
    commitFiles(repo, "edit existing note summary", {
      "change-notes/2026-11-20-old.json": `${JSON.stringify(editedPayload, null, 2)}\n`,
    });
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-edited-minified.json",
    );
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-edited-minified.json",
      JSON.stringify(editedPayload),
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(
      repo,
      "add",
      "change-notes/2026-11-22-edited-minified.json",
      "src/app.ts",
    );
    git(repo, "commit", "-q", "-m", "rename and minify edited note");

    const afterEditRename = checkMain(repo, stateDir);
    expect(afterEditRename.exitCode).toBe(3);
    expect(afterEditRename.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "same-commit-edit-and-copy");
    commitFiles(repo, "edit old note and copy reformatted in same commit", {
      "change-notes/2026-11-20-old.json": `${JSON.stringify(editedPayload, null, 2)}\n`,
      "change-notes/2026-11-22-same-commit-copy.json":
        JSON.stringify(editedPayload),
      "src/app.ts": "export const v = 3;\n",
    });

    const afterSameCommit = checkMain(repo, stateDir);
    expect(afterSameCommit.exitCode).toBe(3);
    expect(afterSameCommit.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1 (r9): Git type-change T (regular -> symlink -> edited regular + reformatted copy) still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "type-change-t");
    const targetPath = join(repo, "change-notes/2026-11-20-old.json");
    rmSync(targetPath);
    symlinkSync("README.md", targetPath);
    git(repo, "add", "change-notes/2026-11-20-old.json");
    git(repo, "commit", "-q", "-m", "replace old note with symlink (T)");

    rmSync(targetPath);
    const editedPayload = {
      kind: "fixed",
      breaking: false,
      affects: ["cli"],
      summary: "Restored after symlink type change with new summary.",
      action: null,
    };
    commitFiles(
      repo,
      "restore regular file with edited content and copy (T + A)",
      {
        "change-notes/2026-11-20-old.json": `${JSON.stringify(editedPayload, null, 2)}\n`,
        "change-notes/2026-11-22-after-t-copy.json":
          JSON.stringify(editedPayload),
        "src/app.ts": "export const v = 2;\n",
      },
    );

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1 (r10): renaming ancestral note to non-.json, editing it, then moving back minified still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "non-json-detour");
    git(repo, "mv", "change-notes/2026-11-20-old.json", "archive.txt");
    git(repo, "commit", "-q", "-m", "move note to archive.txt");

    const editedPayload = {
      kind: "fixed",
      breaking: false,
      affects: ["cli"],
      summary: "Edited while parked at archive.txt.",
      action: null,
    };
    commitFiles(repo, "edit parked archive.txt", {
      "archive.txt": `${JSON.stringify(editedPayload, null, 2)}\n`,
    });
    git(repo, "mv", "archive.txt", "change-notes/2026-11-22-returned.json");
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-returned.json",
      JSON.stringify(editedPayload),
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(repo, "add", "change-notes/2026-11-22-returned.json", "src/app.ts");
    git(repo, "commit", "-q", "-m", "move back minified with shipped edit");

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1 (r11): adding an unrelated >4 MiB asset alongside a valid new note passes R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "large-asset-with-note");
    const largePayload = new Uint8Array(4 * 1024 * 1024 + 1024);
    largePayload.fill(0x41);
    commitFiles(repo, "add large unrelated asset and valid new note", {
      "assets/large.bin": largePayload,
      "src/app.ts": "export const v = 2;\n",
      "change-notes/2026-11-22-valid-new.json": `${JSON.stringify(
        {
          kind: "added",
          breaking: false,
          affects: ["cli"],
          summary: "Added feature with a large asset.",
          action: null,
        },
        null,
        2,
      )}\n`,
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(0);
  });

  test("P1 (r12): oversized >=4 MiB base note renamed and minified cannot bypass R8", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const baseNote = {
      kind: "fixed",
      breaking: false,
      affects: ["cli"],
      summary: "Oversized base note.",
      action: null,
    };
    const paddedBaseNote = `${JSON.stringify(baseNote, null, 2)}${" ".repeat(4 * 1024 * 1024)}\n`;
    commitFiles(repo, "base with oversized change note", {
      "src/app.ts": "export const v = 1;\n",
      "change-notes/2026-11-01-oversized.json": paddedBaseNote,
    });
    git(repo, "checkout", "-b", "rename-minify-oversized");
    git(repo, "rm", "-q", "change-notes/2026-11-01-oversized.json");
    commitFiles(repo, "replace oversized note with minified copy and ship", {
      "src/app.ts": "export const v = 2;\n",
      "change-notes/2026-11-22-minified.json": `${JSON.stringify(baseNote)}\n`,
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
    });
    expect(envelopeMessage(checked.envelope)).toContain("Repair:");
  });
});
