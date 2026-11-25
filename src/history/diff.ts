import {
  commitMarkerPrefix,
  matchingPatternLines,
  redactText,
} from "./rules.ts";
import type { CompiledPattern, HistoryFinding } from "./rules.ts";

type DiffState = {
  commit: string | null;
  filePath: string | null;
  isCombined: boolean;
  parentCount: number;
  inHunk: boolean;
  newLine: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const simpleEscapeBytes = new Map<string, number>([
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
  ["\\", 0x5c],
  ['"', 0x22],
]);

function appendUtf8Bytes(target: number[], text: string): void {
  for (const byte of textEncoder.encode(text)) {
    target.push(byte);
  }
}

function decodeEscapeAt(
  inner: string,
  escapeStart: number,
  target: number[],
): number {
  const next = inner[escapeStart + 1];
  if (next === undefined) {
    target.push(0x5c);
    return escapeStart + 1;
  }
  const mapped = simpleEscapeBytes.get(next);
  if (mapped !== undefined) {
    target.push(mapped);
    return escapeStart + 2;
  }
  const octal = inner.slice(escapeStart + 1, escapeStart + 4);
  if (/^[0-7]{3}$/.test(octal)) {
    target.push(Number.parseInt(octal, 8));
    return escapeStart + 4;
  }
  appendUtf8Bytes(target, next);
  return escapeStart + 2;
}

function decodeGitQuotedPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index] ?? "";
    if (ch === "\\") {
      index = decodeEscapeAt(inner, index, bytes);
      continue;
    }
    const nextSlash = inner.indexOf("\\", index);
    const segmentEnd = nextSlash === -1 ? inner.length : nextSlash;
    appendUtf8Bytes(bytes, inner.slice(index, segmentEnd));
    index = segmentEnd;
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

function findQuotedTokenEnd(text: string): number {
  let index = 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === '"') {
      return index;
    }
    index += 1;
  }
  return -1;
}

function stripDstPrefix(decoded: string): string | null {
  return decoded.startsWith("b/") ? decoded.slice(2) : null;
}

function parseUnquotedDiffGitPath(rest: string): string | null {
  const afterSrcPrefix = rest.slice(2);
  if (afterSrcPrefix.length >= 3 && (afterSrcPrefix.length - 3) % 2 === 0) {
    const half = (afterSrcPrefix.length - 3) / 2;
    if (
      afterSrcPrefix.slice(half, half + 3) === " b/" &&
      afterSrcPrefix.slice(0, half) === afterSrcPrefix.slice(half + 3)
    ) {
      return afterSrcPrefix.slice(0, half);
    }
  }
  const marker = afterSrcPrefix.lastIndexOf(" b/");
  return marker === -1 ? null : afterSrcPrefix.slice(marker + 3);
}

function parseDiffGitPath(line: string): string | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) {
    return null;
  }
  const rest = line.slice(prefix.length);
  if (rest.startsWith('"')) {
    const end = findQuotedTokenEnd(rest);
    if (end === -1 || rest[end + 1] !== " ") {
      return null;
    }
    return stripDstPrefix(decodeGitQuotedPath(rest.slice(end + 2)));
  }
  if (!rest.startsWith("a/")) {
    return null;
  }
  if (rest.endsWith('"')) {
    const quotedMarker = rest.indexOf(' "b/');
    if (quotedMarker === -1) {
      return null;
    }
    return stripDstPrefix(decodeGitQuotedPath(rest.slice(quotedMarker + 1)));
  }
  return parseUnquotedDiffGitPath(rest);
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
      path: redactText(filePath, patterns),
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
  state.isCombined = isCombined;
  state.parentCount = isCombined ? 2 : 1;
  state.inHunk = false;
  state.newLine = 0;
}

function handleDiffHeaderLine(line: string, state: DiffState): boolean {
  if (line.startsWith(commitMarkerPrefix)) {
    const payload = line.slice(commitMarkerPrefix.length);
    const parts = payload.split("\0");
    state.commit = (parts[1] ?? "").trim() || null;
    resetFileState(state, null, false);
    return true;
  }
  if (line.startsWith("diff --git ")) {
    resetFileState(state, parseDiffGitPath(line), false);
    return true;
  }
  if (line.startsWith("diff --cc ")) {
    resetFileState(
      state,
      decodeGitQuotedPath(line.slice("diff --cc ".length)),
      true,
    );
    return true;
  }
  if (line.startsWith("diff --combined ")) {
    resetFileState(
      state,
      decodeGitQuotedPath(line.slice("diff --combined ".length)),
      true,
    );
    return true;
  }
  return false;
}

function handleFileMetaLine(line: string, state: DiffState): boolean {
  if (line.startsWith("rename to ")) {
    state.filePath = decodeGitQuotedPath(line.slice("rename to ".length));
    return true;
  }
  if (line.startsWith("+++ ")) {
    if (line !== "+++ /dev/null") {
      const plusPath = stripDstPrefix(
        decodeGitQuotedPath(line.slice("+++ ".length)),
      );
      if (plusPath !== null) {
        state.filePath = plusPath;
      }
    }
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
    isCombined: false,
    parentCount: 1,
    inHunk: false,
    newLine: 0,
  };

  const lines = diffOutput.split("\n");
  for (const line of lines) {
    if (handleDiffHeaderLine(line, state)) {
      continue;
    }
    if (!state.inHunk && handleFileMetaLine(line, state)) {
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

  return findings;
}
