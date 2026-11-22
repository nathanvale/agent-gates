import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isValidSurfaceWord } from "../change-note/rules.ts";

const GATE_SETTINGS_FILE = "agent-gates.json";
const DEFAULT_VERSION_HEADING = "Repository version";

const topLevelKeys = new Set<string>(["changeNotes", "versions"]);
const changeNotesKeys = new Set<string>([
  "folder",
  "shippedFiles",
  "shippedFolders",
  "affects",
]);
const versionsKeys = new Set<string>(["folder", "heading"]);

type VersionSettings = {
  readonly folder: string;
  readonly heading: string;
};

export type GateSettings = {
  readonly changeNotes: {
    readonly folder: string;
    readonly shippedFiles: readonly string[];
    readonly shippedFolders: readonly string[];
    readonly affects: ReadonlySet<string>;
  };
  readonly versions: VersionSettings | undefined;
};

type RepositoryResolution =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly problem: string };

type SettingsLoadResult =
  | { readonly ok: true; readonly settings: GateSettings }
  | { readonly ok: false; readonly kind: "missing"; readonly problem: string }
  | { readonly ok: false; readonly kind: "invalid"; readonly problem: string };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function defaultStateFolder(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = environment.AGENT_GATES_STATE?.trim();
  if (configured !== undefined && configured !== "") return resolve(configured);
  return join(homedir(), ".local", "state", "agent-gates");
}

function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), "code");
}

function discoverRepositoryRoot(
  explicitFolder: string | undefined,
  cwd: string,
): RepositoryResolution {
  if (explicitFolder !== undefined) {
    const candidate = resolve(cwd, explicitFolder);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch {
      return {
        ok: false,
        problem: `Repository folder "${explicitFolder}" does not exist. Repair: pass an existing git repository directory to --repository.`,
      };
    }
    if (!stat.isDirectory())
      return {
        ok: false,
        problem: `Repository path "${explicitFolder}" is not a directory. Repair: pass a git repository directory to --repository.`,
      };
    const real = realpathSync.native(candidate);
    if (!existsSync(join(real, ".git")))
      return {
        ok: false,
        problem: `Directory "${explicitFolder}" is not a git repository root. Repair: initialize git there or pass the git repository root to --repository.`,
      };
    return { ok: true, root: real };
  }
  let current = realpathSync.native(resolve(cwd));
  for (;;) {
    if (existsSync(join(current, ".git"))) return { ok: true, root: current };
    const parent = dirname(current);
    if (parent === current)
      return {
        ok: false,
        problem: `No git repository root found above ${cwd}. Repair: run inside a git repository or pass --repository <folder>.`,
      };
    current = parent;
  }
}

function plainRelativePathProblem(value: string): string | undefined {
  if (value === "") return "must not be empty";
  if (value.startsWith("/")) return "must be a relative path";
  if (value.includes("\\")) return "must use forward slashes";
  if (value.includes("\0")) return "must not contain NUL bytes";
  if (
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    return 'must not contain empty, "." or ".." segments';
  return undefined;
}

function readObjectFields(
  raw: unknown,
  section: string,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
):
  | { readonly ok: true; readonly fields: Map<string, unknown> }
  | { readonly ok: false; readonly problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: ${section} must be a JSON object. Repair: write an object with ${[...allowedKeys].join(", ")}.`,
    };
  const fields = new Map<string, unknown>(Object.entries(raw));
  const unknown = [...fields.keys()].find((key) => !allowedKeys.has(key));
  if (unknown !== undefined)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: unknown field "${unknown}" in ${section}. Repair: keep only ${[...allowedKeys].join(", ")}.`,
    };
  const missing = requiredKeys.find((key) => !fields.has(key));
  if (missing !== undefined)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: missing required field "${missing}" in ${section}. Repair: set ${requiredKeys.join(", ")}.`,
    };
  return { ok: true, fields };
}

function parseFolder(
  raw: unknown,
  field: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string } {
  if (typeof raw !== "string")
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: ${field} must be a relative folder path string. Repair: set ${field} to a plain relative folder name.`,
    };
  const problem = plainRelativePathProblem(raw);
  if (problem !== undefined)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: ${field} ("${raw}") ${problem}. Repair: set ${field} to a plain relative folder path.`,
    };
  return { ok: true, value: raw };
}

function parseStringArray(
  raw: unknown,
  field: string,
  kindLabel: string,
  repair: string,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly problem: string } {
  if (raw === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(raw))
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: ${field} must be an array of ${kindLabel}. Repair: ${repair}`,
    };
  const items: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string")
      return {
        ok: false,
        problem: `${GATE_SETTINGS_FILE}: ${field} entries must be strings. Repair: ${repair}`,
      };
    items.push(item);
  }
  return { ok: true, value: items };
}

