import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { AdminStore } from "../../src/admin/store.js";
import { withTempDir } from "../support/temp.js";

test("managed keys survive restart, rotate, revoke and are encrypted on disk", async () => {
  await withTempDir(async (root) => {
    let store = new AdminStore(root);
    const key = store.createKey("QQ bot");
    assert.match(key.secret, /^sk-[A-Za-z0-9_-]{43}$/);
    assert.equal(store.authenticate(key.secret), key.id);
    assert.equal(store.revealKey(key.id), key.secret);
    assert.equal(JSON.stringify(store.listKeys()).includes(key.secret), false);
    store.close();
    assert.equal(
      (await readFile(join(root, "admin.sqlite"))).includes(
        Buffer.from(key.secret),
      ),
      false,
    );
    store = new AdminStore(root);
    assert.equal(store.authenticate(key.secret), key.id);
    const rotated = store.rotateKey(key.id);
    assert.match(rotated, /^sk-[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotated, key.secret);
    assert.equal(store.authenticate(key.secret), undefined);
    assert.equal(store.authenticate(rotated), key.id);
    store.setKeyEnabled(key.id, false);
    assert.equal(store.authenticate(rotated), undefined);
    store.close();
  });
});

test("usage is attributed once per request and missing counters remain unknown", async () => {
  await withTempDir(async (root) => {
    const store = new AdminStore(root);
    try {
      const entry = {
        id: "one",
        keyId: "workbuddy",
        model: "synthetic",
        started: Date.now(),
        duration: 12,
        status: 200,
        error: null,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      };
      store.record(entry);
      store.record(entry);
      store.record({
        ...entry,
        id: "two",
        keyId: "qq",
        status: 502,
        error: "upstream_error",
        usage: null,
      });
      const report = store.report() as {
        summary: {
          requests: number;
          measured: number;
          total: number;
          successful: number;
        };
        rows: { total: number | null }[];
      };
      assert.deepEqual(report.summary, {
        costUsd: null,
        priced: 0,
        requests: 2,
        successful: 1,
        measured: 1,
        input: 10,
        output: 5,
        cached: 3,
        reasoning: 2,
        total: 15,
      });
      assert.equal(
        (store.report({ keyId: "qq" }).summary as { total: null }).total,
        null,
      );
      assert.equal(
        (store.report({ model: "other" }).summary as { requests: number })
          .requests,
        0,
      );
      store.saveSettings({
        model: "synthetic",
        timeoutMs: 1000,
        maxRequests: 0,
      });
      assert.equal(store.settings()?.maxRequests, 0);
      assert.throws(() =>
        store.saveSettings({ model: "", timeoutMs: 0, maxRequests: -1 }),
      );
    } finally {
      store.close();
    }
  });
});

test("request model choices are distinct across the retained history", async () => {
  await withTempDir(async (root) => {
    const store = new AdminStore(root);
    try {
      for (const [id, model] of [
        ["one", "synthetic-old"],
        ["two", "synthetic-old"],
        ["three", "synthetic-new"],
        ["four", "unknown"],
      ])
        store.record({
          id: id!,
          keyId: "legacy",
          model: model!,
          started: Date.now(),
          duration: 1,
          status: 200,
          error: null,
          usage: null,
        });
      assert.deepEqual(store.requestModels(), [
        "synthetic-new",
        "synthetic-old",
      ]);
    } finally {
      store.close();
    }
  });
});
