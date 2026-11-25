import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoEcho,
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

describe("history scan inputs and pull requests", () => {
  test("No range: refuses DOMAIN_HISTORY_RANGE_MISSING when range is absent, malformed, or empty", () => {
    const root = testFolder("history-range-missing-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, "secret-word\n", "utf8");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "hello\n" });
      commitAll(repo, "initial");

      const cases: readonly (readonly string[])[] = [
        ["--pattern-file", patternFile],
        ["--range", "HEAD", "--pattern-file", patternFile],
        ["--range", "HEAD..HEAD", "--pattern-file", patternFile],
      ];

      for (const argv of cases) {
        const ran = invokeHistoryScanJson({ cwd: repo }, ...argv);
        expect(ran.exitCode).toBe(3);
        expect(ran.stderr).toBe("");
        expect(ran.envelope).toMatchObject({
          result: {
            commandIdentity: "agent-gates.history-scan",
            causeCode: "DOMAIN_HISTORY_RANGE_MISSING",
            exitCode: 3,
            outcome: "refused",
          },
        });
        expect(ran.stdout.toLowerCase()).toContain("working tree");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Pattern file: refuses DOMAIN_HISTORY_PATTERN_FILE_MISSING for missing, empty, and invalid-regex files", () => {
    const root = testFolder("history-pattern-file-");
    try {
      const repo = join(root, "repo");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const missingPath = join(root, "does-not-exist.txt");
      const emptyPath = join(root, "empty.txt");
      const invalidPath = join(root, "invalid.txt");
      const badRegex = "[unclosed-group";

      writeFileSync(emptyPath, "\n# only a comment\n   \n", "utf8");
      writeFileSync(
        invalidPath,
        "# header\nvalid-word\n[unclosed-group\n",
        "utf8",
      );

      for (const filePath of [missingPath, emptyPath]) {
        const ran = invokeHistoryScanJson(
          { cwd: repo },
          "--range",
          `${base}..${tip}`,
          "--pattern-file",
          filePath,
        );
        expect(ran.exitCode).toBe(3);
        expect(ran.stderr).toBe("");
        expect(ran.envelope).toMatchObject({
          result: {
            commandIdentity: "agent-gates.history-scan",
            causeCode: "DOMAIN_HISTORY_PATTERN_FILE_MISSING",
            exitCode: 3,
            outcome: "refused",
          },
        });
      }

      const invalidRun = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `${base}..${tip}`,
        "--pattern-file",
        invalidPath,
      );
      expect(invalidRun.exitCode).toBe(3);
      expect(invalidRun.stderr).toBe("");
      expect(invalidRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PATTERN_FILE_MISSING",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(invalidRun.stdout).toContain("line 3");
      assertNoEcho(invalidRun, [badRegex]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Pull request text: finds review comment match via fake gh and refuses DOMAIN_PRECONDITION_UNMET on gh failure", () => {
    const root = testFolder("history-pr-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const secret = "private-customer-acme";

      writeFileSync(patternFile, `${secret}\n`, "utf8");
      initRepo(repo);
      runGit(repo, [
        "remote",
        "add",
        "origin",
        "https://github.com/example-org/example-repo.git",
      ]);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const okBin = writeFakeGh(
        join(root, "bin-ok"),
        `case "$*" in
  *"repos/example-org/example-repo/pulls/7/comments"*)
    printf '[[{"id":4201,"body":"Found ${secret} in logs"}]]\n'
    ;;
  *"repos/example-org/example-repo/pulls/7/reviews"*)
    printf '[[]]\n'
    ;;
  *"repos/example-org/example-repo/issues/7/comments"*)
    printf '[[]]\n'
    ;;
  *"repos/example-org/example-repo/pulls/7"*)
    printf '{"title":"Clean title","body":"Clean body"}\n'
    ;;
  *)
    printf 'unexpected gh args: %s\n' "$*" >&2
    exit 1
    ;;
esac`,
      );

      const matchRun = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: okBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "7",
        "--pattern-file",
        patternFile,
      );

      expect(matchRun.exitCode).toBe(3);
      expect(matchRun.stderr).toBe("");
      expect(matchRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(matchRun.stdout).toContain("pull request 7");
      expect(matchRun.stdout).toContain("review-comment");
      expect(matchRun.stdout).toContain("4201");
      expect(matchRun.stdout).toContain("pattern line 1");
      assertNoEcho(matchRun, [secret]);

      const failBin = writeFakeGh(
        join(root, "bin-fail"),
        `printf 'gh: not logged in\n' >&2\nexit 1`,
      );

      const failRun = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: failBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "7",
        "--pattern-file",
        patternFile,
      );

      expect(failRun.exitCode).toBe(3);
      expect(failRun.stderr).toBe("");
      expect(failRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(failRun.stdout).toContain("not logged in");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Clean: exits 0 and reports how many commits and pull requests were scanned", () => {
    const root = testFolder("history-clean-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, "forbidden-token-xyz\n", "utf8");
      initRepo(repo);
      runGit(repo, [
        "remote",
        "add",
        "origin",
        "git@github.com:example-org/example-repo.git",
      ]);
      writeFiles(repo, { "a.txt": "base\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "first\n" });
      commitAll(repo, "first");
      writeFiles(repo, { "b.txt": "second\n" });
      const tip = commitAll(repo, "second");

      const okBin = writeFakeGh(
        join(root, "bin-clean"),
        `case "$*" in
  *"/comments"*|*"/reviews"*)
    printf '[[]]\n'
    ;;
  *"/pulls/12"*)
    printf '{"title":"Add feature","body":"Clean description"}\n'
    ;;
  *)
    exit 1
    ;;
esac`,
      );

      const ran = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: okBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "12",
        "--pattern-file",
        patternFile,
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
          data: {
            commitsScanned: 2,
            pullRequestsScanned: 1,
            findings: [],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
