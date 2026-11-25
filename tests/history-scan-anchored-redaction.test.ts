import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertRefusalBothModes, writeFakeGh } from "./support/history-scan.ts";
import {
  commitAll,
  initRepo,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const privateWord = "example-private-word";
const anchoredPatterns = [
  "^example-private-word$",
  "^example-private-word\\.md$",
  "word$",
];

describe("history scan anchored pattern redaction", () => {
  for (const pathCase of [
    {
      label: "^example-private-word$",
      pattern: "^example-private-word$",
      filePath: `docs/${privateWord}/notes.md`,
    },
    {
      label: "^example-private-word\\.md$",
      pattern: "^example-private-word\\.md$",
      filePath: `${privateWord}.md`,
    },
    {
      label: "word$",
      pattern: "word$",
      filePath: `docs/${privateWord}/notes.md`,
    },
  ]) {
    test(`Matching path (${pathCase.label}): redacts private word in plain and --json`, () => {
      const root = testFolder("history-anchored-path-");
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        writeFileSync(patternFile, `${pathCase.pattern}\n`, "utf8");

        initRepo(repo);
        writeFiles(repo, { "README.md": "# demo\n" });
        const base = commitAll(repo, "base");

        writeFiles(repo, { [pathCase.filePath]: "clean content\n" });
        const tip = commitAll(repo, "add file");

        const { jsonStdout, plainStderr } = assertRefusalBothModes(
          { cwd: repo },
          ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
          "DOMAIN_HISTORY_PRIVATE_MATCH",
          [privateWord],
        );
        expect(jsonStdout).toContain("[redacted]");
        expect(plainStderr).toContain("[redacted]");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const lineCase of [
    {
      label: "^example-private-word$ in matching path segment",
      pattern: "^example-private-word$",
      filePath: `docs/${privateWord}/notes.md`,
      lineContent: privateWord,
    },
    {
      label: "^example-private-word$ in non-matching filename",
      pattern: "^example-private-word$",
      filePath: `${privateWord}.md`,
      lineContent: privateWord,
    },
    {
      label: "^example-private-word\\.md$",
      pattern: "^example-private-word\\.md$",
      filePath: `${privateWord}.md`,
      lineContent: `${privateWord}.md`,
    },
    {
      label: "word$",
      pattern: "word$",
      filePath: `docs/${privateWord}/notes.md`,
      lineContent: `prefix ${privateWord}`,
    },
  ]) {
    test(`Matching added line in matching path (${lineCase.label}): redacts private word in plain and --json`, () => {
      const root = testFolder("history-anchored-line-");
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        writeFileSync(patternFile, `${lineCase.pattern}\n`, "utf8");

        initRepo(repo);
        writeFiles(repo, { "README.md": "# demo\n" });
        const base = commitAll(repo, "base");

        writeFiles(repo, {
          [lineCase.filePath]: `${lineCase.lineContent}\n`,
        });
        const tip = commitAll(repo, "add line");

        const { jsonStdout, plainStderr } = assertRefusalBothModes(
          { cwd: repo },
          ["--range", `${base}..${tip}`, "--pattern-file", patternFile],
          "DOMAIN_HISTORY_PRIVATE_MATCH",
          [privateWord],
        );
        expect(jsonStdout).toContain("[redacted]");
        expect(plainStderr).toContain("[redacted]");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const streamCase of [
    {
      label: "stdout",
      script: `printf '%s\\n' '${privateWord}'\nexit 1`,
    },
    {
      label: "stderr",
      script: `printf '%s\\n' '${privateWord}' >&2\nexit 1`,
    },
  ]) {
    test(`Failing fake gh on ${streamCase.label} with anchored patterns: never quotes output`, () => {
      const root = testFolder(`history-anchored-gh-${streamCase.label}-`);
      try {
        const repo = join(root, "repo");
        const patternFile = join(root, "patterns.txt");
        writeFileSync(patternFile, `${anchoredPatterns.join("\n")}\n`, "utf8");

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

        const failBin = writeFakeGh(join(root, "bin-fail"), streamCase.script);
        const { jsonStdout, plainStderr } = assertRefusalBothModes(
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
          [privateWord],
        );
        expect(jsonStdout).toContain("gh pr view 7");
        expect(jsonStdout).toContain("1");
        expect(plainStderr).toContain("gh pr view 7");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("Private origin URL with anchored patterns: never echoes origin URL in plain or --json", () => {
    const root = testFolder("history-anchored-origin-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, `${anchoredPatterns.join("\n")}\n`, "utf8");

      initRepo(repo);
      runGit(repo, [
        "remote",
        "add",
        "origin",
        `file:///srv/${privateWord}/repo`,
      ]);
      writeFiles(repo, { "a.txt": "one\n" });
      const base = commitAll(repo, "base");
      writeFiles(repo, { "a.txt": "two\n" });
      const tip = commitAll(repo, "tip");

      const okBin = writeFakeGh(join(root, "bin-stub"), "exit 0");
      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo, pathPrefix: okBin },
        [
          "--range",
          `${base}..${tip}`,
          "--pull-request",
          "7",
          "--pattern-file",
          patternFile,
        ],
        "DOMAIN_PRECONDITION_UNMET",
        [privateWord],
      );
      expect(jsonStdout).toContain("git remote get-url origin");
      expect(plainStderr).toContain("git remote get-url origin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Private range end with anchored patterns: never echoes range ref in plain or --json", () => {
    const root = testFolder("history-anchored-range-");
    try {
      const repo = join(root, "repo");
      const patternFile = join(root, "patterns.txt");
      writeFileSync(patternFile, `${anchoredPatterns.join("\n")}\n`, "utf8");

      initRepo(repo);
      writeFiles(repo, { "a.txt": "one\n" });
      commitAll(repo, "base");

      const { jsonStdout, plainStderr } = assertRefusalBothModes(
        { cwd: repo },
        ["--range", `main..${privateWord}`, "--pattern-file", patternFile],
        "DOMAIN_HISTORY_RANGE_MISSING",
        [privateWord],
      );
      expect(jsonStdout).toContain("git rev-parse");
      expect(plainStderr).toContain("git rev-parse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
