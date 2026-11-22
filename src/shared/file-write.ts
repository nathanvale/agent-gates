import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), "code");
}

function isInsideRoot(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(`${realRoot}${sep}`);
}

function folderSteps(
  root: string,
  folder: string,
): readonly { readonly prefix: string; readonly fullPath: string }[] {
  const segments = folder.split("/");
  const steps: { readonly prefix: string; readonly fullPath: string }[] = [];
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? "");
    steps.push({
      prefix: segments.slice(0, index + 1).join("/"),
      fullPath: current,
    });
  }
  return steps;
}

function verifyFolderAncestors(
  root: string,
  folder: string,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  const realRoot = realpathSync.native(root);
  for (const { prefix, fullPath } of folderSteps(root, folder)) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(fullPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { ok: true };
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        problem: `Could not inspect ${prefix} (${reason}). Repair: ensure ${prefix} is a readable plain folder.`,
      };
    }
    if (!stat.isDirectory())
      return {
        ok: false,
        problem: `${prefix} must be a plain folder, not a symlink or file. Repair: replace ${prefix} with a directory inside the repository.`,
      };
    if (!isInsideRoot(realRoot, realpathSync.native(fullPath)))
      return {
        ok: false,
        problem: `${prefix} resolves outside the repository root. Repair: use a plain folder inside the repository.`,
      };
  }
  return { ok: true };
}

function ensurePlainFolderTree(root: string, folder: string): void {
  const verified = verifyFolderAncestors(root, folder);
  if (!verified.ok) throw new Error(verified.problem);
  const realRoot = realpathSync.native(root);
  for (const { prefix, fullPath } of folderSteps(root, folder)) {
    try {
      const stat = lstatSync(fullPath);
      if (!stat.isDirectory())
        throw new Error(
          `${prefix} must be a plain folder, not a symlink or file.`,
        );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      mkdirSync(fullPath);
    }
    if (!isInsideRoot(realRoot, realpathSync.native(fullPath)))
      throw new Error(`${prefix} resolves outside the repository root.`);
  }
}

export function checkWritableTarget(
  root: string,
  folder: string,
  fileName: string,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  const ancestors = verifyFolderAncestors(root, folder);
  if (!ancestors.ok) return ancestors;
  const targetPath = join(root, folder, fileName);
  try {
    lstatSync(targetPath);
    return {
      ok: false,
      problem: `${folder}/${fileName} already exists. Repair: choose a new filename or inspect the existing file.`,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true };
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      problem: `Could not inspect ${folder}/${fileName} (${reason}). Repair: check permissions on ${folder}.`,
    };
  }
}

export function writeExclusiveFile(
  root: string,
  folder: string,
  fileName: string,
  content: string,
): void {
  ensurePlainFolderTree(root, folder);
  const targetPath = join(root, folder, fileName);
  const descriptor = openSync(
    targetPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function confirmFileContent(
  root: string,
  folder: string,
  fileName: string,
  expected: string,
): boolean {
  const ancestors = verifyFolderAncestors(root, folder);
  if (!ancestors.ok) return false;
  const targetPath = join(root, folder, fileName);
  const stat = lstatSync(targetPath);
  if (!stat.isFile()) return false;
  const realRoot = realpathSync.native(root);
  if (!isInsideRoot(realRoot, realpathSync.native(targetPath))) return false;
  return readFileSync(targetPath, "utf8") === expected;
}
