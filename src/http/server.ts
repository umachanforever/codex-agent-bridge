import { randomUUID } from "node:crypto";
import type {
  AdminStore,
  RequestRecord,
  RuntimeSettings,
} from "../admin/store.js";
import type { ChatHandlerOptions } from "./chat-execute.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { HttpError, writeError, writeJson } from "./errors.js";
import type { ServeOptions } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import type { ThreadConfigResolver } from "../app-server/windows-sandbox.js";
import {
  UNRESTRICTED_POLICY_REQUIREMENTS,
  type PolicyRequirements,
} from "../core/policy.js";
import { handleChatCompletion } from "./chat.js";
import { completeText as executeTextCompletion } from "../sessions/completion.js";
import { handleModelList } from "./models.js";
import { readModelCatalog } from "../app-server/models.js";
import {
  localBridgeAuthorizer,
  adaptLocalBridgeRequest,
} from "./local-bridge.js";
import {
  ContinuationCoordinator,
  ResponseStore,
} from "../continuation/state.js";

/** Controls the proxy HTTP listener and readiness state. */
export interface ProxyServer {
  models(): Promise<string[]>;
  completeText(body: unknown, signal: AbortSignal): Promise<string>;
  status(): { ready: boolean; active: number };
  server: Server;
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
  setReady(ready: boolean): void;
  /**
   * Installs or clears the app-server transport. Omitted requirements reset to
   * unrestricted proxy defaults, which is only meaningful when the transport is
   * being cleared.
   */
  setTransport(
    transport: JsonRpcTransport | undefined,
    requirements?: PolicyRequirements,
    resolveThreadConfig?: ThreadConfigResolver,
  ): void;
}

