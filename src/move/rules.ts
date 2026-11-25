export type MoveCause =
  | "DOMAIN_MOVE_FILE_DROPPED"
  | "DOMAIN_MOVE_FILE_CHANGED"
  | "DOMAIN_MOVE_REFERENCE_DANGLING"
  | "DOMAIN_MOVE_SOURCE_KEPT"
  | "DOMAIN_MOVE_TEST_DROPPED";

export type MoveKind = "move" | "copy";

export type TreeEntry = {
  readonly repoPath: string;
  readonly relativePath: string;
  readonly hash: string;
};

export type MoveFinding = {
  readonly cause: MoveCause;
  readonly path: string;
  readonly sourceHash?: string;
  readonly destinationHash?: string;
  readonly reference?: string;
  readonly keptAt?: string;
  readonly beforeCount?: number;
  readonly afterCount?: number;
};

export type NotCheckedItem = {
  readonly check: string;
  readonly reason: string;
  readonly enableWith?: string;
};

export type ResolvedTestScript =
  | { readonly kind: "bun-test"; readonly args: readonly string[] }
  | {
      readonly kind: "unsupported";
      readonly script: string;
      readonly reason: string;
    };

export type CommitRangeSpec = {
  readonly first: string;
  readonly second: string | null;
};

const causeOrder: readonly MoveCause[] = [
  "DOMAIN_MOVE_FILE_DROPPED",
  "DOMAIN_MOVE_FILE_CHANGED",
  "DOMAIN_MOVE_REFERENCE_DANGLING",
  "DOMAIN_MOVE_SOURCE_KEPT",
  "DOMAIN_MOVE_TEST_DROPPED",
];

const emptyBlobHashes = new Set([
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseCommitSpec(
  raw: string,
  optionName: string,
):
  | { readonly ok: true; readonly spec: CommitRangeSpec }
  | { readonly ok: false; readonly reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `${optionName} must not be empty.` };
  }
  if (trimmed.includes("...")) {
    return {
      ok: false,
      reason: `${optionName} must use <rev> or <before>..<after>, not triple-dot syntax.`,
    };
  }
  const separatorIndex = trimmed.indexOf("..");
  if (separatorIndex === -1) {
    return { ok: true, spec: { first: trimmed, second: null } };
  }
  const first = trimmed.slice(0, separatorIndex);
  const second = trimmed.slice(separatorIndex + 2);
  if (first.length === 0 || second.length === 0 || second.includes("..")) {
    return {
      ok: false,
      reason: `${optionName} range must have both before and after revisions.`,
    };
  }
  return { ok: true, spec: { first, second } };
}

export function normalizeFolder(
  raw: string | undefined,
  optionName: string,
):
  | { readonly ok: true; readonly folder: string }
  | { readonly ok: false; readonly reason: string } {
  if (raw === undefined) {
    return { ok: true, folder: "" };
  }
  let cleaned = raw.trim().replaceAll("\\", "/");
  while (cleaned.startsWith("./")) {
    cleaned = cleaned.slice(2);
  }
  cleaned = cleaned.replace(/^\/+|\/+$/g, "");
  if (cleaned === "." || cleaned === "") {
    return { ok: true, folder: "" };
  }
  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return {
      ok: false,
      reason: `${optionName} must be a normalized repository-relative folder path.`,
    };
  }
  return { ok: true, folder: segments.join("/") };
}

export function parseTreeOutput(
  stdout: string,
  folder: string,
): readonly TreeEntry[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  const entries: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) continue;
    const headerParts = record.slice(0, tabIndex).split(" ");
    const objectType = headerParts[1];
    const hash = headerParts[2];
    const repoPath = record.slice(tabIndex + 1);
    if (objectType !== "blob" || hash === undefined || repoPath.length === 0) {
      continue;
    }
    if (prefix !== "" && !repoPath.startsWith(prefix)) continue;
    const relativePath =
      prefix === "" ? repoPath : repoPath.slice(prefix.length);
    entries.push({ repoPath, relativePath, hash });
  }
  entries.sort((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath),
  );
  return entries;
}

