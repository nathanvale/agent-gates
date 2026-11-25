export type MergedPullRequest = {
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly mergedAtMs: number;
  readonly url: string;
};

export type ParsePullRequestsResult =
  | { readonly ok: true; readonly pullRequests: readonly MergedPullRequest[] }
  | { readonly ok: false; readonly reason: string };

export type SelectEarlierResult =
  | { readonly ok: true; readonly earlier: readonly MergedPullRequest[] }
  | { readonly ok: false; readonly code: "adopting-missing" | "no-earlier" };

const earlierHeading = "## Earlier changes";

function buildUniqueHeadingMarker(
  changelog: string,
  lineNumber: number,
): string {
  const base = `agent-gates-earlier-marker-${String(lineNumber)}`;
  let marker = base;
  let suffix = 0;
  while (changelog.includes(marker)) {
    suffix += 1;
    marker = `${base}-${String(suffix)}`;
  }
  return marker;
}

function isRealEarlierHeadingAt(
  changelog: string,
  lineStart: number,
  lineNumber: number,
): boolean {
  const marker = buildUniqueHeadingMarker(changelog, lineNumber);
  const marked = `${changelog.slice(0, lineStart)}## ${marker}${changelog.slice(lineStart + earlierHeading.length)}`;
  return Bun.markdown.html(marked).includes(`<h2>${marker}</h2>`);
}

function findEarlierHeadingIndex(changelog: string): number {
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart < changelog.length) {
    const newlineIndex = changelog.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? changelog.length : newlineIndex;
    const rawLine = changelog.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (
      line === earlierHeading &&
      isRealEarlierHeadingAt(changelog, lineStart, lineNumber)
    ) {
      return lineStart;
    }
    lineStart = newlineIndex === -1 ? changelog.length : newlineIndex + 1;
    lineNumber += 1;
  }

  return -1;
}

function readOwnField(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? Reflect.get(record, key) : undefined;
}

function parsePullRequestEntry(entry: unknown): MergedPullRequest | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const numberValue = readOwnField(entry, "number");
  const titleValue = readOwnField(entry, "title");
  const mergedAtValue = readOwnField(entry, "mergedAt");
  const urlValue = readOwnField(entry, "url");
  if (
    typeof numberValue !== "number" ||
    !Number.isInteger(numberValue) ||
    numberValue < 1
  ) {
    return null;
  }
  if (typeof titleValue !== "string" || titleValue.trim().length === 0) {
    return null;
  }
  if (typeof mergedAtValue !== "string" || mergedAtValue.length === 0) {
    return null;
  }
  const mergedAtMs = Date.parse(mergedAtValue);
  if (Number.isNaN(mergedAtMs)) {
    return null;
  }
  if (typeof urlValue !== "string" || urlValue.trim().length === 0) {
    return null;
  }
  return {
    number: numberValue,
    title: titleValue,
    mergedAt: mergedAtValue,
    mergedAtMs,
    url: urlValue,
  };
}

export function parseMergedPullRequests(
  rawJson: string,
): ParsePullRequestsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      reason: "The merged pull request list is not valid JSON.",
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "The merged pull request list must be a JSON array.",
    };
  }
  const pullRequests: MergedPullRequest[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsePullRequestEntry(parsed[index]);
    if (entry === null) {
      return {
        ok: false,
        reason: `Entry ${String(index + 1)} is missing a valid number, title, mergedAt, or url.`,
      };
    }
    pullRequests.push(entry);
  }
  return { ok: true, pullRequests };
}

function comparePullRequests(
  left: MergedPullRequest,
  right: MergedPullRequest,
): number {
  const timeDiff = left.mergedAtMs - right.mergedAtMs;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.number - right.number;
}

export function selectEarlierPullRequests(
  pullRequests: readonly MergedPullRequest[],
  changesetsFrom: number,
): SelectEarlierResult {
  const adopting = pullRequests.find((pr) => pr.number === changesetsFrom);
  if (adopting === undefined) {
    return { ok: false, code: "adopting-missing" };
  }
  const earlier = pullRequests
    .filter((pr) => comparePullRequests(pr, adopting) < 0)
    .toSorted(comparePullRequests);
  if (earlier.length === 0) {
    return { ok: false, code: "no-earlier" };
  }
  return { ok: true, earlier };
}

function renderEarlierSection(earlier: readonly MergedPullRequest[]): string {
  const lines = earlier.map(
    (pr) => `- ${pr.title} ([#${String(pr.number)}](${pr.url}))`,
  );
  return ["## Earlier changes", "", ...lines, ""].join("\n");
}

function separatorBeforeSection(existingChangelog: string): string {
  if (
    existingChangelog.endsWith("\r\n\r\n") ||
    existingChangelog.endsWith("\n\n")
  ) {
    return "";
  }
  if (existingChangelog.endsWith("\n")) {
    return "\n";
  }
  return "\n\n";
}

export function spliceEarlierChanges(
  existingChangelog: string | null,
  packageName: string,
  earlier: readonly MergedPullRequest[],
): string {
  const section = renderEarlierSection(earlier);
  if (existingChangelog === null || existingChangelog.length === 0) {
    return `# ${packageName}\n\n${section}`;
  }
  const headingIndex = findEarlierHeadingIndex(existingChangelog);
  if (headingIndex !== -1) {
    return `${existingChangelog.slice(0, headingIndex)}${section}`;
  }
  return `${existingChangelog}${separatorBeforeSection(existingChangelog)}${section}`;
}
