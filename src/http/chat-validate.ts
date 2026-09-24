import { record } from "../core/canonical.js";
import type { Logger } from "../core/logger.js";
import {
  validateRequestPolicy,
  type EffectivePolicy,
  type PolicyError,
  type RequestPolicy,
} from "../core/policy.js";
import type { StoredToolCall } from "../continuation/state.js";
import { HttpError } from "./errors.js";
import {
  generationOptions,
  type GenerationOptions,
} from "./generation-options.js";

/** Chat Completions reasoning-effort values supported by the public API. */
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** A validated Chat Completions reasoning-effort value. */
export type ChatReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Narrows an unknown value to one supported reasoning effort. */
function isReasoningEffort(value: unknown): value is ChatReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * Response-only reasoning field names accepted on a replayed assistant message.
 * `reasoning` is the proxy's own x_codex extension; `reasoning_content` is the
 * equivalent field OpenAI-compatible clients such as the Vercel AI SDK replay.
 */
const REASONING_FIELDS = ["reasoning", "reasoning_content"] as const;

/** A validated user content part, retaining the order of input modalities. */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" }
  | { type: "audio"; url: string }
  | { type: "file"; filename: string; data: string };

/** A validated Chat Completions message. */
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  contentParts?: UserContentPart[];
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * Call IDs this assistant message answered with its own `tool_results`, so
   * Codex activity app-server owns stays distinguishable from a client call
   * still awaiting a `role: "tool"` result. The results themselves are
   * deliberately not retained.
   */
  internalToolCallIds?: string[];
}

/** Returns the terminal contiguous block of client-supplied tool results. */
function terminalToolResultBlock(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  let first = messages.length;
  while (messages[first - 1]?.role === "tool") first -= 1;
  return messages.slice(first);
}

/** The final tool batch selected for pending-batch correlation. */
export interface ToolBatchSelection {
  /** The assistant message immediately preceding the result block, if present. */
  assistant: ChatMessage | undefined;
  /** The contiguous `role: "tool"` block that must match a pending batch. */
  results: ChatMessage[];
  /** Consecutive user messages after the result block, in transcript order. */
  suffixUsers: ChatMessage[];
}

/** Selects the final result block, its preceding assistant, and user suffix. */
function selectToolBatch(messages: readonly ChatMessage[]): ToolBatchSelection {
  // Walk backward over the final consecutive user messages, then over the
  // contiguous tool-result block. Never search older rounds for matching IDs
  // and never merge separated result blocks: only the terminal batch and its
  // immediate suffix are continuation candidates.
  let userStart = messages.length;
  while (messages[userStart - 1]?.role === "user") userStart -= 1;
  let resultStart = userStart;
  while (messages[resultStart - 1]?.role === "tool") resultStart -= 1;
  const preceding = messages[resultStart - 1];
  return {
    assistant: preceding?.role === "assistant" ? preceding : undefined,
    results: messages.slice(resultStart, userStart),
    suffixUsers: messages.slice(userStart),
  };
}

/** The Stage 04 request subset after validation. */
export interface ChatRequest {
  generation?: GenerationOptions;
  model: string;
  reasoningEffort?: ChatReasoningEffort;
  messages: ChatMessage[];
  /**
   * The terminal contiguous `role: "tool"` block, derived once during
   * validation. Implicit continuation lookup, the expired-record fallback
   * reason, and the ready-record tool-result rejection read this terminal
   * view; explicit pending-batch correlation instead reads `toolBatch`.
   */
  terminalToolResults: ChatMessage[];
  /**
   * The final tool batch with its preceding assistant message and any user
   * suffix, derived once during validation. Explicit pending-batch
   * correlation reads this view, which permits consecutive user messages
   * after the result block; a terminal tool block yields the same
   * representation with an empty suffix.
   */
  toolBatch: ToolBatchSelection;
  stream: boolean;
  includeUsage: boolean;
  dynamicTools: Array<Record<string, unknown>>;
  previousResponseId?: string;
  policy: EffectivePolicy;
}

/** A validated request awaiting filesystem and managed-policy resolution. */
export type ParsedChatRequest = Omit<ChatRequest, "policy"> & {
  requestPolicy: RequestPolicy;
};