function parseShippedFiles(
  raw: unknown,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly problem: string } {
  const strings = parseStringArray(
    raw,
    "changeNotes.shippedFiles",
    "exact relative file paths",
    "list exact relative file paths.",
  );
  if (!strings.ok) return strings;
  for (const item of strings.value) {
    if (item.endsWith("/"))
      return {
        ok: false,
        problem: `${GATE_SETTINGS_FILE}: changeNotes.shippedFiles entry "${item}" ends with "/". Repair: move whole folders to changeNotes.shippedFolders.`,
      };
    const problem = plainRelativePathProblem(item);
    if (problem !== undefined)
      return {
        ok: false,
        problem: `${GATE_SETTINGS_FILE}: changeNotes.shippedFiles entry "${item}" ${problem}. Repair: use plain relative file paths.`,
      };
  }
  return { ok: true, value: Object.freeze([...strings.value]) };
}

function parseShippedFolders(
  raw: unknown,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly problem: string } {
  const strings = parseStringArray(
    raw,
    "changeNotes.shippedFolders",
    "relative folder paths",
    "list whole folder paths.",
  );
  if (!strings.ok) return strings;
  const items: string[] = [];
  for (const item of strings.value) {
    const normalized = item.endsWith("/") ? item.slice(0, -1) : item;
    const problem = plainRelativePathProblem(normalized);
    if (problem !== undefined)
      return {
        ok: false,
        problem: `${GATE_SETTINGS_FILE}: changeNotes.shippedFolders entry "${item}" ${problem}. Repair: use plain relative folder paths.`,
      };
    items.push(normalized);
  }
  return { ok: true, value: Object.freeze(items) };
}

function parseAffectsWords(
  raw: unknown,
):
  | { readonly ok: true; readonly value: ReadonlySet<string> }
  | { readonly ok: false; readonly problem: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: changeNotes.affects must be a non-empty array of lowercase words. Repair: declare this repository's affects words.`,
    };
  const words = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !isValidSurfaceWord(item))
      return {
        ok: false,
        problem: `${GATE_SETTINGS_FILE}: changeNotes.affects entry "${String(item)}" must be lower-case letters and digits joined by "-" or "/". Repair: fix the affects word.`,
      };
    words.add(item);
  }
  return { ok: true, value: words };
}

function parseHeading(
  raw: unknown,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string } {
  if (raw === undefined) return { ok: true, value: DEFAULT_VERSION_HEADING };
  if (typeof raw !== "string" || raw.trim() === "" || /[\r\n]/.test(raw))
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: versions.heading must be a single non-empty line. Repair: set versions.heading to a single-line heading label.`,
    };
  return { ok: true, value: raw.trim() };
}

function readSettingsBytes(
  filePath: string,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: "missing"; readonly problem: string }
  | { readonly ok: false; readonly kind: "invalid"; readonly problem: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return {
        ok: false,
        kind: "missing",
        problem: `Missing ${GATE_SETTINGS_FILE} at repository root. Repair: add ${GATE_SETTINGS_FILE} declaring changeNotes settings.`,
      };
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "invalid",
      problem: `Could not inspect ${GATE_SETTINGS_FILE} (${reason}). Repair: ensure ${GATE_SETTINGS_FILE} is a readable plain file.`,
    };
  }
  if (!stat.isFile())
    return {
      ok: false,
      kind: "invalid",
      problem: `${GATE_SETTINGS_FILE} must be a plain file, not a symlink or directory. Repair: replace ${GATE_SETTINGS_FILE} with a regular UTF-8 JSON file.`,
    };
  try {
    return { ok: true, text: strictUtf8.decode(readFileSync(filePath)) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "invalid",
      problem: `${GATE_SETTINGS_FILE} could not be read as UTF-8 (${reason}). Repair: save ${GATE_SETTINGS_FILE} as valid UTF-8 JSON.`,
    };
  }
}

function parseChangeNotesSection(
  raw: unknown,
):
  | { readonly ok: true; readonly value: GateSettings["changeNotes"] }
  | { readonly ok: false; readonly problem: string } {
  const section = readObjectFields(raw, "changeNotes", changeNotesKeys, [
    "folder",
    "affects",
  ]);
  if (!section.ok) return section;
  const folder = parseFolder(
    section.fields.get("folder"),
    "changeNotes.folder",
  );
  if (!folder.ok) return folder;
  const shippedFiles = parseShippedFiles(section.fields.get("shippedFiles"));
  if (!shippedFiles.ok) return shippedFiles;
  const shippedFolders = parseShippedFolders(
    section.fields.get("shippedFolders"),
  );
  if (!shippedFolders.ok) return shippedFolders;
  if (shippedFiles.value.length === 0 && shippedFolders.value.length === 0)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: declare at least one entry in changeNotes.shippedFiles or changeNotes.shippedFolders. Repair: list the repository's shipped files or folders.`,
    };
  const affects = parseAffectsWords(section.fields.get("affects"));
  if (!affects.ok) return affects;
  return {
    ok: true,
    value: Object.freeze({
      folder: folder.value,
      shippedFiles: shippedFiles.value,
      shippedFolders: shippedFolders.value,
      affects: affects.value,
    }),
  };
}

