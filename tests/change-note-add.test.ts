import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSandboxTracker,
  envelopeMessage,
  initGitRepo,
  makeConfiguredRepo,
  makeCustomRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

describe("agent-gates change-note add (R1-R7, R16, R19, R23, R25)", () => {
  test("R1, R2, R3, R6, R7, R25: writes a validated note from a nested subdirectory and refuses overwrite", () => {
    const { repo, stateDir } = makeConfiguredRepo(sandbox);
    const nested = join(repo, "docs", "nested");
    mkdirSync(nested, { recursive: true });

    const written = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "bootstrap-folder",
        "--kind",
        "added",
        "--affects",
        "bootstrap",
        "--affects",
        "generated-repository",
        "--summary",
        "  Added change-notes/ to generated repositories.  ",
        "--date",
        "2026-11-22",
        "--json",
      ],
      { cwd: nested, stateDir },
    );
    expect({ exitCode: written.exitCode, stderr: written.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(written.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.change-note-add",
        causeCode: "SUCCESS_COMPLETED",
        data: {
          repository: repo,
          file: "2026-11-22-bootstrap-folder.json",
          relativePath: "change-notes/2026-11-22-bootstrap-folder.json",
          note: {
            kind: "added",
            breaking: false,
            affects: ["bootstrap", "generated-repository"],
            summary: "Added change-notes/ to generated repositories.",
            action: null,
          },
        },
      },
    });
    const saved: unknown = JSON.parse(
      readFileSync(
        join(repo, "change-notes/2026-11-22-bootstrap-folder.json"),
        "utf8",
      ),
    );
    expect(saved).toEqual({
      kind: "added",
      breaking: false,
      affects: ["bootstrap", "generated-repository"],
      summary: "Added change-notes/ to generated repositories.",
      action: null,
    });

    const duplicate = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "bootstrap-folder",
        "--kind",
        "added",
        "--affects",
        "bootstrap",
        "--summary",
        "Duplicate.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(duplicate.exitCode).toBe(3);
    expect(duplicate.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_FILE_EXISTS" },
    });
  });

  test("R1, R4, R5, R6, R7, R16, R25: refuses invalid date, blank summary, breaking without/blank action, none with breaking, and missing/invalid settings before writing", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["parser", "cli"],
      },
    });

    for (const args of [
      [
        "--slug",
        "drop-flag",
        "--kind",
        "removed",
        "--breaking",
        "--affects",
        "cli",
        "--summary",
        "Removed old flag.",
      ],
      [
        "--slug",
        "break-blank",
        "--kind",
        "removed",
        "--breaking",
        "--action",
        "   ",
        "--affects",
        "cli",
        "--summary",
        "Removed old option.",
      ],
      [
        "--slug",
        "bad-none",
        "--kind",
        "none",
        "--breaking",
        "--action",
        "Nothing.",
        "--summary",
        "Internal cleanup.",
      ],
      ["--slug", "blank-summary", "--kind", "none", "--summary", "   "],
      [
        "--slug",
        "not-leap",
        "--kind",
        "none",
        "--summary",
        "Internal.",
        "--date",
        "2026-02-29",
      ],
    ]) {
      const res = runGatesCli(
        [
          "change-note",
          "add",
          ...args,
          ...(args.includes("--date") ? [] : ["--date", "2026-11-22"]),
          "--repository",
          repo,
          "--json",
        ],
        { cwd: repo, stateDir },
      );
      expect(res.exitCode).toBe(3);
      expect(res.envelope).toMatchObject({
        result: { causeCode: "DOMAIN_GATES_NOTE_INVALID" },
      });
      expect(envelopeMessage(res.envelope)).toContain("Repair:");
    }
    expect(existsSync(join(repo, "change-notes"))).toBe(false);

    const noSettingsDir = sandbox.folder("no-settings-");
    initGitRepo(noSettingsDir);
    const missingSettings = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "a",
        "--kind",
        "none",
        "--summary",
        "x",
        "--repository",
        noSettingsDir,
        "--json",
      ],
      { cwd: noSettingsDir, stateDir },
    );
    expect(missingSettings.exitCode).toBe(3);
    expect(missingSettings.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_SETTINGS_MISSING" },
    });

    writeTreeFile(
      noSettingsDir,
      "agent-gates.json",
      JSON.stringify({
        changeNotes: {
          folder: "change-notes",
          shippedFolders: ["src"],
          affects: ["cli"],
        },
        extraField: true,
      }),
    );
    const badSettings = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "a",
        "--kind",
        "none",
        "--summary",
        "x",
        "--repository",
        noSettingsDir,
        "--json",
      ],
      { cwd: noSettingsDir, stateDir },
    );
    expect(badSettings.exitCode).toBe(3);
    expect(badSettings.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_SETTINGS_INVALID" },
    });
  });

  test("R19 (US 3): every affects refusal lists repository allowed words alphabetically with zero bootstrap leak", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "notes",
        shippedFolders: ["src"],
        affects: ["parser", "cli"],
      },
    });
    for (const badArgs of [
      ["--affects", "Bootstrap"],
      ["--affects", "cli_x"],
      ["--affects", "unknown"],
      [],
    ]) {
      const res = runGatesCli(
        [
          "change-note",
          "add",
          "--slug",
          "check-affects",
          "--kind",
          "changed",
          ...badArgs,
          "--summary",
          "Changed behavior.",
          "--date",
          "2026-11-22",
          "--repository",
          repo,
          "--json",
        ],
        { cwd: repo, stateDir },
      );
      expect(res.exitCode).toBe(3);
      expect(res.envelope).toMatchObject({
        result: { causeCode: "DOMAIN_GATES_NOTE_INVALID" },
      });
      const msg = envelopeMessage(res.envelope);
      expect(msg).toContain("cli, parser");
      const repair = msg.split("Repair:")[1] ?? "";
      expect(repair.toLowerCase()).not.toContain("bootstrap");
    }
  });
});
