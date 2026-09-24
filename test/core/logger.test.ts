import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { createLogger } from "../../src/core/logger.js";

test("logger failures write one plain error entry", () => {
  const path = join("private", "workspace", "file.ts");
  const entries: Record<string, unknown>[] = [];
  const log = createLogger("debug", (entry) => entries.push(entry));

  log.failure("widget_failed", { attempt: 1 }, new Error(`boom at ${path}`));

  assert.deepEqual(entries, [
    {
      time: entries[0]?.time,
      level: "error",
      event: "widget_failed",
      attempt: 1,
      error: `boom at ${path}`,
    },
  ]);
});

/** Retains severity filtering, structured fields and stringified non-Error failures. */
test("logger filters below the threshold and formats ordinary failure values", () => {
  const entries: Record<string, unknown>[] = [];
  const log = createLogger("warn", (entry) => entries.push(entry));
  log("debug", "hidden");
  log("info", "hidden");
  log("warn", "visible", { count: 2 });
  log.failure("failed", { error: "stale", count: 3 }, "synthetic failure");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.event, "visible");
  assert.equal(entries[0]?.count, 2);
  assert.equal(entries[1]?.error, "synthetic failure");
  assert.equal(entries[1]?.level, "error");
});
