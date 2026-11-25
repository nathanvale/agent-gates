export type TopLevelHeading = {
  readonly level: number;
  readonly text: string;
};

type ParsedMarkdown = {
  readonly topLevelHeadings: readonly TopLevelHeading[];
  readonly hasHtmlBlock: boolean;
};

type HeadingCandidate = {
  readonly level: number;
  readonly sourceText: string;
  readonly lineStart: number;
};

export type InspectChangelogResult =
  | {
      readonly ok: true;
      readonly headings: readonly TopLevelHeading[];
      readonly earlierHeadingOffset: number;
    }
  | { readonly ok: false; readonly reason: string };

const earlierHeadingText = "Earlier changes";
const atxHeadingLinePattern = /^(#{1,6}) (.*)$/;
const headingTextDiffersReason =
  "The changelog contains a heading whose rendered text differs from its source text.";

export function isEarlierHeading(heading: TopLevelHeading): boolean {
  return heading.level === 2 && heading.text === earlierHeadingText;
}

export function parseMarkdownHeadings(markdown: string): ParsedMarkdown {
  const allHeadings: TopLevelHeading[] = [];
  let hasHtmlBlock = false;
  const rendered = Bun.markdown.render(markdown, {
    heading(children, meta) {
      const index = allHeadings.push({ level: meta.level, text: children }) - 1;
      return `${String(index)},`;
    },
    paragraph: () => "",
    blockquote: () => "",
    code: () => "",
    list: () => "",
    listItem: () => "",
    hr: () => "",
    table: () => "",
    html: () => {
      hasHtmlBlock = true;
      return "";
    },
  });
  const topLevelHeadings: TopLevelHeading[] = [];
  for (const part of rendered.split(",")) {
    if (part.length === 0) {
      continue;
    }
    const heading = allHeadings[Number(part)];
    if (heading !== undefined) {
      topLevelHeadings.push(heading);
    }
  }
  return { topLevelHeadings, hasHtmlBlock };
}

function containsRawHtml(markdown: string, hasHtmlBlock: boolean): boolean {
  if (hasHtmlBlock) {
    return true;
  }
  return (
    Bun.markdown.html(markdown) !==
    Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true })
  );
}

function buildHeadingCheckPrefix(
  markdown: string,
  headings: readonly TopLevelHeading[],
): string {
  let suffix = 0;
  let prefix = `agent-gates-heading-check-${String(suffix)}`;
  while (
    markdown.includes(prefix) ||
    headings.some((heading) => heading.text.includes(prefix))
  ) {
    suffix += 1;
    prefix = `agent-gates-heading-check-${String(suffix)}`;
  }
  return prefix;
}

function markSingleLine(
  rawLine: string,
  lineStart: number,
  lineNumber: number,
  prefix: string,
): {
  readonly markedLine: string;
  readonly candidate: HeadingCandidate | null;
} {
  const hasCarriageReturn = rawLine.endsWith("\r");
  const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
  const match = atxHeadingLinePattern.exec(line);
  if (match === null) {
    return { markedLine: rawLine, candidate: null };
  }
  const hashes = match[1] ?? "";
  const sourceText = match[2] ?? "";
  const suffix = hasCarriageReturn ? "\r" : "";
  return {
    markedLine: `${hashes} ${prefix}-${String(lineNumber)}${suffix}`,
    candidate: { level: hashes.length, sourceText, lineStart },
  };
}

function markAtxHeadingLines(
  markdown: string,
  prefix: string,
): {
  readonly marked: string;
  readonly candidates: ReadonlyMap<number, HeadingCandidate>;
} {
  const candidates = new Map<number, HeadingCandidate>();
  const parts: string[] = [];
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const { markedLine, candidate } = markSingleLine(
      markdown.slice(lineStart, lineEnd),
      lineStart,
      lineNumber,
      prefix,
    );
    if (candidate !== null) {
      candidates.set(lineNumber, candidate);
    }
    parts.push(markedLine);
    if (newlineIndex === -1) {
      break;
    }
    parts.push("\n");
    lineStart = newlineIndex + 1;
    lineNumber += 1;
  }

  return { marked: parts.join(""), candidates };
}

function matchHeadingCandidate(
  original: TopLevelHeading,
  marked: TopLevelHeading,
  prefix: string,
  candidates: ReadonlyMap<number, HeadingCandidate>,
): HeadingCandidate | null {
  const tokenPrefix = `${prefix}-`;
  if (marked.level !== original.level || !marked.text.startsWith(tokenPrefix)) {
    return null;
  }
  const lineNumber = Number(marked.text.slice(tokenPrefix.length));
  const candidate = candidates.get(lineNumber);
  if (
    candidate === undefined ||
    candidate.level !== original.level ||
    candidate.sourceText !== original.text
  ) {
    return null;
  }
  return candidate;
}

export function inspectPlainChangelog(
  markdown: string,
): InspectChangelogResult {
  const parsed = parseMarkdownHeadings(markdown);
  if (containsRawHtml(markdown, parsed.hasHtmlBlock)) {
    return {
      ok: false,
      reason: "The changelog contains raw HTML, which is not supported.",
    };
  }
  if (parsed.topLevelHeadings.length === 0) {
    return {
      ok: true,
      headings: parsed.topLevelHeadings,
      earlierHeadingOffset: -1,
    };
  }
  const prefix = buildHeadingCheckPrefix(markdown, parsed.topLevelHeadings);
  const { marked, candidates } = markAtxHeadingLines(markdown, prefix);
  const markedParsed = parseMarkdownHeadings(marked);
  if (markedParsed.topLevelHeadings.length !== parsed.topLevelHeadings.length) {
    return { ok: false, reason: headingTextDiffersReason };
  }
  let earlierHeadingOffset = -1;
  for (let index = 0; index < parsed.topLevelHeadings.length; index += 1) {
    const original = parsed.topLevelHeadings[index];
    const markedHeading = markedParsed.topLevelHeadings[index];
    if (original === undefined || markedHeading === undefined) {
      return { ok: false, reason: headingTextDiffersReason };
    }
    const matched = matchHeadingCandidate(
      original,
      markedHeading,
      prefix,
      candidates,
    );
    if (matched === null) {
      return { ok: false, reason: headingTextDiffersReason };
    }
    if (earlierHeadingOffset === -1 && isEarlierHeading(original)) {
      earlierHeadingOffset = matched.lineStart;
    }
  }
  return {
    ok: true,
    headings: parsed.topLevelHeadings,
    earlierHeadingOffset,
  };
}
