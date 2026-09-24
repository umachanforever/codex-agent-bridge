import assert from "node:assert/strict";
import { test } from "vitest";
import {
  EventNormalizer,
  aggregateNormalizedEvents,
} from "../../src/http/chat-normalize.js";
import {
  protocolNotification,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import type { ServerNotification } from "../../protocol/generated/typescript/ServerNotification.js";

/** Builds a complete synthetic message lifecycle notification. */
function item(
  method: "item/started" | "item/completed",
  id: string,
  text: string,
  phase: "commentary" | "final_answer" | null,
): ServerNotification {
  const common = {
    threadId: "thread",
    turnId: "turn",
    item: {
      type: "agentMessage" as const,
      id,
      text,
      phase,
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  };
  return method === "item/started"
    ? protocolNotification({ method, params: { ...common, startedAtMs: 0 } })
    : protocolNotification({ method, params: { ...common, completedAtMs: 1 } });
}

/** Builds a synthetic text delta with explicit item identity. */
function delta(id: string, text: string): ServerNotification {
  return protocolNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "turn", itemId: id, delta: text },
  });
}

/** Replays the same normalizer path used by aggregate and SSE execution. */
async function text(
  events: ServerNotification[],
  normalizer = new EventNormalizer(),
): Promise<string> {
  return (
    await aggregateNormalizedEvents(
      events.flatMap((e) => normalizer.normalize(e.method, e.params)),
    )
  ).content;
}

test("commentary is excluded and completed text fills only the missing suffix", async () => {
  assert.equal(
    await text([
      item("item/started", "progress", "", "commentary"),
      delta("progress", "Working..."),
      item("item/completed", "progress", "Working...", "commentary"),
      item("item/started", "answer", "", "final_answer"),
      delta("answer", "hel"),
      item("item/completed", "answer", "hello", "final_answer"),
      item("item/completed", "answer", "hello", "final_answer"),
    ]),
    "hello",
  );
});

test("structured output selects the last final document and never leaks drafts", async () => {
  const n = new EventNormalizer(undefined, undefined, true);
  for (const e of [
    delta("progress", "Working..."),
    item("item/completed", "progress", "Working...", "commentary"),
    item("item/completed", "first", '{"draft":true}', "final_answer"),
    item("item/started", "last", "", "final_answer"),
    delta("last", '{"ok":'),
    item("item/completed", "last", '{"ok":true}', "final_answer"),
  ])
    assert.deepEqual(n.normalize(e.method, e.params), []);
  const done = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "completed") },
  });
  const output = await text([done], n);
  assert.deepEqual(JSON.parse(output), { ok: true });
});

test("completion-only text survives and duplicate completions or late deltas do not repeat it", async () => {
  assert.equal(
    await text([
      item("item/completed", "a", "first", "final_answer"),
      item("item/completed", "a", "first", "final_answer"),
      delta("a", "first"),
      item("item/completed", "b", "second", "final_answer"),
    ]),
    "first\n\nsecond",
  );
});

test("conflicting streamed completions and late commentary fail instead of corrupting success", async () => {
  await assert.rejects(
    text([
      delta("a", "old"),
      item("item/completed", "a", "new", "final_answer"),
    ]),
    /conflicts/,
  );
  await assert.rejects(
    text([
      delta("a", "progress"),
      item("item/completed", "a", "progress", "commentary"),
    ]),
    /conflicts/,
  );
});

test("schema mode repairs buffered prefixes but rejects an incomplete last document", async () => {
  const done = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "completed") },
  });
  assert.equal(
    await text(
      [
        delta("a", "wrong"),
        item("item/completed", "a", '{"ok":true}', "final_answer"),
        done,
        done,
      ],
      new EventNormalizer(undefined, undefined, true),
    ),
    '{"ok":true}',
  );
  await assert.rejects(
    text(
      [
        item("item/completed", "a", '{"ok":true}', "final_answer"),
        delta("b", '{"unfinished":'),
        item("item/started", "b", "", "final_answer"),
        done,
      ],
      new EventNormalizer(undefined, undefined, true),
    ),
    /not valid JSON/,
  );
});

test("schema mode falls back to the last phase-less message but never commentary or failed turns", async () => {
  const done = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "completed") },
  });
  assert.equal(
    await text(
      [delta("a", '{"old":true}'), delta("b", '{"new":true}'), done],
      new EventNormalizer(undefined, undefined, true),
    ),
    '{"new":true}',
  );
  const interrupted = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "interrupted") },
  });
  assert.equal(
    await text(
      [delta("a", '{"incomplete":'), interrupted],
      new EventNormalizer(undefined, undefined, true),
    ),
    "",
  );
});

test("ordinary final deltas remain incremental and tool handoffs do not flush buffered schema drafts", () => {
  const n = new EventNormalizer();
  const start = item("item/started", "a", "", "final_answer");
  n.normalize(start.method, start.params);
  const d = delta("a", "instant");
  assert.deepEqual(n.normalize(d.method, d.params), [
    { delta: { content: "instant" } },
  ]);
  const schema = new EventNormalizer(undefined, undefined, true);
  schema.normalize(d.method, d.params);
  schema.dynamicToolCall({ callId: "call", name: "Bash", arguments: "{}" });
  const done = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "completed") },
  });
  assert.deepEqual(schema.normalize(done.method, done.params), [
    { finishReason: "tool_calls" },
  ]);
});

test("schema completion without an answer is an explicit error, not empty success", async () => {
  const done = protocolNotification({
    method: "turn/completed",
    params: { threadId: "thread", turn: protocolTurn("turn", "completed") },
  });
  await assert.rejects(
    text(
      [item("item/completed", "a", "Working...", "commentary"), done],
      new EventNormalizer(undefined, undefined, true),
    ),
    /not valid JSON/,
  );
});