/** Validates the deliberately narrow request surface implemented in Stage 04. */
export function validateRequest(
  value: unknown,
  log: Logger,
  requestId: string,
  implicitToolContinuation: boolean,
): ParsedChatRequest {
  const body = record(value);
  if (!body) invalid("Request body must be a JSON object.", null);
  if (typeof body.model !== "string" || body.model.trim() === "")
    invalid("model must be a non-empty string.", "model");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    invalid("messages must be a non-empty array.", "messages");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    invalid("stream must be a boolean.", "stream");
  // These controls change the number or shape of model responses. Ignoring
  // them would claim a limit or tool behavior that app-server cannot honor.
  for (const field of [
    "functions",
    "function_call",
    "max_tokens",
    "max_completion_tokens",
  ])
    if (body[field] != null) unsupported(field);
  if (body.n != null && body.n !== 1) unsupported("n");
  if (body.parallel_tool_calls != null && body.parallel_tool_calls !== true)
    unsupported("parallel_tool_calls");
  const rawReasoningEffort = body.reasoning_effort;
  let reasoningEffort: ChatReasoningEffort | undefined;
  if (rawReasoningEffort !== undefined && rawReasoningEffort !== null) {
    if (!isReasoningEffort(rawReasoningEffort))
      invalid(
        `reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")}.`,
        "reasoning_effort",
      );
    reasoningEffort = rawReasoningEffort;
  }
  if (
    body.previous_response_id !== undefined &&
    (typeof body.previous_response_id !== "string" ||
      body.previous_response_id === "")
  )
    invalid(
      "previous_response_id must be a non-empty string.",
      "previous_response_id",
    );
  const requestPolicy = validateRequestPolicy(body.x_codex);
  const messages = body.messages.map((entry, index) =>
    validateMessage(entry, index),
  );
  // Only the terminal block can resolve an implicit continuation. Tool
  // messages before it are completed earlier rounds that `toHistoryItems`
  // replays into a fresh thread, so a full transcript needs no continuation
  // ID to be accepted. Explicit pending-batch correlation instead reads the
  // batch selection, which also admits a trailing user suffix after the
  // results.
  const terminalToolResults = terminalToolResultBlock(messages);
  const toolBatch = selectToolBatch(messages);
  if (
    !body.previous_response_id &&
    terminalToolResults.length &&
    !implicitToolContinuation
  )
    invalid(
      "Tool results require previous_response_id when implicit tool continuation is disabled.",
      "previous_response_id",
    );
  if (
    body.previous_response_id &&
    !["user", "tool"].includes(messages.at(-1)!.role)
  )
    invalid("A continuation must end with a user or tool message.", "messages");
  let includeUsage = true;
  if (body.stream_options !== undefined) {
    const streamOptions = record(body.stream_options);
    if (
      !streamOptions ||
      Object.keys(streamOptions).some((key) => key !== "include_usage") ||
      (streamOptions.include_usage !== undefined &&
        typeof streamOptions.include_usage !== "boolean")
    )
      invalid(
        "stream_options supports only a boolean include_usage field.",
        "stream_options",
      );
    includeUsage = streamOptions.include_usage !== false;
  }
  const dynamicTools = validateTools(body.tools, body.tool_choice);
  const generation = generationOptions(body);
  const supported = new Set([
    "model",
    "reasoning_effort",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "previous_response_id",
    "x_codex",
    "response_format",
    "verbosity",
    "service_tier",
  ]);
  const ignored = Object.keys(body).filter((key) => !supported.has(key));
  if (ignored.length)
    log("warn", "unsupported_chat_fields_ignored", {
      request_id: requestId,
      fields: ignored.sort(),
    });
  return {
    model: body.model as string,
    ...(generation ? { generation } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    messages,
    terminalToolResults,
    toolBatch,
    stream: body.stream === true,
    includeUsage,
    dynamicTools,
    requestPolicy,
    ...(typeof body.previous_response_id === "string"
      ? { previousResponseId: body.previous_response_id }
      : {}),
  };
}

/** Converts a safe policy failure to the public OpenAI error envelope. */
export function policyHttpError(error: PolicyError): HttpError {
  return new HttpError(
    400,
    error.message,
    "invalid_request_error",
    error.code,
    error.param,
  );
}

/** Validates a user image as an inline data URL without fetching remote content. */
function validateImagePart(value: unknown, param: string): UserContentPart {
  const image = record(value);
  if (!image || typeof image.url !== "string")
    invalid("image_url requires a string url.", `${param}.url`);
  if (Object.keys(image).some((key) => key !== "url" && key !== "detail"))
    invalid("image_url contains unsupported fields.", param);
  if (
    image.detail !== undefined &&
    image.detail !== "auto" &&
    image.detail !== "low" &&
    image.detail !== "high"
  )
    invalid("image_url.detail must be auto, low, or high.", `${param}.detail`);
  const match =
    /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      image.url,
    );
  if (!match || match[2]!.length % 4 !== 0)
    invalid(
      "image_url must be a base64 PNG, JPEG, WebP, or GIF data URL.",
      `${param}.url`,
    );
  if (match[2]!.length > 28_000_000)
    invalid("image_url exceeds the 20 MiB image limit.", `${param}.url`);
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== match[2])
    invalid(
      "image_url contains invalid or oversized base64 data.",
      `${param}.url`,
    );
  return {
    type: "image",
    url: image.url,
    ...(image.detail === undefined ? {} : { detail: image.detail }),
  };
}

