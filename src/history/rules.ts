export type CompiledPattern = {
  readonly lineNumber: number;
  readonly regex: RegExp;
  readonly globalRegex: RegExp;
};

export type CommitMeta = {
  readonly fullHash: string;
  readonly shortHash: string;
  readonly message: string;
};

export type CommitAddedPath = {
  readonly commit: string;
  readonly path: string;
};

export type PullRequestPartKind =
  | "title"
  | "body"
  | "issue-comment"
  | "review-comment"
  | "review-body";

export type PullRequestTextPart = {
  readonly kind: PullRequestPartKind;
  readonly id: string;
  readonly text: string;
};

export type HistoryFinding =
  | {
      readonly kind: "commit-message";
      readonly commit: string;
      readonly patternLine: number;
    }
  | {
      readonly kind: "commit-path";
      readonly commit: string;
      readonly path: string;
      readonly patternLine: number;
    }
  | {
      readonly kind: "commit-line";
      readonly commit: string;
      readonly path: string;
      readonly line: number;
      readonly patternLine: number;
    }
  | {
      readonly kind: "pull-request";
      readonly pullRequest: number;
      readonly part: PullRequestPartKind;
      readonly id: string;
      readonly patternLine: number;
    };

export const commitMarkerPrefix = "__AGENT_GATES_COMMIT__";

export function parseRangeSpec(
  raw: string | undefined,
):
  | { readonly ok: true; readonly base: string; readonly head: string }
  | { readonly ok: false; readonly reason: string } {
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      reason:
        "Missing required --range <base>..<head>. The working tree is never scanned.",
    };
  }
  if (raw.includes("...")) {
    return {
      ok: false,
      reason:
        "Range must use two-dot <base>..<head> form, not three-dot form. The working tree is never scanned.",
    };
  }
  const parts = raw.split("..");
  if (parts.length !== 2) {
    return {
      ok: false,
      reason:
        "Range must be in <base>..<head> form. The working tree is never scanned.",
    };
  }
  const base = parts[0]?.trim() ?? "";
  const head = parts[1]?.trim() ?? "";
  if (base === "" || head === "") {
    return {
      ok: false,
      reason:
        "Range must name both <base> and <head> in <base>..<head> form. The working tree is never scanned.",
    };
  }
  return { ok: true, base, head };
}

export function parsePatternFile(
  content: string,
):
  | { readonly ok: true; readonly patterns: readonly CompiledPattern[] }
  | { readonly ok: false; readonly reason: string } {
  const lines = content.split(/\r?\n/);
  const patterns: CompiledPattern[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const lineNumber = index + 1;
    try {
      const regex = new RegExp(rawLine, "i");
      const globalRegex = new RegExp(rawLine, "gi");
      patterns.push({ lineNumber, regex, globalRegex });
    } catch {
      return {
        ok: false,
        reason: `Invalid regular expression on line ${String(lineNumber)} of the pattern file.`,
      };
    }
  }

  if (patterns.length === 0) {
    return {
      ok: false,
      reason: "Pattern file contains no pattern lines.",
    };
  }

  return { ok: true, patterns };
}

export function parseOriginSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "");
  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    /^ssh:\/\/[^@]+@[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    /^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const slug = match?.[1];
    if (slug !== undefined && slug.includes("/")) {
      return slug;
    }
  }
  return null;
}

export type PatternMatchSet = {
  readonly patternLines: readonly number[];
  readonly matchedSubstrings: readonly string[];
};

export type ScanFindingsResult = {
  readonly findings: readonly HistoryFinding[];
  readonly matchedSubstrings: readonly string[];
};

export type ParsedAddedPathsResult =
  | { readonly ok: true; readonly paths: readonly CommitAddedPath[] }
  | { readonly ok: false; readonly reason: string };

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(
  text: string,
  patterns: readonly CompiledPattern[],
  matchedSubstrings: readonly string[] = [],
): string {
  let redacted = text;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern.globalRegex, "[redacted]");
  }
  const uniqueSubstrings = [...new Set(matchedSubstrings)]
    .filter((entry) => entry !== "")
    .sort((left, right) => right.length - left.length);
  for (const matched of uniqueSubstrings) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(matched), "gi"),
      "[redacted]",
    );
  }
  return redacted;
}

