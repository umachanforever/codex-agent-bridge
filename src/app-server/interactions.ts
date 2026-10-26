import { randomUUID } from "node:crypto";
import { record } from "../core/canonical.js";
import type { JsonRpcTransport, ServerRequest } from "./json-rpc.js";

/** Question fields exposed to clients; fixtures check the generated wire types. */
export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

/** Supported wire subset kept independent from generated Node-incompatible sources. */
type InteractionRequest =
  | {
      id: string | number;
      method: "item/tool/requestUserInput";
      params: { threadId: string; turnId: string; questions: InputQuestion[] };
    }
  | {
      id: string | number;
      method: "mcpServer/elicitation/request";
      params: {
        threadId: string;
        turnId: string | null;
        serverName: string;
        message: string;
      } & (
        | { mode: "url"; url: string }
        | { mode: "form"; requestedSchema: unknown }
      );
    };

/** Validated answer shapes sent back to app-server. */
type InteractionResponse =
  | { answers: Record<string, { answers: string[] }> }
  | { action: "accept" | "decline" | "cancel"; content: unknown; _meta: null };

/** In-memory client view; upstream request ids never become reply selectors. */
export type Interaction = InteractionRequest & {
  id: string;
  requestId: string;
};

/** One completion owns its pending interactions until its signal or turn ends. */
interface Scope {
  rpc: JsonRpcTransport;
  threadId: string;
  requestId: string;
  threads: Set<string>;
  currentTurn: () => string | undefined;
  client?: { channel: string; owner: string } | undefined;
}

/** A pending callback retains its original transport across process restarts. */
interface Pending {
  view: Interaction;
  request: InteractionRequest;
  scope: Scope;
}

/** A renderable standard MCP form field. */
export type FormField = Record<string, unknown> & { type: string };

/** Rejects unsupported form shapes rather than silently dropping constraints. */
export function formFields(
  value: unknown,
): Record<string, FormField> | undefined {
  const schema = record(value);
  const properties = record(schema?.properties);
  if (
    schema?.type !== "object" ||
    !properties ||
    Object.keys(properties).length > 64
  )
    return;
  if (
    Object.keys(schema).some(
      (key) => !["$schema", "type", "properties", "required"].includes(key),
    )
  )
    return;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
      ))
  )
    return;
  const fields: Record<string, FormField> = Object.create(null);
  for (const [key, value] of Object.entries(properties)) {
    const field = record(value);
    if (["__proto__", "constructor", "prototype"].includes(key)) return;
    if (
      !field ||
      !["string", "number", "integer", "boolean"].includes(String(field.type))
    )
      return;
    if (
      Object.keys(field).some(
        (name) =>
          ![
            "type",
            "title",
            "description",
            "default",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "enum",
            "enumNames",
            "oneOf",
          ].includes(name),
      )
    )
      return;
    if (
      field.enum !== undefined &&
      (!Array.isArray(field.enum) ||
        !field.enum.every((entry) => typeof entry === "string"))
    )
      return;
    if (
      field.oneOf !== undefined &&
      (!Array.isArray(field.oneOf) ||
        !field.oneOf.every(
          (entry) =>
            typeof record(entry)?.const === "string" &&
            typeof record(entry)?.title === "string",
        ))
    )
      return;
    for (const name of ["minLength", "maxLength", "minimum", "maximum"]) {
      if (
        field[name] !== undefined &&
        (typeof field[name] !== "number" || !Number.isFinite(field[name]))
      )
        return;
    }
    fields[key] = field as FormField;
  }
  return fields;
}

