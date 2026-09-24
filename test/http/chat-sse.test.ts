import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "vitest";
import { writeFrame } from "../../src/http/chat-sse.js";

/** Minimal backpressured response double with explicit lifecycle control. */
class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;

  /** Reports a full write buffer without scheduling a drain event. */
  write(): boolean {
    return false;
  }
}

test("writeFrame rejects and removes listeners when the response closes", async () => {
  const response = new BackpressuredResponse();
  const pending = writeFrame(response as unknown as ServerResponse, "chunk");

  response.destroyed = true;
  response.emit("close");

  await assert.rejects(pending, /closed while sending an SSE frame/);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

/** Ensures a drained write resolves once and leaves no lifecycle listeners. */
test("writeFrame resumes after drain and releases both listeners", async () => {
  const response = new BackpressuredResponse();
  const pending = writeFrame(response as unknown as ServerResponse, "chunk");
  response.emit("drain");
  await pending;
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

/** Exercises closure before writing and closure during a backpressured write. */
test("writeFrame detects synchronous closure without waiting for a close event", async () => {
  const response = new BackpressuredResponse();
  response.destroyed = true;
  await assert.rejects(
    writeFrame(response as unknown as ServerResponse, "chunk"),
    /closed before/,
  );
  response.destroyed = false;
  response.write = (): boolean => {
    response.writableEnded = true;
    return false;
  };
  await assert.rejects(
    writeFrame(response as unknown as ServerResponse, "chunk"),
    /closed while/,
  );
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});
