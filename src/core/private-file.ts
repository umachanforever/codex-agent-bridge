import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";

/** Reads private bytes; permission failures and other I/O errors remain errors. */
export async function readPrivateFile(
  path: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Publishes complete private content using a same-directory atomic rename. */
export async function replacePrivateFile(
  path: string,
  content: Buffer | string,
): Promise<void> {
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    // Exclusive creation avoids following an existing staging-file symlink.
    const file = await open(stagingPath, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(content);
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    await rename(stagingPath, path);
  } finally {
    if (created) await rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

/** Avoids replacing an unchanged UTF-8 configuration or catalog. */
export async function updatePrivateText(
  path: string,
  content: string,
): Promise<boolean> {
  if ((await readPrivateFile(path))?.toString("utf8") === content) return false;
  await replacePrivateFile(path, content);
  return true;
}
