import assert from "node:assert/strict";
import { test } from "vitest";
import {
  cronEntry,
  cronQuote,
  deployWhenIdle,
  newerVersion,
} from "../../scripts/deploy-auto-update.mjs";

/** Records deployment boundaries without Docker, registry access or model calls. */
function operations(failure?: string, busy = false) {
  const events: string[] = [];
  return {
    events,
    ops: {
      maintenance(enabled: boolean) {
        events.push(enabled ? "lock" : "unlock");
      },
      idle() {
        events.push("idle");
        if (failure === "idle") throw new Error("idle");
        return !busy;
      },
      deploy() {
        events.push("deploy");
        if (failure === "deploy") throw new Error("deploy");
      },
      verify() {
        events.push("verify");
        if (failure === "verify" && events.includes("rollback") === false)
          throw new Error("verify");
      },
      rollback() {
        events.push("rollback");
      },
    },
  };
}

test("midnight entry is idempotent, checkout-specific and quotes shell/cron metacharacters", () => {
  const existing =
    "15 4 * * * unrelated\n0 0 * * * old # bridge-a\n0 0 * * * other # bridge-b\n";
  const result = cronEntry(existing, "new", "bridge-a");
  assert.equal(cronEntry(result, "new", "bridge-a"), result);
  assert.match(result, /15 4 \* \* \* unrelated/);
  assert.match(result, /other # bridge-b/);
  assert.match(result, /0 0 \* \* \* new # bridge-a/);
  assert.doesNotMatch(result, /old/);
  assert.equal(cronQuote("a'b%$()"), "'a'\\''b\\%$()'");
  assert.throws(() => cronQuote("a\nb"));
});

test("stable comparison never downgrades and compares numeric components", () => {
  assert.equal(newerVersion("0.9.0", "0.10.0"), true);
  assert.equal(newerVersion("1.0.0", "0.163.0"), false);
  assert.equal(newerVersion("0.163.0", "0.163.0"), false);
  assert.throws(() => newerVersion("0.163.0-beta", "latest"));
});

test("idle deployment holds admission closed until verification completes", async () => {
  const { ops, events } = operations();
  assert.equal(await deployWhenIdle(ops), true);
  assert.deepEqual(events, ["lock", "idle", "deploy", "verify", "unlock"]);
});

test("busy or unreadable state never deploys and releases maintenance", async () => {
  const busy = operations(undefined, true);
  assert.equal(await deployWhenIdle(busy.ops), false);
  assert.deepEqual(busy.events, ["lock", "idle", "unlock"]);
  const failed = operations("idle");
  await assert.rejects(deployWhenIdle(failed.ops), /idle/);
  assert.deepEqual(failed.events, ["lock", "idle", "unlock"]);
});

test("failed replacement or verification restores and verifies the old image", async () => {
  for (const reason of ["deploy", "verify"]) {
    const { ops, events } = operations(reason);
    await assert.rejects(deployWhenIdle(ops), new RegExp(reason));
    assert.deepEqual(events.slice(-3), ["rollback", "verify", "unlock"]);
  }
});

test("failed rollback still releases admission; an unowned marker is never removed", async () => {
  const { ops, events } = operations("deploy");
  ops.rollback = () => {
    throw new Error("rollback failed");
  };
  await assert.rejects(deployWhenIdle(ops), /rollback failed/);
  assert.equal(events.at(-1), "unlock");
  const owned = operations();
  owned.ops.maintenance = () => {
    throw new Error("owned");
  };
  await assert.rejects(deployWhenIdle(owned.ops), /owned/);
  assert.deepEqual(owned.events, []);
});
