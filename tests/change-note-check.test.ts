import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitFiles,
  createSandboxTracker,
  git,
  initGitRepo,
  makeConfiguredRepo,
  runGatesCli,
  writeTreeFile,
} from "./support/git-repo.ts";

setDefaultTimeout(30_000);

const sandbox = createSandboxTracker();

afterEach(() => {
  sandbox.cleanup();
});

function checkRepo(
  repo: string,
  stateDir: string,
  extraArgs: readonly string[] = [],
) {
  return runGatesCli(
    [
      "change-note",
      "check",
      "--base",
      "main",
      "--repository",
      repo,
      ...extraArgs,
      "--json",
    ],
    { cwd: repo, stateDir },
  );
}

describe("agent-gates change-note check and pending (R1-R9, R16-R19, R23)", () => {
  test("R8, R18: passes on non-shipped edits, refuses exact or folder shipped edits without a note, and passes once a note is committed", () => {
    const { repo, stateDir } = makeConfiguredRepo(sandbox);
    git(repo, "checkout", "-b", "docs-only");
    commitFiles(repo, "docs update", { "docs/guide.md": "# Updated\n" });

    const docsPass = checkRepo(repo, stateDir);
    expect(docsPass.exitCode).toBe(0);
    expect(docsPass.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.change-note-check",
        causeCode: "SUCCESS_UNCHANGED",
        data: { shippedFiles: [], addedNotes: [] },
      },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "shipped-exact");
    commitFiles(repo, "exact shipped path", {
      "src/recipe.ts": "export const r = 2;\n",
    });
    const missingExact = checkRepo(repo, stateDir);
    expect(missingExact.exitCode).toBe(3);
    expect(missingExact.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "shipped-folder");
    commitFiles(repo, "folder shipped path", {
      "generated-repository/settings/package.json": '{"private":true}\n',
    });
    const missingFolder = checkRepo(repo, stateDir);
    expect(missingFolder.exitCode).toBe(3);
    expect(missingFolder.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });

    const added = runGatesCli(
      [
        "change-note",
        "add",
        "--slug",
        "internal",
        "--kind",
        "none",
        "--summary",
        "Formatted package.json; no consumer effect.",
        "--date",
        "2026-11-22",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(added.exitCode).toBe(0);
    git(repo, "add", "change-notes/2026-11-22-internal.json");
    git(repo, "commit", "-q", "-m", "add none note");

    const green = checkRepo(repo, stateDir);
    expect(green.exitCode).toBe(0);
    expect(green.envelope).toMatchObject({
      result: {
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          shippedFiles: ["generated-repository/settings/package.json"],
          addedNotes: ["change-notes/2026-11-22-internal.json"],
        },
      },
    });
  });

  test("R1, R2, R3, R9: refuses bad filenames, nested notes, unknown or missing fields, symlinks, and non-UTF-8 notes in HEAD", () => {
    const { repo, stateDir } = makeConfiguredRepo(sandbox);
    git(repo, "checkout", "-b", "bad-notes");
    commitFiles(repo, "bad names", {
      "change-notes/not-dated.json": "{}",
      "change-notes/sub/2026-11-22-nested.json": "{}",
    });
    expect(checkRepo(repo, stateDir).exitCode).toBe(3);

    for (const [branch, file, payload] of [
      [
        "unknown-field",
        "change-notes/2026-11-22-extra.json",
        JSON.stringify({
          kind: "fixed",
          breaking: false,
          affects: ["bootstrap"],
          summary: "Fixed copy.",
          action: null,
          extra: true,
        }),
      ],
      [
        "missing-field",
        "change-notes/2026-11-22-missing.json",
        JSON.stringify({
          kind: "fixed",
          breaking: false,
          affects: ["bootstrap"],
          summary: "Missing action key.",
        }),
      ],
    ] as const) {
      const target = makeConfiguredRepo(sandbox);
      git(target.repo, "checkout", "-b", branch);
      commitFiles(target.repo, branch, { [file]: payload });
      const res = checkRepo(target.repo, target.stateDir);
      expect(res.exitCode).toBe(3);
      expect(res.envelope).toMatchObject({
        result: { causeCode: "DOMAIN_GATES_NOTE_INVALID" },
      });
    }

    const bytesRepo = makeConfiguredRepo(sandbox);
    git(bytesRepo.repo, "checkout", "-b", "bad-bytes");
    writeFileSync(
      join(bytesRepo.repo, "change-notes/2026-11-22-bytes.json"),
      new Uint8Array([0xff, 0xfe]),
    );
    git(bytesRepo.repo, "add", "change-notes/2026-11-22-bytes.json");
    git(bytesRepo.repo, "commit", "-q", "-m", "bad bytes");
    expect(checkRepo(bytesRepo.repo, bytesRepo.stateDir).exitCode).toBe(3);

    const linkRepo = makeConfiguredRepo(sandbox);
    git(linkRepo.repo, "checkout", "-b", "symlink-note");
    writeTreeFile(
      linkRepo.repo,
      "outside.json",
      JSON.stringify({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Outside.",
        action: null,
      }),
    );
    symlinkSync(
      "../outside.json",
      join(linkRepo.repo, "change-notes/2026-11-22-linked.json"),
    );
    git(
      linkRepo.repo,
      "add",
      "outside.json",
      "change-notes/2026-11-22-linked.json",
    );
    git(linkRepo.repo, "commit", "-q", "-m", "linked note");
    expect(checkRepo(linkRepo.repo, linkRepo.stateDir).exitCode).toBe(3);
  });

  test("R16, R17, R23: validates committed HEAD only, isolates poisoned git config, refuses unknown base and bad flags", () => {
    const { repo, stateDir } = makeConfiguredRepo(sandbox);
    git(repo, "checkout", "-b", "head-vs-worktree");
    const noteRel = "change-notes/2026-11-22-head-check.json";
    const validNote = JSON.stringify({
      kind: "fixed",
      breaking: false,
      affects: ["bootstrap"],
      summary: "Fixed committed note.",
      action: null,
    });
    commitFiles(repo, "commit broken note", {
      "src/recipe.ts": "export const r = 2;\n",
      [noteRel]: "{broken",
    });
    writeTreeFile(repo, noteRel, validNote);
    expect(checkRepo(repo, stateDir).exitCode).toBe(3);

    commitFiles(repo, "fix note in HEAD", { [noteRel]: validNote });
    writeTreeFile(repo, noteRel, "{uncommitted-broken");

    const isolatedPass = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "main",
        "--repository",
        repo,
        "--json",
      ],
      {
        cwd: repo,
        stateDir,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "diff.orderFile",
          GIT_CONFIG_VALUE_0: join(repo, "no-such-order-file"),
        },
      },
    );
    expect(isolatedPass.exitCode).toBe(0);

    const unknownBase = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "no-such-revision",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(unknownBase.exitCode).toBe(3);
    expect(unknownBase.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
    });

    const injectedBase = runGatesCli(
      [
        "change-note",
        "check",
        "--base",
        "--relative=",
        "--repository",
        repo,
        "--json",
      ],
      { cwd: repo, stateDir },
    );
    expect(injectedBase.exitCode).toBe(3);
    expect(injectedBase.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_GIT_FAILED" },
    });

    const unknownFlag = runGatesCli(["change-note", "check", "--unknown"], {
      cwd: repo,
      stateDir,
    });
    expect(unknownFlag.exitCode).toBe(2);
    expect(unknownFlag.stderr).toContain("USAGE_INVALID_INVOCATION");

    const subParent = makeConfiguredRepo(sandbox);
    const childSub = sandbox.folder("sub-child-");
    initGitRepo(childSub);
    commitFiles(childSub, "sub init", { "README.md": "sub\n" });
    const subCommit1 = git(childSub, "rev-parse", "HEAD");
    git(
      subParent.repo,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${subCommit1},generated-repository/sub`,
    );
    git(subParent.repo, "commit", "-q", "-m", "add gitlink");
    git(subParent.repo, "config", "diff.ignoreSubmodules", "all");
    git(subParent.repo, "checkout", "-b", "bump-sub");
    commitFiles(childSub, "sub update", { "README.md": "sub v2\n" });
    const subCommit2 = git(childSub, "rev-parse", "HEAD");
    git(
      subParent.repo,
      "update-index",
      "--replace",
      "--cacheinfo",
      `160000,${subCommit2},generated-repository/sub`,
    );
    git(subParent.repo, "commit", "-q", "-m", "bump gitlink without note");
    const subBlocked = checkRepo(subParent.repo, subParent.stateDir);
    expect(subBlocked.exitCode).toBe(3);
    expect(subBlocked.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_NOTE_MISSING" },
    });
  });

  test("validates all 4 existing template change notes from origin/main unchanged and pending handles empty/corrupt state", () => {
    const { repo, stateDir } = makeConfiguredRepo(sandbox);
    git(repo, "checkout", "-b", "template-existing-notes");
    commitFiles(repo, "replay existing template notes", {
      "src/recipe.ts": "export const r = 99;\n",
      "change-notes/2026-11-22-bootstrap-agents-kernel-skills.json": `${JSON.stringify(
        {
          kind: "changed",
          breaking: false,
          affects: ["bootstrap", "generated-repository"],
          summary:
            "Updated generated AGENTS.md to list installed kernel skills and their paths in its opening lines.",
          action:
            "An existing repository receives the new AGENTS.md lines on its next Template upgrade.",
        },
        null,
        2,
      )}\n`,
      "change-notes/2026-11-22-rename-template-json.json": `${JSON.stringify(
        {
          kind: "changed",
          breaking: false,
          affects: ["bootstrap", "generated-repository"],
          summary:
            "Renamed the template stamp file from .cli-design-template.json to .template.json and dropped specRevision, entryPoint, commandOwner, and registrationVersion, so the deprecated cli-design compose tool will no longer recognise a repository.",
          action:
            "Existing repositories receive the new .template.json file name and trimmed stamp on their next Template upgrade.",
        },
        null,
        2,
      )}\n`,
      "change-notes/2026-11-22-template-change-notes.json": `${JSON.stringify(
        {
          kind: "added",
          breaking: false,
          affects: ["bootstrap", "generated-repository"],
          summary:
            "Added a change-notes/ folder with README.md to generated repositories through Bootstrap.",
          action:
            "Add change-notes/README.md if an existing generated repository should record change notes.",
        },
        null,
        2,
      )}\n`,
      "change-notes/2026-11-22-template-upgrade-change-notes.json": `${JSON.stringify(
        {
          kind: "changed",
          breaking: false,
          affects: ["generated-repository"],
          summary:
            "Included breaking-first template change notes in upgrade plan, apply, and commit messages, reported bun install and bun run check step outcomes in apply, named edited shared files to merge in plan, and printed the target commit with a behind-origin/main warning when HEAD lags.",
          action: null,
        },
        null,
        2,
      )}\n`,
    });

    const checked = checkRepo(repo, stateDir);
    expect(checked.exitCode).toBe(0);
    expect(checked.envelope).toMatchObject({
      result: {
        causeCode: "SUCCESS_UNCHANGED",
        data: {
          addedNotes: [
            "change-notes/2026-11-22-bootstrap-agents-kernel-skills.json",
            "change-notes/2026-11-22-rename-template-json.json",
            "change-notes/2026-11-22-template-change-notes.json",
            "change-notes/2026-11-22-template-upgrade-change-notes.json",
          ],
        },
      },
    });

    const base = sandbox.folder("gates-pending-");
    const pendingState = join(base, "state");
    const empty = runGatesCli(["pending", "--json"], {
      cwd: base,
      stateDir: pendingState,
    });
    expect(empty.exitCode).toBe(0);
    expect(empty.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.pending",
        causeCode: "SUCCESS_UNCHANGED",
        data: { unfinished: [] },
      },
    });

    const badStatePath = join(base, "not-a-folder");
    writeFileSync(badStatePath, "corrupt");
    const unreadable = runGatesCli(["pending", "--json"], {
      cwd: base,
      stateDir: badStatePath,
    });
    expect(unreadable.exitCode).toBe(3);
    expect(unreadable.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_GATES_STATE_UNAVAILABLE" },
    });
  });
});
