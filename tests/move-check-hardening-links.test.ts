import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanGitEnv,
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  invokeMoveCheckJsonWithEnv,
  runGit,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

function normalizeEnvelope(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) return envelope;
  const copy: Record<string, unknown> = { ...envelope };
  if (typeof copy.result === "object" && copy.result !== null) {
    copy.result = { ...copy.result, runId: "<runId>" };
  }
  return copy;
}

describe("move check hardening: links, scripts, and git env isolation", () => {
  test("Markdown extensions: checks relative links in .markdown files", () => {
    const root = testFolder("move-markdown-ext-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/readme.markdown": "See [left behind](../other/left-behind.md).\n",
        "other/left-behind.md": "# Left behind\n",
      });
      const sourceCommit = commitAll(source, "source markdown doc");

      writeFiles(destination, {
        "docs/readme.markdown": "See [left behind](../other/left-behind.md).\n",
      });
      const destinationCommit = commitAll(destination, "dest markdown doc");

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
      expect(serialized).toContain("docs/readme.markdown");
      expect(serialized).toContain("../other/left-behind.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Symlink link target missing: refuses DOMAIN_MOVE_REFERENCE_DANGLING", () => {
    const root = testFolder("move-symlink-dangling-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "shared/real-guide.md": "# Guide\n",
      });
      symlinkSync("../shared/real-guide.md", join(source, "docs/guide.md"));
      const sourceCommit = commitAll(source, "source with symlink");

      writeFiles(destination, {
        "docs/README.md": "Read [the guide](guide.md).\n",
      });
      symlinkSync(
        "../shared/real-guide.md",
        join(destination, "docs/guide.md"),
      );
      const destinationCommit = commitAll(
        destination,
        "dest missing symlink target",
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

  test("Symlink link target present: exits 0 when symlink target is also moved", () => {
    const root = testFolder("move-symlink-ok-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "shared/real-guide.md": "# Guide\n",
      });
      symlinkSync("../shared/real-guide.md", join(source, "docs/guide.md"));
      const sourceCommit = commitAll(source, "source with symlink");

      writeFiles(destination, {
        "docs/README.md": "Read [the guide](guide.md).\n",
        "shared/real-guide.md": "# Guide\n",
      });
      symlinkSync(
        "../shared/real-guide.md",
        join(destination, "docs/guide.md"),
      );
      const destinationCommit = commitAll(
        destination,
        "dest with symlink target",
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

  test("Compound test script: exits 0 and lists test-discovery under notChecked with script text", () => {
    const root = testFolder("move-compound-test-script-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "note.txt": "carried note\n" });
      const sourceCommit = commitAll(source, "source note");

      const compoundScript = "bun test ./unit && bun test ./integration";
      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-compound",
          scripts: { test: compoundScript },
        }),
        "unit/a.test.ts":
          'import { expect, test } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
        "integration/b.test.ts":
          'import { expect, test } from "bun:test";\ntest("b", () => expect(2).toBe(2));\n',
      });
      const destBefore = commitAll(destination, "dest before");

      writeFiles(destination, { "note.txt": "carried note\n" });
      const destAfter = commitAll(destination, "dest after");

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
      expect(serialized).toContain(compoundScript);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Inherited GIT_DIR and GIT_WORK_TREE: neither helpers nor move check touch another repository", () => {
    const root = testFolder("move-git-env-isolation-");
    const savedGitDir = process.env.GIT_DIR;
    const savedGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      const other = join(root, "other");
      initRepo(other);
      writeFiles(other, { "sentinel.txt": "do not touch\n" });
      commitAll(other, "other initial");

      const otherHeadBefore = runGit(other, ["rev-parse", "HEAD"]);
      const otherIndexBefore = readFileSync(join(other, ".git", "index"));
      const otherConfigBefore = readFileSync(
        join(other, ".git", "config"),
        "utf8",
      );

      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;

      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "pkg/item.txt": "moved item\n" });
      const sourceCommit = commitAll(source, "source item");

      writeFiles(destination, { "pkg/item.txt": "moved item\n" });
      const destinationCommit = commitAll(destination, "dest item");

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

      if (savedGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = savedGitDir;
      }
      if (savedGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = savedGitWorkTree;
      }

      expect(runGit(other, ["rev-parse", "HEAD"])).toBe(otherHeadBefore);
      expect(readFileSync(join(other, ".git", "index"))).toEqual(
        otherIndexBefore,
      );
      expect(readFileSync(join(other, ".git", "config"), "utf8")).toBe(
        otherConfigBefore,
      );
    } finally {
      if (savedGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = savedGitDir;
      }
      if (savedGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = savedGitWorkTree;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Inherited GIT_DIR and GIT_WORK_TREE: test discovery strips git location vars and leaves another repository untouched", () => {
    const root = testFolder("move-test-discovery-git-env-");
    try {
      const other = join(root, "other");
      initRepo(other);
      writeFiles(other, { "sentinel.txt": "do not touch\n" });
      commitAll(other, "other initial");

      const otherHeadBefore = runGit(other, ["rev-parse", "HEAD"]);
      const otherIndexBefore = readFileSync(join(other, ".git", "index"));
      const otherConfigBefore = readFileSync(
        join(other, ".git", "config"),
        "utf8",
      );

      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, { "pkg/item.txt": "moved item\n" });
      const sourceCommit = commitAll(source, "source item");

      const expectedHeadFile = join(root, "expected-head.txt");
      const repoAwareTest = [
        'import { expect, test } from "bun:test";',
        'import { readFileSync } from "node:fs";',
        `const child = Bun.spawnSync(["git", "-C", ${JSON.stringify(destination)}, "rev-parse", "HEAD"]);`,
        "if (child.exitCode !== 0) throw new Error(child.stderr.toString());",
        "const actualHead = child.stdout.toString().trim();",
        `const expectedHead = readFileSync(${JSON.stringify(expectedHeadFile)}, "utf8").trim();`,
        "if (actualHead !== expectedHead) {",
        "  throw new Error(`Expected destination HEAD ${expectedHead}, got ${actualHead}`);",
        "}",
        'test("repo head matches", () => expect(actualHead).toBe(expectedHead));',
        "",
      ].join("\n");

      writeFiles(destination, {
        "package.json": JSON.stringify({
          name: "dest-git-env-test",
          scripts: { test: "bun test" },
        }),
        "tests/repo-head.test.ts": repoAwareTest,
      });
      const destBefore = commitAll(destination, "dest before move");

      writeFiles(destination, { "pkg/item.txt": "moved item\n" });
      const destAfter = commitAll(destination, "dest after move");
      writeFileSync(expectedHeadFile, `${destAfter}\n`, "utf8");

      const argv = [
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
      ];

      const cleanEnv = cleanGitEnv();

      const baseline = invokeMoveCheckJsonWithEnv(cleanEnv, ...argv);
      const polluted = invokeMoveCheckJsonWithEnv(
        {
          ...cleanEnv,
          GIT_DIR: join(other, ".git"),
          GIT_WORK_TREE: other,
        },
        ...argv,
      );

      expect(baseline.exitCode).toBe(0);
      expect(baseline.stderr).toBe("");
      expect(baseline.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.move-check",
          causeCode: "SUCCESS_UNCHANGED",
          exitCode: 0,
          outcome: "success",
          data: {
            findings: [],
            notChecked: [],
          },
        },
      });
      expect(polluted.exitCode).toBe(baseline.exitCode);
      expect(polluted.stderr).toBe(baseline.stderr);
      expect(normalizeEnvelope(polluted.envelope)).toEqual(
        normalizeEnvelope(baseline.envelope),
      );

      expect(runGit(other, ["rev-parse", "HEAD"])).toBe(otherHeadBefore);
      expect(readFileSync(join(other, ".git", "index"))).toEqual(
        otherIndexBefore,
      );
      expect(readFileSync(join(other, ".git", "config"), "utf8")).toBe(
        otherConfigBefore,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