/** Converts standard inline Chat Completions audio into an app-server data URL. */
function validateAudioPart(value: unknown, param: string): UserContentPart {
  const audio = record(value);
  if (!audio || typeof audio.data !== "string")
    invalid("input_audio requires base64 data.", `${param}.data`);
  if (audio.format !== "wav" && audio.format !== "mp3")
    invalid("input_audio.format must be wav or mp3.", `${param}.format`);
  if (Object.keys(audio).some((key) => key !== "data" && key !== "format"))
    invalid("input_audio contains unsupported fields.", param);
  const data = audio.data;
  if (
    data.length === 0 ||
    data.length > 28_000_000 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    invalid(
      "input_audio must contain at most 20 MiB of base64 data.",
      `${param}.data`,
    );
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== data)
    invalid(
      "input_audio contains invalid or oversized base64 data.",
      `${param}.data`,
    );
  return {
    type: "audio",
    url: `data:audio/${audio.format === "mp3" ? "mpeg" : "wav"};base64,${data}`,
  };
}

/** Validates an inline file before local conversion; paths and file IDs are not resolved. */
function validateFilePart(value: unknown, param: string): UserContentPart {
  const file = record(value);
  if (!file || typeof file.file_data !== "string")
    invalid("file requires inline base64 file_data.", `${param}.file_data`);
  if (
    typeof file.filename !== "string" ||
    file.filename.length === 0 ||
    file.filename.length > 128 ||
    /[\\/]/.test(file.filename) ||
    [...file.filename].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    invalid("file.filename must be a basename.", `${param}.filename`);
  if (
    Object.keys(file).some((key) => key !== "file_data" && key !== "filename")
  )
    invalid("file contains unsupported fields.", param);
  const match =
    /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      file.file_data,
    );
  if (!match || match[2]!.length > 28_000_000 || match[2]!.length % 4 !== 0)
    invalid(
      "file_data must be an inline base64 file of at most 20 MiB.",
      `${param}.file_data`,
    );
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    bytes.length > 20 * 1024 * 1024 ||
    bytes.toString("base64") !== match[2] ||
    (match[1]!.toLowerCase() === "application/pdf" &&
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
  )
    invalid(
      "file_data must contain valid file base64 data.",
      `${param}.file_data`,
    );
  return { type: "file", filename: file.filename, data: file.file_data };
}

