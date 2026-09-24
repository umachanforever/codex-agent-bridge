import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { record } from "../core/canonical.js";

/** Error fields accepted when replying to an app-server request. */
export interface RpcErrorData {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC error returned for a request initiated by this process. */
export class RpcError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** An app-server request awaiting a response from this process. */
export interface ServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

/** Resolves or rejects an outgoing request exactly once. */
interface PendingRequest {
  settle(error: unknown, value?: unknown): void;
}

/** Correlates newline-framed JSON-RPC requests with app-server responses. */
export class JsonRpcTransport extends EventEmitter {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #nextId = 1;
  #closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    super();
    // Each active completion subscribes to the same transport; listener count
    // reflects concurrency, not a leak.
    this.setMaxListeners(0);
    input.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
      this.#accept(text);
    });
    input.on("end", () => {
      this.#accept(this.#decoder.end());
      if (!this.#closed && this.#buffer.trim()) this.#dispatch(this.#buffer);
      this.#buffer = "";
      this.close();
    });
    input.on("close", () => this.close());
    input.on("error", (error: Error) => this.close(error));
    output.on("error", (error: Error) => this.close(error));
  }

  /** Sends one request and rejects it if cancelled or the transport closes. */
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error("app-server transport is closed"));
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("request cancelled"));

    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        pending.settle(signal?.reason ?? new Error("request cancelled"));
      };
      const pending: PendingRequest = {
        settle: (error, value) => {
          if (settled) return;
          settled = true;
          this.#pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          if (error !== undefined) reject(error);
          else resolve(value);
        },
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Cancellation can race listener registration; do not write a cancelled
      // request onto the wire.
      if (signal?.aborted) onAbort();
      if (settled) return;
      try {
        this.#send({ id, method, params });
      } catch (error) {
        pending.settle(error);
      }
    });
  }

  /** Sends a one-way client notification. */
  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  /** Replies to a server-initiated request. */
  respond(id: string | number, result: unknown): void {
    this.#send({ id, result });
  }

  /** Replies to a server-initiated request with a JSON-RPC error. */
  respondError(id: string | number, error: RpcErrorData): void {
    this.#send({ id, error });
  }

  /** Stops dispatch and fails all requests still awaiting replies. */
  close(reason: Error = new Error("app-server transport closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#pending.values()) request.settle(reason);
    this.#pending.clear();
    this.emit("close", reason);
  }

  /** Writes exactly one JSON message and its line terminator. */
  #send(message: object): void {
    if (this.#closed) throw new Error("app-server transport is closed");
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  /** Converts arbitrary stream chunks into complete lines. */
  #accept(text: string): void {
    if (this.#closed) return;
    this.#buffer += text;
    let end: number;
    while (!this.#closed && (end = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(end + 1);
      if (line.trim()) this.#dispatch(line);
    }
  }

  /** Dispatches a complete frame by its JSON-RPC shape. */
  #dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit("malformed", line);
      this.close(new Error("app-server emitted malformed JSON"));
      return;
    }
    const frame = record(parsed);
    if (!frame) {
      this.emit("malformed", line);
      return;
    }
    const id = frame.id;
    if (
      (typeof id === "number" || typeof id === "string") &&
      ("result" in frame || "error" in frame)
    ) {
      this.#settleResponse(id, frame, line);
      return;
    }
    if (typeof frame.method !== "string") {
      this.emit("malformed", line);
      return;
    }
    if (typeof id === "number" || typeof id === "string") {
      this.emit("request", {
        id,
        method: frame.method,
        params: frame.params,
      } satisfies ServerRequest);
    } else {
      this.emit("notification", frame.method, frame.params);
    }
  }

  /** Settles a matched client request; stale and foreign IDs are ignored. */
  #settleResponse(
    id: string | number,
    frame: Record<string, unknown>,
    line: string,
  ): void {
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (!("error" in frame)) {
      pending.settle(undefined, frame.result);
      return;
    }
    const error = record(frame.error);
    if (!error || typeof error.code !== "number") {
      this.emit("malformed", line);
      pending.settle(new Error("app-server emitted malformed JSON-RPC error"));
      return;
    }
    pending.settle(
      new RpcError(error.code, String(error.message ?? "JSON-RPC error")),
    );
  }
}
