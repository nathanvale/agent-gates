import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoEcho,
  invokeHistoryScan,
  invokeHistoryScanJson,
} from "./support/history-scan.ts";
import {
  commitAll,
  initRepo,
  repoSnapshot,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

describe("history scan commit checks", () => {
  test("479c3f28 shape: finds private line added in earlier commit and removed at tip without echoing it", () => {
    const root = testFolder("history-479c3f28-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const ownerPrefix = ["", "Users", "example-owner"].join("/");
      const privateFixturePath = [
        ownerPrefix,
        "Library",
        "Messages",
        "Attachments",
        "IMG_1.HEIC",
      ].join("/");

      writeFileSync(patternFile, `${ownerPrefix}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "README.md": "# demo\n" });
      const base = commitAll(repo, "base");

      writeFiles(repo, {
        "tests/lib.test.ts": `const clean = true;\nconst fixture = "${privateFixturePath}";\n`,
      });
      const leakCommit = commitAll(repo, "add fixture test");
      const leakShort = runGit(repo, ["rev-parse", "--short", leakCommit]);

      writeFiles(repo, {
        "tests/lib.test.ts": "const clean = true;\n",
      });
      const tip = commitAll(repo, "remove fixture path");

      expect(
        readFileSync(join(repo, "tests/lib.test.ts"), "utf8"),
      ).not.toContain(ownerPrefix);

      const ran = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${tip}`,
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(ran.stdout).toContain(leakShort);
      expect(ran.stdout).toContain("tests/lib.test.ts:2");
      expect(ran.stdout).toContain("pattern line 1");
      assertNoEcho(ran, [ownerPrefix, privateFixturePath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Commit message: finds private match that appears only in a commit message", () => {
    const root = testFolder("history-message-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secret = "internal-codename-violet";

      writeFileSync(patternFile, `# comment line\n${secret}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "src/a.ts": "export const a = 1;\n" });
      const base = commitAll(repo, "base");

      writeFiles(repo, { "src/a.ts": "export const a = 2;\n" });
      const leakCommit = commitAll(repo, `sync from ${secret} repo`);
      const leakShort = runGit(repo, ["rev-parse", "--short", leakCommit]);

      const ran = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${leakCommit}`,
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(ran.stdout).toContain(leakShort);
      expect(ran.stdout).toContain("message");
      expect(ran.stdout).toContain("pattern line 2");
      assertNoEcho(ran, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Path: finds private match that appears only in an added file path", () => {
    const root = testFolder("history-path-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secretSegment = "private-runbook";

      writeFileSync(patternFile, `${secretSegment}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "README.md": "# demo\n" });
      const base = commitAll(repo, "base");

      writeFiles(repo, {
        [`docs/${secretSegment}/notes.md`]: "plain public text\n",
      });
      const leakCommit = commitAll(repo, "add docs");
      const leakShort = runGit(repo, ["rev-parse", "--short", leakCommit]);

      const ran = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${leakCommit}`,
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(ran.stdout).toContain(leakShort);
      expect(ran.stdout).toContain("path");
      expect(ran.stdout).toContain("pattern line 1");
      assertNoEcho(ran, [secretSegment]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Conflict resolution: finds line introduced only during merge conflict resolution", () => {
    const root = testFolder("history-merge-conflict-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secret = "conflict-resolution-secret-99";

      writeFileSync(patternFile, `${secret}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "shared.txt": "header\noriginal\n" });
      const base = commitAll(repo, "base");

      runGit(repo, ["checkout", "-b", "side"]);
      writeFiles(repo, { "shared.txt": "header\nside-version\n" });
      commitAll(repo, "side edit");

      runGit(repo, ["checkout", "main"]);
      writeFiles(repo, { "shared.txt": "header\nmain-version\n" });
      commitAll(repo, "main edit");

      const mergeAttempt = Bun.spawnSync(
        [Bun.which("git") ?? "git", "-C", repo, "merge", "side"],
        { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
      );
      expect(mergeAttempt.exitCode).not.toBe(0);

      writeFiles(repo, { "shared.txt": `header\n${secret}\n` });
      const mergeCommit = commitAll(repo, "resolve merge conflict");
      const mergeShort = runGit(repo, ["rev-parse", "--short", mergeCommit]);

      const ran = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${mergeCommit}`,
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(ran.stdout).toContain(mergeShort);
      expect(ran.stdout).toContain("shared.txt:2");
      expect(ran.stdout).toContain("pattern line 1");
      assertNoEcho(ran, [secret]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("No echo: plain-text refusal prints neither matched text nor pattern on stdout or stderr", () => {
    const root = testFolder("history-no-echo-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "super-secret-alpha|super-secret-beta";
      const matchedText = "super-secret-beta";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "clean\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": `value=${matchedText}\n` });
      const tip = commitAll(repo, "add value");

      const plainRun = invokeHistoryScan(
        { cwd: repo },
        "--range",
        `${base}..${tip}`,
        "--pattern-file",
        patternFile,
      );

      expect(plainRun.exitCode).toBe(3);
      expect(plainRun.stdout).toBe("");
      expect(plainRun.stderr).toContain("pattern line 1");
      assertNoEcho(plainRun, [patternText, matchedText, "super-secret-alpha"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Changes nothing: git status, HEAD, and worktree list are identical before and after", () => {
    const root = testFolder("history-unchanged-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, "never-matches\n", "utf8");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const before = repoSnapshot(repo);
      const ran = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${tip}`,
        "--pattern-file",
        patternFile,
      );
      const after = repoSnapshot(repo);

      expect(ran.exitCode).toBe(0);
      expect(after).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
