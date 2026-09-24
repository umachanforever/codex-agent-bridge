import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServeOptions } from "../core/config.js";
import { normalizeLoopbackHost } from "../core/config.js";
import type { AdminStore, RuntimeSettings, UsageFilter } from "./store.js";
import type { discoverPrices } from "./price-discovery.js";

/** Only a digest is retained for management login verification. */
export function adminCredential(
  directory: string,
): ((token: unknown) => boolean) & { version: string } {
  const file =
    process.env.CODEX_BRIDGE_ADMIN_TOKEN_FILE ?? join(directory, "admin-token");
  if (!existsSync(file) && !process.env.CODEX_BRIDGE_ADMIN_TOKEN_FILE)
    writeFileSync(file, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  const token = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (token.length < 24 || /\s/.test(token))
    throw new Error(
      "Admin token must be at least 24 characters without whitespace.",
    );
  const clientToken = process.env.CODEX_BRIDGE_TOKEN_FILE
    ? readFileSync(process.env.CODEX_BRIDGE_TOKEN_FILE, "utf8").replace(
        /\r?\n$/,
        "",
      )
    : process.env.CODEX_BRIDGE_TOKEN;
  if (token === clientToken)
    throw new Error("Admin and client credentials must be different.");
  const expected = createHash("sha256").update(token).digest();
  return Object.assign(
    (value: unknown) =>
      typeof value === "string" &&
      timingSafeEqual(expected, createHash("sha256").update(value).digest()),
    { version: expected.toString("hex") },
  );
}

/** Typed dependencies keep the management listener independent from model execution. */
export interface AdminOptions {
  host: "127.0.0.1" | "::1";
  port: number;
  store: AdminStore;
  verifyToken: ((value: unknown) => boolean) & { version?: string };
  config: ServeOptions;
  status: () => { ready: boolean; active: number };
  assets?: string;
  models?: () => Promise<string[]>;
  discoverPrices?: (signal: AbortSignal) => ReturnType<typeof discoverPrices>;
}
/** Opaque sessions expire without retaining the administrator password. */
interface Session {
  expires: number;
  csrf: string;
}

/** Encodes no-store JSON for the browser-only management surface. */
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
/** Reads bounded JSON objects, never logging their contents. */
async function body(
  request: IncomingMessage,
  limit = 16384,
): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new Error("JSON body required.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Body too large.");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON object required.");
  return value as Record<string, unknown>;
}

