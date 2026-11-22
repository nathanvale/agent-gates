import {
  type ChangeNote,
  type ChangeNoteEntry,
  compareText,
  isValidIsoDate,
} from "../change-note/rules.ts";

const STARTING_REPOSITORY_VERSION = "0.1.0";

type RepositoryVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

type VersionBump = "major" | "minor" | "patch" | "none";

type VersionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const strictVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const kindSections: readonly [ChangeNote["kind"], string][] = [
  ["added", "Added"],
  ["changed", "Changed"],
  ["fixed", "Fixed"],
  ["removed", "Removed"],
];

export function parseRepositoryVersion(
  raw: string,
): VersionResult<RepositoryVersion> {
  const match = strictVersionPattern.exec(raw);
  if (match === null)
    return {
      ok: false,
      problem: `Invalid repository version "${raw}". Repair: use strict X.Y.Z numbers such as ${STARTING_REPOSITORY_VERSION}.`,
    };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    Bun.semver.order(raw, raw) !== 0
  )
    return {
      ok: false,
      problem: `Invalid repository version "${raw}". Repair: use strict X.Y.Z numbers supported by Bun.semver.`,
    };
  return { ok: true, value: Object.freeze({ major, minor, patch }) };
}

function formatRepositoryVersion(version: RepositoryVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

export function compareRepositoryVersions(left: string, right: string): number {
  const leftParsed = parseRepositoryVersion(left);
  if (!leftParsed.ok) throw new Error(leftParsed.problem);
  const rightParsed = parseRepositoryVersion(right);
  if (!rightParsed.ok) throw new Error(rightParsed.problem);
  return Bun.semver.order(left, right);
}

function bumpFromChangeNotes(
  currentVersion: string,
  notes: readonly ChangeNote[],
): VersionResult<VersionBump> {
  const parsed = parseRepositoryVersion(currentVersion);
  if (!parsed.ok) return parsed;
  const consumerNotes = notes.filter((note) => note.kind !== "none");
  if (consumerNotes.length === 0) return { ok: true, value: "none" };
  const hasBreaking = consumerNotes.some((note) => note.breaking);
  if (parsed.value.major === 0)
    return { ok: true, value: hasBreaking ? "minor" : "patch" };
  if (hasBreaking) return { ok: true, value: "major" };
  return {
    ok: true,
    value: consumerNotes.some((note) => note.kind === "added")
      ? "minor"
      : "patch",
  };
}

function applyVersionBump(
  currentVersion: string,
  bump: VersionBump,
): VersionResult<string> {
  const parsed = parseRepositoryVersion(currentVersion);
  if (!parsed.ok) return parsed;
  if (bump === "none") return { ok: true, value: currentVersion };
  const current = parsed.value;
  const next =
    bump === "major"
      ? formatRepositoryVersion({
          major: current.major + 1,
          minor: 0,
          patch: 0,
        })
      : bump === "minor"
        ? formatRepositoryVersion({
            major: current.major,
            minor: current.minor + 1,
            patch: 0,
          })
        : formatRepositoryVersion({
            major: current.major,
            minor: current.minor,
            patch: current.patch + 1,
          });
  if (Bun.semver.order(next, currentVersion) <= 0)
    return {
      ok: false,
      problem: `Computed next repository version "${next}" is not greater than "${currentVersion}". Repair: inspect the current version tag.`,
    };
  return { ok: true, value: next };
}

export function nextRepositoryVersion(
  previousVersion: string | undefined,
  notes: readonly ChangeNote[],
): VersionResult<string | undefined> {
  const consumerNotes = notes.filter((note) => note.kind !== "none");
  if (consumerNotes.length === 0) return { ok: true, value: undefined };
  if (previousVersion === undefined)
    return { ok: true, value: STARTING_REPOSITORY_VERSION };
  const bump = bumpFromChangeNotes(previousVersion, notes);
  if (!bump.ok) return bump;
  if (bump.value === "none") return { ok: true, value: undefined };
  return applyVersionBump(previousVersion, bump.value);
}

export function normalizeLead(raw: string): VersionResult<string> {
  if (/[\r\n]/.test(raw))
    return {
      ok: false,
      problem:
        "Lead sentence must be a single line. Repair: pass a one-sentence --lead without line breaks.",
    };
  const trimmed = raw.trim();
  if (trimmed === "")
    return {
      ok: false,
      problem:
        'Lead sentence is required. Repair: pass --lead "<one-sentence summary>".',
    };
  return { ok: true, value: trimmed };
}

function renderBullet({ file, note }: ChangeNoteEntry): string[] {
  const scope =
    note.affects.length > 0 ? `**${note.affects.join(", ")}:** ` : "";
  const lines = [`- ${scope}${note.summary} (\`${file}\`)`];
  if (note.action !== null) lines.push(`  - **Action:** ${note.action}`);
  return lines;
}

export function pluralCount(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function renderAffectsLine(
  consumer: readonly ChangeNoteEntry[],
  breakingCount: number,
  nonBreakingCount: number,
  internalCount: number,
): string {
  const countParts: string[] = [];
  if (breakingCount > 0)
    countParts.push(pluralCount(breakingCount, "breaking change"));
  if (nonBreakingCount > 0)
    countParts.push(pluralCount(nonBreakingCount, "consumer update"));
  const omitted =
    internalCount > 0
      ? `; ${pluralCount(internalCount, "internal change")} omitted`
      : "";
  const surfaces = [
    ...new Set(consumer.flatMap(({ note }) => note.affects)),
  ].sort(compareText);
  return `Affects: ${surfaces.join(", ")} (${countParts.join(", ")}${omitted}).`;
}

function renderGroupedSections(
  breaking: readonly ChangeNoteEntry[],
  nonBreaking: readonly ChangeNoteEntry[],
): string[] {
  const lines: string[] = [];
  if (breaking.length > 0) {
    lines.push("", "## Breaking Changes", "");
    for (const entry of breaking) lines.push(...renderBullet(entry));
  }
  for (const [kind, heading] of kindSections) {
    const group = nonBreaking.filter(({ note }) => note.kind === kind);
    if (group.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const entry of group) lines.push(...renderBullet(entry));
  }
  return lines;
}

export function renderVersionAccount({
  heading,
  version,
  date,
  lead,
  entries,
}: {
  readonly heading: string;
  readonly version: string;
  readonly date: string;
  readonly lead: string;
  readonly entries: readonly ChangeNoteEntry[];
}): VersionResult<string> {
  const versionCheck = parseRepositoryVersion(version);
  if (!versionCheck.ok) return versionCheck;
  if (!isValidIsoDate(date))
    return {
      ok: false,
      problem: `Invalid date "${date}". Repair: pass --date YYYY-MM-DD with a real calendar date.`,
    };
  const cleanLead = normalizeLead(lead);
  if (!cleanLead.ok) return cleanLead;
  const ordered = [...entries].sort((left, right) =>
    compareText(left.file, right.file),
  );
  const consumer = ordered.filter(({ note }) => note.kind !== "none");
  const breaking = consumer.filter(({ note }) => note.breaking);
  const nonBreaking = consumer.filter(({ note }) => !note.breaking);
  const lines: string[] = [
    `# ${heading} ${version} (${date})`,
    "",
    cleanLead.value,
    "",
    renderAffectsLine(
      consumer,
      breaking.length,
      nonBreaking.length,
      ordered.length - consumer.length,
    ),
    ...renderGroupedSections(breaking, nonBreaking),
  ];
  return { ok: true, value: `${lines.join("\n")}\n` };
}
