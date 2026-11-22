import {
  closeSync,
  constants,
  fstatSync,
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

function sameInode(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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

function openPlainDirectory(prefix: string, fullPath: string): number {
  try {
    return openSync(
      fullPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(
      `${prefix} must be a plain folder, not a symlink or file.`,
      {
        cause: error,
      },
    );
  }
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

function createOrVerifyDirectory(prefix: string, fullPath: string): void {
  try {
    mkdirSync(fullPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const descriptor = openPlainDirectory(prefix, fullPath);
    closeSync(descriptor);
  }
}

function ensureAndOpenStep(
  realRoot: string,
  step: { readonly prefix: string; readonly fullPath: string },
): number {
  try {
    const stat = lstatSync(step.fullPath);
    if (!stat.isDirectory())
      throw new Error(
        `${step.prefix} must be a plain folder, not a symlink or file.`,
      );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    createOrVerifyDirectory(step.prefix, step.fullPath);
  }
  const dirFd = openPlainDirectory(step.prefix, step.fullPath);
  try {
    if (!isInsideRoot(realRoot, realpathSync.native(step.fullPath)))
      throw new Error(`${step.prefix} resolves outside the repository root.`);
    return dirFd;
  } catch (error) {
    closeSync(dirFd);
    throw error;
  }
}

function ensureAndPinFolderTree(
  root: string,
  folder: string,
): { readonly parentPath: string; readonly parentFd: number } {
  const verified = verifyFolderAncestors(root, folder);
  if (!verified.ok) throw new Error(verified.problem);
  const realRoot = realpathSync.native(root);
  const steps = folderSteps(root, folder);
  let leafFd = -1;
  let leafPath = root;
  try {
    for (const step of steps) {
      const dirFd = ensureAndOpenStep(realRoot, step);
      if (leafFd >= 0) closeSync(leafFd);
      leafFd = dirFd;
      leafPath = step.fullPath;
    }
    return { parentPath: leafPath, parentFd: leafFd };
  } catch (error) {
    if (leafFd >= 0) closeSync(leafFd);
    throw error;
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

function assertOpenedTargetInsideRoot(
  root: string,
  folder: string,
  parentPath: string,
  parentFd: number,
  targetPath: string,
  fileFd: number,
): void {
  const ancestors = verifyFolderAncestors(root, folder);
  if (!ancestors.ok) throw new Error(ancestors.problem);
  const pinnedParent = fstatSync(parentFd, { bigint: true });
  const liveParent = lstatSync(parentPath, { bigint: true });
  if (!sameInode(pinnedParent, liveParent))
    throw new Error(`${folder} changed during file creation.`);
  const opened = fstatSync(fileFd, { bigint: true });
  const liveFile = lstatSync(targetPath, { bigint: true });
  if (!opened.isFile() || !sameInode(opened, liveFile))
    throw new Error(`${targetPath} changed during file creation.`);
  const realRoot = realpathSync.native(root);
  if (!isInsideRoot(realRoot, realpathSync.native(targetPath)))
    throw new Error(`${folder} resolves outside the repository root.`);
}

export function writeExclusiveFile(
  root: string,
  folder: string,
  fileName: string,
  content: string,
): void {
  const { parentPath, parentFd } = ensureAndPinFolderTree(root, folder);
  const targetPath = join(parentPath, fileName);
  try {
    const descriptor = openSync(
      targetPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      assertOpenedTargetInsideRoot(
        root,
        folder,
        parentPath,
        parentFd,
        targetPath,
        descriptor,
      );
      writeFileSync(descriptor, content, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } finally {
    if (parentFd >= 0) closeSync(parentFd);
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
  const descriptor = openSync(
    targetPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const live = lstatSync(targetPath, { bigint: true });
    if (!opened.isFile() || !sameInode(opened, live)) return false;
    const realRoot = realpathSync.native(root);
    if (!isInsideRoot(realRoot, realpathSync.native(targetPath))) return false;
    return readFileSync(descriptor, "utf8") === expected;
  } finally {
    closeSync(descriptor);
  }
}