/** Runs a separate loopback-only management listener with same-origin and CSRF gates. */
export function createAdminServer(options: AdminOptions) {
  const sessions = new Map<string, Session>();
  const credentialVersion =
    options.verifyToken.version ?? randomBytes(32).toString("hex");
  let attempts = 0;
  let windowStart = Date.now();
  let priceLookup: AbortController | undefined;
  let lastPriceLookup = 0;
  const assets = resolve(
    options.assets ??
      join(dirname(fileURLToPath(import.meta.url)), "../../web-dist"),
  );
  const authorizedAttempt = (token: unknown): boolean => {
    if (Date.now() - windowStart > 60000) {
      attempts = 0;
      windowStart = Date.now();
    }
    if (++attempts > 20) return false;
    return options.verifyToken(token);
  };
  const server = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    void route(request, response).catch(() => {
      if (!response.headersSent)
        json(response, 400, { error: "请求无效，或操作无法完成。" });
      else response.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
      json(response, 403, { error: "Invalid host." });
      return;
    }
    const origin = `http://${host}`;
    const url = new URL(request.url ?? "/", origin);
    const mutation = !["GET", "HEAD"].includes(request.method ?? "");
    if (
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      (mutation && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      json(response, 403, { error: "Same-origin request required." });
      return;
    }
    if (!url.pathname.startsWith("/admin/api/")) {
      if (request.method !== "GET" || !url.pathname.startsWith("/admin")) {
        json(response, 404, { error: "Not found." });
        return;
      }
      const relative =
        url.pathname === "/admin" || url.pathname === "/admin/"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice("/admin/".length));
      const file = resolve(assets, relative);
      if (
        !file.startsWith(assets + sep) ||
        ![".html", ".js", ".css", ".svg", ".woff2"].includes(extname(file))
      ) {
        json(response, 404, { error: "Not found." });
        return;
      }
      try {
        const data = await readFile(file);
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        };
        response.writeHead(200, {
          "content-type": `${types[extname(file)]}; charset=utf-8`,
          "cache-control": "no-store",
        });
        response.end(data);
      } catch {
        json(response, 404, {
          error: "管理页面尚未构建，请运行 npm run build:web。",
        });
      }
      return;
    }
    if (url.pathname === "/admin/api/auth" && request.method === "GET") {
      json(response, 200, { localLogin: options.config.adminAuth === "local" });
      return;
    }
    if (
      (url.pathname === "/admin/api/login" ||
        url.pathname === "/admin/api/local-login") &&
      request.method === "POST"
    ) {
      const input = await body(request);
      const local = url.pathname.endsWith("/local-login");
      const peer = request.socket.remoteAddress;
      if (
        local &&
        (options.config.adminAuth !== "local" ||
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
          request.headers["sec-fetch-site"] !== "same-origin" ||
          Object.keys(request.headers).some(
            (key) =>
              key === "forwarded" ||
              key.startsWith("x-forwarded-") ||
              key === "x-real-ip",
          ))
      ) {
        json(response, 403, {
          error: "本机免登录仅允许直接同源访问，不支持代理。",
        });
        return;
      }
      if (!local && !authorizedAttempt(input.token)) {
        json(response, 401, {
          error: "管理口令无效或尝试过于频繁，请稍后重试。",
        });
        return;
      }
      for (const [key, value] of sessions)
        if (value.expires < Date.now()) sessions.delete(key);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString("base64url");
      const csrf = randomBytes(24).toString("base64url");
      const remember = !local && input.remember === true;
      const maxAge = remember ? 30 * 86400 : 12 * 3600;
      const expires = Date.now() + maxAge * 1000;
      if (remember)
        options.store.saveSession(id, csrf, expires, credentialVersion);
      else sessions.set(id, { csrf, expires });
      // Browser storage is origin-scoped, unlike cookies shared across localhost ports.
      json(response, 200, { session: id, csrf });
      return;
    }
    const supplied = request.headers["x-admin-session"];
    const id =
      typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/.test(supplied)
        ? supplied
        : "";
    const session =
      sessions.get(id) ?? options.store.session(id, credentialVersion);
    if (!session || session.expires < Date.now()) {
      sessions.delete(id);
      json(response, 401, { error: "请先登录管理页面。" });
      return;
    }
    if (mutation && request.headers["x-csrf-token"] !== session.csrf) {
      json(response, 403, { error: "Invalid CSRF token." });
      return;
    }
    const path = url.pathname.slice("/admin/api/".length);
    if (path === "pricing" && request.method === "GET") {
      json(response, 200, options.store.prices());
      return;
    }
    if (path === "pricing" && request.method === "POST") {
      const input = await body(request, 65536);
      if (input.revision !== options.store.prices().revision) {
        json(response, 409, {
          error: "价格已被其他页面修改，请重新加载后编辑。",
        });
        return;
      }
      options.store.savePrices(input.rates, input.revision);
      json(response, 200, options.store.prices());
      return;
    }
    if (path === "pricing/discover" && request.method === "POST") {
      const input = await body(request);
      if (input.confirm !== true) {
        json(response, 400, { error: "请确认本次查询会调用模型并消耗用量。" });
        return;
      }
      if (!options.discoverPrices) {
        json(response, 503, { error: "当前环境未提供价格查询模型。" });
        return;
      }
      if (priceLookup || Date.now() - lastPriceLookup < 60000) {
        json(response, 429, {
          error: "价格查询正在运行或过于频繁，请稍后重试。",
        });
        return;
      }
      const controller = new AbortController();
      priceLookup = controller;
      lastPriceLookup = Date.now();
      const timer = setTimeout(() => controller.abort(), 120000);
      const cancel = () => controller.abort();
      response.once("close", cancel);
      try {
        json(response, 200, await options.discoverPrices(controller.signal));
      } catch {
        if (!response.destroyed)
          json(response, 502, {
            error:
              "查询失败：请检查官方页面网络连接、模型可用性或稍后重试。现有价格未修改。",
          });
      } finally {
        clearTimeout(timer);
        response.off("close", cancel);
        if (priceLookup === controller) priceLookup = undefined;
      }
      return;
    }
    if (path === "session" && request.method === "GET") {
      json(response, 200, { csrf: session.csrf });
      return;
    }
    if (path === "logout" && request.method === "POST") {
      sessions.delete(id);
      options.store.deleteSession(id);
      json(response, 200, { ok: true });
      return;
    }
    if (path === "models" && request.method === "GET") {
      try {
        if (!options.models) throw new Error("Unavailable");
        json(response, 200, { models: await options.models() });
      } catch {
        json(response, 503, {
          error: "暂时无法获取模型，请确认桥接已就绪后重试。",
        });
      }
      return;
    }
    if (path === "usage/models" && request.method === "GET") {
      const historical = options.store.requestModels();
      // The model catalog may be unavailable during app-server recovery; the
      // retained request names must remain usable as report filters.
      const current = await options.models?.().catch(() => []);
      json(response, 200, {
        models: [...new Set([...(current ?? []), ...historical])].sort(),
      });
      return;
    }
    if (path === "overview" && request.method === "GET") {
      json(response, 200, {
        ...options.status(),
        authMode: options.config.authMode ?? "reuse",
        authSource: options.config.authSource
          ? "指定本地认证目录"
          : "本地 Codex",
        settings: options.store.settings() ?? {
          model: options.config.localBridgeModel ?? "",
          timeoutMs: options.config.requestTimeoutMs,
          maxRequests: options.config.maxRequests,
        },
        apiBase: `http://${options.config.host === "::1" ? "[::1]" : options.config.host}:${options.config.port}/v1`,
        retentionDays: 90,
      });
      return;
    }
    if (path === "keys" && request.method === "GET") {
      json(response, 200, options.store.listKeys());
      return;
    }
    if (path === "keys" && request.method === "POST") {
      const input = await body(request);
      if (typeof input.name !== "string") throw new Error("Name required.");
      json(response, 201, options.store.createKey(input.name));
      return;
    }
    const keyRoute = /^keys\/([a-f0-9-]{36})\/(reveal|rotate|enabled)$/.exec(
      path,
    );
    if (keyRoute && request.method === "POST") {
      const input = await body(request);
      const key = keyRoute[1]!;
      if (keyRoute[2] === "enabled") {
        if (typeof input.enabled !== "boolean")
          throw new Error("Boolean required.");
        options.store.setKeyEnabled(key, input.enabled);
        json(response, 200, { ok: true });
        return;
      }
      if (!authorizedAttempt(input.token)) {
        json(response, 401, { error: "请重新确认管理口令。" });
        return;
      }
      json(response, 200, {
        secret:
          keyRoute[2] === "reveal"
            ? options.store.revealKey(key)
            : options.store.rotateKey(key),
      });
      return;
    }
    if (path === "usage" && request.method === "GET") {
      const filter: UsageFilter = {};
      for (const field of ["since", "until", "offset"] as const) {
        if (!url.searchParams.has(field)) continue;
        const value = Number(url.searchParams.get(field));
        if (
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > (field === "offset" ? 1000000 : 8640000000000000)
        )
          throw new Error("Invalid range.");
        filter[field] = value;
      }
      for (const field of ["keyId", "model"] as const) {
        const value = url.searchParams.get(field);
        if (value) {
          if (value.length > 160) throw new Error("Filter too long.");
          filter[field] = value;
        }
      }
      json(response, 200, options.store.report(filter));
      return;
    }
    if (path === "settings" && request.method === "POST") {
      options.store.saveSettings(
        (await body(request)) as unknown as RuntimeSettings,
      );
      json(response, 200, { ok: true });
      return;
    }
    json(response, 404, { error: "Not found." });
  }
  return {
    server,
    listen: () =>
      new Promise<number>((resolvePort, reject) => {
        server.once("error", reject);
        server.listen(options.port, normalizeLoopbackHost(options.host), () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string")
            return reject(new Error("Missing listener address."));
          resolvePort(address.port);
        });
      }),
    close: () =>
      new Promise<void>((done) => {
        priceLookup?.abort();
        sessions.clear();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