function replaceCrossSegmentMatches(
  filePath: string,
  patterns: readonly CompiledPattern[],
): string {
  let current = filePath;
  for (const pattern of patterns) {
    let spansSegment = false;
    for (const match of current.matchAll(pattern.globalRegex)) {
      if (match[0].includes("/")) {
        spansSegment = true;
        break;
      }
    }
    if (spansSegment) {
      current = current.replace(pattern.globalRegex, "[redacted]");
    }
  }
  return current;
}

export function redactPath(
  filePath: string,
  patterns: readonly CompiledPattern[],
): string {
  const afterCrossSegment = replaceCrossSegmentMatches(filePath, patterns);
  const redactedSegments = afterCrossSegment
    .split("/")
    .map((segment) =>
      patterns.some((pattern) => pattern.regex.test(segment))
        ? "[redacted]"
        : segment,
    )
    .join("/");
  let finalPath = redactedSegments;
  for (const pattern of patterns) {
    if (pattern.regex.test(finalPath)) {
      finalPath = finalPath.replace(pattern.globalRegex, "[redacted]");
    }
  }
  return finalPath;
}

function consumeNameStatusEntry(
  tokens: readonly string[],
  index: number,
  status: string,
  commit: string,
  entries: CommitAddedPath[],
):
  | { readonly ok: true; readonly nextIndex: number }
  | { readonly ok: false; readonly reason: string } {
  if (/^[RC]\d*$/.test(status)) {
    const destination = tokens[index + 2];
    if (destination !== undefined && destination !== "") {
      entries.push({ commit, path: destination });
    }
    return { ok: true, nextIndex: index + 3 };
  }
  if (/^[AMT]$/.test(status) || /^[ACRMT]{2,}$/.test(status)) {
    const filePath = tokens[index + 1];
    if (filePath !== undefined && filePath !== "") {
      entries.push({ commit, path: filePath });
    }
    return { ok: true, nextIndex: index + 2 };
  }
  if (/^D+$/.test(status)) {
    return { ok: true, nextIndex: index + 2 };
  }
  return {
    ok: false,
    reason: `Unrecognised git --name-status code "${status}" in commit ${commit}. Run \`git log --name-status <base>..<head>\` to inspect the history.`,
  };
}

export function parseAddedPaths(nulOutput: string): ParsedAddedPathsResult {
  if (nulOutput === "") {
    return { ok: true, paths: [] };
  }
  const tokens = nulOutput.split("\0");
  const entries: CommitAddedPath[] = [];
  let currentCommit: string | null = null;
  let index = 0;

  while (index < tokens.length) {
    const raw = tokens[index] ?? "";
    const token = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (token === "") {
      index += 1;
    } else if (token.startsWith(commitMarkerPrefix)) {
      currentCommit = token.slice(commitMarkerPrefix.length).trim() || null;
      index += 1;
    } else if (currentCommit === null) {
      index += 1;
    } else {
      const consumed = consumeNameStatusEntry(
        tokens,
        index,
        token,
        currentCommit,
        entries,
      );
      if (!consumed.ok) {
        return consumed;
      }
      index = consumed.nextIndex;
    }
  }

  return { ok: true, paths: entries };
}

export function parseCommitMessages(nulOutput: string): readonly CommitMeta[] {
  if (nulOutput === "") {
    return [];
  }
  const fields = nulOutput.split("\0");
  const commits: CommitMeta[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const fullHash = (fields[index] ?? "").trim();
    const shortHash = (fields[index + 1] ?? "").trim();
    const message = fields[index + 2] ?? "";
    if (fullHash !== "" && shortHash !== "") {
      commits.push({ fullHash, shortHash, message });
    }
  }
  return commits;
}

