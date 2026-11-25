import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

describe("move check hardening: tree export and listing", () => {
  test("export-ignore: discovers tests in export-ignored folder and refuses DOMAIN_MOVE_TEST_DROPPED", () => {
    const root = testFolder("move-export-ignore-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "note.txt": "carried note\n" });
      const sourceCommit = commitAll(source, "source note");

      writeFiles(destination, {
        ".gitattributes": "tests/ export-ignore\n",
        "package.json": JSON.stringify({
          name: "dest-export-ignore",
          scripts: { test: "bun test" },
        }),
        "tests/root.test.ts":
          'import { expect, test } from "bun:test";\ntest("root", () => expect(1).toBe(1));\n',
        "skills/a/skill.test.ts":
          'import { expect, test } from "bun:test";\ntest("skill", () => expect(2).toBe(2));\n',
      });
      const destBefore = commitAll(destination, "dest before narrowing");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-export-ignore",
          scripts: { test: "bun test ./skills" },
        }),
        "note.txt": "carried note\n",
      });
      const destAfter = commitAll(destination, "dest after narrowing");

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
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_MOVE_TEST_DROPPED",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain("before 2, after 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unknown --source-folder: refuses DOMAIN_PRECONDITION_UNMET naming --source-folder", () => {
    const root = testFolder("move-unknown-folder-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "pkg/file.txt": "hello\n" });
      const sourceCommit = commitAll(source, "source");

      writeFiles(destination, { "pkg/file.txt": "hello\n" });
      const destinationCommit = commitAll(destination, "destination");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "no-such-folder",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain("--source-folder");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Empty --destination-folder: refuses DOMAIN_PRECONDITION_UNMET naming --destination-folder", () => {
    const root = testFolder("move-empty-dest-folder-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "pkg/file.txt": "hello\n" });
      const sourceCommit = commitAll(source, "source");

      writeFiles(destination, { "other/file.txt": "hello\n" });
      const destinationCommit = commitAll(destination, "destination");

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
        "no-such-dest",
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain("--destination-folder");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Subfolder --source: compares root-relative --source-folder using --full-tree", () => {
    const root = testFolder("move-source-subdir-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "pkg/kept.txt": "kept\n",
        "pkg/missing.txt": "missing\n",
        "nested/sub/placeholder.txt": "placeholder\n",
      });
      const sourceCommit = commitAll(source, "source");

      writeFiles(destination, { "pkg/kept.txt": "kept\n" });
      const destinationCommit = commitAll(destination, "destination");

      const sourceSubdir = join(source, "nested", "sub");
      mkdirSync(sourceSubdir, { recursive: true });

      const ran = invokeMoveCheckJson(
        "--source",
        sourceSubdir,
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
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_MOVE_FILE_DROPPED",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain("missing.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Truncated ls-tree output: refuses DOMAIN_PRECONDITION_UNMET when listing exceeds output limit", () => {
    const root = testFolder("move-tree-truncated-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      const blob = runGit(source, ["hash-object", "-w", "--stdin"], "x\n");
      const leafLines: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        const suffix = String(index).padStart(2, "0");
        leafLines.push(
          `100644 blob ${blob}\tleaf-0000000000000000000000000000000000000000-${suffix}.txt`,
        );
      }
      const leafTree = runGit(source, ["mktree"], `${leafLines.join("\n")}\n`);

      const midLines: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        const suffix = String(index).padStart(2, "0");
        midLines.push(
          `040000 tree ${leafTree}\tmid-0000000000000000000000000000000000000000-${suffix}`,
        );
      }
      const midTree = runGit(source, ["mktree"], `${midLines.join("\n")}\n`);

      const topLines: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const suffix = String(index).padStart(2, "0");
        topLines.push(
          `040000 tree ${midTree}\ttop-0000000000000000000000000000000000000000-${suffix}`,
        );
      }
      const topTree = runGit(source, ["mktree"], `${topLines.join("\n")}\n`);
      const rootTree = runGit(
        source,
        ["mktree"],
        `040000 tree ${topTree}\tpkg\n`,
      );
      const sourceCommit = runGit(source, [
        "commit-tree",
        rootTree,
        "-m",
        "oversized source tree",
      ]);

      writeFiles(destination, { "pkg/placeholder.txt": "placeholder\n" });
      const destinationCommit = commitAll(destination, "dest placeholder");

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
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_PRECONDITION_UNMET",
          exitCode: 3,
          outcome: "refused",
        },
      });
      expect(JSON.stringify(ran.envelope)).toContain("output limit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