export function compareTrees(
  sourceEntries: readonly TreeEntry[],
  destinationEntries: readonly TreeEntry[],
): readonly MoveFinding[] {
  const destinationByRelative = new Map<string, TreeEntry>();
  for (const entry of destinationEntries) {
    destinationByRelative.set(entry.relativePath, entry);
  }
  const findings: MoveFinding[] = [];
  for (const sourceEntry of sourceEntries) {
    const destEntry = destinationByRelative.get(sourceEntry.relativePath);
    if (destEntry === undefined) {
      findings.push({
        cause: "DOMAIN_MOVE_FILE_DROPPED",
        path: sourceEntry.relativePath,
        sourceHash: sourceEntry.hash,
      });
    } else if (destEntry.hash !== sourceEntry.hash) {
      findings.push({
        cause: "DOMAIN_MOVE_FILE_CHANGED",
        path: sourceEntry.relativePath,
        sourceHash: sourceEntry.hash,
        destinationHash: destEntry.hash,
      });
    }
  }
  return findings;
}

function isRelativeFileLink(target: string): boolean {
  if (target.length === 0) return false;
  if (target.startsWith("#") || target.startsWith("/")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return false;
  return true;
}

function extractRelativeMarkdownLinks(markdown: string): readonly string[] {
  const links: string[] = [];
  const collect = (rawTarget: string | undefined) => {
    if (rawTarget === undefined) return;
    const trimmed = rawTarget.trim();
    if (isRelativeFileLink(trimmed)) {
      links.push(trimmed);
    }
  };
  Bun.markdown.render(markdown, {
    link(children, meta) {
      collect(meta.href);
      return children;
    },
    image(children, meta) {
      collect(meta.src);
      return children;
    },
    code: () => "",
    codespan: () => "",
  });
  return links;
}

function normalizePosixSegments(segments: readonly string[]): string | null {
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join("/");
}

function resolveMarkdownLink(
  fromRepoPath: string,
  rawTarget: string,
): string | null {
  const withoutHash = rawTarget.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  if (withoutQuery.length === 0) return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const slashIndex = fromRepoPath.lastIndexOf("/");
  const baseDir = slashIndex === -1 ? "" : fromRepoPath.slice(0, slashIndex);
  const combined =
    baseDir === ""
      ? decoded.split("/")
      : [...baseDir.split("/"), ...decoded.split("/")];
  return normalizePosixSegments(combined);
}

export function findBrokenMarkdownLinks(
  movedMarkdownFiles: readonly {
    readonly repoPath: string;
    readonly text: string;
  }[],
  destinationPaths: readonly string[],
): readonly MoveFinding[] {
  const pathSet = new Set(destinationPaths);
  const dirSet = new Set<string>();
  for (const filePath of destinationPaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirSet.add(parts.slice(0, index).join("/"));
    }
  }
  const findings: MoveFinding[] = [];
  for (const file of movedMarkdownFiles) {
    const links = extractRelativeMarkdownLinks(file.text);
    for (const rawTarget of links) {
      const resolved = resolveMarkdownLink(file.repoPath, rawTarget);
      if (resolved === "") continue;
      if (
        resolved === null ||
        (!pathSet.has(resolved) && !dirSet.has(resolved))
      ) {
        findings.push({
          cause: "DOMAIN_MOVE_REFERENCE_DANGLING",
          path: file.repoPath,
          reference: rawTarget,
        });
      }
    }
  }
  return findings;
}

export function findSourceKeptBlobs(
  sourceEntries: readonly TreeEntry[],
  sourceAfterEntries: readonly TreeEntry[],
): readonly MoveFinding[] {
  const byHash = new Map<string, string[]>();
  for (const entry of sourceAfterEntries) {
    const list = byHash.get(entry.hash);
    if (list === undefined) {
      byHash.set(entry.hash, [entry.repoPath]);
    } else {
      list.push(entry.repoPath);
    }
  }
  const findings: MoveFinding[] = [];
  for (const sourceEntry of sourceEntries) {
    if (emptyBlobHashes.has(sourceEntry.hash)) continue;
    const keptPaths = byHash.get(sourceEntry.hash);
    if (keptPaths === undefined) continue;
    for (const keptAt of [...keptPaths].sort(compareCodeUnits)) {
      findings.push({
        cause: "DOMAIN_MOVE_SOURCE_KEPT",
        path: sourceEntry.relativePath,
        sourceHash: sourceEntry.hash,
        keptAt,
      });
    }
  }
  return findings;
}