/** Validates form answers against exactly the supported upstream constraints. */
function formAnswer(
  schemaValue: unknown,
  value: unknown,
): Record<string, unknown> {
  const fields = formFields(schemaValue);
  const content = record(value);
  const schema = record(schemaValue)!;
  if (
    !fields ||
    !content ||
    Object.keys(content).some((key) => !Object.hasOwn(fields, key))
  )
    throw new Error("Invalid form fields.");
  const required = (schema.required ?? []) as string[];
  for (const [key, field] of Object.entries(fields)) {
    const answer = content[key];
    if (answer === undefined) {
      if (required.includes(key))
        throw new Error("A required field is missing.");
      continue;
    }
    if (
      field.type === "boolean"
        ? typeof answer !== "boolean"
        : field.type === "string"
          ? typeof answer !== "string"
          : typeof answer !== "number" ||
            !Number.isFinite(answer) ||
            (field.type === "integer" && !Number.isInteger(answer))
    )
      throw new Error("Invalid field type.");
    if (typeof answer === "string") {
      const length = [...answer].length;
      if (
        (typeof field.minLength === "number" && length < field.minLength) ||
        (typeof field.maxLength === "number" && length > field.maxLength)
      )
        throw new Error("Invalid field length.");
      if (Array.isArray(field.enum) && !field.enum.includes(answer))
        throw new Error("Invalid field option.");
      if (
        Array.isArray(field.oneOf) &&
        !field.oneOf.some((option) => record(option)?.const === answer)
      )
        throw new Error("Invalid field option.");
    }
    if (
      typeof answer === "number" &&
      ((typeof field.minimum === "number" && answer < field.minimum) ||
        (typeof field.maximum === "number" && answer > field.maximum))
    )
      throw new Error("Invalid field range.");
  }
  return content;
}

/** Holds human callbacks only in memory and cancels them with their completion. */
export class InteractionBroker {
  readonly #scopes = new Set<Scope>();
  readonly #pending = new Map<string, Pending>();

  /** Registers before turn/start, since callbacks can precede its RPC response. */
  bind(
    rpc: JsonRpcTransport,
    threadId: string,
    requestId: string,
    signal: AbortSignal,
    currentTurn: () => string | undefined = () => undefined,
    client?: { channel: string; owner: string },
  ): () => void {
    if (client && this.hasChannel(client))
      throw new Error("Interaction channel is already active.");
    const scope = {
      rpc,
      threadId,
      requestId,
      threads: new Set([threadId]),
      currentTurn,
      client,
    };
    const finish = (respond = true): void => {
      this.#scopes.delete(scope);
      signal.removeEventListener("abort", onAbort);
      rpc.off("close", onClose);
      rpc.off("notification", onNotification);
      for (const [id, pending] of this.#pending) {
        if (pending.scope !== scope) continue;
        this.#pending.delete(id);
        if (respond)
          this.#reply(
            pending,
            pending.request.method === "item/tool/requestUserInput"
              ? { answers: {} }
              : { action: "cancel", content: null, _meta: null },
          );
      }
    };
    const onAbort = (): void => finish();
    const onClose = (): void => finish(false);
    const onNotification = (method: string, value: unknown): void => {
      const params = record(value);
      if (method === "thread/started") {
        const thread = record(params?.thread);
        if (
          typeof thread?.id === "string" &&
          typeof thread.parentThreadId === "string" &&
          scope.threads.has(thread.parentThreadId)
        )
          scope.threads.add(thread.id);
      }
      if (!scope.threads.has(String(params?.threadId))) return;
      if (method === "turn/completed") {
        const pendingTurn = [...this.#pending.values()].find(
          (pending) =>
            pending.scope === scope &&
            pending.request.params.threadId === params?.threadId,
        )?.request.params.turnId;
        const expectedTurn =
          params?.threadId === threadId
            ? (currentTurn() ?? pendingTurn)
            : pendingTurn;
        if (!expectedTurn || record(params?.turn)?.id !== expectedTurn) return;
        if (params?.threadId === threadId) finish(false);
        else
          for (const [id, pending] of this.#pending) {
            if (
              pending.scope === scope &&
              pending.request.params.threadId === params?.threadId
            ) {
              this.#pending.delete(id);
            }
          }
      }
      if (method === "serverRequest/resolved") {
        for (const [id, pending] of this.#pending)
          if (
            pending.scope === scope &&
            pending.request.id === params?.requestId
          )
            this.#pending.delete(id);
      }
    };
    if (!signal.aborted) {
      this.#scopes.add(scope);
      signal.addEventListener("abort", onAbort, { once: true });
      rpc.once("close", onClose);
      rpc.on("notification", onNotification);
    }
    return finish;
  }

