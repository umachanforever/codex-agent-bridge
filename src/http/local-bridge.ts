import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { record } from "../core/canonical.js";
import { HttpError } from "./errors.js";

/** Converts text-only client content while retaining supported user images. */
function normalizeMessage(value: unknown, index: number): unknown {
  const original = record(value);
  if (!original) return value;
  // Project protocol input, not client-specific bookkeeping. Future client
  // metadata cannot accidentally become instructions or execution policy.
  const message: Record<string, unknown> = {};
  for (const key of [
    "role",
    "content",
    "name",
    "tool_call_id",
    "tool_calls",
    "tool_results",
    "reasoning",
    "reasoning_content",
    "audio",
    "refusal",
    "annotations",
  ]) {
    if (Object.hasOwn(original, key)) message[key] = original[key];
  }
  // SDKs replay nullable response metadata. Only remove empty optional values;
  // meaningful refusal/audio/annotation data must still be explicitly rejected.
  if (message.role === "assistant") {
    for (const key of [
      "tool_calls",
      "reasoning",
      "reasoning_content",
      "refusal",
      "audio",
      "annotations",
    ])
      if (message[key] === null) delete message[key];
    if (Array.isArray(message.annotations) && message.annotations.length === 0)
      delete message.annotations;
  }
  // Interrupted and reasoning-only assistant turns may omit visible content.
  // Keep their position so pending tool-result correlation remains unchanged.
  if (message.role === "assistant" && message.content === undefined)
    message.content = null;
  if (!Array.isArray(message.content)) return message;
  // The validator checks every part, including malformed ones, and preserves
  // media order. Never flatten a mixed message into a text-only prompt.
  if (
    message.role === "user" &&
    message.content.some((value: unknown) =>
      ["image_url", "input_audio", "file"].includes(
        String(record(value)?.type),
      ),
    )
  )
    return message;
  const content = message.content
    .map((value: unknown, partIndex: number) => {
      const part = record(value);
      const param = `messages.${index}.content.${partIndex}`;
      if (!part || typeof part.type !== "string")
        throw new HttpError(
          400,
          "Each content part must be a typed text object.",
          "invalid_request_error",
          "invalid_content_part",
          param,
        );
      if (
        message.role === "assistant" &&
        (part.type === "thinking" || part.type === "reasoning")
      ) {
        if (typeof (part.thinking ?? part.text) !== "string")
          throw new HttpError(
            400,
            "Assistant reasoning parts require string text.",
            "invalid_request_error",
            "invalid_content_part",
            param,
          );
        // Like the response-only reasoning fields, replayed thinking must not
        // become instructions or impersonate app-server's reasoning state.
        return "";
      }
      if (
        part.type !== "text" &&
        part.type !== "input_text" &&
        !(message.role === "assistant" && part.type === "output_text")
      )
        throw new HttpError(
          400,
          "Only text content parts are supported; image, audio, file and other non-text parts cannot be forwarded.",
          "invalid_request_error",
          "unsupported_content_type",
          `${param}.type`,
        );
      if (typeof part.text !== "string")
        throw new HttpError(
          400,
          "Text content parts require a string text field.",
          "invalid_request_error",
          "invalid_content_part",
          `${param}.text`,
        );
      return part.text;
    })
    .join("");
  return { ...message, content };
}

/** Maps the standard omitted function schema to an explicit zero-argument schema. */
function normalizeTool(value: unknown): unknown {
  const tool = record(value);
  const fn = record(tool?.function);
  if (tool?.type !== "function" || !fn || fn.parameters !== undefined)
    return value;
  return {
    ...tool,
    function: {
      ...fn,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };
}

/** Builds an opt-in, fail-closed bearer gate without retaining a plaintext key. */
export function localBridgeAuthorizer(
  enabled: boolean,
): (request: IncomingMessage) => boolean {
  if (!enabled) return () => true;
  const file = process.env.CODEX_BRIDGE_TOKEN_FILE;
  if (file !== undefined && process.env.CODEX_BRIDGE_TOKEN !== undefined)
    throw new Error("Set only CODEX_BRIDGE_TOKEN or CODEX_BRIDGE_TOKEN_FILE.");
  // Secret files commonly end in a newline; embedded whitespace is invalid.
  const token =
    file === undefined
      ? process.env.CODEX_BRIDGE_TOKEN
      : readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!token || token.trim() !== token || /\s/.test(token))
    throw new Error("CODEX_BRIDGE_TOKEN must contain a nonempty bearer key.");
  const expected = createHash("sha256").update(token).digest();
  return (request) => {
    const header = request.headers.authorization;
    if (!header || !/^Bearer [^\s]+$/i.test(header)) return false;
    const actual = createHash("sha256").update(header.slice(7)).digest();
    return timingSafeEqual(expected, actual);
  };
}

/** Applies legacy defaults before the ordinary validator and managed-policy checks. */
export function adaptLocalBridgeRequest(
  value: unknown,
  model: string | undefined,
): unknown {
  if (model === undefined) return value;
  const body = record(value);
  if (!body) return value;
  const extension = record(body.x_codex);
  // Leave malformed extensions intact for the normal validator to reject.
  if (body.x_codex !== undefined && !extension) return value;
  return {
    ...body,
    ...(Array.isArray(body.messages)
      ? { messages: body.messages.map(normalizeMessage) }
      : {}),
    ...(Array.isArray(body.tools)
      ? { tools: body.tools.map(normalizeTool) }
      : {}),
    model:
      body.model === undefined || body.model === "codex-cli"
        ? model
        : body.model,
    x_codex: {
      // Explicit client restrictions override the personal-use full-access default.
      sandbox: "danger-full-access",
      ...extension,
    },
  };
}
