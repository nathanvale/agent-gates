import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import type {
  OriginTarget,
  PullRequestPartKind,
  PullRequestTextPart,
} from "./rules.ts";

const defaultTimeoutMs = 30_000;
const defaultShutdownMs = 1_000;
const apiOutputLimitBytes = 16_777_216;

function readOwnString(record: object, key: string): string | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : null;
}

function readOwnId(record: object, key: string): string | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const value: unknown = Reflect.get(record, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return null;
}

function parsePullRequestDetails(
  jsonText: string,
  prNumber: number,
):
  | { readonly ok: true; readonly parts: readonly PullRequestTextPart[] }
  | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      ok: false,
      reason: `Pull request ${String(prNumber)} response was not valid JSON.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `Pull request ${String(prNumber)} response was not a JSON object.`,
    };
  }
  const parts: PullRequestTextPart[] = [];
  const title = readOwnString(parsed, "title");
  if (title !== null && title !== "") {
    parts.push({ kind: "title", id: String(prNumber), text: title });
  }
  const body = readOwnString(parsed, "body");
  if (body !== null && body !== "") {
    parts.push({ kind: "body", id: String(prNumber), text: body });
  }
  return { ok: true, parts };
}

function extractTextPart(
  entry: unknown,
  kind: PullRequestPartKind,
): PullRequestTextPart | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const body = readOwnString(entry, "body");
  if (body === null || body === "") {
    return null;
  }
  const id = readOwnId(entry, "id") ?? "unknown";
  return { kind, id, text: body };
}

function parseSlurpedTextItems(
  jsonText: string,
  kind: PullRequestPartKind,
  label: string,
):
  | { readonly ok: true; readonly parts: readonly PullRequestTextPart[] }
  | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: `${label} response was not valid JSON.` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: `${label} response was not a JSON array.` };
  }
  const entries = parsed.flatMap((page: unknown): readonly unknown[] =>
    Array.isArray(page) ? page : [page],
  );
  const parts: PullRequestTextPart[] = [];
  for (const entry of entries) {
    const part = extractTextPart(entry, kind);
    if (part !== null) {
      parts.push(part);
    }
  }
  return { ok: true, parts };
}

export function resolveGhBinary(
  parsePath: (raw: string) => ParsedPath,
):
  | { readonly ok: true; readonly gh: ParsedPath }
  | { readonly ok: false; readonly reason: string } {
  const gh = Bun.which("gh");
  if (gh === null) {
    return {
      ok: false,
      reason: "gh executable not found on PATH; cannot scan pull request text.",
    };
  }
  return { ok: true, gh: parsePath(gh) };
}

async function runGhApi(
  programs: ProgramsCapability,
  gh: ParsedPath,
  hostname: string,
  args: readonly string[],
  label: string,
  prNumber: number,
): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await programs.inspect({
    executable: gh,
    args: ["api", "--hostname", hostname, ...args],
    timeoutMilliseconds: defaultTimeoutMs,
    outputLimitBytes: apiOutputLimitBytes,
    shutdownMilliseconds: defaultShutdownMs,
  });
  if (result.outputTruncated) {
    return {
      ok: false,
      reason: `GitHub CLI output exceeded the 16 MiB limit while reading ${label}.`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `GitHub CLI failed while reading ${label} (exit code ${String(result.exitCode)}). Run \`gh pr view ${String(prNumber)}\` to see the detail.`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

export async function fetchPullRequestText(
  programs: ProgramsCapability,
  gh: ParsedPath,
  origin: OriginTarget,
  prNumber: number,
): Promise<
  | { readonly ok: true; readonly parts: readonly PullRequestTextPart[] }
  | { readonly ok: false; readonly reason: string }
> {
  const prLabel = `pull request ${String(prNumber)}`;
  const prResponse = await runGhApi(
    programs,
    gh,
    origin.host,
    [`repos/${origin.slug}/pulls/${String(prNumber)}`],
    prLabel,
    prNumber,
  );
  if (!prResponse.ok) {
    return prResponse;
  }
  const prDetails = parsePullRequestDetails(prResponse.stdout, prNumber);
  if (!prDetails.ok) {
    return prDetails;
  }

  const allParts: PullRequestTextPart[] = [...prDetails.parts];
  const collections: readonly {
    readonly endpoint: string;
    readonly kind: PullRequestPartKind;
    readonly label: string;
  }[] = [
    {
      endpoint: `repos/${origin.slug}/issues/${String(prNumber)}/comments?per_page=100`,
      kind: "issue-comment",
      label: `${prLabel} issue comments`,
    },
    {
      endpoint: `repos/${origin.slug}/pulls/${String(prNumber)}/comments?per_page=100`,
      kind: "review-comment",
      label: `${prLabel} review comments`,
    },
    {
      endpoint: `repos/${origin.slug}/pulls/${String(prNumber)}/reviews?per_page=100`,
      kind: "review-body",
      label: `${prLabel} reviews`,
    },
  ];

  for (const collection of collections) {
    const response = await runGhApi(
      programs,
      gh,
      origin.host,
      ["--paginate", "--slurp", collection.endpoint],
      collection.label,
      prNumber,
    );
    if (!response.ok) {
      return response;
    }
    const parsed = parseSlurpedTextItems(
      response.stdout,
      collection.kind,
      collection.label,
    );
    if (!parsed.ok) {
      return parsed;
    }
    allParts.push(...parsed.parts);
  }

  return { ok: true, parts: allParts };
}