/** Creates a loopback proxy with bounded concurrency and request lifetimes. */
export function createProxyServer(
  options: ServeOptions,
  log: Logger,
  administration?: AdminStore,
): ProxyServer {
  const authorize = localBridgeAuthorizer(
    options.localBridgeModel !== undefined,
  );
  let ready = false;
  let transport: JsonRpcTransport | undefined;
  let requirements = UNRESTRICTED_POLICY_REQUIREMENTS;
  let resolveThreadConfig: ThreadConfigResolver | undefined;
  let continuations: ContinuationCoordinator | undefined;
  const continuationStore = new ResponseStore(options.stateDir);
  let active = 0;
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    // Parse the request target once; routing and every log line reuse it.
    let url: URL | undefined;
    try {
      url = new URL(request.url ?? "/", "http://loopback.invalid");
    } catch {
      url = undefined;
    }
    const logRequest = (status: number): void => {
      // Successful liveness and readiness polling is debug-only so a frequent
      // health checker cannot bury real events at the default level. Only the
      // expected outcomes qualify: a rejection or failure on a probe path
      // reports a hostile authority, overload, or misuse, and those must stay
      // visible without opting into debug.
      const routineProbe =
        (url?.pathname === "/health" && status === 200) ||
        (url?.pathname === "/ready" && (status === 200 || status === 503));
      log(routineProbe ? "debug" : "info", "http_request", {
        request_id: requestId,
        method: request.method,
        path: url?.pathname ?? "[invalid-path]",
        status,
        duration_ms: Date.now() - started,
      });
    };
    const authorityError = validateRequestAuthority(request);
    if (authorityError) {
      writeError(response, authorityError);
      logRequest(authorityError.status);
      return;
    }
    const bearer = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? "",
    )?.[1];
    let keyId: string | undefined;
    let settings: RuntimeSettings | undefined;
    try {
      keyId = bearer ? administration?.authenticate(bearer) : undefined;
      settings = administration?.settings();
    } catch {
      writeError(
        response,
        new HttpError(
          503,
          "Management state is unavailable.",
          "server_error",
          "management_unavailable",
        ),
      );
      logRequest(503);
      return;
    }
    if (!keyId && !authorize(request)) {
      const error = new HttpError(
        401,
        "Invalid or missing API key.",
        "authentication_error",
        "invalid_api_key",
      );
      response.setHeader("www-authenticate", "Bearer");
      writeError(response, error);
      logRequest(error.status);
      return;
    }
    const maxRequests = settings?.maxRequests ?? options.maxRequests;
    const timeoutMs = settings?.timeoutMs ?? options.requestTimeoutMs;
    const metadata: RequestRecord = {
      id: requestId,
      keyId: keyId ?? "legacy",
      model: "unknown",
      started,
      duration: 0,
      status: 0,
      error: null,
      usage: null,
    };
    const isCompletion =
      request.method === "POST" &&
      (url?.pathname === "/v1/chat/completions" ||
        url?.pathname === "/chat/completions");
    const saveRecord = (): void => {
      if (!administration || !isCompletion) return;
      try {
        administration.record({ ...metadata, duration: Date.now() - started });
      } catch {
        log("error", "usage_persistence_failed", { request_id: requestId });
      }
    };
    // Reject before allocating per-request resources when capacity is full.
    if (maxRequests > 0 && active >= maxRequests) {
      const overloaded = new HttpError(
        429,
        "The proxy is handling too many requests.",
        "rate_limit_error",
        "overloaded",
      );
      writeError(response, overloaded);
      logRequest(overloaded.status);
      metadata.status = 429;
      metadata.error = "overloaded";
      saveRecord();
      return;
    }
    active += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort(new Error("request timeout"));
      // Give abort-aware handlers the rest of this event-loop turn to emit an
      // OpenAI-shaped timeout. A handler stalled on HTTP backpressure cannot
      // make progress, so the fallback close releases its concurrency slot.
      setImmediate(() => {
        if (!response.writableEnded && !response.destroyed) response.destroy();
      });
    }, timeoutMs);
    timer.unref();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controllers.delete(controller);
      active -= 1;
      logRequest(response.statusCode);
    };
    response.once("finish", finish);
    response.once("close", () => {
      // Closing before the response finished is a client disconnect or a
      // deadline teardown; downstream work must stop either way.
      if (!response.writableFinished)
        controller.abort(new Error("client disconnected"));
      finish();
    });
    void route({
      request,
      response,
      ready,
      bodyLimit: options.bodyLimitBytes,
      signal: controller.signal,
      transport,
      continuations,
      root: options.root,
      requirements,
      resolveThreadConfig,
      implicitToolContinuation: options.implicitToolContinuation,
      log,
      requestId,
      url,
      localBridgeModel: settings?.model ?? options.localBridgeModel,
      observe: (value) => {
        if (value.model) metadata.model = value.model;
        if (value.usage) metadata.usage = value.usage;
        if (value.error) metadata.error = value.error;
      },
      agentService: options.agentService ?? false,
      localHostTools: options.localHostTools ?? false,
      localHealth:
        options.localBridgeModel === undefined
          ? undefined
          : {
              backend: "civitas-app-server",
              default_model: settings?.model ?? options.localBridgeModel,
              active: active - 1,
              max_concurrency: maxRequests || null,
              timeout_seconds: timeoutMs / 1000,
              max_body_bytes: options.bodyLimitBytes,
              ready,
            },
    })
      .catch((cause: unknown) => {
        const error =
          cause instanceof HttpError
            ? cause
            : controller.signal.aborted
              ? new HttpError(
                  408,
                  "The request timed out.",
                  "invalid_request_error",
                  "request_timeout",
                )
              : new HttpError(
                  500,
                  "An internal error occurred.",
                  "server_error",
                  "internal_error",
                );
        if (!(cause instanceof HttpError))
          log.failure("request_failed", { request_id: requestId }, cause);
        writeError(response, error);
        metadata.error = String(error.code);
      })
      .finally(() => {
        metadata.status =
          !response.writableFinished && controller.signal.aborted
            ? controller.signal.reason?.message === "request timeout"
              ? 408
              : 499
            : response.statusCode;
        if (metadata.error && metadata.status < 400) metadata.status = 502;
        saveRecord();
      });
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    async models() {
      const catalog = await readModelCatalog(readyTransport(ready, transport), {
        signal: AbortSignal.timeout(15000),
      });
      return [
        ...new Set(
          catalog.filter((model) => !model.hidden).map((model) => model.model),
        ),
      ];
    },
    async completeText(body: unknown, signal: AbortSignal) {
      const rpc = readyTransport(ready, transport);
      if (!continuations)
        throw new HttpError(
          503,
          "The app-server transport is unavailable.",
          "server_error",
          "app_server_not_ready",
        );
      const settings = administration?.settings();
      const maxRequests = settings?.maxRequests ?? options.maxRequests;
      if (maxRequests > 0 && active >= maxRequests)
        throw new HttpError(
          429,
          "The proxy is handling too many requests.",
          "rate_limit_error",
          "overloaded",
        );
      if (signal.aborted) throw signal.reason;
      const requestId = randomUUID();
      const started = Date.now();
      const metadata: RequestRecord = {
        id: requestId,
        keyId: "legacy",
        model: "unknown",
        started,
        duration: 0,
        status: 502,
        error: null,
        usage: null,
      };
      const controller = new AbortController();
      const cancel = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("request timeout")),
        settings?.timeoutMs ?? options.requestTimeoutMs,
      );
      timer.unref();
      controllers.add(controller);
      active += 1;
      try {
        const result = await executeTextCompletion(body, {
          rpc,
          log,
          requestId,
          signal: controller.signal,
          continuations,
          root: options.root,
          requirements,
          resolveThreadConfig,
          implicitToolContinuation: options.implicitToolContinuation,
          observe: (value) => {
            if (value.model) metadata.model = value.model;
            if (value.usage) metadata.usage = value.usage;
            if (value.error) metadata.error = value.error;
          },
        });
        metadata.status = 200;
        return result.content;
      } catch (error) {
        metadata.status = controller.signal.aborted ? 499 : 502;
        metadata.error =
          error instanceof HttpError
            ? String(error.code)
            : "internal_completion_failed";
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        controllers.delete(controller);
        active -= 1;
        if (administration) {
          try {
            administration.record({
              ...metadata,
              duration: Date.now() - started,
            });
          } catch {
            log("error", "usage_persistence_failed", { request_id: requestId });
          }
        }
      }
    },
    status: () => ({ ready, active }),
    server,
    setReady(value) {
      ready = value;
    },
    setTransport(
      value: JsonRpcTransport | undefined,
      nextRequirements?: PolicyRequirements,
      nextThreadConfigResolver?: ThreadConfigResolver,
    ) {
      // Update requirements before the same-transport short-circuit so a refresh
      // of managed policy against an unchanged transport still takes effect.
      requirements = nextRequirements ?? UNRESTRICTED_POLICY_REQUIREMENTS;
      resolveThreadConfig = nextThreadConfigResolver;
      if (transport === value) return;
      continuations?.dispose();
      if (transport && transport !== value)
        transport.close(new Error("app-server transport replaced"));
      transport = value;
      continuations = value
        ? new ContinuationCoordinator(continuationStore, value)
        : undefined;
    },
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(
          { host: options.host, port: options.port, exclusive: true },
          () => {
            server.off("error", onError);
            const address = server.address();
            if (address === null || typeof address === "string")
              return reject(
                new Error("Listener did not return a TCP address."),
              );
            resolve({ address: address.address, port: address.port });
          },
        );
      }),
    close: () =>
      new Promise((resolve, reject) => {
        continuations?.dispose();
        transport?.close(new Error("proxy shutting down"));
        continuations = undefined;
        transport = undefined;
        controllers.forEach((controller) =>
          controller.abort(new Error("server shutting down")),
        );
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        const force = setTimeout(() => {
          sockets.forEach((socket) => socket.destroy());
          server.closeAllConnections();
        }, options.shutdownTimeoutMs);
        force.unref();
      }),
  };
}

