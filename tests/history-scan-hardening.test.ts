import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertNoEcho,
  assertRefusalBothModes,
  invokeHistoryScanJson,
  writeFakeGh,
} from "./support/history-scan.ts";
import {
  commitAll,
  initRepo,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

function writeRecordingGitWrapper(
  binDir: string,
  realGit: string,
  logFile: string,
): string {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "git");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${logFile}'`,
    `exec '${realGit}' "$@"`,
  ].join("\n");
  writeFileSync(scriptPath, `${script}\n`, "utf8");
  chmodSync(scriptPath, 0o755);
  return binDir;
}

function writeRecordingFakeGh(binDir: string, logFile: string): string {
  return writeFakeGh(
    binDir,
    `printf '%s\\n' "$*" >> '${logFile}'
case "$*" in
  *"/comments"*|*"/reviews"*)
    printf '[[]]\\n'
    ;;
  *"/pulls/7"*)
    printf '{"title":"Clean title","body":"Clean body"}\\n'
    ;;
  *)
    printf 'unexpected gh args: %s\\n' "$*" >&2
    exit 1
    ;;
esac`,
  );
}

describe("history scan hardening", () => {
  test("Root commits: refuses unrelated-history root commit match when log.showRoot=false", () => {
    const root = testFolder("history-show-root-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secret = "unrelated-root-secret-42";

      writeFileSync(patternFile, `${secret}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "README.md": "# main history\n" });
      const base = commitAll(repo, "main base");

      runGit(repo, ["checkout", "--orphan", "imported"]);
      runGit(repo, ["rm", "-rf", "."]);
      writeFiles(repo, { "imported.txt": `public line\n${secret}\n` });
      const importedRoot = commitAll(repo, "imported root commit");
      const importedRootShort = runGit(repo, [
        "rev-parse",
        "--short",
        importedRoot,
      ]);

      runGit(repo, ["checkout", "main"]);
      runGit(repo, [
        "merge",
        "--allow-unrelated-histories",
        "-m",
        "merge unrelated history",
        "imported",
      ]);
      const tip = runGit(repo, ["rev-parse", "HEAD"]);

      runGit(repo, ["config", "log.showRoot", "false"]);

      const refusal = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_PRIVATE_MATCH",
        [secret],
      );

      expect(refusal.jsonStdout).toContain(importedRootShort);
      expect(refusal.jsonStdout).toContain("imported.txt:2");
      expect(refusal.jsonStdout).toContain("pattern line 1");
      expect(refusal.plainStderr).toContain(importedRootShort);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Message encoding: refuses UTF-8 commit message match when i18n.logOutputEncoding=ISO-8859-1", () => {
    const root = testFolder("history-encoding-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secret = "café-confidentiel";

      writeFileSync(patternFile, `${secret}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "notes.txt": "base\n" });
      const base = commitAll(repo, "base");

      writeFiles(repo, { "notes.txt": "updated\n" });
      const tip = commitAll(repo, `sync ${secret} notes`);
      const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

      runGit(repo, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);

      const refusal = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_PRIVATE_MATCH",
        [secret],
      );

      expect(refusal.jsonStdout).toContain(tipShort);
      expect(refusal.jsonStdout).toContain("message");
      expect(refusal.jsonStdout).toContain("pattern line 1");
      expect(refusal.plainStderr).toContain(tipShort);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("One resolved range: passes the same two full commit hashes to all three git log reads", () => {
    const root = testFolder("history-resolved-range-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const logFile = join(root, "git-args.log");
      const realGit = Bun.which("git");
      expect(realGit).not.toBeNull();

      writeFileSync(patternFile, "never-matches-token\n", "utf8");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "one\n" });
      const baseHash = commitAll(repo, "base");
      runGit(repo, ["branch", "base-branch"]);

      writeFiles(repo, { "a.txt": "two\n" });
      const tipHash = commitAll(repo, "tip");
      runGit(repo, ["branch", "tip-branch"]);

      expect(baseHash).toMatch(/^[0-9a-f]{40}$/);
      expect(tipHash).toMatch(/^[0-9a-f]{40}$/);

      const binDir = writeRecordingGitWrapper(
        join(root, "bin"),
        realGit ?? "git",
        logFile,
      );

      const ran = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: binDir },
        "--range",
        "base-branch..tip-branch",
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");

      const invocations = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "");
      const logCalls = invocations.filter((line) => line.includes(" log "));

      expect(logCalls).toHaveLength(3);
      const expectedRangeArg = `${baseHash}..${tipHash}`;
      for (const call of logCalls) {
        expect(call).toContain(expectedRangeArg);
        expect(call).not.toContain("base-branch..tip-branch");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const originCase of [
    {
      label: "GitHub Enterprise HTTPS origin",
      originUrl: "https://ghe.example/acme/tool.git",
      expectedHost: "ghe.example",
    },
    {
      label: "github.com HTTPS origin",
      originUrl: "https://github.com/acme/tool.git",
      expectedHost: "github.com",
    },
    {
      label: "github.com SSH origin",
      originUrl: "git@github.com:acme/tool.git",
      expectedHost: "github.com",
    },
  ]) {
    test(`Origin host (${originCase.label}): passes --hostname ${originCase.expectedHost} to every gh api call`, () => {
      const root = testFolder("history-origin-host-");
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        const logFile = join(root, "gh-args.log");

        writeFileSync(patternFile, "never-matches-token\n", "utf8");
        initRepo(repo);
        runGit(repo, ["remote", "add", "origin", originCase.originUrl]);
        writeFiles(repo, { "a.txt": "one\n" });
        const base = commitAll(repo, "base");
        writeFiles(repo, { "a.txt": "two\n" });
        const tip = commitAll(repo, "tip");

        const binDir = writeRecordingFakeGh(join(root, "bin"), logFile);

        const ran = invokeHistoryScanJson(
          { cwd: repo, pathPrefix: binDir },
          "--range",
          `${base}..${tip}`,
          "--pull-request",
          "7",
          "--pattern-file",
          patternFile,
        );

        expect(ran.exitCode).toBe(0);
        expect(ran.stderr).toBe("");

        const calls = readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line !== "");
        expect(calls).toHaveLength(4);
        for (const call of calls) {
          expect(call).toContain(`api --hostname ${originCase.expectedHost} `);
          expect(call).toContain("repos/acme/tool/");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("Origin host failure: keeps refusal free of origin hostname and URL", () => {
    const root = testFolder("history-origin-host-refusal-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secretHost = "ghe-private-host.example";

      writeFileSync(patternFile, "never-matches-token\n", "utf8");
      initRepo(repo);
      runGit(repo, [
        "remote",
        "add",
        "origin",
        `https://${secretHost}/acme/tool.git`,
      ]);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const failBin = writeFakeGh(
        join(root, "bin-fail"),
        "printf 'auth failed\\n' >&2\nexit 1",
      );

      const refusal = assertRefusalBothModes(
        { cwd: repo, pathPrefix: failBin },
        [
          "--range",
          `${base}..${tip}`,
          "--pull-request",
          "7",
          "--pattern-file",
          patternFile,
        ],
        "DOMAIN_PRECONDITION_UNMET",
        [secretHost, "acme/tool"],
      );

      expect(refusal.jsonStdout).toContain("exit code 1");
      assertNoEcho(
        { stdout: refusal.jsonStdout, stderr: refusal.plainStderr },
        [secretHost, "acme/tool"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
