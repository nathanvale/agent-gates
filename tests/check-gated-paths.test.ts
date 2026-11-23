import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { testFolder } from "./support/test-folder.ts";

const gateScript = resolve(import.meta.dir, "../scripts/check-gated-paths.ts");
const baseCli = "export {};\n";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const next = created.pop();
    if (next !== undefined) rmSync(next, { recursive: true, force: true });
  }
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(repo: string, ...args: string[]): void {
  const ran = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} exited ${String(ran.exitCode)}: ${ran.stderr.toString()}`,
    );
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo: string, message: string, ...paths: string[]): void {
  git(repo, "add", "--", ...paths);
  git(repo, "commit", "-q", "-m", message);
}

function repoAtBase(): string {
  const repo = testFolder("check-gated-paths-");
  created.push(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "package.json", '{ "name": "fixture" }\n');
  write(repo, "src/cli.ts", baseCli);
  write(repo, "README.md", "# Fixture\n");
  write(repo, ".changeset/README.md", "# Changesets\n");
  commit(repo, "base", "package.json", "src/cli.ts", "README.md", ".changeset");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function runGate(repo: string): { exitCode: number; stderr: string } {
  const ran = Bun.spawnSync([process.execPath, gateScript], {
    cwd: repo,
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return { exitCode: ran.exitCode, stderr: ran.stderr.toString() };
}

function editCli(repo: string): void {
  write(repo, "src/cli.ts", `${baseCli}// edited\n`);
}

test.each<[string, string, (repo: string) => void]>([
  [
    "a gated edit that is committed",
    "src/cli.ts",
    (repo) => {
      editCli(repo);
      commit(repo, "edit", "src/cli.ts");
    },
  ],
  [
    "a gated edit that is staged while the working tree is put back",
    "src/cli.ts",
    (repo) => {
      editCli(repo);
      git(repo, "add", "--", "src/cli.ts");
      write(repo, "src/cli.ts", baseCli);
    },
  ],
  [
    "a gated edit only in the working tree",
    "src/cli.ts",
    (repo) => {
      editCli(repo);
    },
  ],
  [
    "a committed gated edit put back in the working tree",
    "src/cli.ts",
    (repo) => {
      editCli(repo);
      commit(repo, "edit", "src/cli.ts");
      write(repo, "src/cli.ts", baseCli);
    },
  ],
  [
    "a package.json edit",
    "package.json",
    (repo) => {
      write(repo, "package.json", '{ "name": "fixture", "private": true }\n');
      commit(repo, "edit", "package.json");
    },
  ],
  [
    "a rename out of src/",
    "src/cli.ts",
    (repo) => {
      mkdirSync(join(repo, "archive"));
      git(repo, "mv", "src/cli.ts", "archive/cli.ts");
      git(repo, "commit", "-q", "-m", "rename out");
    },
  ],
  [
    "a new file with a non-ASCII name",
    "src/café.ts",
    (repo) => {
      write(repo, "src/café.ts", baseCli);
      commit(repo, "add", "src/café.ts");
    },
  ],
  [
    "a new dot-file under src/",
    "src/.entry.ts",
    (repo) => {
      write(repo, "src/.entry.ts", baseCli);
      commit(repo, "add", "src/.entry.ts");
    },
  ],
])("refuses %s with no changeset", (_case, firstPath, plant) => {
  const repo = repoAtBase();
  plant(repo);
  const gate = runGate(repo);
  expect(gate.stderr).toContain(
    `gated path(s) (first: ${JSON.stringify(firstPath)}) and adds no changeset.`,
  );
  expect(gate.exitCode).toBe(1);
});

test.each<[string, (repo: string) => void]>([
  [
    "a README-only change",
    (repo) => {
      write(repo, "README.md", "# Fixture\n\nMore.\n");
      commit(repo, "docs", "README.md");
    },
  ],
  [
    "a gated edit with a staged changeset",
    (repo) => {
      editCli(repo);
      commit(repo, "edit", "src/cli.ts");
      write(repo, ".changeset/quiet-edit.md", "---\n---\n\n");
      git(repo, "add", "--", ".changeset/quiet-edit.md");
    },
  ],
])("admits %s", (_case, plant) => {
  const repo = repoAtBase();
  plant(repo);
  expect(runGate(repo)).toEqual({ exitCode: 0, stderr: "" });
});