/** Everything one routed request needs from the server's current state. */
interface RouteContext {
  observe?: ChatHandlerOptions["observe"];
  request: IncomingMessage;
  response: ServerResponse;
  ready: boolean;
  bodyLimit: number;
  signal: AbortSignal;
  transport: JsonRpcTransport | undefined;
  continuations: ContinuationCoordinator | undefined;
  root: string;
  requirements: PolicyRequirements;
  resolveThreadConfig: ThreadConfigResolver | undefined;
  implicitToolContinuation: boolean;
  log: Logger;
  requestId: string;
  url: URL | undefined;
  localBridgeModel: string | undefined;
  agentService: boolean;
  localHostTools: boolean;
  localHealth: Record<string, unknown> | undefined;
}

/** Routes the intentionally small public HTTP surface. */
async function route({
  request,
  response,
  ready,
  bodyLimit,
  signal,
  transport,
  continuations,
  root,
  requirements,
  resolveThreadConfig,
  implicitToolContinuation,
  log,
  requestId,
  url,
  localBridgeModel,
  agentService,
  localHostTools,
  localHealth,
  observe,
}: RouteContext): Promise<void> {
  if (request.method === "GET" && url?.pathname === "/health") {
    writeJson(response, 200, { status: "ok", ...localHealth });
    return;
  }
  if (request.method === "GET" && url?.pathname === "/ready") {
    writeJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
    });
    return;
  }
  if (request.method === "GET" && url?.pathname === "/v1/models") {
    await handleModelList(response, {
      includeLocalAlias: localBridgeModel !== undefined,
      rpc: readyTransport(ready, transport),
      log,
      requestId,
      signal,
    });
    return;
  }
  if (
    request.method === "POST" &&
    (url?.pathname === "/v1/chat/completions" ||
      (localBridgeModel !== undefined && url?.pathname === "/chat/completions"))
  ) {
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      throw new HttpError(
        415,
        "Content-Type must be application/json.",
        "invalid_request_error",
        "unsupported_media_type",
      );
    const body = await readJsonBody(request, bodyLimit, signal);
    const rpc = readyTransport(ready, transport);
    if (!continuations)
      throw new HttpError(
        503,
        "The app-server transport is unavailable.",
        "server_error",
        "app_server_not_ready",
      );
    await handleChatCompletion(
      adaptLocalBridgeRequest(
        body,
        localBridgeModel,
        agentService,
        localHostTools,
      ),
      response,
      {
        rpc,
        observe,
        log,
        requestId,
        signal,
        continuations,
        root,
        requirements,
        resolveThreadConfig,
        implicitToolContinuation,
      },
    );
    return;
  }
  throw new HttpError(
    404,
    "The requested route was not found.",
    "not_found_error",
    "route_not_found",
  );
}

