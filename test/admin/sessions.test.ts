import assert from "node:assert/strict";
import { test } from "vitest";
import { AdminStore } from "../../src/admin/store.js";
import { createAdminServer } from "../../src/admin/server.js";
import {
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";

/** Uses only synthetic credentials and ephemeral loopback listeners. */
test("remembered sessions survive restart, revoke on logout and bind to credentials", async () => {
  await withTempDir(async (root) => {
    let store = new AdminStore(root);
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
    const verifier = Object.assign(
      (value: unknown) => value === "synthetic-admin",
      { version: "v1" },
    );
    const start = () =>
      createAdminServer({
        host: "127.0.0.1",
        port: 0,
        store,
        config,
        verifyToken: verifier,
        status: () => ({ ready: false, active: 0 }),
      });
    let server = start();
    let origin = `http://127.0.0.1:${await server.listen()}`;
    const login = async (remember: boolean) => {
      const response = await fetch(origin + "/admin/api/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "synthetic-admin", remember }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get("set-cookie")!.split(";")[0]!,
        header: response.headers.get("set-cookie")!,
        csrf: ((await response.json()) as { csrf: string }).csrf,
      };
    };
    try {
      const remembered = await login(true),
        temporary = await login(false);
      assert.match(remembered.header, /Max-Age=2592000/);
      assert.doesNotMatch(temporary.header, /Max-Age/);
      await server.close();
      store.close();
      store = new AdminStore(root);
      server = start();
      origin = `http://127.0.0.1:${await server.listen()}`;
      const get = (cookie: string) =>
        fetch(origin + "/admin/api/session", { headers: { cookie } });
      assert.equal((await get(remembered.cookie)).status, 200);
      assert.equal((await get(temporary.cookie)).status, 401);
      assert.equal(
        (
          await fetch(origin + "/admin/api/logout", {
            method: "POST",
            headers: { origin, cookie: remembered.cookie },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(origin + "/admin/api/logout", {
            method: "POST",
            headers: {
              origin,
              cookie: remembered.cookie,
              "x-csrf-token": remembered.csrf,
            },
          })
        ).status,
        200,
      );
      assert.equal((await get(remembered.cookie)).status, 401);
      const rotated = await login(true);
      await server.close();
      verifier.version = "v2";
      server = start();
      origin = `http://127.0.0.1:${await server.listen()}`;
      assert.equal((await get(rotated.cookie)).status, 401);
      store.saveSession("expired", "csrf", Date.now() - 1, "v2");
      assert.equal(store.session("expired", "v2"), undefined);
    } finally {
      await server.close();
      store.close();
    }
  });
});

/** Local bypass remains opt-in and cannot skip origin, proxy or reauthentication gates. */
test("local login is explicit and rejects forwarded and cross-site requests", async () => {
  await withTempDir(async (root) => {
    const store = new AdminStore(root);
    const config = await resolveServeOptions(
      parseServeOptions([
        "--root",
        root,
        "--state-dir",
        root,
        "--admin-port",
        "0",
        "--admin-auth",
        "local",
        "--agent-service-model",
        "synthetic",
      ]),
    );
    const server = createAdminServer({
      host: "127.0.0.1",
      port: 0,
      store,
      config,
      verifyToken: (value) => value === "synthetic-admin",
      status: () => ({ ready: false, active: 0 }),
    });
    const origin = `http://127.0.0.1:${await server.listen()}`;
    const post = (headers: Record<string, string> = {}) =>
      fetch(origin + "/admin/api/local-login", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          ...headers,
        },
        body: "{}",
      });
    try {
      assert.equal(
        (await post({ origin: "https://evil.invalid" })).status,
        403,
      );
      assert.equal(
        (await post({ "x-forwarded-for": "127.0.0.1" })).status,
        403,
      );
      assert.equal(
        (await post({ "sec-fetch-site": "cross-site" })).status,
        403,
      );
      const response = await post();
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const { csrf } = (await response.json()) as { csrf: string };
      const key = store.createKey("synthetic");
      assert.equal(
        (
          await fetch(origin + `/admin/api/keys/${key.id}/reveal`, {
            method: "POST",
            headers: {
              origin,
              cookie,
              "content-type": "application/json",
              "x-csrf-token": csrf,
            },
            body: "{}",
          })
        ).status,
        401,
      );
      config.adminAuth = "password";
      assert.equal((await post()).status, 403);
    } finally {
      await server.close();
      store.close();
    }
    assert.throws(() => parseServeOptions(["--admin-auth", "local"]));
    assert.throws(() => parseServeOptions(["--admin-auth", "invalid"]));
  });
});
