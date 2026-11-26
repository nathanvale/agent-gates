import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blobHash,
  commitAll,
  initRepo,
  invokeMoveCheckJson,
  writeFiles,
} from "./support/move-check.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

type Planted = {
  readonly executable?: string;
  readonly symlink?: { readonly path: string; readonly target: string };
};

function plant(repo: string, planted: Planted): void {
  if (planted.executable !== undefined) {
    chmodSync(join(repo, planted.executable), 0o755);
  }
  if (planted.symlink !== undefined) {
    const fullPath = join(repo, planted.symlink.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    symlinkSync(planted.symlink.target, fullPath);
  }
}

function runCopyCheck(
  prefix: string,
  side: {
    readonly sourceFiles: Readonly<Record<string, string>>;
    readonly sourcePlanted: Planted;
    readonly destinationFiles: Readonly<Record<string, string>>;
    readonly destinationPlanted: Planted;
    readonly path: string;
  },
) {
  const root = testFolder(prefix);
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    initRepo(source);
    initRepo(destination);

    writeFiles(source, side.sourceFiles);
    plant(source, side.sourcePlanted);
    const sourceCommit = commitAll(source, "source");

    writeFiles(destination, side.destinationFiles);
    plant(destination, side.destinationPlanted);
    const destinationCommit = commitAll(destination, "destination");

    const ran = invokeMoveCheckJson(
      "--source",
      source,
      "--source-commit",
      sourceCommit,
      "--source-folder",
      "tool",
      "--destination",
      destination,
      "--destination-commit",
      destinationCommit,
      "--destination-folder",
      "tool",
      "--kind",
      "copy",
    );
    return {
      ...ran,
      serialized: JSON.stringify(ran.envelope),
      sourceHash: blobHash(source, sourceCommit, side.path),
      destinationHash: blobHash(destination, destinationCommit, side.path),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const script = "#!/bin/sh\necho run\n";

describe("move check compares each file's mode with its bytes", () => {
  test("Executable arrives without its executable bit: refuses DOMAIN_MOVE_FILE_CHANGED naming 100755 and 100644", () => {
    const ran = runCopyCheck("move-mode-exec-lost-", {
      sourceFiles: { "tool/run.sh": script },
      sourcePlanted: { executable: "tool/run.sh" },
      destinationFiles: { "tool/run.sh": script },
      destinationPlanted: {},
      path: "tool/run.sh",
    });

    expect(ran.sourceHash).toBe(ran.destinationHash);
    expect(ran.exitCode).toBe(3);
    expect(ran.envelope).toMatchObject({
      result: {
        causeCode: "DOMAIN_MOVE_FILE_CHANGED",
        exitCode: 3,
        outcome: "refused",
      },
    });
    expect(ran.serialized).toContain(
      `DOMAIN_MOVE_FILE_CHANGED run.sh (source mode 100755 hash ${ran.sourceHash}, destination mode 100644 hash ${ran.destinationHash})`,
    );
    expect(ran.serialized).toContain("git update-index --chmod=+x <path>");
  });

  test("Tracked symlink arrives as a regular file with the same bytes: refuses DOMAIN_MOVE_FILE_CHANGED naming 120000 and 100644", () => {
    const ran = runCopyCheck("move-mode-symlink-flattened-", {
      sourceFiles: { "tool/target.txt": "target\n" },
      sourcePlanted: { symlink: { path: "tool/link", target: "target.txt" } },
      destinationFiles: {
        "tool/target.txt": "target\n",
        "tool/link": "target.txt",
      },
      destinationPlanted: {},
      path: "tool/link",
    });

    expect(ran.sourceHash).toBe(ran.destinationHash);
    expect(ran.exitCode).toBe(3);
    expect(ran.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_MOVE_FILE_CHANGED", outcome: "refused" },
    });
    expect(ran.serialized).toContain(
      `DOMAIN_MOVE_FILE_CHANGED link (source mode 120000 hash ${ran.sourceHash}, destination mode 100644 hash ${ran.destinationHash})`,
    );
  });

  test("Executable arrives still executable: exits 0", () => {
    const ran = runCopyCheck("move-mode-exec-kept-", {
      sourceFiles: { "tool/run.sh": script },
      sourcePlanted: { executable: "tool/run.sh" },
      destinationFiles: { "tool/run.sh": script },
      destinationPlanted: { executable: "tool/run.sh" },
      path: "tool/run.sh",
    });

    expect(ran.exitCode).toBe(0);
    expect(ran.envelope).toMatchObject({
      result: { causeCode: "SUCCESS_UNCHANGED", data: { findings: [] } },
    });
  });

  test("Same mode with different bytes: refuses DOMAIN_MOVE_FILE_CHANGED naming both hashes", () => {
    const ran = runCopyCheck("move-mode-bytes-changed-", {
      sourceFiles: { "tool/run.sh": script },
      sourcePlanted: {},
      destinationFiles: { "tool/run.sh": "#!/bin/sh\necho changed\n" },
      destinationPlanted: {},
      path: "tool/run.sh",
    });

    expect(ran.sourceHash).not.toBe(ran.destinationHash);
    expect(ran.exitCode).toBe(3);
    expect(ran.envelope).toMatchObject({
      result: { causeCode: "DOMAIN_MOVE_FILE_CHANGED", outcome: "refused" },
    });
    expect(ran.serialized).toContain(
      `DOMAIN_MOVE_FILE_CHANGED run.sh (source mode 100644 hash ${ran.sourceHash}, destination mode 100644 hash ${ran.destinationHash})`,
    );
  });
});
