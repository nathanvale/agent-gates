import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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
        kind: "added",
        breaking: false,
        affects: ["cli"],
        summary: "Old base note.",
        action: null,
      },
      null,
      2,
    )}\n`,
  });
  return { repo, stateDir };
}

function checkMain(repo: string, stateDir: string) {
  return runGatesCli(
    ["change-note", "check", "--base", "main", "--repository", repo, "--json"],
    { cwd: repo, stateDir },
  );
}

describe("Ancestry size limits and intermediate settings transitions", () => {
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

  test("P1-1 (r13): intermediate affects vocabulary change cannot drop ancestral fingerprint", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "temp-affects-bypass");
    const tempSettings = JSON.stringify({
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli", "temp"],
      },
    });
    const baseSettings = JSON.stringify({
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const editedTemp = {
      kind: "added",
      breaking: false,
      affects: ["temp"],
      summary: "Edited under temp affects.",
      action: null,
    };
    commitFiles(repo, "add temp affects and edit base note", {
      "agent-gates.json": tempSettings,
      "change-notes/2026-11-20-old.json": `${JSON.stringify(editedTemp, null, 2)}\n`,
    });
    git(repo, "rm", "-q", "change-notes/2026-11-20-old.json");
    commitFiles(repo, "replace with minified copy under temp affects", {
      "change-notes/2026-11-22-renamed.json": `${JSON.stringify(editedTemp)}\n`,
    });
    commitFiles(repo, "restore affects and ship change", {
      "agent-gates.json": baseSettings,
      "src/app.ts": "export const v = 2;\n",
      "change-notes/2026-11-22-renamed.json": `${JSON.stringify({ ...editedTemp, affects: ["cli"] }, null, 2)}\n`,
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-2 (r13): intermediate configured notes folder refuses oversized added note", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "temp-folder-oversized");
    const padded = `${JSON.stringify(
      {
        kind: "added",
        breaking: false,
        affects: ["cli"],
        summary: "Old base note.",
        action: null,
      },
      null,
      2,
    )}${" ".repeat(4 * 1024 * 1024)}\n`;
    git(repo, "rm", "-q", "change-notes/2026-11-20-old.json");
    commitFiles(repo, "switch notes folder and move padded note", {
      "agent-gates.json": JSON.stringify({
        changeNotes: {
          folder: "staging-notes",
          shippedFolders: ["src"],
          affects: ["cli"],
        },
      }),
      "staging-notes/2026-11-21-padded.json": padded,
    });
    git(repo, "rm", "-q", "staging-notes/2026-11-21-padded.json");
    commitFiles(repo, "restore folder with minified edited note and ship", {
      "agent-gates.json": JSON.stringify({
        changeNotes: {
          folder: "change-notes",
          shippedFolders: ["src"],
          affects: ["cli"],
        },
      }),
      "src/app.ts": "export const v = 2;\n",
      "change-notes/2026-11-22-repackaged.json": `${JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["cli"],
        summary: "Repackaged.",
        action: null,
      })}\n`,
    });

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
    });
  });

  test("P1-3 (r13): oversized temporary copy outside notes folder minified, edited, and moved in still fails R8", () => {
    const { repo, stateDir } = makeBaseRepo();
    git(repo, "checkout", "-b", "oversized-temp-copy");
    const padded = `${JSON.stringify(
      {
        kind: "added",
        breaking: false,
        affects: ["cli"],
        summary: "Old base note.",
        action: null,
      },
      null,
      2,
    )}${" ".repeat(4 * 1024 * 1024)}\n`;
    commitFiles(repo, "pad copy to archive.txt", { "archive.txt": padded });
    commitFiles(repo, "minify and edit archive.txt", {
      "archive.txt": `${JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["cli"],
        summary: "Edited temp copy.",
        action: null,
      })}\n`,
    });
    git(repo, "mv", "archive.txt", "change-notes/2026-11-22-from-archive.json");
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(repo, "add", "src/app.ts");
    git(repo, "commit", "-q", "-m", "move archive into change-notes and ship");

    const checked = checkMain(repo, stateDir);
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });
});
