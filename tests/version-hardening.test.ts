import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  envelopeData,
  envelopeMessage,
  git,
  initGitRepo,
  makeVersionRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const cliPath = join(import.meta.dir, "../src/cli.ts");
const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

async function spawnGatesAsync(
  argv: readonly string[],
  cwd: string,
  stateDir: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: unknown;
}> {
  const child = Bun.spawn([process.execPath, "run", cliPath, ...argv], {
    cwd,
    env: {
      ...process.env,
      AGENT_GATES_STATE: stateDir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    child.kill();
  }, 20_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const envelope: unknown =
      argv.includes("--json") && stdout.trim() !== ""
        ? JSON.parse(stdout)
        : null;
    return { exitCode, stdout, stderr, envelope };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

describe("PR 2 hardening tests for versions (R16, R21, concurrency, discoverability)", () => {
  test("P0-1 parity & R21: reformatted rename and verbatim copy of a pre-tag note do not trigger a version", () => {
    const initialNote = {
      kind: "added",
      breaking: false,
      affects: ["bootstrap"],
      summary: "Released before tag.",
      action: null,
    };
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-20-released.json": `${JSON.stringify(initialNote, null, 2)}\n`,
    });
    git(repo, "tag", "v0.1.0");

    git(
      repo,
      "mv",
      "change-notes/2026-11-20-released.json",
      "change-notes/2026-11-22-reformatted-rename.json",
    );
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-reformatted-rename.json",
      JSON.stringify(initialNote),
    );
    git(repo, "add", "change-notes/2026-11-22-reformatted-rename.json");
    git(repo, "commit", "-q", "-m", "rename and reformat pre-tag note");

    const afterRename = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Should not trigger.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(afterRename.exitCode).toBe(3);
    expect(afterRename.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });

    commitFiles(repo, "verbatim copy of pre-tag note", {
      "change-notes/2026-11-22-copied-old.json": `${JSON.stringify(initialNote, null, 2)}\n`,
    });
    const afterCopy = runGatesCli(
      [
        "version",
        "prepare",
        "--lead",
        "Should not trigger either.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(afterCopy.exitCode).toBe(3);
    expect(afterCopy.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });

    git(
      repo,
      "mv",
      "change-notes/2026-11-22-copied-old.json",
      "change-notes/2026-11-22-step1-rename.json",
    );
    git(repo, "commit", "-q", "-m", "step 1 rename copied pre-tag note");
    commitFiles(repo, "step 2 minify and tweak punctuation", {
      "change-notes/2026-11-22-step1-rename.json": JSON.stringify({
        ...initialNote,
        summary: "Released before tag!",
      }),
    });
    const afterTwoStep = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "Two-step rename and edit must not trigger.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(afterTwoStep.exitCode).toBe(3);
    expect(afterTwoStep.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTHING_TO_PREPARE" },
    });
  });

  test("P1-1 parity: concurrent version prepare leaves zero unresolved lock and allows retry after removal", async () => {
    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-22-first.json": JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Initial feature.",
        action: null,
      }),
    });

    const args = [
      "version",
      "prepare",
      "--lead",
      "First version.",
      "--date",
      "2026-11-22",
      "--repository",
      repo,
      "--json",
    ];
    const [first, second] = await Promise.all([
      spawnGatesAsync(args, repo, stateDir),
      spawnGatesAsync(args, repo, stateDir),
    ]);
    const exitCodes = [first.exitCode, second.exitCode].sort((a, b) => a - b);
    expect(exitCodes).toEqual([0, 3]);
    const loser = first.exitCode === 3 ? first : second;
    expect(loser.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_FILE_EXISTS" },
    });

    const pending = runGatesCli(["pending", "--repository", repo, "--json"], {
      cwd: repo,
      stateDir,
    });
    expect(pending.exitCode).toBe(0);
    expect(envelopeData(pending.envelope).unfinished).toEqual([]);

    rmSync(join(repo, "versions/v0.1.0.md"));
    const retry = runGatesCli(args, { cwd: repo, stateDir });
    expect(retry.exitCode).toBe(0);
    expect(envelopeData(retry.envelope)).toMatchObject({
      version: "0.1.0",
      relativePath: "versions/v0.1.0.md",
      written: true,
    });
  });

  test("P1-4 & P1-5 parity: unborn git repo prints Repair once, nested cwd works, and help/discover expose version commands", () => {
    const unbornBase = sandbox.folder("gates-unborn-ver-");
    const unbornRepo = join(unbornBase, "repo");
    const unbornState = join(unbornBase, "state");
    initGitRepo(unbornRepo);

    for (const sub of ["preview", "prepare"] as const) {
      const unborn = runGatesCli(
        [
          "version",
          sub,
          "--lead",
          "Unborn check.",
          "--date",
          "2026-11-22",
          "--repository",
          unbornRepo,
          "--json",
        ],
        { cwd: unbornRepo, stateDir: unbornState },
      );
      expect(unborn.exitCode).toBe(3);
      expect(unborn.envelope).toMatchObject({
        result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
      });
      const repairCount = (
        envelopeMessage(unborn.envelope).match(/Repair:/g) ?? []
      ).length;
      expect(repairCount).toBe(1);
    }

    const { repo, stateDir } = makeVersionRepo(sandbox, {
      "change-notes/2026-11-22-nested.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["bootstrap"],
        summary: "Nested fix.",
        action: null,
      }),
    });
    const nested = join(repo, "nested/sub/dir");
    mkdirSync(nested, { recursive: true });
    const nestedPreview = runGatesCli(
      [
        "version",
        "preview",
        "--lead",
        "From nested.",
        "--date",
        "2026-11-22",
        "--json",
      ],
      { cwd: nested, stateDir },
    );
    expect(nestedPreview.exitCode).toBe(0);
    expect(nestedPreview.stderr).toBe("");
    expect(envelopeData(nestedPreview.envelope)).toMatchObject({
      version: "0.1.0",
      written: false,
    });

    const previewHelp = runGatesCli(["version", "preview", "--help"], {
      cwd: repo,
      stateDir,
    });
    expect(previewHelp.exitCode).toBe(0);
    expect(previewHelp.stdout).toContain("--lead");
    expect(previewHelp.stdout).not.toContain("--tag");

    const discover = runGatesCli(["--discover"], { cwd: repo, stateDir });
    expect(discover.exitCode).toBe(0);
    expect(discover.stdout).toContain("version-prepare");
    expect(discover.stdout).toContain("version-preview");
  });
});
