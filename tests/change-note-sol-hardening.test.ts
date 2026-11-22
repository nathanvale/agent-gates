import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  git,
  initGitRepo,
  makeCustomRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";
import { seedUnfinishedOperation } from "./support/seed-state.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

function unfinishedEntries(envelope: unknown): unknown {
  const result: unknown = Reflect.get(Object(envelope), "result");
  const data: unknown = Reflect.get(Object(result), "data");
  return Reflect.get(Object(data), "unfinished");
}

afterEach(() => {
  sandbox.cleanup();
});

function initConfiguredRepoAt(repo: string, settings: object): void {
  initGitRepo(repo);
  commitFiles(repo, "init", {
    "agent-gates.json": `${JSON.stringify(settings, null, 2)}\n`,
    "src/app.ts": "export const v = 1;\n",
  });
}

describe("Sol 6.1 PR 1 hardening tests (affects order, folder move, gitlink, scope keys, colon isolation)", () => {
  test("P1-1: reordered affects on a renamed reformatted base note still fails R8", () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["bootstrap", "lint-rules"],
      },
    });
    commitFiles(repo, "base note", {
      "change-notes/2026-11-20-old.json": `${JSON.stringify(
        {
          kind: "changed",
          breaking: false,
          affects: ["bootstrap", "lint-rules"],
          summary: "Earlier change.",
          action: null,
        },
        null,
        2,
      )}\n`,
      "src/app.ts": "export const v = 1;\n",
    });

    git(repo, "checkout", "-b", "reordered-affects");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-reordered.json",
    );
    writeTreeFile(
      repo,
      "change-notes/2026-11-22-reordered.json",
      JSON.stringify({
        kind: "changed",
        breaking: false,
        affects: ["lint-rules", "bootstrap"],
        summary: "Earlier change.",
        action: null,
      }),
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(repo, "add", "change-notes/2026-11-22-reordered.json", "src/app.ts");
    git(repo, "commit", "-q", "-m", "rename with reversed affects");

    const checked = runGatesCli(
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
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-2: changing changeNotes.folder and moving an old note into it still fails R8", () => {
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
          summary: "Earlier feature.",
          action: null,
        },
        null,
        2,
      )}\n`,
      "src/app.ts": "export const v = 1;\n",
    });

    git(repo, "checkout", "-b", "move-notes-folder");
    mkdirSync(join(repo, "notes"), { recursive: true });
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "notes/2026-11-20-old.json",
    );
    writeTreeFile(
      repo,
      "agent-gates.json",
      `${JSON.stringify(
        {
          changeNotes: {
            folder: "notes",
            shippedFolders: ["src"],
            affects: ["cli"],
          },
        },
        null,
        2,
      )}\n`,
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(
      repo,
      "add",
      "agent-gates.json",
      "notes/2026-11-20-old.json",
      "src/app.ts",
    );
    git(repo, "commit", "-q", "-m", "move notes folder without new note");

    const checked = runGatesCli(
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
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-3: submodule gitlink directly at a shippedFolders entry requires a change note", () => {
    const base = sandbox.folder("gitlink-");
    const subRepo = join(base, "sub");
    initGitRepo(subRepo);
    commitFiles(subRepo, "sub v1", { "index.ts": "export const s = 1;\n" });
    const subCommit1 = git(subRepo, "rev-parse", "HEAD");
    commitFiles(subRepo, "sub v2", { "index.ts": "export const s = 2;\n" });
    const subCommit2 = git(subRepo, "rev-parse", "HEAD");

    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["vendor"],
        affects: ["cli"],
      },
    });
    git(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${subCommit1},vendor`,
    );
    git(repo, "commit", "-q", "-m", "add vendor gitlink");

    git(repo, "checkout", "-b", "bump-vendor");
    git(repo, "update-index", "--cacheinfo", `160000,${subCommit2},vendor`);
    git(repo, "commit", "-q", "-m", "bump vendor gitlink without note");

    const checked = runGatesCli(
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
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P1-4 & P2-1: spaces, >256-char paths, and colon-suffixed repos stay isolated in state scope and pending", async () => {
    const base = sandbox.folder("scope-isolation-");
    const sharedState = join(base, "state");
    const settings = {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["cli"],
      },
    };

    const spacedRepo = join(base, "repo with spaces");
    const longNested = join(
      base,
      "a".repeat(80),
      "b".repeat(80),
      "c".repeat(80),
      "long-repo",
    );
    const plainRepo = join(base, "repo");
    const colonRepo = join(base, "repo:other");
    const bystanderRepo = join(base, "bystander");

    for (const dir of [
      spacedRepo,
      longNested,
      plainRepo,
      colonRepo,
      bystanderRepo,
    ]) {
      initConfiguredRepoAt(dir, settings);
    }

    await seedUnfinishedOperation(
      sharedState,
      spacedRepo,
      "change-notes/2026-11-22-spaced-lock.json",
    );
    await seedUnfinishedOperation(
      sharedState,
      longNested,
      "change-notes/2026-11-22-long-lock.json",
    );
    await seedUnfinishedOperation(
      sharedState,
      colonRepo,
      "change-notes/2026-11-22-colon-secret.json",
    );

    const bystanderAdd = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "independent-write",
        "--kind",
        "added",
        "--affects",
        "cli",
        "--summary",
        "Must not be blocked by spaced or long-path locks in other repos.",
        "--date",
        "2026-11-22",
        "--repository",
        bystanderRepo,
        "--json",
      ],
      { cwd: bystanderRepo, stateDir: sharedState },
    );
    expect(bystanderAdd.exitCode).toBe(0);

    const spacedPending = runGatesCli(["pending", "--json"], {
      cwd: spacedRepo,
      stateDir: sharedState,
    });
    expect(spacedPending.exitCode).toBe(0);
    expect(unfinishedEntries(spacedPending.envelope)).toMatchObject([
      { target: "change-notes/2026-11-22-spaced-lock.json" },
    ]);

    const longPending = runGatesCli(["pending", "--json"], {
      cwd: longNested,
      stateDir: sharedState,
    });
    expect(longPending.exitCode).toBe(0);
    expect(unfinishedEntries(longPending.envelope)).toMatchObject([
      { target: "change-notes/2026-11-22-long-lock.json" },
    ]);

    const plainPending = runGatesCli(["pending", "--json"], {
      cwd: plainRepo,
      stateDir: sharedState,
    });
    expect(plainPending.exitCode).toBe(0);
    expect(plainPending.stdout).not.toContain("2026-11-22-colon-secret.json");
    expect(unfinishedEntries(plainPending.envelope)).toEqual([]);
  });

  test("P1-2 (Check B): rename in commit 1 then minify + punctuation edit in commit 2 still fails R8", () => {
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
          summary: "Earlier fix with plenty of pretty-printed formatting.",
          action: null,
        },
        null,
        2,
      )}\n`,
      "src/app.ts": "export const v = 1;\n",
    });

    git(repo, "checkout", "-b", "rename-then-edit");
    git(
      repo,
      "mv",
      "change-notes/2026-11-20-old.json",
      "change-notes/2026-11-22-disguised.json",
    );
    git(repo, "commit", "-q", "-m", "step 1 rename old note");

    writeTreeFile(
      repo,
      "change-notes/2026-11-22-disguised.json",
      JSON.stringify({
        kind: "fixed",
        breaking: false,
        affects: ["cli"],
        summary: "Earlier fix with plenty of pretty-printed formatting!",
        action: null,
      }),
    );
    writeTreeFile(repo, "src/app.ts", "export const v = 2;\n");
    git(repo, "add", "change-notes/2026-11-22-disguised.json", "src/app.ts");
    git(repo, "commit", "-q", "-m", "step 2 minify, tweak summary, edit src");

    const checked = runGatesCli(
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
    expect(checked.exitCode).toBe(3);
    expect(checked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("P2-1..P2-4: literal U+FFFD passes R9, missing affects lists allowed words, and state refusals print Repair", async () => {
    const { repo, stateDir } = makeCustomRepo(sandbox, {
      changeNotes: {
        folder: "change-notes",
        shippedFolders: ["src"],
        affects: ["parser", "cli"],
      },
    });
    const runCheck = () =>
      runGatesCli(
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
    git(repo, "checkout", "-b", "literal-fffd");
    commitFiles(repo, "valid literal U+FFFD note", {
      "change-notes/2026-11-22-fffd.json": `${JSON.stringify(
        {
          kind: "fixed",
          breaking: false,
          affects: ["cli"],
          summary: "Show \uFFFD for undecodable bytes.",
          action: null,
        },
        null,
        2,
      )}\n`,
      "src/app.ts": "export const v = 2;\n",
    });
    expect(runCheck().exitCode).toBe(0);

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "missing-affects");
    commitFiles(repo, "note missing affects", {
      "change-notes/2026-11-22-no-affects.json": JSON.stringify({
        kind: "fixed",
        breaking: false,
        summary: "Missing affects key.",
        action: null,
      }),
    });
    const missingAffects = runCheck();
    expect(missingAffects.exitCode).toBe(3);
    expect(
      String(Reflect.get(Object(missingAffects.envelope), "message")),
    ).toContain("cli, parser");

    const unavailable = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "unavailable-probe",
        "--kind",
        "none",
        "--summary",
        "Probe unavailable state.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
      ],
      { cwd: repo, stateDir: "/dev/null" },
    );
    expect(unavailable.exitCode).toBe(3);
    expect(unavailable.stderr).toContain("DOMAIN_GATES_STATE_UNAVAILABLE");
    expect(unavailable.stderr).toContain("Repair:");

    await seedUnfinishedOperation(
      stateDir,
      repo,
      "change-notes/2026-11-22-blocked-slug.json",
    );
    const addWithSlug = (slug: string, extra: readonly string[] = []) =>
      runGatesCli(
        [
          "change-note",
          "add",
          "--slug",
          slug,
          "--kind",
          "added",
          "--affects",
          "cli",
          "--summary",
          `Note for ${slug}.`,
          "--date",
          "2026-11-22",
          "--repository",
          repo,
          ...extra,
        ],
        { cwd: repo, stateDir },
      );
    const blocked = addWithSlug("blocked-slug");
    expect(blocked.exitCode).toBe(3);
    expect(blocked.stderr).toContain("DOMAIN_GATES_CHANGE_UNRESOLVED");
    expect(blocked.stderr).toContain("Repair:");
    expect(blocked.stderr).toContain("pending");
    expect(addWithSlug("other-slug", ["--json"]).exitCode).toBe(0);
  });
});