export function findPatternMatches(
  text: string,
  patterns: readonly CompiledPattern[],
): PatternMatchSet {
  const patternLines: number[] = [];
  const matchedSubstrings: string[] = [];
  for (const pattern of patterns) {
    let matched = false;
    for (const match of text.matchAll(pattern.globalRegex)) {
      matched = true;
      if (match[0] !== "") {
        matchedSubstrings.push(match[0]);
      }
    }
    if (matched) {
      patternLines.push(pattern.lineNumber);
    }
  }
  return { patternLines, matchedSubstrings };
}

export function scanCommitMessages(
  commits: readonly CommitMeta[],
  patterns: readonly CompiledPattern[],
): ScanFindingsResult {
  const findings: HistoryFinding[] = [];
  const matchedSubstrings: string[] = [];
  for (const commit of commits) {
    const matches = findPatternMatches(commit.message, patterns);
    matchedSubstrings.push(...matches.matchedSubstrings);
    for (const patternLine of matches.patternLines) {
      findings.push({
        kind: "commit-message",
        commit: commit.shortHash,
        patternLine,
      });
    }
  }
  return { findings, matchedSubstrings };
}

function matchPathAndSegments(
  filePath: string,
  patterns: readonly CompiledPattern[],
): PatternMatchSet {
  const lineNumbers = new Set<number>();
  const matchedSubstrings: string[] = [];
  for (const candidate of [filePath, ...filePath.split("/")]) {
    if (candidate === "") {
      continue;
    }
    const matches = findPatternMatches(candidate, patterns);
    for (const line of matches.patternLines) {
      lineNumbers.add(line);
    }
    matchedSubstrings.push(...matches.matchedSubstrings);
  }
  return {
    patternLines: [...lineNumbers].sort((left, right) => left - right),
    matchedSubstrings,
  };
}

export function scanCommitPaths(
  entries: readonly CommitAddedPath[],
  patterns: readonly CompiledPattern[],
): ScanFindingsResult {
  const findings: HistoryFinding[] = [];
  const matchedSubstrings: string[] = [];
  for (const entry of entries) {
    const matches = matchPathAndSegments(entry.path, patterns);
    matchedSubstrings.push(...matches.matchedSubstrings);
    const safePath = redactPath(entry.path, patterns);
    for (const patternLine of matches.patternLines) {
      findings.push({
        kind: "commit-path",
        commit: entry.commit,
        path: safePath,
        patternLine,
      });
    }
  }
  return { findings, matchedSubstrings };
}

export function scanPullRequestParts(
  pullRequest: number,
  parts: readonly PullRequestTextPart[],
  patterns: readonly CompiledPattern[],
): ScanFindingsResult {
  const findings: HistoryFinding[] = [];
  const matchedSubstrings: string[] = [];
  for (const part of parts) {
    const matches = findPatternMatches(part.text, patterns);
    matchedSubstrings.push(...matches.matchedSubstrings);
    for (const patternLine of matches.patternLines) {
      findings.push({
        kind: "pull-request",
        pullRequest,
        part: part.kind,
        id: part.id,
        patternLine,
      });
    }
  }
  return { findings, matchedSubstrings };
}

function formatFinding(finding: HistoryFinding): string {
  switch (finding.kind) {
    case "commit-message":
      return `commit ${finding.commit} message (pattern line ${String(finding.patternLine)})`;
    case "commit-path":
      return `commit ${finding.commit} path ${finding.path} (pattern line ${String(finding.patternLine)})`;
    case "commit-line":
      return `commit ${finding.commit} ${finding.path}:${String(finding.line)} (pattern line ${String(finding.patternLine)})`;
    case "pull-request":
      return `pull request ${String(finding.pullRequest)} ${finding.part} ${finding.id} (pattern line ${String(finding.patternLine)})`;
  }
}

export function formatRefusalMessage(
  findings: readonly HistoryFinding[],
): string {
  const list = findings.map(formatFinding).join("; ");
  return `History scan found ${String(findings.length)} private match${findings.length === 1 ? "" : "es"}: ${list}`;
}