/** Validates one role-preserving message and supported user content parts. */
function validateMessage(value: unknown, index: number): ChatMessage {
  const message = record(value);
  const param = `messages.${index}`;
  if (
    !message ||
    !["system", "developer", "user", "assistant", "tool"].includes(
      String(message.role),
    )
  )
    invalid(
      "Only system, developer, user, assistant, and tool messages are supported.",
      `${param}.role`,
    );
  let contentParts: UserContentPart[] | undefined;
  if (message.role === "user" && Array.isArray(message.content)) {
    if (message.content.length === 0)
      invalid("User content parts must be non-empty.", `${param}.content`);
    contentParts = message.content.map((raw, partIndex) => {
      const part = record(raw);
      const partParam = `${param}.content.${partIndex}`;
      if (part?.type === "image_url")
        return validateImagePart(part.image_url, `${partParam}.image_url`);
      if (part?.type === "input_audio")
        return validateAudioPart(part.input_audio, `${partParam}.input_audio`);
      if (part?.type === "file")
        return validateFilePart(part.file, `${partParam}.file`);
      if (
        (part?.type !== "text" && part?.type !== "input_text") ||
        typeof part.text !== "string" ||
        Object.keys(part).some((key) => key !== "type" && key !== "text")
      )
        invalid(
          "User content parts must be text, image_url, input_audio, or file objects.",
          partParam,
        );
      return { type: "text", text: part.text };
    });
  } else if (
    typeof message.content !== "string" &&
    !(message.role === "assistant" && message.content === null)
  )
    invalid("Message content must be a string.", `${param}.content`);
  const allowed = new Set([
    "role",
    "content",
    "name",
    "tool_call_id",
    "tool_calls",
    "tool_results",
    ...REASONING_FIELDS,
  ]);
  // Name the offending keys: clients send provider-specific extras, and a bare
  // rejection gives them nothing to fix.
  const unsupported = Object.keys(message)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unsupported.length)
    invalid(
      `This message contains unsupported fields: ${unsupported.join(", ")}.`,
      param,
    );
  // These fields are response-only. Accept the proxy's own output when a client
  // replays a transcript, but never make either one model-visible.
  for (const field of REASONING_FIELDS)
    if (
      message[field] !== undefined &&
      (message.role !== "assistant" || typeof message[field] !== "string")
    )
      invalid(
        `${field} is supported only as a string on assistant messages.`,
        `${param}.${field}`,
      );
  let toolCalls: ChatMessage["toolCalls"];
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls))
      invalid("tool_calls must be an array.", `${param}.tool_calls`);
    toolCalls = message.tool_calls.map((raw, callIndex) => {
      const call = record(raw);
      const fn = record(call?.function);
      if (
        call?.type !== "function" ||
        typeof call.id !== "string" ||
        typeof fn?.name !== "string" ||
        typeof fn.arguments !== "string"
      )
        invalid(
          "Each assistant tool call must be a complete function call.",
          `${param}.tool_calls.${callIndex}`,
        );
      return { id: call.id, name: fn.name, arguments: fn.arguments };
    });
    if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length)
      invalid("Assistant tool call IDs must be unique.", `${param}.tool_calls`);
  }
  if (
    message.role === "assistant" &&
    message.content === null &&
    (!toolCalls || toolCalls.length === 0)
  )
    invalid(
      "Null assistant content requires at least one tool call.",
      `${param}.content`,
    );
  let internalToolCallIds: string[] | undefined;
  if (message.tool_results !== undefined) {
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.tool_results) ||
      message.tool_results.length === 0
    )
      invalid(
        "tool_results must be a non-empty array on an assistant message.",
        `${param}.tool_results`,
      );
    const callsById = new Map(toolCalls?.map((call) => [call.id, call]));
    internalToolCallIds = [];
    message.tool_results.forEach((raw, resultIndex) => {
      const result = record(raw);
      const fn = record(result?.function);
      const data = record(result?.result);
      const call =
        typeof result?.id === "string" ? callsById.get(result.id) : undefined;
      if (
        result?.type !== "function" ||
        !call ||
        typeof fn?.name !== "string" ||
        typeof fn.arguments !== "string" ||
        call.name !== fn.name ||
        call.arguments !== fn.arguments ||
        typeof data?.status !== "string"
      )
        invalid(
          "Each tool result must match a complete assistant tool call.",
          `${param}.tool_results.${resultIndex}`,
        );
      internalToolCallIds!.push(call.id);
    });
    // These self-correlating results describe Codex activity that app-server
    // already executed. Only the correlation is retained, so history replay can
    // tell the activity apart from a client call; the results themselves are not.
  }
  if (message.role === "tool" && typeof message.tool_call_id !== "string")
    invalid("A tool message requires tool_call_id.", `${param}.tool_call_id`);
  return {
    role: message.role as ChatMessage["role"],
    content: contentParts
      ? contentParts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      : typeof message.content === "string"
        ? message.content
        : null,
    ...(contentParts ? { contentParts } : {}),
    ...(typeof message.tool_call_id === "string"
      ? { toolCallId: message.tool_call_id }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(internalToolCallIds?.length ? { internalToolCallIds } : {}),
  };
}

