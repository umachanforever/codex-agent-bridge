import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import {
  readPrivateFile,
  replacePrivateFile,
  updatePrivateText,
} from "../../src/core/private-file.js";
import { withTempDir } from "../support/temp.js";

/** Verifies replacement, unchanged-file avoidance and private permissions. */
test("private files replace bytes atomically and skip unchanged text", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "state.json");
    assert.equal(await readPrivateFile(path), undefined);
    await writeFile(path, "old", { mode: 0o644 });
    await replacePrivateFile(path, Buffer.from("new"));
    assert.equal((await readPrivateFile(path))?.toString(), "new");
    const before = await stat(path);
    assert.equal(await updatePrivateText(path, "new"), false);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.equal(await updatePrivateText(path, "changed"), true);
    assert.equal(await readFile(path, "utf8"), "changed");
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["state.json"]);
  });
});

/** Verifies failed publication removes staging data and retains the old target. */
test("private-file errors preserve the destination and clean staging files", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "occupied");
    await mkdir(path);
    await writeFile(join(path, "keep"), "original");
    await assert.rejects(replacePrivateFile(path, "replacement"));
    assert.equal(await readFile(join(path, "keep"), "utf8"), "original");
    assert.deepEqual(await readdir(directory), ["occupied"]);
    await assert.rejects(
      replacePrivateFile(join(directory, "missing", "file"), "bytes"),
    );
    // Windows reports ENOENT for a child of a regular file, whereas Unix
    // reports ENOTDIR. Reading a directory is a non-ENOENT error on both.
    await assert.rejects(readPrivateFile(path));
  });
});
