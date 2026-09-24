import { randomUUID } from "node:crypto";
import { PolicyError, resolveEffectivePolicy } from "../core/policy.js";
import {
  execute,
  type ChatHandlerOptions,
  type ExecutionSession,
} from "../http/chat-execute.js";
import {
  aggregateNormalizedEvents,
  type Usage,
} from "../http/chat-normalize.js";
import {
  policyHttpError,
  validateRequest,
  type ChatRequest,
} from "../http/chat-validate.js";
import { materializePdfParts } from "../http/pdf-input.js";

/** One prepared Codex execution shared by HTTP output and internal callers. */
export interface PreparedCompletion {
  request: ChatRequest;
  responseId: string;
  execution: ExecutionSession;
}

/** Validates policy before starting a Codex turn and owns its response identity. */
export async function prepareCompletion(
  body: unknown,
  options: ChatHandlerOptions,
  textOnly = false,
): Promise<PreparedCompletion> {
  let request: ChatRequest;
  try {
    const { requestPolicy, ...parsed } = validateRequest(
      body,
      options.log,
      options.requestId,
      options.implicitToolContinuation,
    );
    await materializePdfParts(parsed.messages, options.signal);
    if (
      textOnly &&
      (parsed.stream ||
        parsed.dynamicTools.length > 0 ||
        parsed.previousResponseId !== undefined)
    )
      throw new Error(
        "Internal completion must be non-streaming and tool-free.",
      );
    request = {
      ...parsed,
      policy: await resolveEffectivePolicy(
        requestPolicy,
        options.root,
        options.requirements,
      ),
    };
  } catch (error) {
    if (error instanceof PolicyError) throw policyHttpError(error);
    throw error;
  }
  const responseId = `chatcmpl_codex_${randomUUID().replaceAll("-", "")}`;
  options.observe?.({ model: request.model });
  return {
    request,
    responseId,
    execution: await execute(request, options, responseId),
  };
}

/** Returns one bounded plain-text answer without an HTTP self-request. */
export async function completeText(
  body: unknown,
  options: ChatHandlerOptions,
): Promise<{ content: string; usage?: Usage }> {
  const { execution } = await prepareCompletion(body, options, true);
  try {
    const result = await aggregateNormalizedEvents(execution.events);
    if (result.usage) options.observe?.({ usage: result.usage });
    if (
      result.finishReason !== "stop" ||
      result.toolCalls.length > 0 ||
      result.content.trim() === "" ||
      Buffer.byteLength(result.content, "utf8") > 100_000
    )
      throw new Error("Internal completion did not return bounded final text.");
    return {
      content: result.content,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } finally {
    await execution.dispose();
  }
}
