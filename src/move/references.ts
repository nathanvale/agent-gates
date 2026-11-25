import type { MoveFinding, TreeEntry } from "./rules.ts";

export type ReferenceTarget = {
  readonly value: string;
  readonly kind: "path" | "name";
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathChar(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[A-Za-z0-9._-]/.test(character);
}

function isNameChar(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[A-Za-z0-9_-]/.test(character);
}

function isPathOrSlashChar(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[A-Za-z0-9._/-]/.test(character);
}

function lastPathSegment(folder: string): string {
  const slashIndex = folder.lastIndexOf("/");
  return slashIndex === -1 ? folder : folder.slice(slashIndex + 1);
}

function lineMentionsTarget(line: string, target: ReferenceTarget): boolean {
  const boundaryCheck = target.kind === "name" ? isNameChar : isPathChar;
  let start = 0;
  for (;;) {
    const index = line.indexOf(target.value, start);
    if (index === -1) return false;
    const before = index > 0 ? line[index - 1] : undefined;
    const after = line[index + target.value.length];
    if (!boundaryCheck(before) && !boundaryCheck(after)) {
      return true;
    }
    start = index + 1;
  }
}

function lineMentionsDestinationPath(line: string, destPath: string): boolean {
  const endsWithSlash = destPath.endsWith("/");
  let start = 0;
  for (;;) {
    const index = line.indexOf(destPath, start);
    if (index === -1) return false;
    const before = index > 0 ? line[index - 1] : undefined;
    const after = line[index + destPath.length];
    if (!isPathOrSlashChar(before) && (endsWithSlash || !isPathChar(after))) {
      return true;
    }
    start = index + 1;
  }
}

function isMoveRecordLine(
  line: string,
  destinationRecordPaths: readonly string[],
): boolean {
  for (const destPath of destinationRecordPaths) {
    if (lineMentionsDestinationPath(line, destPath)) {
      return true;
    }
  }
  return false;
}

export function collectMovedPathTargets(
  sourceEntries: readonly TreeEntry[],
  sourceAfterEntries: readonly TreeEntry[],
  sourceFolder: string,
): readonly ReferenceTarget[] {
  const stillPresent = new Set(
    sourceAfterEntries.map((entry) => entry.repoPath),
  );
  const targets: ReferenceTarget[] = [];
  for (const entry of sourceEntries) {
    if (!stillPresent.has(entry.repoPath)) {
      targets.push({ value: entry.repoPath, kind: "path" });
    }
  }
  if (
    sourceFolder !== "" &&
    !sourceAfterEntries.some(
      (entry) =>
        entry.repoPath === sourceFolder ||
        entry.repoPath.startsWith(`${sourceFolder}/`),
    )
  ) {
    targets.push(
      {
        value: sourceFolder.includes("/") ? sourceFolder : `${sourceFolder}/`,
        kind: "path",
      },
      {
        value: lastPathSegment(sourceFolder),
        kind: "name",
      },
    );
  }
  targets.sort((left, right) => compareCodeUnits(left.value, right.value));
  return targets;
}

export function collectDestinationRecordPaths(
  sourceEntries: readonly TreeEntry[],
  sourceFolder: string,
  destinationFolder: string,
): readonly string[] {
  if (destinationFolder === sourceFolder) {
    return [];
  }
  const paths = new Set<string>();
  if (destinationFolder !== "") {
    paths.add(
      destinationFolder.includes("/")
        ? destinationFolder
        : `${destinationFolder}/`,
    );
  }
  for (const entry of sourceEntries) {
    const destPath =
      destinationFolder === ""
        ? entry.relativePath
        : `${destinationFolder}/${entry.relativePath}`;
    paths.add(destPath);
  }
  return [...paths].sort(compareCodeUnits);
}

export function isDestinationEntry(
  repoPath: string,
  destinationFolder: string,
  sourceRelatives: ReadonlySet<string>,
): boolean {
  if (destinationFolder !== "") {
    return (
      repoPath === destinationFolder ||
      repoPath.startsWith(`${destinationFolder}/`)
    );
  }
  return sourceRelatives.has(repoPath);
}

export function findSourceStaleReferences(
  sourceAfterFiles: readonly {
    readonly repoPath: string;
    readonly text: string;
  }[],
  targets: readonly ReferenceTarget[],
  destinationRecordPaths: readonly string[],
): readonly MoveFinding[] {
  const findings: MoveFinding[] = [];
  for (const file of sourceAfterFiles) {
    const matched = new Set<string>();
    for (const line of file.text.split(/\r?\n/)) {
      if (isMoveRecordLine(line, destinationRecordPaths)) continue;
      for (const target of targets) {
        if (lineMentionsTarget(line, target)) {
          matched.add(target.value);
        }
      }
    }
    for (const reference of [...matched].sort(compareCodeUnits)) {
      findings.push({
        cause: "DOMAIN_MOVE_REFERENCE_DANGLING",
        path: file.repoPath,
        reference,
      });
    }
  }
  return findings;
}
