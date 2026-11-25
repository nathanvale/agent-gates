import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  blobHash,
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  repoSnapshot,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

describe("move check modes and guarantees", () => {
  test("Clean move: exits 0, lists every file with its hash, and marks nothing as not checked", () => {
    const root = testFolder("move-clean-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "keep.txt": "unrelated file\n",
        "bundle/a.md": "See [b](b.md).\n",
        "bundle/b.md": "# B\n",
      });
      const sourceBefore = commitAll(source, "source before");
      const hashA = blobHash(source, sourceBefore, "bundle/a.md");
      const hashB = blobHash(source, sourceBefore, "bundle/b.md");

      runGit(source, ["rm", "-r", "bundle"]);
      const sourceAfter = commitAll(source, "source after");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-clean",
          scripts: { test: "bun test" },
        }),
        "tests/existing.test.ts":
          'import { expect, test } from "bun:test";\ntest("ok", () => expect(true).toBe(true));\n',
      });
      const destBefore = commitAll(destination, "dest before");

      writeFiles(destination, {
        "imported/a.md": "See [b](b.md).\n",
        "imported/b.md": "# B\n",
      });
      const destAfter = commitAll(destination, "dest after");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "bundle",
        "--destination",
        destination,
        "--destination-commit",
        `${destBefore}..${destAfter}`,
        "--destination-folder",
        "imported",
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
          data: {
            kind: "move",
            files: [
              { path: "a.md", hash: hashA },
              { path: "b.md", hash: hashB },
            ],
            findings: [],
            notChecked: [],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Not checked: without ranges, reports every skipped check and the option that enables it", () => {
    const root = testFolder("move-not-checked-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "file.txt": "hello\n" });
      const sourceCommit = commitAll(source, "source");
      const fileHash = blobHash(source, sourceCommit, "file.txt");

      writeFiles(destination, { "file.txt": "hello\n" });
      const destinationCommit = commitAll(destination, "destination");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            kind: "move",
            files: [{ path: "file.txt", hash: fileHash }],
            findings: [],
            notChecked: [
              {
                check: "source-references",
                enableWith: "--source-commit <before>..<after>",
              },
              {
                check: "source-kept",
                enableWith: "--source-commit <before>..<after>",
              },
              {
                check: "test-discovery",
                enableWith: "--destination-commit <before>..<after>",
              },
            ],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Changes nothing: git status, HEAD, and worktrees are identical before and after a run", () => {
    const root = testFolder("move-readonly-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "a.txt": "alpha\n" });
      const sourceBefore = commitAll(source, "source before");
      runGit(source, ["rm", "a.txt"]);
      const sourceAfter = commitAll(source, "source after");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-readonly",
          scripts: { test: "bun test" },
        }),
        "tests/one.test.ts":
          'import { expect, test } from "bun:test";\ntest("one", () => expect(1).toBe(1));\n',
      });
      const destBefore = commitAll(destination, "dest before");
      writeFiles(destination, { "a.txt": "alpha\n" });
      const destAfter = commitAll(destination, "dest after");

      const sourceSnapshotBefore = repoSnapshot(source);
      const destSnapshotBefore = repoSnapshot(destination);

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--destination",
        destination,
        "--destination-commit",
        `${destBefore}..${destAfter}`,
      );

      expect(ran.exitCode).toBe(0);
      expect(repoSnapshot(source)).toEqual(sourceSnapshotBefore);
      expect(repoSnapshot(destination)).toEqual(destSnapshotBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Reports every finding in priority order when multiple checks fail", () => {
    const root = testFolder("move-multi-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "pkg/dropped.txt": "missing\n",
        "pkg/changed.txt": "before\n",
      });
      const sourceCommit = commitAll(source, "source");
      const sourceChangedHash = blobHash(
        source,
        sourceCommit,
        "pkg/changed.txt",
      );

      writeFiles(destination, {
        "pkg/changed.txt": "after\n",
      });
      const destinationCommit = commitAll(destination, "destination");
      const destChangedHash = blobHash(
        destination,
        destinationCommit,
        "pkg/changed.txt",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "pkg",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "pkg",
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.envelope).toMatchObject({
        result: {
          causeCode: "DOMAIN_MOVE_FILE_DROPPED",
          exitCode: 3,
          outcome: "refused",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("DOMAIN_MOVE_FILE_DROPPED dropped.txt");
      expect(serialized).toContain("DOMAIN_MOVE_FILE_CHANGED changed.txt");
      expect(serialized).toContain(sourceChangedHash);
      expect(serialized).toContain(destChangedHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Copy kind allows source files to remain without reporting source checks as not checked", () => {
    const root = testFolder("move-copy-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "shared/a.txt": "copied\n" });
      const sourceBefore = commitAll(source, "source before");
      writeFiles(source, { "shared/note.txt": "source keeps shared/a.txt\n" });
      const sourceAfter = commitAll(source, "source after");

      writeFiles(destination, { "shared/a.txt": "copied\n" });
      const destinationCommit = commitAll(destination, "destination");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "shared",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "shared",
        "--kind",
        "copy",
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.envelope).toMatchObject({
        result: {
          causeCode: "SUCCESS_UNCHANGED",
          data: {
            kind: "copy",
            findings: [],
            notChecked: [
              {
                check: "test-discovery",
                enableWith: "--destination-commit <before>..<after>",
              },
            ],
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Test discovery refuses with runner error when a test file fails to load", () => {
    const root = testFolder("move-runner-fail-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "note.txt": "hello\n" });
      const sourceCommit = commitAll(source, "source");

      writeFiles(destination, {
        "tests/ok.test.ts":
          'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
      });
      const destBefore = commitAll(destination, "dest before");

      writeFiles(destination, {
        "note.txt": "hello\n",
        "tests/broken.test.ts": "const x = {{{;\n",
      });
      const destAfter = commitAll(destination, "dest after with syntax error");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--destination",
        destination,
        "--destination-commit",
        `${destBefore}..${destAfter}`,
        "--kind",
        "copy",
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.envelope).toMatchObject({
        result: {
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain(
        "Test runner failed to load",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
