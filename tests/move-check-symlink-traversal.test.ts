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

describe("move check symlink traversal order", () => {
  test("Directory symlink before dot-dot with real target left behind: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-symlink-traversal-dangling-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "guide.md": "# Root guide\n",
        "sub/guide.md": "# Sub guide\n",
        "sub/nested/keep.txt": "present\n",
      });
      writeSymlink(source, "docs/guide.md", "../alias/../guide.md");
      writeSymlink(source, "alias", "sub/nested");
      const sourceCommit = commitAll(source, "source with chained symlinks");

      writeFiles(destination, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "guide.md": "# Root guide\n",
        "sub/nested/keep.txt": "present\n",
      });
      writeSymlink(destination, "docs/guide.md", "../alias/../guide.md");
      writeSymlink(destination, "alias", "sub/nested");
      const destinationCommit = commitAll(
        destination,
        "dest missing sub/guide.md",
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
      expect(serialized).toContain("docs/README.md");
      expect(serialized).toContain("guide.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Directory symlink before dot-dot with real target moved too: exits 0", () => {
    const root = testFolder("move-symlink-traversal-ok-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "guide.md": "# Root guide\n",
        "sub/guide.md": "# Sub guide\n",
        "sub/nested/keep.txt": "present\n",
      });
      writeSymlink(source, "docs/guide.md", "../alias/../guide.md");
      writeSymlink(source, "alias", "sub/nested");
      const sourceCommit = commitAll(source, "source with chained symlinks");

      writeFiles(destination, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "guide.md": "# Root guide\n",
        "sub/guide.md": "# Sub guide\n",
        "sub/nested/keep.txt": "present\n",
      });
      writeSymlink(destination, "docs/guide.md", "../alias/../guide.md");
      writeSymlink(destination, "alias", "sub/nested");
      const destinationCommit = commitAll(
        destination,
        "dest with sub/guide.md",
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

  test("Moved SKILL.md through directory symlink with target present: exits 0", () => {
    const root = testFolder("move-skill-symlink-ok-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        ".claude/skills/my-skill/SKILL.md":
          "See [reference](../verify-cli/references/x.md).\n",
        ".agents/skills/verify-cli/references/x.md": "# Reference X\n",
      });
      writeSymlink(
        source,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const sourceCommit = commitAll(source, "source skill with symlink");

      writeFiles(destination, {
        ".claude/skills/my-skill/SKILL.md":
          "See [reference](../verify-cli/references/x.md).\n",
        ".agents/skills/verify-cli/references/x.md": "# Reference X\n",
      });
      writeSymlink(
        destination,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const destinationCommit = commitAll(
        destination,
        "dest skill with symlink target present",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        ".claude/skills/my-skill",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        ".claude/skills/my-skill",
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

  test("Moved SKILL.md through directory symlink with target left behind: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-skill-symlink-dangling-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        ".claude/skills/my-skill/SKILL.md":
          "See [reference](../verify-cli/references/x.md).\n",
        ".agents/skills/verify-cli/SKILL.md": "# Verify CLI\n",
        ".agents/skills/verify-cli/references/x.md": "# Reference X\n",
      });
      writeSymlink(
        source,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const sourceCommit = commitAll(source, "source skill with symlink");

      writeFiles(destination, {
        ".claude/skills/my-skill/SKILL.md":
          "See [reference](../verify-cli/references/x.md).\n",
        ".agents/skills/verify-cli/SKILL.md": "# Verify CLI\n",
      });
      writeSymlink(
        destination,
        ".claude/skills/verify-cli",
        "../../.agents/skills/verify-cli",
      );
      const destinationCommit = commitAll(
        destination,
        "dest skill with x.md left behind",
      );

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        sourceCommit,
        "--source-folder",
        ".claude/skills/my-skill",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        ".claude/skills/my-skill",
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
      expect(serialized).toContain(".claude/skills/my-skill/SKILL.md");
      expect(serialized).toContain("../verify-cli/references/x.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Symlink climbing above repository root: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-symlink-above-root-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/README.md": "Read [escape](escape.md).\n",
      });
      writeSymlink(source, "docs/escape.md", "../../outside.md");
      const sourceCommit = commitAll(source, "source symlink above root");

      writeFiles(destination, {
        "docs/README.md": "Read [escape](escape.md).\n",
      });
      writeSymlink(destination, "docs/escape.md", "../../outside.md");
      const destinationCommit = commitAll(
        destination,
        "dest symlink above root",
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
      expect(serialized).toContain("docs/README.md");
      expect(serialized).toContain("escape.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