  /** Claims only supported callbacks belonging to a currently active completion. */
  handle(rpc: JsonRpcTransport, request: ServerRequest): boolean {
    if (
      request.method !== "item/tool/requestUserInput" &&
      request.method !== "mcpServer/elicitation/request"
    )
      return false;
    const params = record(request.params);
    const scope = [...this.#scopes].find(
      (value) =>
        value.rpc === rpc && value.threads.has(String(params?.threadId)),
    );
    if (!scope || !params || typeof params.threadId !== "string") return false;
    const expectedTurn = scope.currentTurn();
    if (
      params.threadId === scope.threadId &&
      expectedTurn &&
      typeof params.turnId === "string" &&
      params.turnId !== expectedTurn
    )
      return false;
    if (
      [...this.#pending.values()].some(
        (pending) =>
          pending.scope === scope && pending.request.id === request.id,
      )
    )
      return true;
    if (request.method === "item/tool/requestUserInput") {
      if (
        !Array.isArray(params.questions) ||
        params.questions.length > 16 ||
        !params.questions.every((value) => {
          const question = record(value);
          return (
            typeof question?.id === "string" &&
            !["__proto__", "constructor", "prototype"].includes(question.id) &&
            typeof question.header === "string" &&
            typeof question.isSecret === "boolean" &&
            typeof question.isOther === "boolean" &&
            typeof question.question === "string" &&
            (question.options === null ||
              (Array.isArray(question.options) &&
                question.options.every(
                  (option) => typeof record(option)?.label === "string",
                )))
          );
        })
      )
        return false;
    } else if (params.mode === "url") {
      try {
        const url = new URL(String(params.url));
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return false;
      } catch {
        return false;
      }
    } else if (params.mode !== "form" || !formFields(params.requestedSchema))
      return false;
    // Bound retained payloads without persisting prompts, form values, or authorization URLs.
    if (this.#pending.size >= 128 || JSON.stringify(params).length > 65536)
      return false;
    const id = randomUUID();
    this.#pending.set(id, {
      view: {
        id,
        requestId: scope.requestId,
        method: request.method,
        params: request.params as InteractionRequest["params"],
      } as Interaction,
      request: request as InteractionRequest,
      scope,
    });
    return true;
  }

  /** Prevents two active completions from sharing a client interaction channel. */
  hasChannel(client: { channel: string; owner: string }): boolean {
    return [...this.#scopes].some(
      (scope) =>
        scope.client?.channel === client.channel &&
        scope.client.owner === client.owner,
    );
  }

  /** Filters pending interactions by both client channel and authenticated owner. */
  list(client?: { channel: string; owner: string }): Interaction[] {
    return [...this.#pending.values()]
      .filter(
        (pending) =>
          !client ||
          (pending.scope.client?.channel === client.channel &&
            pending.scope.client.owner === client.owner),
      )
      .map((pending) => pending.view);
  }

  /** Validates a human reply, consumes it once, and resumes the original RPC. */
  resolve(
    id: string,
    value: unknown,
    client?: { channel: string; owner: string },
  ): boolean {
    const pending = this.#pending.get(id);
    if (
      !pending ||
      (client &&
        (pending.scope.client?.channel !== client.channel ||
          pending.scope.client.owner !== client.owner))
    )
      return false;
    const input = record(value);
    if (!input) throw new Error("A response object is required.");
    let response: InteractionResponse;
    if (pending.request.method === "item/tool/requestUserInput") {
      const answers = record(input.answers);
      const questions = pending.request.params.questions;
      if (
        !answers ||
        Object.keys(answers).some(
          (key) => !questions.some((question) => question.id === key),
        )
      )
        throw new Error("Invalid question ids.");
      for (const [key, value] of Object.entries(answers)) {
        const question = questions.find((question) => question.id === key)!;
        const answer = record(value);
        if (
          !Array.isArray(answer?.answers) ||
          !answer.answers.every(
            (text) =>
              typeof text === "string" &&
              text.length <= 16384 &&
              (question.isOther ||
                !question.options?.length ||
                question.options.some((option) => option.label === text)),
          )
        )
          throw new Error("Invalid question answer.");
      }
      response = {
        answers: answers as Record<string, { answers: string[] }>,
      };
    } else {
      if (!["accept", "decline", "cancel"].includes(String(input.action)))
        throw new Error("Invalid elicitation action.");
      const params = pending.request.params;
      response = {
        action: input.action as "accept" | "decline" | "cancel",
        content:
          input.action === "accept" && params.mode === "form"
            ? formAnswer(params.requestedSchema, input.content)
            : null,
        _meta: null,
      };
    }
    this.#pending.delete(id);
    this.#reply(pending, response);
    return true;
  }

  /** Never retry a callback after its original transport has closed. */
  #reply(pending: Pending, value: unknown): void {
    try {
      pending.scope.rpc.respond(pending.request.id, value);
    } catch {
      /* Transport closure already cancels the completion. */
    }
  }
}