function parseVersionsSection(
  raw: unknown,
  notesFolder: string,
):
  | { readonly ok: true; readonly value: VersionSettings }
  | { readonly ok: false; readonly problem: string } {
  const section = readObjectFields(raw, "versions", versionsKeys, ["folder"]);
  if (!section.ok) return section;
  const folder = parseFolder(section.fields.get("folder"), "versions.folder");
  if (!folder.ok) return folder;
  if (notesFolder === folder.value)
    return {
      ok: false,
      problem: `${GATE_SETTINGS_FILE}: changeNotes.folder and versions.folder must be distinct folders. Repair: choose separate folder names.`,
    };
  const heading = parseHeading(section.fields.get("heading"));
  if (!heading.ok) return heading;
  return {
    ok: true,
    value: Object.freeze({ folder: folder.value, heading: heading.value }),
  };
}

function loadGateSettings(repositoryRoot: string): SettingsLoadResult {
  const raw = readSettingsBytes(join(repositoryRoot, GATE_SETTINGS_FILE));
  if (!raw.ok) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "invalid",
      problem: `${GATE_SETTINGS_FILE}: invalid JSON (${reason}). Repair: fix the JSON syntax in ${GATE_SETTINGS_FILE}.`,
    };
  }
  const top = readObjectFields(parsed, "root", topLevelKeys, ["changeNotes"]);
  if (!top.ok) return { ok: false, kind: "invalid", problem: top.problem };

  const changeNotes = parseChangeNotesSection(top.fields.get("changeNotes"));
  if (!changeNotes.ok)
    return { ok: false, kind: "invalid", problem: changeNotes.problem };

  let versions: VersionSettings | undefined;
  if (top.fields.has("versions")) {
    const parsedVersions = parseVersionsSection(
      top.fields.get("versions"),
      changeNotes.value.folder,
    );
    if (!parsedVersions.ok)
      return { ok: false, kind: "invalid", problem: parsedVersions.problem };
    versions = parsedVersions.value;
  }

  return {
    ok: true,
    settings: Object.freeze({
      changeNotes: changeNotes.value,
      versions,
    }),
  };
}

export function resolveRepositoryAndSettings(
  explicitFolder: string | undefined,
  cwd: string,
):
  | {
      readonly ok: true;
      readonly root: string;
      readonly settings: GateSettings;
    }
  | {
      readonly ok: false;
      readonly causeCode:
        | "DOMAIN_GATES_REPOSITORY_NOT_FOUND"
        | "DOMAIN_GATES_SETTINGS_MISSING"
        | "DOMAIN_GATES_SETTINGS_INVALID";
      readonly message: string;
    } {
  const repoResult = discoverRepositoryRoot(explicitFolder, cwd);
  if (!repoResult.ok)
    return {
      ok: false,
      causeCode: "DOMAIN_GATES_REPOSITORY_NOT_FOUND",
      message: repoResult.problem,
    };
  const settingsResult = loadGateSettings(repoResult.root);
  if (!settingsResult.ok)
    return {
      ok: false,
      causeCode:
        settingsResult.kind === "missing"
          ? "DOMAIN_GATES_SETTINGS_MISSING"
          : "DOMAIN_GATES_SETTINGS_INVALID",
      message: settingsResult.problem,
    };
  return { ok: true, root: repoResult.root, settings: settingsResult.settings };
}

export function isShippedPath(settings: GateSettings, path: string): boolean {
  return (
    settings.changeNotes.shippedFiles.includes(path) ||
    settings.changeNotes.shippedFolders.some((folder) =>
      path.startsWith(`${folder}/`),
    )
  );
}
