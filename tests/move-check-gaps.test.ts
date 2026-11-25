import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
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

describe("move check fix round 2", () => {
  test("Reference-style Markdown link: refuses DOMAIN_MOVE_REFERENCE_DANGLING and skips code blocks", () => {
    const root = testFolder("move-ref-md-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      const doc = [
        "See [guide][g].",
        "",
        "`[ignored-span][dead]`",
        "",
        "```md",
        "[ignored-fence][dead]",
        "```",
        "",
        "[g]: ../shared/guide.md",
        "[dead]: ../shared/never.md",
        "",
      ].join("\n");

      writeFiles(source, { "docs/readme.md": doc });
      const sourceCommit = commitAll(source, "source ref-link doc");

      writeFiles(destination, { "docs/readme.md": doc });
      const destinationCommit = commitAll(
        destination,
        "destination ref-link doc",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "docs",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "docs",
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_MOVE_REFERENCE_DANGLING",
          exitCode: 3,
          outcome: "refused",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("docs/readme.md");
      expect(serialized).toContain("../shared/guide.md");
      expect(serialized).not.toContain("../shared/never.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Test script alias: follows bun run alias and refuses DOMAIN_MOVE_TEST_DROPPED with both counts", () => {
    const root = testFolder("move-test-alias-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "note.txt": "carried note\n" });
      const sourceCommit = commitAll(source, "source note");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-alias",
          scripts: {
            test: "bun run test:unit",
            "test:unit": "bun test",
          },
        }),
        "tests/root.test.ts":
          'import { expect, test } from "bun:test";\ntest("root", () => expect(1).toBe(1));\n',
        "skills/a/skill.test.ts":
          'import { expect, test } from "bun:test";\ntest("skill", () => expect(2).toBe(2));\n',
      });
      const destBefore = commitAll(destination, "before narrowing alias");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-alias",
          scripts: {
            test: "bun run test:unit",
            "test:unit": "bun test ./tests",
          },
        }),
        "note.txt": "carried note\n",
      });
      const destAfter = commitAll(destination, "after narrowing alias");

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
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("before 2, after 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Unsupported test script: reports test-discovery under notChecked with reason and script text", () => {
    const root = testFolder("move-test-unsupported-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "note.txt": "carried note\n" });
      const sourceCommit = commitAll(source, "source note");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-custom-runner",
          scripts: {
            test: "bun scripts/test-run.ts",
          },
        }),
        "tests/root.test.ts":
          'import { expect, test } from "bun:test";\ntest("root", () => expect(1).toBe(1));\n',
      });
      const destBefore = commitAll(destination, "before custom runner");

      writeFiles(destination, { "note.txt": "carried note\n" });
      const destAfter = commitAll(destination, "after custom runner");

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

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("test-discovery");
      expect(serialized).toContain("bun scripts/test-run.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Large text file: reports unreadable over-limit text blob under notChecked naming the file", () => {
    const root = testFolder("move-large-blob-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      const largeText = `${"a".repeat(1023)}\n`.repeat(4300);
      writeFiles(source, {
        "pkg/item.txt": "moved content\n",
        "big/notes.txt": largeText,
      });
      const sourceBefore = commitAll(source, "before moving pkg");

      runGit(source, ["rm", "-r", "pkg"]);
      const sourceAfter = commitAll(source, "after removing pkg");

      writeFiles(destination, {
        "pkg/item.txt": "moved content\n",
      });
      const destinationCommit = commitAll(destination, "import pkg");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "pkg",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "pkg",
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("source-references");
      expect(serialized).toContain("big/notes.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Linked worktrees: same repository checked through two worktrees exits 0", () => {
    const root = testFolder("move-worktrees-");
    try {
      const mainWorktree = join(root, "main-wt");
      const linkedWorktree = join(root, "linked-wt");
      initRepo(mainWorktree);

      writeFiles(mainWorktree, {
        "a/guide.md": "Notes about `a` and a/guide.md.\n",
        "keep.txt": "unrelated file\n",
      });
      const before = commitAll(mainWorktree, "before move a to b");

      runGit(mainWorktree, [
        "worktree",
        "add",
        "-b",
        "moved",
        linkedWorktree,
        before,
      ]);
      runGit(linkedWorktree, ["rm", "-r", "a"]);
      writeFiles(linkedWorktree, {
        "b/guide.md": "Notes about `a` and a/guide.md.\n",
      });
      const after = commitAll(linkedWorktree, "move a to b in linked worktree");

      const ran = invokeMoveCheckJson(
        "--source",
        mainWorktree,
        "--source-commit",
        `${before}..${after}`,
        "--source-folder",
        "a",
        "--destination",
        linkedWorktree,
        "--destination-commit",
        after,
        "--destination-folder",
        "b",
      );

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Test-runner load failure: does not hide file findings and lists discovery failure under not checked", () => {
    const root = testFolder("move-runner-and-drop-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "pkg/kept.txt": "kept\n",
        "pkg/dropped.txt": "dropped\n",
      });
      const sourceCommit = commitAll(source, "source files");

      writeFiles(destination, {
        "tests/ok.test.ts":
          'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
      });
      const destBefore = commitAll(destination, "dest before");

      writeFiles(destination, {
        "pkg/kept.txt": "kept\n",
        "tests/broken.test.ts": "const x = {{{;\n",
      });
      const destAfter = commitAll(
        destination,
        "dest after with dropped file and broken test",
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
        `${destBefore}..${destAfter}`,
        "--destination-folder",
        "pkg",
        "--kind",
        "copy",
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
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("dropped.txt");
      expect(serialized).toContain("not checked");
      expect(serialized).toContain("test-discovery");
      expect(serialized).toContain("Test runner failed to load");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
