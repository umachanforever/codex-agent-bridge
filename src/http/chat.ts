import type { ServerResponse } from "node:http";
import { appServerError, HttpError, writeJson } from "./errors.js";
import { chunk, writeFrame, writeSse, writeSseError } from "./chat-sse.js";
import {
  aggregateNormalizedEvents,
  type NormalizedEvent,
} from "./chat-normalize.js";
import type { ChatHandlerOptions } from "./chat-execute.js";
import type { ChatRequest } from "./chat-validate.js";
import { prepareCompletion } from "../sessions/completion.js";

/** Validates, executes, and serializes one Chat Completions request. */
export async function handleChatCompletion(
  body: unknown,
  response: ServerResponse,
  options: ChatHandlerOptions,
): Promise<void> {
  const { request, responseId, execution } = await prepareCompletion(
    body,
    options,
  );
  const created = Math.floor(Date.now() / 1_000);
  // Setup is eager so validation and RPC failures retain their HTTP status
  // instead of committing an SSE response before streaming is primed.
  const { instructionSources, threadReused } = execution;
  const events = observeEvents(execution.events, options);
  try {
    if (request.stream) {
      await streamChatResponse(
        response,
        events,
        request,
        responseId,
        created,
        instructionSources,
        threadReused,
      );
      return;
    }
    await writeAggregateResponse(
      response,
      events,
      request,
      responseId,
      created,
      instructionSources,
      threadReused,
    );
  } finally {
    // This is idempotent with iterator disposal and also releases eager setup
    // if stream priming or its initial SSE writes fail.
    await execution.dispose();
  }
}

/** Observes usage independently of whether the client requests SSE usage chunks. */
async function* observeEvents(
  events: AsyncIterable<NormalizedEvent>,
  options: ChatHandlerOptions,
): AsyncGenerator<NormalizedEvent> {
  try {
    for await (const event of events) {
      if (event.usage) options.observe?.({ usage: event.usage });
      if (event.terminalError)
        options.observe?.({
          error: String(event.terminalError.code ?? "upstream_error"),
        });
      yield event;
    }
  } catch (error) {
    options.observe?.({
      error: error instanceof HttpError ? String(error.code) : "upstream_error",
    });
    throw error;
  }
}

/** Serializes one execution as an SSE Chat Completions response. */
async function streamChatResponse(
  response: ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
  request: ChatRequest,
  responseId: string,
  created: number,
  instructionSources: string[],
  threadReused: boolean,
): Promise<void> {
  let committed = false;
  const commit = async (): Promise<void> => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    await writeSse(response, {
      ...chunk(responseId, created, request.model, { role: "assistant" }, null),
      x_codex: { instructionSources, threadReused },
    });
    committed = true;
  };
  let streamFailed = false;
  try {
    for await (const event of events) {
      // The first event precedes SSE commitment so a turn that fails before any
      // visible output stays an ordinary JSON HTTP error carrying its real
      // status, code, and Retry-After. Committing 200 first would instead hand
      // lenient clients an empty stream that reads as a successful non-answer.
      if (!committed) {
        if (event.terminalError) throw event.terminalError;
        await commit();
      }
      if (event.terminalError) {
        await writeSseError(response, event.terminalError);
        streamFailed = true;
        break;
      }
      if (event.delta)
        await writeSse(
          response,
          chunk(responseId, created, request.model, event.delta, null),
        );
      if (event.finishReason)
        await writeSse(
          response,
          chunk(responseId, created, request.model, {}, event.finishReason),
        );
      if (event.usage && request.includeUsage)
        await writeSse(response, {
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [],
          usage: event.usage,
        });
    }
    if (!committed) await commit();
  } catch (error) {
    // The first event precedes headers specifically so route handling can
    // serialize immediate failures as normal JSON HTTP errors.
    if (!response.headersSent) throw error;
    streamFailed = true;
    if (!response.writableEnded && !response.destroyed)
      await writeSseError(
        response,
        error instanceof HttpError
          ? error
          : appServerError(
              error instanceof Error
                ? error.message
                : "The app-server turn failed.",
            ),
      );
  }
  if (!streamFailed) await writeFrame(response, "[DONE]");
  response.end();
}

/** Aggregates and serializes one non-streaming Chat Completions response. */
async function writeAggregateResponse(
  response: ServerResponse,
  events: AsyncIterable<NormalizedEvent>,
  request: ChatRequest,
  responseId: string,
  created: number,
  instructionSources: string[],
  threadReused: boolean,
): Promise<void> {
  const aggregated = await aggregateNormalizedEvents(events);
  const { content, reasoning, toolResults, finishReason, usage } = aggregated;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: aggregated.toolCalls.length && content === "" ? null : content,
  };
  if (reasoning) message.reasoning = reasoning;
  if (aggregated.toolCalls.length) {
    message.tool_calls = aggregated.toolCalls.map((call) => ({
      id: call.id,
      type: call.type,
      function: call.function,
    }));
  }
  if (toolResults.length) message.tool_results = toolResults;
  writeJson(response, 200, {
    id: responseId,
    object: "chat.completion",
    created,
    model: request.model,
    x_codex: { instructionSources, threadReused },
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  });
}