/** Converts OpenAI function declarations to app-server dynamic tool specs. */
function validateTools(
  value: unknown,
  choice: unknown,
): Array<Record<string, unknown>> {
  if (choice !== undefined && choice !== "auto" && choice !== "none")
    invalid(
      "tool_choice supports only auto or none in this stage.",
      "tool_choice",
    );
  if (value === undefined || choice === "none") return [];
  if (!Array.isArray(value)) invalid("tools must be an array.", "tools");
  return value.map((raw, index) => {
    const tool = record(raw);
    const fn = record(tool?.function);
    if (
      tool?.type !== "function" ||
      !fn ||
      typeof fn.name !== "string" ||
      fn.name === "" ||
      fn.name.length > 128 ||
      !/^[a-zA-Z0-9_-]+$/.test(fn.name) ||
      !record(fn.parameters)
    )
      invalid(
        "Each tool must be a named function with a JSON Schema parameters object.",
        `tools.${index}`,
      );
    return {
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      inputSchema: fn.parameters,
    };
  });
}

/** Joins Chat Completions system messages for app-server base instructions. */
export function toBaseInstructions(messages: readonly ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n\n");
}

/** Maps one prior non-system message to raw Responses API history. */
export function toHistoryItem(
  message: ChatMessage,
): Record<string, unknown> | undefined {
  // System messages are owned by `toBaseInstructions`; app-server filters
  // raw system history out of model requests.
  if (message.role === "system") return undefined;
  // A tool-only assistant response has no model-visible text to inject; its
  // calls are represented by the pairs `toHistoryItems` builds around it.
  if (message.content === null) return undefined;
  return {
    type: "message",
    role: message.role,
    content: message.contentParts
      ? message.contentParts.map((part) =>
          part.type === "text"
            ? { type: "input_text", text: part.text }
            : part.type === "image"
              ? {
                  type: "input_image",
                  image_url: part.url,
                  ...(part.detail ? { detail: part.detail } : {}),
                }
              : part.type === "audio"
                ? { type: "input_audio", audio_url: part.url }
                : invalid("PDF input was not prepared.", "messages"),
        )
      : [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
  };
}

/** One replayed history mapping plus the tool items it could not represent. */
export interface HistoryItems {
  items: Array<Record<string, unknown>>;
  /** Replayed assistant tool calls no client result answered. */
  unansweredCalls: number;
  /** Replayed tool results no preceding assistant message requested. */
  orphanResults: number;
}

/**
 * Maps a replayed transcript to raw Responses API history, pairing each earlier
 * assistant tool-call batch with its immediately following client-result block
 * so a completed tool round survives into a fresh thread. A `role: "tool"`
 * history message is not a Responses item, and app-server silently ignores a
 * `function_call_output` without its `function_call`, so only complete pairs are
 * injected in assistant-declared call order. An unanswered call would leave the
 * thread describing work that never finished, and an orphan result has no call
 * to attach to. Both are counted so the caller can report the loss instead of
 * injecting a misleading transcript.
 */
export function toHistoryItems(messages: readonly ChatMessage[]): HistoryItems {
  const items: Array<Record<string, unknown>> = [];
  let unansweredCalls = 0;
  let orphanResults = 0;
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    index += 1;
    if (message.role === "tool") {
      orphanResults += 1;
      continue;
    }
    const text = toHistoryItem(message);
    if (text) items.push(text);
    const internal = new Set(message.internalToolCallIds);
    // Activity this message already answered itself is app-server's, and the
    // fresh thread owns its own: replaying it under Codex's internal tool names
    // would describe work this thread never performed.
    const calls = (message.toolCalls ?? []).filter(
      (call) => !internal.has(call.id),
    );
    if (!calls.length) continue;
    const callIds = new Set(calls.map((call) => call.id));
    const results = new Map<string, string>();
    // Consume this assistant message's whole result block so those tool roles
    // cannot be reconsidered by a later batch with a repeated call ID.
    while (messages[index]?.role === "tool") {
      const callId = messages[index]!.toolCallId!;
      if (!callIds.has(callId) || results.has(callId)) orphanResults += 1;
      else results.set(callId, messages[index]!.content!);
      index += 1;
    }
    for (const call of calls) {
      const output = results.get(call.id);
      if (output === undefined) {
        unansweredCalls += 1;
        continue;
      }
      items.push(
        toFunctionCallItem({
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        }),
        toFunctionCallOutputItem(call.id, output),
      );
    }
  }
  return { items, unansweredCalls, orphanResults };
}

