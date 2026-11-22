import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), "code");
}

export function checkWritableTarget(
  root: string,
  folder: string,
  fileName: string,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  const folderPath = join(root, folder);
  let folderStat: ReturnType<typeof lstatSync> | undefined;
  try {
    folderStat = lstatSync(folderPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        problem: `Could not inspect ${folder} (${reason}). Repair: ensure ${folder} is a readable plain folder.`,
      };
    }
  }
  if (folderStat !== undefined && !folderStat.isDirectory())
    return {
      ok: false,
      problem: `${folder} must be a plain folder, not a symlink or file. Repair: replace ${folder} with a directory.`,
    };
  const targetPath = join(folderPath, fileName);
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
  const folderPath = join(root, folder);
  let folderStat: ReturnType<typeof lstatSync> | undefined;
  try {
    folderStat = lstatSync(folderPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (folderStat === undefined) mkdirSync(folderPath, { recursive: true });
  else if (!folderStat.isDirectory())
    throw new Error(`${folder} must be a plain folder, not a symlink or file.`);

  const targetPath = join(folderPath, fileName);
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
  const targetPath = join(root, folder, fileName);
  const stat = lstatSync(targetPath);
  if (!stat.isFile()) return false;
  return readFileSync(targetPath, "utf8") === expected;
}
