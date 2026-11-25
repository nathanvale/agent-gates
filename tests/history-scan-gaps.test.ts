import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoEcho,
  invokeHistoryScan,
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

describe("history scan quoted filenames", () => {
  for (const fileCase of [
    { label: "double quote", fileName: 'quoted"name.md' },
    { label: "backslash", fileName: "back\\slash.md" },
    { label: "tab", fileName: "has\ttab.md" },
  ]) {
    test(`Quoted filename (${fileCase.label}): detects added private line without echoing secret or pattern`, () => {
      const root = testFolder("history-quoted-file-");
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        const patternText = "zebra-secret-token|fallback-token";
        const secret = "zebra-secret-token";

        writeFileSync(patternFile, `${patternText}\n`, "utf8");
        initRepo(repo);
        writeFiles(repo, { "README.md": "# demo\n" });
        const base = commitAll(repo, "base");

        writeFiles(repo, {
          [fileCase.fileName]: `clean line\n${secret}\n`,
        });
        const tip = commitAll(repo, "add quoted file");
        const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

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
        expect(ran.stdout).toContain(tipShort);
        expect(ran.stdout).toContain("pattern line 1");
        assertNoEcho(ran, [secret, patternText, "fallback-token"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("Quoted path match: detects private word in quoted added filename without echoing it", () => {
    const root = testFolder("history-quoted-path-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "zebra-path-secret";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "README.md": "# demo\n" });
      const base = commitAll(repo, "base");

      writeFiles(repo, {
        [`quoted"${patternText}.md`]: "plain public content\n",
      });
      const tip = commitAll(repo, "add file with quoted private name");
      const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

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
      expect(ran.stdout).toContain(tipShort);
      expect(ran.stdout).toContain("path");
      expect(ran.stdout).toContain("[redacted]");
      expect(ran.stdout).toContain("pattern line 1");
      assertNoEcho(ran, [patternText]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("history scan repository diff settings", () => {
  for (const configCase of [
    { key: "diff.noprefix", value: "true" },
    { key: "diff.mnemonicPrefix", value: "true" },
  ]) {
    test(`Repo config ${configCase.key}=${configCase.value}: still detects added private line`, () => {
      const root = testFolder("history-diff-config-");
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        const patternText = "config-secret-omega|unused-alt";
        const secret = "config-secret-omega";

        writeFileSync(patternFile, `${patternText}\n`, "utf8");
        initRepo(repo);
        runGit(repo, ["config", configCase.key, configCase.value]);
        writeFiles(repo, { "notes.md": "intro\n" });
        const base = commitAll(repo, "base");

        writeFiles(repo, { "notes.md": `intro\n${secret}\n` });
        const tip = commitAll(repo, "add secret line");
        const tipShort = runGit(repo, ["rev-parse", "--short", tip]);

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
        expect(ran.stdout).toContain(tipShort);
        expect(ran.stdout).toContain("notes.md:2");
        expect(ran.stdout).toContain("pattern line 1");
        assertNoEcho(ran, [secret, patternText, "unused-alt"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("history scan refusal message redaction", () => {
  test("Failing gh on stdout: redacts private word in plain and --json refusal", () => {
    const root = testFolder("history-redact-gh-stdout-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "zebra-gh-stdout|other-alt";
      const secret = "zebra-gh-stdout";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
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

      const failBin = writeFakeGh(
        join(root, "bin-fail-stdout"),
        `printf 'api error mentioning %s on stdout\n' '${secret}'\nexit 1`,
      );

      const jsonRun = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: failBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(jsonRun.exitCode).toBe(3);
      expect(jsonRun.stderr).toBe("");
      expect(jsonRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(jsonRun.stdout).toContain("[redacted]");
      assertNoEcho(jsonRun, [secret, patternText, "other-alt"]);

      const plainRun = invokeHistoryScan(
        { cwd: repo, pathPrefix: failBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(plainRun.exitCode).toBe(3);
      expect(plainRun.stdout).toBe("");
      expect(plainRun.stderr).toContain("[redacted]");
      assertNoEcho(plainRun, [secret, patternText, "other-alt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Failing gh on stderr: redacts private word in plain and --json refusal", () => {
    const root = testFolder("history-redact-gh-stderr-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "zebra-gh-stderr|other-alt";
      const secret = "zebra-gh-stderr";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
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

      const failBin = writeFakeGh(
        join(root, "bin-fail-stderr"),
        `printf 'gh auth error for %s\n' '${secret}' >&2\nexit 1`,
      );

      const jsonRun = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: failBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(jsonRun.exitCode).toBe(3);
      expect(jsonRun.stderr).toBe("");
      expect(jsonRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(jsonRun.stdout).toContain("[redacted]");
      assertNoEcho(jsonRun, [secret, patternText, "other-alt"]);

      const plainRun = invokeHistoryScan(
        { cwd: repo, pathPrefix: failBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(plainRun.exitCode).toBe(3);
      expect(plainRun.stdout).toBe("");
      expect(plainRun.stderr).toContain("[redacted]");
      assertNoEcho(plainRun, [secret, patternText, "other-alt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unparseable origin URL: redacts private word in plain and --json refusal", () => {
    const root = testFolder("history-redact-origin-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "zebra-origin-secret|other-alt";
      const secret = "zebra-origin-secret";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
      initRepo(repo);
      runGit(repo, ["remote", "add", "origin", `file:///srv/${secret}/repo`]);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const okBin = writeFakeGh(join(root, "bin-stub"), "exit 0");

      const jsonRun = invokeHistoryScanJson(
        { cwd: repo, pathPrefix: okBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(jsonRun.exitCode).toBe(3);
      expect(jsonRun.stderr).toBe("");
      expect(jsonRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(jsonRun.stdout).toContain("[redacted]");
      assertNoEcho(jsonRun, [secret, patternText, "other-alt"]);

      const plainRun = invokeHistoryScan(
        { cwd: repo, pathPrefix: okBin },
        "--range",
        `${base}..${tip}`,
        "--pull-request",
        "9",
        "--pattern-file",
        patternFile,
      );
      expect(plainRun.exitCode).toBe(3);
      expect(plainRun.stdout).toBe("");
      expect(plainRun.stderr).toContain("[redacted]");
      assertNoEcho(plainRun, [secret, patternText, "other-alt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unresolvable range ref: redacts private word in plain and --json refusal", () => {
    const root = testFolder("history-redact-range-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      const patternText = "zebra-word|other-alt";
      const secret = "zebra-word";

      writeFileSync(patternFile, `${patternText}\n`, "utf8");
      initRepo(repo);
      writeFiles(repo, { "a.txt": "one\n" });
      commitAll(repo, "base");

      const jsonRun = invokeHistoryScanJson(
        { cwd: repo },
        "--range",
        `main..${secret}`,
        "--pattern-file",
        patternFile,
      );
      expect(jsonRun.exitCode).toBe(3);
      expect(jsonRun.stderr).toBe("");
      expect(jsonRun.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.history-scan",
          causeCode: "DOMAIN_HISTORY_RANGE_MISSING",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(jsonRun.stdout).toContain("[redacted]");
      assertNoEcho(jsonRun, [secret, patternText, "other-alt"]);

      const plainRun = invokeHistoryScan(
        { cwd: repo },
        "--range",
        `main..${secret}`,
        "--pattern-file",
        patternFile,
      );
      expect(plainRun.exitCode).toBe(3);
      expect(plainRun.stdout).toBe("");
      expect(plainRun.stderr).toContain("[redacted]");
      assertNoEcho(plainRun, [secret, patternText, "other-alt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