/** Returns the ready authenticated app-server transport required by HTTP work. */
function readyTransport(
  ready: boolean,
  transport: JsonRpcTransport | undefined,
): JsonRpcTransport {
  if (!ready)
    throw new HttpError(
      503,
      "The app-server is not ready.",
      "server_error",
      "app_server_not_ready",
    );
  if (!transport)
    throw new HttpError(
      503,
      "The app-server transport is unavailable.",
      "server_error",
      "app_server_not_ready",
    );
  return transport;
}

/** Rejects hostile authorities and every browser-originated request. */
function validateRequestAuthority(
  request: IncomingMessage,
): HttpError | undefined {
  if (!isAllowedHost(request.headers.host))
    return new HttpError(
      403,
      "The Host header must identify a loopback address.",
      "invalid_request_error",
      "invalid_host_header",
      "host",
    );
  // The proxy has no browser authentication surface. Rejecting Origin entirely
  // keeps cross-origin and browser form traffic fail-closed, while ordinary CLI
  // and server-side HTTP clients (which omit Origin) remain compatible.
  if (request.headers.origin !== undefined)
    return new HttpError(
      403,
      "Browser-originated requests are not accepted.",
      "invalid_request_error",
      "invalid_origin_header",
      "origin",
    );
  return undefined;
}

/** Accepts only explicit loopback HTTP authorities with an optional valid port. */
function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/i.exec(host);
  if (!match) return false;
  if (match[2] === undefined) return true;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Creates the stable error returned when a request body exceeds its limit. */
function bodyTooLargeError(): HttpError {
  return new HttpError(
    413,
    "Request body is too large.",
    "invalid_request_error",
    "body_too_large",
  );
}

/** Reads and parses a size-limited, abortable JSON request body. */
async function readJsonBody(
  request: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw bodyTooLargeError();
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const result: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      cleanup();
      // Pausing instead of destroying preserves the socket long enough for the
      // route to return its OpenAI-shaped body-limit or timeout response.
      request.pause();
      reject(error);
    };
    const onData = (raw: Buffer): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > limit) {
        fail(bodyTooLargeError());
        return;
      }
      result.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(result);
    };
    const onError = (): void =>
      fail(
        new HttpError(
          400,
          "The request body could not be read.",
          "invalid_request_error",
          "invalid_body",
        ),
      );
    const onAbort = (): void => fail(signal.reason);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "The request body is not valid JSON.",
      "invalid_request_error",
      "invalid_json",
    );
  }
}
