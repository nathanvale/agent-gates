import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { testFolder } from "./test-folder.ts";

const cliPath = join(import.meta.dir, "../../src/cli.ts");

const cleanGitEnv: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

function filteredEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const blocked = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !blocked.has(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(cleanGitEnv)) out[key] = value;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) Reflect.deleteProperty(out, key);
    else out[key] = value;
  }
  return out;
}

export function createSandboxTracker() {
  const folders: string[] = [];
  return {
    folder(prefix: string): string {
      const created = testFolder(prefix);
      folders.push(created);
      return created;
    },
    cleanup(): void {
      while (folders.length > 0) {
        const next = folders.pop();
        if (next !== undefined) rmSync(next, { recursive: true, force: true });
      }
    },
  };
}

export function writeTreeFile(
  root: string,
  relativePath: string,
  content: string | Uint8Array,
): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

export function git(root: string, ...args: string[]): string {
  const ran = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: filteredEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (ran.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${String(ran.exitCode)}): ${ran.stderr.toString()}`,
    );
  return ran.stdout.toString().trim();
}

export function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
}

export function commitFiles(
  root: string,
  message: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): void {
  const paths = Object.keys(files);
  for (const [relativePath, content] of Object.entries(files)) {
    writeTreeFile(root, relativePath, content);
  }
  git(root, "add", "--", ...paths);
  git(root, "commit", "-q", "-m", message);
}

const defaultSettingsJson = `${JSON.stringify(
  {
    changeNotes: {
      folder: "change-notes",
      shippedFiles: ["package.json", "src/recipe.ts", "kernel-pin.json"],
      shippedFolders: ["generated-repository", "config"],
      affects: [
        "bootstrap",
        "generated-repository",
        "kernel-pin",
        "lint-rules",
        "test-support",
      ],
    },
    versions: {
      folder: "versions",
      heading: "Template version",
    },
  },
  null,
  2,
)}\n`;

export function envelopeMessage(envelope: unknown): string {
  return String(Reflect.get(Object(envelope), "message"));
}

export function envelopeData(envelope: unknown): Record<string, unknown> {
  const result: unknown = Reflect.get(Object(envelope), "result");
  const data: unknown = Reflect.get(Object(result), "data");
  if (typeof data !== "object" || data === null)
    throw new Error("Expected non-null result.data in JSON envelope.");
  return Object.fromEntries(Object.entries(data));
}

export function makeVersionRepo(
  sandbox: ReturnType<typeof createSandboxTracker>,
  initialNotes: Readonly<Record<string, string>> = {},
): { readonly repo: string; readonly stateDir: string } {
  const base = sandbox.folder("gates-version-");
  const repo = join(base, "repo");
  const stateDir = join(base, "state");
  initGitRepo(repo);
  commitFiles(repo, "init", {
    "agent-gates.json": defaultSettingsJson,
    "change-notes/README.md": "# Change notes\n",
    ...initialNotes,
  });
  return { repo, stateDir };
}

export function makeGitRecorderStub(stubFolder: string): {
  readonly pathEnv: string;
  readonly logFile: string;
} {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git binary not found on PATH.");
  const binDir = join(stubFolder, "bin");
  const logFile = join(stubFolder, "git-calls.log");
  writeTreeFile(
    binDir,
    "git",
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "git"), 0o755);
  return {
    pathEnv: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    logFile,
  };
}

export function makeConfiguredRepo(
  sandbox: ReturnType<typeof createSandboxTracker>,
): {
  readonly repo: string;
  readonly stateDir: string;
} {
  const base = sandbox.folder("gates-notes-");
  const repo = join(base, "repo");
  const stateDir = join(base, "state");
  initGitRepo(repo);
  commitFiles(repo, "init", {
    "agent-gates.json": defaultSettingsJson,
    "docs/guide.md": "# Guide\n",
    "generated-repository/settings/package.json": "{}\n",
    "config/template-rules.mjs": "export default {};\n",
    "src/recipe.ts": "export const r = 1;\n",
    "kernel-pin.json": "{}\n",
    "change-notes/README.md": "# Change notes\n",
  });
  return { repo, stateDir };
}

export function makeCustomRepo(
  sandbox: ReturnType<typeof createSandboxTracker>,
  settings: object,
): { readonly repo: string; readonly stateDir: string } {
  const base = sandbox.folder("gates-custom-");
  const repo = join(base, "repo");
  const stateDir = join(base, "state");
  initGitRepo(repo);
  commitFiles(repo, "init", {
    "agent-gates.json": `${JSON.stringify(settings, null, 2)}\n`,
    "README.md": "# Repo\n",
  });
  return { repo, stateDir };
}

export function runGatesCli(
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly stateDir: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: unknown;
} {
  const ran = Bun.spawnSync([process.execPath, "run", cliPath, ...argv], {
    cwd: options.cwd,
    env: filteredEnv({
      AGENT_GATES_STATE: options.stateDir,
      ...options.env,
    }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const stdout = ran.stdout.toString();
  const stderr = ran.stderr.toString();
  let envelope: unknown = null;
  if (argv.includes("--json") && stdout.trim() !== "") {
    envelope = JSON.parse(stdout);
  }
  return { exitCode: ran.exitCode, stdout, stderr, envelope };
}