/**
 * Returns the history slice a fresh execution replays: every message except a
 * final user message, which becomes the new turn's input instead. Fallback
 * validation and fresh setup must derive the identical slice so a validated
 * fallback transcript is exactly what fresh setup replays.
 */
export function freshExecutionHistory(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  return messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
}

/**
 * Validates that a fallback transcript supplies complete tool pairing. Unlike
 * an ordinary fresh request, which drops unpairable history with a warning, a
 * fallback was selected because the requested continuation was unavailable, so
 * silently discarding the client's calls or results would lose work the
 * transcript claims to carry. A pending continuation with no result block may
 * abandon unanswered calls; fresh setup drops them with its existing warning.
 */
export function validateFallbackHistory(
  messages: readonly ChatMessage[],
  options: { allowUnansweredCalls?: boolean } = {},
): void {
  const prior = toHistoryItems(freshExecutionHistory(messages));
  if (
    (prior.unansweredCalls && !options.allowUnansweredCalls) ||
    prior.orphanResults
  )
    invalid(
      "A fresh continuation requires every assistant tool call to be answered and every tool result to follow the assistant message that requested it.",
      "messages",
    );
}

/** Builds the Responses API function_call item for one recorded dynamic call. */
export function toFunctionCallItem(
  call: StoredToolCall,
): Record<string, unknown> {
  return {
    type: "function_call",
    name: call.name,
    arguments: call.arguments,
    call_id: call.callId,
  };
}

/** Builds the Responses API function_call_output item pairing one result. */
export function toFunctionCallOutputItem(
  callId: string,
  output: string,
): Record<string, unknown> {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  };
}

/** Validates a complete, single-use result set for a pending tool batch. */
export function validateToolResults(
  assistant: ChatMessage | undefined,
  toolResults: ChatMessage[],
  pending: StoredToolCall[],
): Map<string, string> {
  if (!assistant?.toolCalls)
    invalid("The assistant tool-call message is required.", "messages");
  const expected = new Map(pending.map((call) => [call.callId, call]));
  // Internal calls in a replayed assistant message are observational. Only
  // calls owned by the pending dynamic batch participate in continuation.
  const pendingCalls = assistant.toolCalls.filter((call) =>
    expected.has(call.id),
  );
  if (
    pendingCalls.length !== expected.size ||
    pendingCalls.some(
      (call) =>
        expected.get(call.id)?.name !== call.name ||
        // The persisted arguments string is byte-identical to what the
        // tool-call response emitted, so replay comparison is exact.
        call.arguments !== expected.get(call.id)?.arguments,
    )
  )
    invalid(
      "The assistant tool calls do not match the pending continuation.",
      "messages",
    );
  const results = new Map<string, string>();
  for (const message of toolResults) {
    if (!message.toolCallId || !expected.has(message.toolCallId))
      invalid("The tool result references a foreign call ID.", "messages");
    if (results.has(message.toolCallId))
      invalid("A tool call has more than one result.", "messages");
    results.set(message.toolCallId, message.content!);
  }
  if (results.size !== expected.size)
    invalid(
      "Exactly one result is required for every pending tool call.",
      "messages",
    );
  return results;
}

/** Throws an OpenAI-shaped request validation error. */
function invalid(message: string, param: string | null): never {
  throw new HttpError(
    400,
    message,
    "invalid_request_error",
    "invalid_request",
    param,
  );
}

/** Rejects a known Chat Completions control this proxy cannot honor. */
function unsupported(param: string): never {
  throw new HttpError(
    400,
    `${param} is not supported by this proxy.`,
    "invalid_request_error",
    "unsupported_parameter",
    param,
  );
}
