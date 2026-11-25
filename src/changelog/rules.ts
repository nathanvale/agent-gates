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

export type SpliceEarlierResult =
  | { readonly ok: true; readonly changelog: string }
  | { readonly ok: false; readonly reason: string };

type TopLevelHeading = {
  readonly level: number;
  readonly html: string;
};

type HtmlScanState = {
  readonly headings: TopLevelHeading[];
  depth: number;
};

const earlierHeadingText = "Earlier changes";
const earlierHeading = `## ${earlierHeadingText}`;
const rawHtmlTags = new Set(["pre", "script", "style", "textarea"]);
const containerHtmlTags = new Set(["blockquote", "ul", "ol", "li"]);
const headingTagLevels = new Map<string, number>([
  ["h1", 1],
  ["h2", 2],
  ["h3", 3],
  ["h4", 4],
  ["h5", 5],
  ["h6", 6],
]);
const htmlTagPattern = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^>]*>/;

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

function computeEarlierChangelog(
  existingChangelog: string | null,
  packageName: string,
  earlier: readonly MergedPullRequest[],
): { readonly prefix: string; readonly changelog: string } {
  const section = renderEarlierSection(earlier);
  if (existingChangelog === null || existingChangelog.length === 0) {
    return { prefix: "", changelog: `# ${packageName}\n\n${section}` };
  }
  const headingIndex = findEarlierHeadingIndex(existingChangelog);
  if (headingIndex !== -1) {
    const prefix = existingChangelog.slice(0, headingIndex);
    return { prefix, changelog: `${prefix}${section}` };
  }
  return {
    prefix: existingChangelog,
    changelog: `${existingChangelog}${separatorBeforeSection(existingChangelog)}${section}`,
  };
}

function findRawTagEnd(lowerHtml: string, tag: string, from: number): number {
  const closeIndex = lowerHtml.indexOf(`</${tag}>`, from);
  return closeIndex === -1 ? lowerHtml.length : closeIndex + tag.length + 3;
}

function stepHtmlTag(
  html: string,
  lowerHtml: string,
  tagStart: number,
  state: HtmlScanState,
): number {
  if (html.startsWith("<!--", tagStart)) {
    const closeIndex = html.indexOf("-->", tagStart + 4);
    return closeIndex === -1 ? html.length : closeIndex + 3;
  }
  const match = htmlTagPattern.exec(html.slice(tagStart));
  if (match === null) {
    return tagStart + 1;
  }
  const isClosing = match[1] === "/";
  const tag = (match[2] ?? "").toLowerCase();
  const tagEnd = tagStart + match[0].length;
  if (!isClosing && rawHtmlTags.has(tag)) {
    return findRawTagEnd(lowerHtml, tag, tagEnd);
  }
  if (containerHtmlTags.has(tag)) {
    if (isClosing) {
      state.depth = Math.max(0, state.depth - 1);
    } else if (!match[0].endsWith("/>")) {
      state.depth += 1;
    }
    return tagEnd;
  }
  const level = headingTagLevels.get(tag);
  if (!isClosing && state.depth === 0 && level !== undefined) {
    const closeIndex = lowerHtml.indexOf(`</${tag}>`, tagEnd);
    if (closeIndex !== -1) {
      state.headings.push({ level, html: html.slice(tagEnd, closeIndex) });
      return closeIndex + tag.length + 3;
    }
  }
  return tagEnd;
}

function extractTopLevelHeadings(html: string): readonly TopLevelHeading[] {
  const lowerHtml = html.toLowerCase();
  const state: HtmlScanState = { headings: [], depth: 0 };
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }
    cursor = stepHtmlTag(html, lowerHtml, tagStart, state);
  }
  return state.headings;
}

function isEarlierHeading(heading: TopLevelHeading): boolean {
  return heading.level === 2 && heading.html === earlierHeadingText;
}

function hasSingleFinalEarlierHeading(
  headings: readonly TopLevelHeading[],
): boolean {
  const h2Headings = headings.filter((heading) => heading.level === 2);
  const earlierCount = h2Headings.filter(isEarlierHeading).length;
  const lastH2 = h2Headings.at(-1);
  return earlierCount === 1 && lastH2 !== undefined && isEarlierHeading(lastH2);
}

function preservesNonEarlierHeadings(
  inputHeadings: readonly TopLevelHeading[],
  resultHeadings: readonly TopLevelHeading[],
): boolean {
  const expected = inputHeadings.filter(
    (heading) => !isEarlierHeading(heading),
  );
  const actual = resultHeadings.filter((heading) => !isEarlierHeading(heading));
  let searchFrom = 0;
  for (const heading of expected) {
    const foundIndex = actual.findIndex(
      (candidate, index) =>
        index >= searchFrom &&
        candidate.level === heading.level &&
        candidate.html === heading.html,
    );
    if (foundIndex === -1) {
      return false;
    }
    searchFrom = foundIndex + 1;
  }
  return true;
}

function verifyEarlierChangelog(
  existingChangelog: string | null,
  packageName: string,
  earlier: readonly MergedPullRequest[],
  prefix: string,
  candidate: string,
): string | null {
  if (!candidate.startsWith(prefix)) {
    return "The built changelog does not start with the preserved prefix byte for byte.";
  }
  const resultHeadings = extractTopLevelHeadings(Bun.markdown.html(candidate));
  if (!hasSingleFinalEarlierHeading(resultHeadings)) {
    return "The built changelog does not end with a single top-level Earlier changes heading.";
  }
  if (existingChangelog !== null && existingChangelog.length > 0) {
    const inputHeadings = extractTopLevelHeadings(
      Bun.markdown.html(existingChangelog),
    );
    if (!preservesNonEarlierHeadings(inputHeadings, resultHeadings)) {
      return "The built changelog dropped or reordered an existing top-level heading.";
    }
  }
  const rerun = computeEarlierChangelog(candidate, packageName, earlier);
  if (rerun.changelog !== candidate) {
    return "Re-running changelog earlier on the built changelog did not return the same result.";
  }
  return null;
}

export function spliceEarlierChanges(
  existingChangelog: string | null,
  packageName: string,
  earlier: readonly MergedPullRequest[],
): SpliceEarlierResult {
  const computed = computeEarlierChangelog(
    existingChangelog,
    packageName,
    earlier,
  );
  const failureReason = verifyEarlierChangelog(
    existingChangelog,
    packageName,
    earlier,
    computed.prefix,
    computed.changelog,
  );
  if (failureReason !== null) {
    return { ok: false, reason: failureReason };
  }
  return { ok: true, changelog: computed.changelog };
}
