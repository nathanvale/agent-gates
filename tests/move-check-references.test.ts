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

const crosswalkLine =
  "config/agents/plugins/personal/library/delivery-slice/SKILL.md\tskills\tskills-coordinator\tskills:skills/experimental/delivery-slice/SKILL.md\tmoved\tskills@9bb35b5c\n";

describe("move check reference rules", () => {
  test("D041 real shape: flags whole-name reference in verifier and skips crosswalk move record", () => {
    const root = testFolder("move-d041-real-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "config/agents/plugins/personal/library/delivery-slice/SKILL.md":
          "# Delivery Slice\n",
        ".agents/skills/verify-delivery-slice/SKILL.md":
          "Skill event resolve `personal:delivery-slice` from this candidate.\n",
      });
      const sourceBefore = commitAll(source, "before moving delivery-slice");

      runGit(source, [
        "rm",
        "-r",
        "config/agents/plugins/personal/library/delivery-slice",
      ]);
      writeFiles(source, {
        "migration/crosswalk.tsv": crosswalkLine,
      });
      const sourceAfter = commitAll(
        source,
        "remove delivery-slice and record crosswalk",
      );

      writeFiles(destination, {
        "skills/experimental/delivery-slice/SKILL.md": "# Delivery Slice\n",
      });
      const destinationCommit = commitAll(destination, "import delivery-slice");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "config/agents/plugins/personal/library/delivery-slice",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "skills/experimental/delivery-slice",
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
      expect(serialized).toContain(
        "Move check found 1 issue: DOMAIN_MOVE_REFERENCE_DANGLING .agents/skills/verify-delivery-slice/SKILL.md references delivery-slice",
      );
      expect(serialized).not.toContain("migration/crosswalk.tsv");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("D041 real shape cleaned: exits 0 when verifier is removed and crosswalk record remains", () => {
    const root = testFolder("move-d041-clean-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "config/agents/plugins/personal/library/delivery-slice/SKILL.md":
          "# Delivery Slice\n",
        ".agents/skills/verify-delivery-slice/SKILL.md":
          "Skill event resolve `personal:delivery-slice` from this candidate.\n",
      });
      const sourceBefore = commitAll(source, "before moving delivery-slice");

      runGit(source, [
        "rm",
        "-r",
        "config/agents/plugins/personal/library/delivery-slice",
        ".agents/skills/verify-delivery-slice",
      ]);
      writeFiles(source, {
        "migration/crosswalk.tsv": crosswalkLine,
      });
      const sourceAfter = commitAll(
        source,
        "remove delivery-slice and verifier, record crosswalk",
      );

      writeFiles(destination, {
        "skills/experimental/delivery-slice/SKILL.md": "# Delivery Slice\n",
      });
      const destinationCommit = commitAll(destination, "import delivery-slice");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "config/agents/plugins/personal/library/delivery-slice",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "skills/experimental/delivery-slice",
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

  test("Whole-name boundary: text mentioning only verify-delivery-slice is not a finding", () => {
    const root = testFolder("move-boundary-");
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      initRepo(source);
      initRepo(destination);

      writeFiles(source, {
        "config/agents/plugins/personal/library/delivery-slice/SKILL.md":
          "# Delivery Slice\n",
        "docs/notes.md":
          "The helper verify-delivery-slice and delivery-slices remain unrelated.\n",
      });
      const sourceBefore = commitAll(source, "before moving delivery-slice");

      runGit(source, [
        "rm",
        "-r",
        "config/agents/plugins/personal/library/delivery-slice",
      ]);
      const sourceAfter = commitAll(source, "remove delivery-slice");

      writeFiles(destination, {
        "skills/experimental/delivery-slice/SKILL.md": "# Delivery Slice\n",
      });
      const destinationCommit = commitAll(destination, "import delivery-slice");

      const ran = invokeMoveCheckJson(
        "--source",
        source,
        "--source-commit",
        `${sourceBefore}..${sourceAfter}`,
        "--source-folder",
        "config/agents/plugins/personal/library/delivery-slice",
        "--destination",
        destination,
        "--destination-commit",
        destinationCommit,
        "--destination-folder",
        "skills/experimental/delivery-slice",
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

  test("Same repository move from a/ to b/ skips destination files for source-kept and reference checks", () => {
    const root = testFolder("move-same-repo-");
    try {
      const repo = join(root, "repo");
      initRepo(repo);

      writeFiles(repo, {
        "a/guide.md": "Notes about `a` and a/guide.md.\n",
        "keep.txt": "unrelated file\n",
      });
      const before = commitAll(repo, "before move a to b");

      runGit(repo, ["rm", "-r", "a"]);
      writeFiles(repo, {
        "b/guide.md": "Notes about `a` and a/guide.md.\n",
      });
      const after = commitAll(repo, "move a to b");

      const ran = invokeMoveCheckJson(
        "--source",
        repo,
        "--source-commit",
        `${before}..${after}`,
        "--source-folder",
        "a",
        "--destination",
        repo,
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
});
