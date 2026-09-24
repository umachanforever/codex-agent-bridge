import type { ServerResponse } from "node:http";
import type { NormalizedDelta } from "./chat-normalize.js";
import { errorEnvelopeFor, type HttpError } from "./errors.js";

/** Creates a conventional single-choice streaming chunk. */
export function chunk(
  id: string,
  created: number,
  model: string,
  delta: NormalizedDelta | { role: "assistant" },
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Writes one JSON SSE data frame while respecting HTTP backpressure. */
export async function writeSse(
  response: ServerResponse,
  value: unknown,
): Promise<void> {
  await writeFrame(response, JSON.stringify(value));
}

/** Writes the single terminal OpenAI-shaped error allowed on an SSE stream. */
export async function writeSseError(
  response: ServerResponse,
  error: HttpError,
): Promise<void> {
  await writeSse(response, errorEnvelopeFor(error));
}

/** Writes one SSE data frame and waits for drain when required. */
export async function writeFrame(
  response: ServerResponse,
  data: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded)
    throw new Error("The HTTP response closed before the SSE frame was sent.");
  if (response.write(serializeSseFrame(data))) return;
  await waitForDrain(response);
}

/** Owns the drain/close listeners for exactly one blocked write. */
function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (didClose: boolean): void => {
      if (settled) return;
      settled = true;
      response.off("drain", drained);
      response.off("close", closed);
      if (didClose)
        reject(
          new Error("The HTTP response closed while sending an SSE frame."),
        );
      else resolve();
    };
    const drained = (): void => finish(false);
    const closed = (): void => finish(true);
    // Check both before and after registration: write or response-like listener
    // installation can close synchronously without a later close notification.
    if (response.destroyed || response.writableEnded) {
      closed();
      return;
    }
    response.once("drain", drained);
    response.once("close", closed);
    if (response.destroyed || response.writableEnded) closed();
  });
}

/** Serializes one SSE data frame without performing I/O. */
export function serializeSseFrame(data: string): string {
  return `data: ${data}\n\n`;
}
