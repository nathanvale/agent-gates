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

export function redactPath(
  filePath: string,
  patterns: readonly CompiledPattern[],
): string {
  let redacted = filePath;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern.globalRegex, "[redacted]");
  }
  return redacted;
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

export function matchingPatternLines(
  text: string,
  patterns: readonly CompiledPattern[],
): readonly number[] {
  const matched: number[] = [];
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      matched.push(pattern.lineNumber);
    }
  }
  return matched;
}

export function scanCommitMessages(
  commits: readonly CommitMeta[],
  patterns: readonly CompiledPattern[],
): readonly HistoryFinding[] {
  const findings: HistoryFinding[] = [];
  for (const commit of commits) {
    for (const patternLine of matchingPatternLines(commit.message, patterns)) {
      findings.push({
        kind: "commit-message",
        commit: commit.shortHash,
        patternLine,
      });
    }
  }
  return findings;
}

export function scanPullRequestParts(
  pullRequest: number,
  parts: readonly PullRequestTextPart[],
  patterns: readonly CompiledPattern[],
): readonly HistoryFinding[] {
  const findings: HistoryFinding[] = [];
  for (const part of parts) {
    for (const patternLine of matchingPatternLines(part.text, patterns)) {
      findings.push({
        kind: "pull-request",
        pullRequest,
        part: part.kind,
        id: part.id,
        patternLine,
      });
    }
  }
  return findings;
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
