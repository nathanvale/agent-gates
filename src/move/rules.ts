export type MoveCause =
  | "DOMAIN_MOVE_FILE_DROPPED"
  | "DOMAIN_MOVE_FILE_CHANGED"
  | "DOMAIN_MOVE_REFERENCE_DANGLING"
  | "DOMAIN_MOVE_SOURCE_KEPT"
  | "DOMAIN_MOVE_TEST_DROPPED";

export type MoveKind = "move" | "copy";

export const symlinkMode = "120000";

export type TreeEntry = {
  readonly repoPath: string;
  readonly relativePath: string;
  readonly hash: string;
  readonly mode: string;
};

export type MoveFinding = {
  readonly cause: MoveCause;
  readonly path: string;
  readonly sourceHash?: string;
  readonly destinationHash?: string;
  readonly sourceMode?: string;
  readonly destinationMode?: string;
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

const markdownExtensions = [".md", ".markdown", ".mdown", ".mkd"];
const maxSymlinkHops = 16;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isMarkdownPath(repoPath: string): boolean {
  const lower = repoPath.toLowerCase();
  return markdownExtensions.some((extension) => lower.endsWith(extension));
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
    const mode = headerParts[0];
    const objectType = headerParts[1];
    const hash = headerParts[2];
    const repoPath = record.slice(tabIndex + 1);
    if (
      mode === undefined ||
      objectType !== "blob" ||
      hash === undefined ||
      repoPath.length === 0
    ) {
      continue;
    }
    if (prefix !== "" && !repoPath.startsWith(prefix)) continue;
    const relativePath =
      prefix === "" ? repoPath : repoPath.slice(prefix.length);
    entries.push({ repoPath, relativePath, hash, mode });
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
    } else if (
      destEntry.hash !== sourceEntry.hash ||
      destEntry.mode !== sourceEntry.mode
    ) {
      findings.push({
        cause: "DOMAIN_MOVE_FILE_CHANGED",
        path: sourceEntry.relativePath,
        sourceHash: sourceEntry.hash,
        destinationHash: destEntry.hash,
        sourceMode: sourceEntry.mode,
        destinationMode: destEntry.mode,
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

function decodeMarkdownLinkTarget(rawTarget: string): string {
  const withoutHash = rawTarget.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  if (withoutQuery.length === 0) return "";
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

function initialFolderSegments(repoPath: string): string[] {
  const slashIndex = repoPath.lastIndexOf("/");
  return slashIndex === -1 ? [] : repoPath.slice(0, slashIndex).split("/");
}

function joinSegment(current: readonly string[], segment: string): string {
  return current.length === 0 ? segment : `${current.join("/")}/${segment}`;
}

function pushSegmentsReversed(pending: string[], rawPath: string): void {
  const segments = rawPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined) {
      pending.push(segment);
    }
  }
}

type PathWalkState = {
  readonly current: string[];
  readonly pending: string[];
  readonly dirSet: ReadonlySet<string>;
  readonly symlinks: ReadonlyMap<string, string>;
  hops: number;
};

function applySegment(segment: string, state: PathWalkState): boolean {
  if (segment === "" || segment === ".") return true;
  if (segment === "..") {
    if (state.current.length === 0) return false;
    state.current.pop();
    return true;
  }
  const candidate = joinSegment(state.current, segment);
  const symlinkTarget = state.symlinks.get(candidate);
  if (symlinkTarget === undefined) {
    if (state.pending.length > 0 && !state.dirSet.has(candidate)) {
      return false;
    }
    state.current.push(segment);
    return true;
  }
  state.hops += 1;
  if (
    state.hops > maxSymlinkHops ||
    symlinkTarget.length === 0 ||
    symlinkTarget.startsWith("/")
  ) {
    return false;
  }
  pushSegmentsReversed(state.pending, symlinkTarget);
  return true;
}

function resolvePathThroughSymlinks(
  fromRepoPath: string,
  decodedTarget: string,
  dirSet: ReadonlySet<string>,
  symlinks: ReadonlyMap<string, string>,
): string | null {
  const state: PathWalkState = {
    current: initialFolderSegments(fromRepoPath),
    pending: [],
    dirSet,
    symlinks,
    hops: 0,
  };
  pushSegmentsReversed(state.pending, decodedTarget);

  while (state.pending.length > 0) {
    const segment = state.pending.pop();
    if (segment === undefined) continue;
    if (!applySegment(segment, state)) {
      return null;
    }
  }

  return state.current.join("/");
}

function buildDestinationIndex(destinationEntries: readonly TreeEntry[]): {
  readonly pathSet: ReadonlySet<string>;
  readonly dirSet: ReadonlySet<string>;
} {
  const pathSet = new Set<string>();
  const dirSet = new Set<string>();
  for (const entry of destinationEntries) {
    if (entry.mode !== symlinkMode) {
      pathSet.add(entry.repoPath);
    }
    const parts = entry.repoPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirSet.add(parts.slice(0, index).join("/"));
    }
  }
  return { pathSet, dirSet };
}

function isLinkTargetResolved(
  fromRepoPath: string,
  rawTarget: string,
  index: {
    readonly pathSet: ReadonlySet<string>;
    readonly dirSet: ReadonlySet<string>;
  },
  symlinks: ReadonlyMap<string, string>,
): boolean {
  const decoded = decodeMarkdownLinkTarget(rawTarget);
  if (decoded === "") return true;
  const finalTarget = resolvePathThroughSymlinks(
    fromRepoPath,
    decoded,
    index.dirSet,
    symlinks,
  );
  if (finalTarget === null) return false;
  if (finalTarget === "") return true;
  return index.pathSet.has(finalTarget) || index.dirSet.has(finalTarget);
}

export function findBrokenMarkdownLinks(
  movedMarkdownFiles: readonly {
    readonly repoPath: string;
    readonly text: string;
  }[],
  destinationEntries: readonly TreeEntry[],
  symlinks: ReadonlyMap<string, string> = new Map(),
): readonly MoveFinding[] {
  const index = buildDestinationIndex(destinationEntries);
  const findings: MoveFinding[] = [];
  for (const file of movedMarkdownFiles) {
    for (const rawTarget of extractRelativeMarkdownLinks(file.text)) {
      if (!isLinkTargetResolved(file.repoPath, rawTarget, index, symlinks)) {
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
