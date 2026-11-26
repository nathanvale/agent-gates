import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

function writeSymlink(repo: string, relativePath: string, target: string) {
  const fullPath = join(repo, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  symlinkSync(target, fullPath);
}

describe("move check intermediate folder existence", () => {
  test("Symlink traversing missing removed/nested before dot-dot: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-intermediate-missing-symlink-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "move/README.md": "Read [the guide](guide.md).\n",
        "removed/nested/keep.txt": "present in source\n",
        "guide.md": "# Root guide\n",
      });
      writeSymlink(source, "move/guide.md", "../removed/nested/../../guide.md");
      const sourceCommit = commitAll(source, "source with nested traversal");

      writeFiles(destination, {
        "move/README.md": "Read [the guide](guide.md).\n",
        "guide.md": "# Root guide\n",
      });
      writeSymlink(
        destination,
        "move/guide.md",
        "../removed/nested/../../guide.md",
      );
      const destinationCommit = commitAll(
        destination,
        "dest missing removed/nested",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "move",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "move",
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
      expect(serialized).toContain("move/README.md");
      expect(serialized).toContain("guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Symlink traversing present removed/nested before dot-dot: exits 0", () => {
    const root = testFolder("move-intermediate-present-symlink-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "move/README.md": "Read [the guide](guide.md).\n",
        "removed/nested/keep.txt": "present in source\n",
        "guide.md": "# Root guide\n",
      });
      writeSymlink(source, "move/guide.md", "../removed/nested/../../guide.md");
      const sourceCommit = commitAll(source, "source with nested traversal");

      writeFiles(destination, {
        "move/README.md": "Read [the guide](guide.md).\n",
        "removed/nested/keep.txt": "present in destination\n",
        "guide.md": "# Root guide\n",
      });
      writeSymlink(
        destination,
        "move/guide.md",
        "../removed/nested/../../guide.md",
      );
      const destinationCommit = commitAll(
        destination,
        "dest with removed/nested present",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "move",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "move",
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

  test("Plain Markdown link through missing folder before dot-dot: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-intermediate-missing-plain-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "move/README.md": "Read [the guide](../removed/../guide.md).\n",
        "removed/keep.txt": "present in source\n",
        "guide.md": "# Root guide\n",
      });
      const sourceCommit = commitAll(source, "source with plain dot-dot link");

      writeFiles(destination, {
        "move/README.md": "Read [the guide](../removed/../guide.md).\n",
        "guide.md": "# Root guide\n",
      });
      const destinationCommit = commitAll(destination, "dest missing removed");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "move",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "move",
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
      expect(serialized).toContain("move/README.md");
      expect(serialized).toContain("../removed/../guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Markdown link traversing a regular file as a folder before dot-dot: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-intermediate-file-as-folder-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "move/README.md": "Read [the guide](notes.md/../guide.md).\n",
        "move/notes.md": "# Notes\n",
        "move/guide.md": "# Guide\n",
      });
      const sourceCommit = commitAll(source, "source with file as folder link");

      writeFiles(destination, {
        "move/README.md": "Read [the guide](notes.md/../guide.md).\n",
        "move/notes.md": "# Notes\n",
        "move/guide.md": "# Guide\n",
      });
      const destinationCommit = commitAll(
        destination,
        "dest with file as folder link",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        "move",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "move",
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
      expect(serialized).toContain("move/README.md");
      expect(serialized).toContain("notes.md/../guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Markdown link through directory symlink and dot-dot to existing sibling skill: exits 0", () => {
    const root = testFolder("move-intermediate-dir-symlink-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "README.md":
          "See [kernel](.claude/skills/verify-cli/../agent-cli-kernel/SKILL.md).\n",
        ".agents/skills/verify-cli/SKILL.md": "# Verify CLI\n",
        ".agents/skills/agent-cli-kernel/SKILL.md": "# Agent CLI Kernel\n",
      });
      writeSymlink(
        source,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const sourceCommit = commitAll(source, "source with dir symlink");

      writeFiles(destination, {
        "README.md":
          "See [kernel](.claude/skills/verify-cli/../agent-cli-kernel/SKILL.md).\n",
        ".agents/skills/verify-cli/SKILL.md": "# Verify CLI\n",
        ".agents/skills/agent-cli-kernel/SKILL.md": "# Agent CLI Kernel\n",
      });
      writeSymlink(
        destination,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const destinationCommit = commitAll(
        destination,
        "dest with dir symlink and sibling target",
      );

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
          exitCode: 0,
          outcome: "success",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