function splitCommandTokens(command: string): readonly string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) tokens.push(value);
  }
  return tokens;
}

function readPackageScripts(
  packageJsonText: string | null,
): ReadonlyMap<string, string> | null {
  if (packageJsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const scripts: unknown = Reflect.get(parsed, "scripts");
  if (typeof scripts !== "object" || scripts === null) return null;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") {
      map.set(key, value.trim());
    }
  }
  return map;
}

function filterBunTestTokens(tokens: readonly string[]): readonly string[] {
  const args: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "&&" || token === "||" || token === ";") break;
    if (token === "-t" || token === "--test-name-pattern") {
      skipNext = true;
      continue;
    }
    if (!token.startsWith("--test-name-pattern=")) args.push(token);
  }
  return args;
}

function stripLeadingDoubleDash(tokens: readonly string[]): readonly string[] {
  return tokens[0] === "--" ? tokens.slice(1) : tokens;
}

function extractAliasTarget(
  tokens: readonly string[],
  scripts: ReadonlyMap<string, string>,
): { readonly name: string; readonly trailing: readonly string[] } | null {
  const first = tokens[0];
  const second = tokens[1];
  const third = tokens[2];
  if ((first === "bun" || first === "npm") && second === "run") {
    if (third === undefined) return null;
    return { name: third, trailing: stripLeadingDoubleDash(tokens.slice(3)) };
  }
  if (first === "bun" && second !== undefined && scripts.has(second)) {
    return { name: second, trailing: stripLeadingDoubleDash(tokens.slice(2)) };
  }
  return null;
}

export function resolveBunTestScript(
  packageJsonText: string | null,
): ResolvedTestScript {
  const scripts = readPackageScripts(packageJsonText);
  const initial = scripts?.get("test");
  if (scripts === null || initial === undefined || initial.length === 0) {
    return { kind: "bun-test", args: [] };
  }
  const visited = new Set<string>(["test"]);
  let current = initial;
  const trailingChunks: (readonly string[])[] = [];
  for (;;) {
    const tokens = splitCommandTokens(current);
    if (tokens[0] === "bun" && tokens[1] === "test") {
      return {
        kind: "bun-test",
        args: filterBunTestTokens([
          ...tokens.slice(2),
          ...trailingChunks.reverse().flat(),
        ]),
      };
    }
    const alias = extractAliasTarget(tokens, scripts);
    if (alias === null) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" does not resolve to bun test.`,
      };
    }
    if (visited.has(alias.name)) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" forms an alias loop on "${alias.name}".`,
      };
    }
    const next = scripts.get(alias.name);
    if (next === undefined || next.length === 0) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" references missing script "${alias.name}".`,
      };
    }
    visited.add(alias.name);
    trailingChunks.push(alias.trailing);
    current = next;
  }
}

export function parseBunTestDiscovery(
  output: string,
):
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string } {
  const searched =
    /Searched\s+(\d+)\s+files?\s+\(skipping\s+\d+\s+tests?\)/.exec(output);
  if (searched?.[1] !== undefined) {
    return { ok: true, count: Number(searched[1]) };
  }
  if (/error:\s+0\s+test\s+files\s+matching/.test(output)) {
    return { ok: true, count: 0 };
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary = lines.slice(0, 6).join(" | ");
  return {
    ok: false,
    reason:
      summary.length > 0
        ? `Test runner failed to load: ${summary}`
        : "Test runner failed to load with no output.",
  };
}

export function orderFindings(
  findings: readonly MoveFinding[],
): readonly MoveFinding[] {
  return [...findings].sort((left, right) => {
    const causeDiff =
      causeOrder.indexOf(left.cause) - causeOrder.indexOf(right.cause);
    if (causeDiff !== 0) return causeDiff;
    return compareCodeUnits(left.path, right.path);
  });
}
