import {
  inspectPlainChangelog,
  isEarlierHeading,
  parseMarkdownHeadings,
  type TopLevelHeading,
} from "./markdown/rules.ts";

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

type ComputedChangelogResult =
  | {
      readonly ok: true;
      readonly prefix: string;
      readonly changelog: string;
      readonly inputHeadings: readonly TopLevelHeading[];
    }
  | { readonly ok: false; readonly reason: string };

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
): ComputedChangelogResult {
  const section = renderEarlierSection(earlier);
  if (existingChangelog === null || existingChangelog.length === 0) {
    return {
      ok: true,
      prefix: "",
      changelog: `# ${packageName}\n\n${section}`,
      inputHeadings: [],
    };
  }
  const inspected = inspectPlainChangelog(existingChangelog);
  if (!inspected.ok) {
    return inspected;
  }
  if (inspected.earlierHeadingOffset !== -1) {
    const prefix = existingChangelog.slice(0, inspected.earlierHeadingOffset);
    return {
      ok: true,
      prefix,
      changelog: `${prefix}${section}`,
      inputHeadings: inspected.headings,
    };
  }
  return {
    ok: true,
    prefix: existingChangelog,
    changelog: `${existingChangelog}${separatorBeforeSection(existingChangelog)}${section}`,
    inputHeadings: inspected.headings,
  };
}

function hasSingleFinalEarlierHeading(
  headings: readonly TopLevelHeading[],
): boolean {
  const earlierCount = headings.filter(isEarlierHeading).length;
  const lastHeading = headings.at(-1);
  return (
    earlierCount === 1 &&
    lastHeading !== undefined &&
    isEarlierHeading(lastHeading)
  );
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
        candidate.text === heading.text,
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
  inputHeadings: readonly TopLevelHeading[],
): string | null {
  if (!candidate.startsWith(prefix)) {
    return "The built changelog does not start with the preserved prefix byte for byte.";
  }
  const resultHeadings = parseMarkdownHeadings(candidate).topLevelHeadings;
  if (!hasSingleFinalEarlierHeading(resultHeadings)) {
    return "The built changelog does not end with a single top-level Earlier changes heading.";
  }
  if (existingChangelog !== null && existingChangelog.length > 0) {
    if (!preservesNonEarlierHeadings(inputHeadings, resultHeadings)) {
      return "The built changelog dropped or reordered an existing top-level heading.";
    }
  }
  const rerun = computeEarlierChangelog(candidate, packageName, earlier);
  if (!rerun.ok || rerun.changelog !== candidate) {
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
  if (!computed.ok) {
    return computed;
  }
  const failureReason = verifyEarlierChangelog(
    existingChangelog,
    packageName,
    earlier,
    computed.prefix,
    computed.changelog,
    computed.inputHeadings,
  );
  if (failureReason !== null) {
    return { ok: false, reason: failureReason };
  }
  return { ok: true, changelog: computed.changelog };
}
