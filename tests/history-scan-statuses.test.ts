import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { commitMarkerPrefix } from "../src/history/rules.ts";
import { assertRefusalBothModes } from "./support/history-scan.ts";
import {
  commitAll,
  initRepo,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const privateWord = "example-private-word";

describe("history scan git name-status coverage", () => {
  test("Rename-conflict merge (RR): detects private destination path in combined status without echoing it", () => {
    const root = testFolder("history-merge-rr-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, `${privateWord}\n`, "utf8");

      initRepo(repo);
      writeFiles(repo, {
        "orig.md": "# doc\nline one\nline two\nline three\n",
      });
      const base = commitAll(repo, "base");

      runGit(repo, ["checkout", "-b", "side"]);
      runGit(repo, ["mv", "orig.md", "side.md"]);
      commitAll(repo, "rename on side");

      runGit(repo, ["checkout", "main"]);
      runGit(repo, ["mv", "orig.md", "main.md"]);
      commitAll(repo, "rename on main");

      const mergeAttempt = Bun.spawnSync(
        [Bun.which("git") ?? "git", "-C", repo, "merge", "side"],
        { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
      );
      expect(mergeAttempt.exitCode).not.toBe(0);

      runGit(repo, ["rm", "-f", "--ignore-unmatch", "side.md", "main.md"]);
      writeFiles(repo, {
        [`${privateWord}.md`]: "# doc\nline one\nline two\nline three\n",
      });
      const mergeCommit = commitAll(repo, "resolve rename conflict");
      const mergeShort = runGit(repo, ["rev-parse", "--short", mergeCommit]);

      const rawStatus = runGit(repo, [
        "log",
        "--name-status",
        "-M",
        "--diff-merges=cc",
        "-n",
        "1",
        mergeCommit,
      ]);
      expect(rawStatus).toContain(`RR\t${privateWord}.md`);

      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `${base}..${mergeCommit}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_PRIVATE_MATCH",
        [privateWord],
      );
      expect(jsonStdout).toContain(mergeShort);
      expect(jsonStdout).toContain("[redacted]");
      expect(plainStderr).toContain(mergeShort);
      expect(plainStderr).toContain("[redacted]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Copy (C): detects private destination path reported with C status without echoing it", () => {
    const root = testFolder("history-copy-c-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, `${privateWord}\n`, "utf8");

      initRepo(repo);
      const body = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
      writeFiles(repo, { "orig.md": body });
      const base = commitAll(repo, "base");

      writeFiles(repo, {
        "orig.md": `${body}iota\n`,
        [`${privateWord}.md`]: body,
      });
      const tip = commitAll(repo, "copy file");
      const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

      const rawStatus = runGit(repo, [
        "log",
        "--name-status",
        "-M",
        "-C",
        `${base}..${tip}`,
      ]);
      expect(rawStatus).toMatch(/C\d+\torig\.md\texample-private-word\.md/);

      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_PRIVATE_MATCH",
        [privateWord],
      );
      expect(jsonStdout).toContain(tipShort);
      expect(jsonStdout).toContain("[redacted]");
      expect(plainStderr).toContain(tipShort);
      expect(plainStderr).toContain("[redacted]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Type change (T): detects private path reported with T status without echoing it", () => {
    const root = testFolder("history-type-t-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, `${privateWord}\n`, "utf8");

      initRepo(repo);
      writeFiles(repo, {
        "target.md": "clean target\n",
        [`${privateWord}.md`]: "regular file\n",
      });
      const base = commitAll(repo, "base");

      unlinkSync(join(repo, `${privateWord}.md`));
      symlinkSync("target.md", join(repo, `${privateWord}.md`));
      const tip = commitAll(repo, "replace file with symlink");
      const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

      const rawStatus = runGit(repo, [
        "log",
        "--name-status",
        `${base}..${tip}`,
      ]);
      expect(rawStatus).toContain(`T\t${privateWord}.md`);

      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_PRIVATE_MATCH",
        [privateWord],
      );
      expect(jsonStdout).toContain(tipShort);
      expect(jsonStdout).toContain("[redacted]");
      expect(plainStderr).toContain(tipShort);
      expect(plainStderr).toContain("[redacted]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unrecognised status: refuses with DOMAIN_PRECONDITION_UNMET naming the status letters", () => {
    const root = testFolder("history-unknown-status-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const realGit = Bun.which("git");
      if (realGit === null) {
        throw new Error("git is required to run history-scan tests.");
      }
      writeFileSync(patternFile, `${privateWord}\n`, "utf8");

      initRepo(repo);
      writeFiles(repo, { "a.md": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.md": "two\n" });
      const tip = commitAll(repo, "tip");

      const fakeBin = join(root, "bin-fake-git");
      mkdirSync(fakeBin, { recursive: true });
      const fakeGit = join(fakeBin, "git");
      writeFileSync(
        fakeGit,
        `#!/bin/sh
case "$*" in
  *"--name-status"*)
    printf '${commitMarkerPrefix}abc1234\\0\\nQZ\\0notes.md\\0'
    exit 0
    ;;
  *)
    exec '${realGit}' "$@"
    ;;
esac
`,
        "utf8",
      );
      chmodSync(fakeGit, 0o755);

      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo, pathPrefix: fakeBin },
        ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
        "DOMAIN_PRECONDITION_UNMET",
        [privateWord],
      );
      expect(jsonStdout).toContain("QZ");
      expect(plainStderr).toContain("QZ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
