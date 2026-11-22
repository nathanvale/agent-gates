import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
import { seedUnfinishedOperation } from "./support/seed-state.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();
const cliPath = join(import.meta.dir, "../src/cli.ts");
const verifyCliPath = join(
  import.meta.dir,
  "../node_modules/agent-cli-kernel/skills/verify-cli/verify.ts",
);

afterEach(() => {
  sandbox.cleanup();
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("PR 1 hardening and catch tests (P0-1, P1-1..P1-5)", () => {
  test("P0-1 & US 7: refuses reformatted rename, verbatim copy of base note, and multi-commit shipped edits", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const baseNoteObj = {
      kind: "fixed",
      breaking: false,
      affects: ["cli"],
      summary: "Earlier base fix.",
      action: null,
    };
    commitFiles(repo, "add base note", {
      "change-notes/2026-11-20-old.json": `${JSON.stringify(baseNoteObj, null, 2)}\n`,
      "src/tool.ts": "export const v = 1;\n",
    });

    git(repo, "checkout", "-b", "reformatted-rename");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-minified.json",
    );
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-minified.json",
      JSON.stringify(baseNoteObj),
    );
    writeTreeFile(repo, "src/tool.ts", "export const v = 2;\n");
    git(repo, "add", "change-notes/2026-11-22-minified.json", "src/tool.ts");
    git(repo, "commit", "-q", "-m", "reformatted rename plus shipped change");
    const reformatted = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "main",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(reformatted.exitCode).toBe(3);
    expect(reformatted.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "verbatim-copy");
    commitFiles(repo, "copy old note plus shipped change", {
      "change-notes/2026-11-22-copied.json": `${JSON.stringify(baseNoteObj, null, 2)}\n`,
      "src/tool.ts": "export const v = 3;\n",
    });
    const copied = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "main",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(copied.exitCode).toBe(3);
    expect(copied.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "multi-commit");
    commitFiles(repo, "commit 1 shipped edit", {
      "src/tool.ts": "export const v = 4;\n",
    });
    commitFiles(repo, "commit 2 docs only", {
      "README.md": "# Updated docs\n",
    });
    const multiCommit = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "main",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(multiCommit.exitCode).toBe(3);
    expect(multiCommit.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-1: concurrent change-note add on the same slug leaves zero unresolved lock and allows retry after removal", async () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const addArgv = (summary: string) => [
      "change-note",
      "add",
      "--slug",
      "race-slug",
      "--kind",
      "added",
      "--affects",
      "cli",
      "--summary",
      summary,
      "--date",
      "2026-11-22",
      "--repository",
      repo,
      "--json",
    ];
    const spawnAdd = (summary: string) =>
      Bun.spawn([process.execPath, "run", cliPath, ...addArgv(summary)], {
        cwd: repo,
        env: { ...process.env, AGENT_GATES_STATE: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      });

    const p1 = spawnAdd("First concurrent note.");
    const p2 = spawnAdd("Second concurrent note.");
    const timer = setTimeout(() => {
      p1.kill();
      p2.kill();
    }, 20_000);
    let code1: number;
    let code2: number;
    let out1: string;
    let out2: string;
    try {
      [code1, code2, out1, out2] = await Promise.all([
        p1.exited,
        p2.exited,
        new Response(p1.stdout).text(),
        new Response(p2.stdout).text(),
      ]);
    } finally {
      clearTimeout(timer);
      if (p1.exitCode === null) p1.kill();
      if (p2.exitCode === null) p2.kill();
    }
    const codes = [code1, code2].sort((a, b) => a - b);
    expect(codes).toEqual([0, 3]);
    const loserEnvelope: unknown = JSON.parse(code1 === 3 ? out1 : out2);
    const loserCause = String(
      Reflect.get(
        Object(Reflect.get(Object(loserEnvelope), "result")),
        "causeCode",
      ),
    );
    expect(["DOMAIN_GATES_FILE_EXISTS", "DOMAIN_GATES_CHANGE_HELD"]).toContain(
      loserCause,
    );

    const pendingAfter = runGatesCli(
      ["pending", "--repository", repo, "--json"],
      { cwd: repo, stateDir },
    );
    expect(pendingAfter.exitCode).toBe(0);
    expect(pendingAfter.envelope).toMatchObject({
      result: { data: { unfinished: [] } },
    });

    rmSync(join(repo, "change-notes/2026-11-22-race-slug.json"));
    const retry = runGatesCli(addArgv("Clean retry after removal."), {
      cwd: repo,
      stateDir,
    });
    expect(retry.exitCode).toBe(0);
  });

  test("P1-2 & US 25: package.json check wires check:change-notes and fails on unguarded src edit against origin/main", () => {
    const pkgText = readFileSync(
      join(import.meta.dir, "../package.json"),
      "utf8",
    );
    const pkg: unknown = JSON.parse(pkgText);
    const scripts: unknown = Reflect.get(Object(pkg), "scripts");
    const checkScript = String(Reflect.get(Object(scripts), "check"));
    expect(checkScript).toContain("check:change-notes");

    const base = sandbox.folder("self-gate-");
    const bare = join(base, "origin.git");
    const repo = join(base, "repo");
    const stateDir = join(base, "state");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-q");
    initGitRepo(repo);
    commitFiles(repo, "init", {
      "agent-gates.json": readFileSync(
        join(import.meta.dir, "../agent-gates.json"),
        "utf8",
      ),
      "src/commands.ts": "export const ready = true;\n",
    });
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "checkout", "-b", "unguarded");
    commitFiles(repo, "unguarded edit", {
      "src/commands.ts": "export const ready = false;\n",
    });
    const blocked = runGatesCli(["change-note", "check", "--json"], {
      cwd: repo,
      stateDir,
    });
    expect(blocked.exitCode).toBe(3);
    expect(blocked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-3: pending omits stateFolder, scopes to current repository, and prints relative target paths only", async () => {
    const sharedState = sandbox.folder("shared-state-");
    const repoA = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    }).repo;
    const repoB = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    }).repo;

    await seedUnfinishedOperation(
      sharedState,
      repoA,
      "change-notes/2026-11-22-secret.json",
    );

    const fromB = runGatesCli(["pending", "--json"], {
      cwd: repoB,
      stateDir: sharedState,
    });
    expect(fromB.exitCode).toBe(0);
    expect(fromB.stdout).not.toContain(sharedState);
    expect(fromB.stdout).not.toContain(repoA);
    expect(fromB.stdout).not.toContain("2026-11-22-secret.json");
    expect(fromB.envelope).toMatchObject({
      result: { data: { unfinished: [] } },
    });
    const dataB: unknown = Reflect.get(
      Object(Reflect.get(Object(fromB.envelope), "result")),
      "data",
    );
    expect(
      typeof dataB === "object" && dataB !== null ? Object.keys(dataB) : [],
    ).toEqual(["unfinished"]);

    const fromA = runGatesCli(["pending", "--json"], {
      cwd: repoA,
      stateDir: sharedState,
    });
    expect(fromA.exitCode).toBe(0);
    expect(fromA.stdout).not.toContain(sharedState);
    expect(fromA.stdout).not.toContain(repoA);
    expect(fromA.envelope).toMatchObject({
      result: {
        data: {
          unfinished: [
            {
              commandIdentity: "agent-gates.change-note-add",
              target: "change-notes/2026-11-22-secret.json",
            },
          ],
        },
      },
    });
  });

  test("P1-4 & R16: unborn git repo prints Repair and leading-dash base prints exactly one Repair", () => {
    const base = sandbox.folder("unborn-");
    const repo = join(base, "repo");
    const stateDir = join(base, "state");
    initGitRepo(repo);

    const unborn = runGatesCli(["change-note", "check", "--json"], {
      cwd: repo,
      stateDir,
    });
    expect(unborn.exitCode).toBe(3);
    expect(unborn.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
    });
    expect(countOccurrences(envelopeMessage(unborn.envelope), "Repair:")).toBe(
      1,
    );

    const configured = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const dashBase = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "--relative=",
        "--repository",
        configured.repo,
        "--json",
      ],
      { cwd: configured.repo, stateDir: configured.stateDir },
    );
    expect(dashBase.exitCode).toBe(3);
    expect(
      countOccurrences(envelopeMessage(dashBase.envelope), "Repair:"),
    ).toBe(1);
  });

  test("P1-5 (US 3 on check, US 18 host node_modules/.bin, US 23 subcommand help & verify-cli ready)", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "notes",
        shippedFolders: ["src"],
        affects: ["parser", "cli"],
      },
    });
    for (const [branch, affects] of [
      ["bad-cap", ["Bootstrap"]],
      ["bad-syntax", ["cli_x"]],
      ["bad-unknown", ["other"]],
      ["bad-empty", []],
    ] as const) {
      git(repo, "checkout", "main");
      git(repo, "checkout", "-b", branch);
      commitFiles(repo, branch, {
        "notes/2026-11-22-a.json": JSON.stringify({
          kind: "changed",
          breaking: false,
          affects,
          summary: "Check affects.",
          action: null,
        }),
      });
      const res = runGatesCli(
        [
          "change-note",
          "check",
          "--base",
          "main",
          "--repository",
          repo,
          "--json",
        ],
        { cwd: repo, stateDir },
      );
      expect(res.exitCode).toBe(3);
      const msg = envelopeMessage(res.envelope);
      expect(msg).toContain("cli, parser");
      expect((msg.split("Repair:")[1] ?? "").toLowerCase()).not.toContain(
        "bootstrap",
      );
    }

    const host = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    });
    const binDir = join(host.repo, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(cliPath, join(binDir, "agent-gates"));
    git(host.repo, "checkout", "-b", "host-feat");
    commitFiles(host.repo, "host shipped change", {
      "src/app.ts": "export const a = 1;\n",
    });

    const hostBin = join(host.repo, "node_modules", ".bin", "agent-gates");
    const runBin = (args: readonly string[]) =>
      Bun.spawnSync([process.execPath, hostBin, ...args], {
        cwd: host.repo,
        env: { ...process.env, AGENT_GATES_STATE: host.stateDir },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      });
    expect(runBin(["change-note", "check", "--base", "main"]).exitCode).toBe(3);
    expect(
      runBin([
        "change-note",
        "add",
        "--slug",
        "host-change",
        "--kind",
        "added",
        "--affects",
        "cli",
        "--summary",
        "Host change.",
        "--date",
        "2026-11-22",
      ]).exitCode,
    ).toBe(0);
    expect(
      existsSync(join(host.repo, "change-notes/2026-11-22-host-change.json")),
    ).toBe(true);
    git(host.repo, "add", "change-notes/2026-11-22-host-change.json");
    git(host.repo, "commit", "-q", "-m", "add host note");
    expect(runBin(["change-note", "check", "--base", "main"]).exitCode).toBe(0);

    for (const args of [
      ["change-note", "add", "--help"],
      ["change-note", "check", "--help"],
      ["pending", "--help"],
      ["--discover", "--json"],
    ]) {
      const out = runGatesCli(args, {
        cwd: host.repo,
        stateDir: host.stateDir,
      });
      expect(out.exitCode).toBe(0);
    }

    const ready = Bun.spawnSync(
      [process.execPath, verifyCliPath, "ready", cliPath],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    expect(ready.exitCode).toBe(0);
  });
});
