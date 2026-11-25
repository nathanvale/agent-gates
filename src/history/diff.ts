import {
  commitMarkerPrefix,
  matchingPatternLines,
  redactPath,
} from "./rules.ts";
import type { CompiledPattern, HistoryFinding } from "./rules.ts";

type DiffState = {
  commit: string | null;
  filePath: string | null;
  isNewFile: boolean;
  pathScanned: boolean;
  isCombined: boolean;
  parentCount: number;
  inHunk: boolean;
  newLine: number;
};

function parseDiffGitPath(line: string): string | null {
  const prefix = "diff --git a/";
  if (!line.startsWith(prefix)) {
    return null;
  }
  const rest = line.slice(prefix.length);
  if (rest.length >= 3 && (rest.length - 3) % 2 === 0) {
    const half = (rest.length - 3) / 2;
    if (
      rest.slice(half, half + 3) === " b/" &&
      rest.slice(0, half) === rest.slice(half + 3)
    ) {
      return rest.slice(0, half);
    }
  }
  const marker = rest.lastIndexOf(" b/");
  if (marker === -1) {
    return null;
  }
  return rest.slice(marker + 3);
}

function recordPathFindings(
  commit: string,
  filePath: string,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): void {
  for (const patternLine of matchingPatternLines(filePath, patterns)) {
    findings.push({
      kind: "commit-path",
      commit,
      path: redactPath(filePath, patterns),
      patternLine,
    });
  }
}

function flushPendingAddedPath(
  state: DiffState,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): void {
  if (
    state.commit === null ||
    state.filePath === null ||
    !state.isNewFile ||
    state.pathScanned
  ) {
    return;
  }
  state.pathScanned = true;
  recordPathFindings(state.commit, state.filePath, patterns, findings);
}

function recordLineFindings(
  commit: string,
  filePath: string,
  lineNumber: number,
  content: string,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): void {
  for (const patternLine of matchingPatternLines(content, patterns)) {
    findings.push({
      kind: "commit-line",
      commit,
      path: redactPath(filePath, patterns),
      line: lineNumber,
      patternLine,
    });
  }
}

function parseHunkStart(
  line: string,
): { readonly parentCount: number; readonly newLine: number } | null {
  if (line.startsWith("@@ ")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match?.[1] !== undefined) {
      return { parentCount: 1, newLine: Number(match[1]) };
    }
    return null;
  }
  if (line.startsWith("@@@")) {
    const match = /^(@{3,}) .* \+(\d+)(?:,\d+)? \1/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        parentCount: match[1].length - 1,
        newLine: Number(match[2]),
      };
    }
  }
  return null;
}

function isCombinedDiffPrefix(prefix: string): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    const ch = prefix[index];
    if (ch !== "+" && ch !== "-" && ch !== " ") {
      return false;
    }
  }
  return prefix.length > 0;
}

function processHunkLine(
  line: string,
  state: DiffState,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): void {
  if (
    line.startsWith("\\") ||
    state.commit === null ||
    state.filePath === null
  ) {
    return;
  }
  if (!state.isCombined) {
    const tag = line[0];
    if (tag === "+") {
      recordLineFindings(
        state.commit,
        state.filePath,
        state.newLine,
        line.slice(1),
        patterns,
        findings,
      );
      state.newLine += 1;
    } else if (tag === " ") {
      state.newLine += 1;
    }
    return;
  }
  const prefix = line.slice(0, state.parentCount);
  if (!isCombinedDiffPrefix(prefix) || prefix.includes("-")) {
    return;
  }
  if (prefix.includes("+")) {
    recordLineFindings(
      state.commit,
      state.filePath,
      state.newLine,
      line.slice(state.parentCount),
      patterns,
      findings,
    );
  }
  state.newLine += 1;
}

function resetFileState(
  state: DiffState,
  filePath: string | null,
  isCombined: boolean,
): void {
  state.filePath = filePath;
  state.isNewFile = false;
  state.pathScanned = false;
  state.isCombined = isCombined;
  state.parentCount = isCombined ? 2 : 1;
  state.inHunk = false;
  state.newLine = 0;
}

function handleDiffHeaderLine(
  line: string,
  state: DiffState,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): boolean {
  if (line.startsWith(commitMarkerPrefix)) {
    flushPendingAddedPath(state, patterns, findings);
    const payload = line.slice(commitMarkerPrefix.length);
    const parts = payload.split("\0");
    state.commit = (parts[1] ?? "").trim() || null;
    resetFileState(state, null, false);
    return true;
  }
  if (line.startsWith("diff --git ")) {
    flushPendingAddedPath(state, patterns, findings);
    resetFileState(state, parseDiffGitPath(line), false);
    return true;
  }
  if (line.startsWith("diff --cc ")) {
    flushPendingAddedPath(state, patterns, findings);
    resetFileState(state, line.slice("diff --cc ".length), true);
    return true;
  }
  if (line.startsWith("diff --combined ")) {
    flushPendingAddedPath(state, patterns, findings);
    resetFileState(state, line.slice("diff --combined ".length), true);
    return true;
  }
  return false;
}

function handleFileMetaLine(
  line: string,
  state: DiffState,
  patterns: readonly CompiledPattern[],
  findings: HistoryFinding[],
): boolean {
  if (line.startsWith("new file mode ")) {
    state.isNewFile = true;
    return true;
  }
  if (line.startsWith("rename to ")) {
    const renamedPath = line.slice("rename to ".length);
    state.filePath = renamedPath;
    state.pathScanned = true;
    if (state.commit !== null) {
      recordPathFindings(state.commit, renamedPath, patterns, findings);
    }
    return true;
  }
  if (line.startsWith("+++ b/")) {
    const plusPath = line.slice("+++ b/".length);
    state.filePath = plusPath;
    flushPendingAddedPath(state, patterns, findings);
    return true;
  }
  return false;
}

export function scanDiffOutput(
  diffOutput: string,
  patterns: readonly CompiledPattern[],
): readonly HistoryFinding[] {
  const findings: HistoryFinding[] = [];
  const state: DiffState = {
    commit: null,
    filePath: null,
    isNewFile: false,
    pathScanned: false,
    isCombined: false,
    parentCount: 1,
    inHunk: false,
    newLine: 0,
  };

  const lines = diffOutput.split("\n");
  for (const line of lines) {
    if (handleDiffHeaderLine(line, state, patterns, findings)) {
      continue;
    }
    if (!state.inHunk && handleFileMetaLine(line, state, patterns, findings)) {
      continue;
    }
    const hunkStart = parseHunkStart(line);
    if (hunkStart !== null) {
      state.inHunk = true;
      state.parentCount = hunkStart.parentCount;
      state.newLine = hunkStart.newLine;
      continue;
    }
    if (state.inHunk) {
      processHunkLine(line, state, patterns, findings);
    }
  }

  flushPendingAddedPath(state, patterns, findings);
  return findings;
}
