import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { adminCredential, createAdminServer } from "../../src/admin/server.js";
import { AdminStore } from "../../src/admin/store.js";
import {
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";

test("admin credentials cannot reuse a file-backed client secret", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "shared-token");
    await writeFile(file, "synthetic-shared-secret-long-enough\n");
    vi.stubEnv("CODEX_BRIDGE_TOKEN", undefined);
    vi.stubEnv("CODEX_BRIDGE_TOKEN_FILE", file);
    vi.stubEnv("CODEX_BRIDGE_ADMIN_TOKEN_FILE", file);
    try {
      assert.throws(() => adminCredential(root), /must be different/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

test("management login, CSRF, key reveal and logout are isolated from client bearer auth", async () => {
  await withTempDir(async (root) => {
    const store = new AdminStore(join(root, "admin"));
    const config = await resolveServeOptions(
      parseServeOptions([
        "--root",
        root,
        "--state-dir",
        root,
        "--agent-service-model",
        "synthetic",
      ]),
    );
    let modelsAvailable = true;
    const server = createAdminServer({
      host: "127.0.0.1",
      port: 0,
      store,
      config,
      verifyToken: (value) => value === "synthetic-admin-only-token",
      status: () => ({ ready: false, active: 0 }),
      models: async () => {
        if (!modelsAvailable) throw new Error("synthetic model failure");
        return ["synthetic-a", "synthetic-b"];
      },
      discoverPrices: async () => ({
        rates: { synthetic: [1, 0.1, 2] as const },
        evidence: { synthetic: "synthetic evidence" },
        source: "https://developers.openai.com/api/docs/pricing",
        fetchedAt: new Date().toISOString(),
        documentHash: "synthetic",
        model: "synthetic",
      }),
    });
    const port = await server.listen();
    const origin = `http://127.0.0.1:${port}`;
    let cookie = "",
      csrf = "";
    const post = (
      path: string,
      value: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${origin}/admin/api/${path}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie,
          "x-csrf-token": csrf,
          ...extra,
        },
        body: JSON.stringify(value),
      });
    try {
      assert.equal((await fetch(`${origin}/admin/api/models`)).status, 401);
      assert.equal(
        (await fetch(`${origin}/admin/api/usage/models`)).status,
        401,
      );
      assert.equal(
        (await post("pricing/discover", { confirm: true })).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${origin}/admin/api/keys`, {
            headers: { authorization: "Bearer synthetic-client" },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await post(
            "login",
            { token: "synthetic-admin-only-token" },
            { origin: "https://evil.invalid" },
          )
        ).status,
        403,
      );
      assert.equal((await post("login", { token: "wrong" })).status, 401);
      const login = await post("login", {
        token: "synthetic-admin-only-token",
      });
      assert.equal(login.status, 200);
      assert.match(
        login.headers.get("set-cookie")!,
        /HttpOnly; SameSite=Strict/,
      );
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      csrf = ((await login.json()) as { csrf: string }).csrf;
      const prices = store.prices();
      assert.equal(
        (
          await post(
            "pricing",
            { rates: {}, revision: prices.revision },
            { "x-csrf-token": "wrong" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post("pricing", {
            rates: { synthetic: [1, 0.1, 2] },
            revision: prices.revision,
          })
        ).status,
        200,
      );
      assert.equal(
        (await post("pricing", { rates: {}, revision: prices.revision }))
          .status,
        409,
      );
      const beforeLookup = store.prices();
      assert.equal((await post("pricing/discover", {})).status, 400);
      assert.equal(
        (
          await post(
            "pricing/discover",
            { confirm: true },
            { "x-csrf-token": "wrong" },
          )
        ).status,
        403,
      );
      assert.equal(
        (await post("pricing/discover", { confirm: true })).status,
        200,
      );
      assert.deepEqual(store.prices(), beforeLookup);
      assert.equal(
        (await post("pricing/discover", { confirm: true })).status,
        429,
      );
      assert.deepEqual(
        await (
          await fetch(`${origin}/admin/api/models`, { headers: { cookie } })
        ).json(),
        { models: ["synthetic-a", "synthetic-b"] },
      );
      for (const [id, model] of [
        ["model-one", "synthetic-old"],
        ["model-two", "synthetic-a"],
        ["model-three", "synthetic-old"],
        ["model-four", "unknown"],
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
      assert.deepEqual(
        await (
          await fetch(`${origin}/admin/api/usage/models`, {
            headers: { cookie },
          })
        ).json(),
        { models: ["synthetic-a", "synthetic-b", "synthetic-old"] },
      );
      modelsAvailable = false;
      assert.equal(
        (await fetch(`${origin}/admin/api/models`, { headers: { cookie } }))
          .status,
        503,
      );
      assert.deepEqual(
        await (
          await fetch(`${origin}/admin/api/usage/models`, {
            headers: { cookie },
          })
        ).json(),
        { models: ["synthetic-a", "synthetic-old"] },
      );
      assert.equal(
        (await post("keys", { name: "test" }, { "x-csrf-token": "wrong" }))
          .status,
        403,
      );
      const key = (await (await post("keys", { name: "test" })).json()) as {
        id: string;
        secret: string;
      };
      assert.equal(store.authenticate(key.secret), key.id);
      assert.equal(
        (await post(`keys/${key.id}/reveal`, { token: key.secret })).status,
        401,
      );
      const revealed = (await (
        await post(`keys/${key.id}/reveal`, {
          token: "synthetic-admin-only-token",
        })
      ).json()) as { secret: string };
      assert.equal(revealed.secret, key.secret);
      const listing = await fetch(`${origin}/admin/api/keys`, {
        headers: { cookie },
      });
      assert.equal((await listing.text()).includes(key.secret), false);
      assert.equal(
        (
          await post("settings", {
            model: "synthetic",
            timeoutMs: 21600000,
            maxRequests: 0,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await post("settings", {
            model: "synthetic",
            timeoutMs: -1,
            maxRequests: 0,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/admin/api/usage?offset=-1`, {
            headers: { cookie },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/admin/api/overview`, {
            headers: { cookie, origin: "https://evil.invalid" },
          })
        ).status,
        403,
      );
      assert.equal((await post("logout", {})).status, 200);
      assert.equal(
        (await fetch(`${origin}/admin/api/keys`, { headers: { cookie } }))
          .status,
        401,
      );
    } finally {
      await server.close();
      store.close();
    }
  });
});
