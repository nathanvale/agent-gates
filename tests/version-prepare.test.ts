import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeData,
  git,
  makeGitRecorderStub,
  makeVersionRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";
import { studyCuts, studyNotes } from "./support/replay-notes-fixture.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();
const readOnlySubcommands = new Set([
  "for-each-ref",
  "ls-tree",
  "diff",
  "cat-file",
  "rev-parse",
]);

afterEach(() => {
  sandbox.cleanup();
});

function prepareVersion(
  repo: string,
  stateDir: string,
  lead: string,
  date: string,
  env?: Readonly<Record<string, string | undefined>>,
) {
  return runGatesCli(
    [
      "version",
      "prepare",
      "--lead",
      lead,
      "--date",
      date,
      "--repository",
      repo,
      "--json",
    ],
    { cwd: repo, stateDir, ...(env === undefined ? {} : { env }) },
  );
}

describe("agent-gates version prepare (R10-R16, R20-R24)", () => {
  test("R13: with no earlier version tag, first prepared version is 0.1.0 itself regardless of breaking or non-breaking notes", () => {
    const breakingRepo = makeVersionRepo(sandbox, {
      "change-notes/2026-11-22-break-first.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["bootstrap"],
        summary: "Removed legacy option.",
        action: "Drop the legacy option.",
      }),
    });
    const breakingFirst = prepareVersion(
      breakingRepo.repo,
      breakingRepo.stateDir,
      "First repository version with a breaking change.",
      "2026-11-22",
    );
    expect(breakingFirst.exitCode).toBe(0);
    expect(envelopeData(breakingFirst.envelope)).toMatchObject({
      previousTag: null,
      previousVersion: null,
      version: "0.1.0",
      relativePath: "versions/v0.1.0.md",
    });

    const patchRepo = makeVersionRepo(sandbox, {
      "change-notes/2026-11-22-fix-first.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Fixed initial copy.",
        action: null,
      }),
    });
    const patchFirst = prepareVersion(
      patchRepo.repo,
      patchRepo.stateDir,
      "First repository version with a fix.",
      "2026-11-22",
    );
    expect(patchFirst.exitCode).toBe(0);
    expect(envelopeData(patchFirst.envelope)).toMatchObject({
      previousTag: null,
      previousVersion: null,
      version: "0.1.0",
      relativePath: "versions/v0.1.0.md",
    });
  });

  test("R11, R14, R16, R23: refuses none-only notes, zero new notes after tag, invalid lead, invalid date, and missing lead", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-internal.json": JSON.stringify({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Internal refactor.",
        action: null,
      }),
    });

    const noneOnly = prepareVersion(
      repo,
      stateDir,
      "Should not prepare.",
      "2026-11-20",
    );
    expect(noneOnly.exitCode).toBe(3);
    expect(noneOnly.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });
    expect(existsSync(join(repo, "versions"))).toBe(false);

    git(repo, "tag", "v0.1.0");
    const noNew = prepareVersion(repo, stateDir, "No new notes.", "2026-11-20");
    expect(noNew.exitCode).toBe(3);
    expect(noNew.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });

    for (const [lead, date] of [
      ["   ", "2026-11-20"],
      ["First line.\nSecond line.", "2026-11-20"],
      ["Valid lead.", "2026-02-29"],
    ] as const) {
      const invalid = prepareVersion(repo, stateDir, lead, date);
      expect(invalid.exitCode).toBe(3);
      expect(invalid.envelope).toMatchObject({
        result: { causeCode: "DOMAIN_GATES_VERSION_INVALID" },
      });
    }

    const missingLead = runGatesCli(
      ["version", "prepare", "--repository", repo],
      { cwd: repo, stateDir },
    );
    expect(missingLead.exitCode).toBe(2);
  });

  test("R10, R12, R15, R20, R22: writes one version account, executes zero git writes, keeps notes, stays in 0.x, and refuses overwrite", () => {
    const noteRel = "change-notes/2026-11-22-added-ci.json";
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-first.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Initial release.",
        action: null,
      }),
    });
    git(repo, "tag", "v0.1.0");
    commitFiles(repo, "add ci note", {
      [noteRel]: JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap", "generated-repository"],
        summary: "Added hosted check workflow to generated repositories.",
        action: "Copy .github/workflows/ci.yml into existing repositories.",
      }),
    });
    const stub = makeGitRecorderStub(sandbox.folder("git-stub-"));
    const headBefore = git(repo, "rev-parse", "HEAD");
    const tagsBefore = git(repo, "tag", "-l");

    const prepared = prepareVersion(
      repo,
      stateDir,
      "Generated repositories now include a GitHub hosted check.",
      "2026-11-22",
      { PATH: stub.pathEnv },
    );
    expect(prepared.exitCode).toBe(0);
    expect(prepared.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.version-prepare",
        causeCode: "SUCCESS_COMPLETED",
        data: {
          previousTag: "v0.1.0",
          previousVersion: "0.1.0",
          version: "0.1.1",
          relativePath: "versions/v0.1.1.md",
          consumerCount: 1,
          internalCount: 0,
        },
      },
    });
    expect(existsSync(join(repo, "versions/v0.1.1.md"))).toBe(true);
    expect(existsSync(join(repo, noteRel))).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "tag", "-l")).toBe(tagsBefore);

    const recorded = readFileSync(stub.logFile, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "");
    expect(recorded.length).toBeGreaterThan(0);
    for (const line of recorded) {
      const parts = line.split(" ");
      const subcommand =
        parts[0] === "-C" ? (parts[2] ?? "") : (parts[0] ?? "");
      expect(readOnlySubcommands.has(subcommand)).toBe(true);
    }

    const overwrite = prepareVersion(
      repo,
      stateDir,
      "Duplicate prepare.",
      "2026-11-22",
    );
    expect(overwrite.exitCode).toBe(3);
    expect(overwrite.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_FILE_EXISTS" },
    });

    git(repo, "tag", "v0.9.5");
    commitFiles(repo, "breaking note on 0.9.5", {
      "change-notes/2026-11-22-break-09.json": JSON.stringify({
        kind: "removed",
        breaking: true,
        affects: ["bootstrap"],
        summary: "Removed old hook.",
        action: "Drop old hook.",
      }),
    });
    const staysZeroX = prepareVersion(
      repo,
      stateDir,
      "Breaking change stays in 0.x and resets patch to 0.",
      "2026-11-22",
    );
    expect(staysZeroX.exitCode).toBe(0);
    expect(envelopeData(staysZeroX.envelope).version).toBe("0.10.0");
  });

  test("R9, R22: refuses symlinked versions folder, symlinked notes, and non-UTF-8 notes in HEAD", () => {
    const symlinkFolder = makeVersionRepo(sandbox, {
      "change-notes/2026-11-22-valid.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Valid.",
        action: null,
      }),
    });
    symlinkSync(
      sandbox.folder("outside-versions-"),
      join(symlinkFolder.repo, "versions"),
    );
    const refusedFolder = prepareVersion(
      symlinkFolder.repo,
      symlinkFolder.stateDir,
      "Should refuse symlink folder.",
      "2026-11-22",
    );
    expect(refusedFolder.exitCode).toBe(3);
    expect(refusedFolder.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_FILE_EXISTS" },
    });

    const badBytes = makeVersionRepo(sandbox);
    writeFileSync(
      join(badBytes.repo, "change-notes/2026-11-22-bytes.json"),
      new Uint8Array([0xff, 0xfe]),
    );
    git(badBytes.repo, "add", "change-notes/2026-11-22-bytes.json");
    git(badBytes.repo, "commit", "-q", "-m", "bad bytes");
    const refusedBytes = prepareVersion(
      badBytes.repo,
      badBytes.stateDir,
      "Bad bytes.",
      "2026-11-22",
    );
    expect(refusedBytes.exitCode).toBe(3);
    expect(refusedBytes.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_INVALID" },
    });

    const symlinkNote = makeVersionRepo(sandbox);
    writeTreeFile(
      symlinkNote.repo,
      "outside.json",
      JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Outside.",
        action: null,
      }),
    );
    symlinkSync(
      "../outside.json",
      join(symlinkNote.repo, "change-notes/2026-11-22-linked.json"),
    );
    git(
      symlinkNote.repo,
      "add",
      "outside.json",
      "change-notes/2026-11-22-linked.json",
    );
    git(symlinkNote.repo, "commit", "-q", "-m", "symlink note");
    const refusedLink = prepareVersion(
      symlinkNote.repo,
      symlinkNote.stateDir,
      "Symlink note.",
      "2026-11-22",
    );
    expect(refusedLink.exitCode).toBe(3);
    expect(refusedLink.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_INVALID" },
    });
  });

  test("R10, R13, R14, R15, R21: replays all 20 template study notes across 3 cuts through the real CLI (0.1.0, 0.2.0, 0.2.1)", () => {
    const { repo, stateDir } = makeVersionRepo(sandbox);
    const replayedVersions: string[] = [];
    const generatedTexts = new Map<string, string>();

    for (const cutInfo of studyCuts) {
      for (const item of studyNotes.filter((n) => n.cut === cutInfo.cut)) {
        commitFiles(repo, `PR #${String(item.pr)}`, {
          [`change-notes/${item.file}`]: `${JSON.stringify(item.note, null, 2)}\n`,
        });
      }
      const prepared = prepareVersion(
        repo,
        stateDir,
        cutInfo.lead,
        cutInfo.date,
      );
      expect(prepared.exitCode).toBe(0);
      const data = envelopeData(prepared.envelope);
      expect(data.version).toBe(cutInfo.expectedVersion);
      expect(data.relativePath).toBe(`versions/v${cutInfo.expectedVersion}.md`);

      const rel = String(data.relativePath);
      const text = readFileSync(join(repo, rel), "utf8");
      replayedVersions.push(String(data.version));
      generatedTexts.set(String(data.version), text);

      git(repo, "add", "--", rel);
      git(repo, "commit", "-q", "-m", `Cut version ${String(data.version)}`);
      git(repo, "tag", `v${String(data.version)}`);
    }

    expect(replayedVersions).toEqual(["0.1.0", "0.2.0", "0.2.1"]);
    const remainingNotes = readdirSync(join(repo, "change-notes")).filter(
      (name) => name.endsWith(".json"),
    );
    expect(remainingNotes.length).toBe(20);

    const v010 = generatedTexts.get("0.1.0") ?? "";
    expect(v010).toContain("# Template version 0.1.0 (2026-11-20)");
    expect(v010).toContain("10 internal changes omitted");
    expect(v010).toContain("## Breaking Changes");
    expect(v010).toContain("recipe_source_missing");

    const v020 = generatedTexts.get("0.2.0") ?? "";
    expect(v020).toContain("# Template version 0.2.0 (2026-11-21)");
    expect(v020).toContain("4 internal changes omitted");
    expect(v020).toContain("Remove check:write from package.json");
    expect(v020).not.toContain("symbol-gate");

    const v021 = generatedTexts.get("0.2.1") ?? "";
    expect(v021).toContain("# Template version 0.2.1 (2026-11-21)");
    expect(v021).toContain("## Added");
    expect(v021).toContain("## Fixed");
    expect(v021).toContain(".worktrees/");
  });
});
