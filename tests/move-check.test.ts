import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  blobHash,
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

describe("move check refusals", () => {
  test("D051 replay: refuses DOMAIN_MOVE_FILE_DROPPED when destination lacks a tracked dist file", () => {
    const root = testFolder("move-d051-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "skills/x/SKILL.md": "# Skill X\n",
        "skills/x/helper/dist/x.js": "export const value = 1;\n",
      });
      runGit(source, ["add", "-f", "skills/x/helper/dist/x.js"]);
      const sourceCommit = commitAll(source, "source with dist bundle");

      writeFiles(destination, {
        "skills/x/SKILL.md": "# Skill X\n",
      });
      const destinationCommit = commitAll(
        destination,
        "import missing dist bundle",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "skills/x",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "skills/x",
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
      expect(JSON.stringify(ran.envelope)).toContain("helper/dist/x.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Changed hash: refuses DOMAIN_MOVE_FILE_CHANGED with both git blob hashes", () => {
    const root = testFolder("move-changed-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "pkg/readme.md": "original bytes\n",
      });
      const sourceCommit = commitAll(source, "source original");
      const sourceHash = blobHash(source, sourceCommit, "pkg/readme.md");

      writeFiles(destination, {
        "pkg/readme.md": "modified bytes\n",
      });
      const destinationCommit = commitAll(destination, "destination modified");
      const destinationHash = blobHash(
        destination,
        destinationCommit,
        "pkg/readme.md",
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
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "DOMAIN_MOVE_FILE_CHANGED",
          exitCode: 3,
          outcome: "refused",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("readme.md");
      expect(serialized).toContain(sourceHash);
      expect(serialized).toContain(destinationHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("D041 replay: refuses DOMAIN_MOVE_REFERENCE_DANGLING when source still names a moved path", () => {
    const root = testFolder("move-d041-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "skills/personal/a/SKILL.md": "# Skill A\n",
        ".agents/skills/verify-a/SKILL.md":
          "Verify skills/personal/a/SKILL.md before release.\n",
      });
      const sourceBefore = commitAll(source, "before moving skill a");

      runGit(source, ["rm", "-r", "skills/personal/a"]);
      const sourceAfter = commitAll(source, "remove skill a leaving stale ref");

      writeFiles(destination, {
        "a/SKILL.md": "# Skill A\n",
      });
      const destinationCommit = commitAll(destination, "import skill a");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "skills/personal/a",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "a",
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
      expect(serialized).toContain(".agents/skills/verify-a/SKILL.md");
      expect(serialized).toContain("skills/personal/a/SKILL.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("D041 destination link: refuses DOMAIN_MOVE_REFERENCE_DANGLING on broken relative Markdown link", () => {
    const root = testFolder("move-md-link-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/guide.md": "See [missing](../other/missing.md) for details.\n",
      });
      const sourceCommit = commitAll(source, "source guide");

      writeFiles(destination, {
        "docs/guide.md": "See [missing](../other/missing.md) for details.\n",
      });
      const destinationCommit = commitAll(destination, "destination guide");

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
      expect(serialized).toContain("docs/guide.md");
      expect(serialized).toContain("../other/missing.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("C147 replay: refuses DOMAIN_MOVE_SOURCE_KEPT when moved blob remains under another path", () => {
    const root = testFolder("move-c147-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      const content = "export const moved = 'exact-bytes-c147';\n";
      writeFiles(source, {
        "moved/tool.ts": content,
        "archive/duplicate.ts": content,
      });
      const sourceBefore = commitAll(source, "before move with duplicate");

      runGit(source, ["rm", "-r", "moved"]);
      const sourceAfter = commitAll(source, "remove moved folder only");

      writeFiles(destination, {
        "tool.ts": content,
      });
      const destinationCommit = commitAll(destination, "import tool");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "moved",
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
          causeCode: "DOMAIN_MOVE_SOURCE_KEPT",
          exitCode: 3,
          outcome: "refused",
        },
      });
      const serialized = JSON.stringify(ran.envelope);
      expect(serialized).toContain("archive/duplicate.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("D050 replay: refuses DOMAIN_MOVE_TEST_DROPPED with both counts when test script hides test files", () => {
    const root = testFolder("move-d050-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "note.txt": "carried note\n",
      });
      const sourceCommit = commitAll(source, "source note");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-d050",
          scripts: { test: "bun test" },
        }),
        "tests/root.test.ts":
          'import { expect, test } from "bun:test";\ntest("root", () => expect(1).toBe(1));\n',
        "skills/a/skill.test.ts":
          'import { expect, test } from "bun:test";\ntest("skill", () => expect(2).toBe(2));\n',
      });
      const destBefore = commitAll(destination, "before narrowing test script");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-d050",
          scripts: { test: "bun test tests" },
        }),
        "note.txt": "carried note\n",
      });
      const destAfter = commitAll(destination, "after narrowing test script");

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
      expect(serialized).toContain("2");
      expect(serialized).toContain("1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
