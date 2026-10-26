import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import {
  InteractionBroker,
  formFields,
} from "../../src/app-server/interactions.js";
import { JsonRpcTransport } from "../../src/app-server/json-rpc.js";
import {
  protocolNotification,
  protocolThread,
  protocolServerRequest,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import type { McpServerElicitationRequestParams } from "../../protocol/generated/typescript/v2/McpServerElicitationRequestParams.js";
import type { ToolRequestUserInputResponse } from "../../protocol/generated/typescript/v2/ToolRequestUserInputResponse.js";
import type { McpServerElicitationRequestResponse } from "../../protocol/generated/typescript/v2/McpServerElicitationRequestResponse.js";

/** Isolated in-memory app-server whose replies can be inspected without a model. */
function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<{ id: string | number; result: unknown }> = [];
  output.on("data", (chunk) => replies.push(JSON.parse(String(chunk))));
  const rpc = new JsonRpcTransport(input, output);
  const broker = new InteractionBroker();
  const controller = new AbortController();
  const dispose = broker.bind(
    rpc,
    "thread_fixture",
    "request_fixture",
    controller.signal,
  );
  return { input, rpc, broker, controller, dispose, replies };
}

/** Complete generated user-input callback with one option-bound and one secret question. */
function question(id: string | number = "question_fixture") {
  return protocolServerRequest({
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fixture",
      turnId: "turn_fixture",
      itemId: "item_fixture",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Pick one.",
          isOther: false,
          isSecret: false,
          options: [{ label: "A", description: "Synthetic option" }],
        },
        {
          id: "secret",
          header: "Secret",
          question: "Synthetic secret input.",
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    },
  });
}

/** Complete generated MCP callback with caller-selected mode and schema. */
function elicitation(
  params: Partial<McpServerElicitationRequestParams> = {},
  id: string | number = 2,
) {
  return protocolServerRequest({
    id,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread_fixture",
      turnId: "turn_fixture",
      serverName: "fixture",
      mode: "url",
      _meta: null,
      message: "Open the synthetic authorization page.",
      url: "https://example.invalid/authorize",
      elicitationId: "elicitation_fixture",
      ...params,
    } as McpServerElicitationRequestParams,
  });
}

test("questions and MCP URLs resume their original callbacks exactly once", () => {
  const f = fixture();
  const q = question();
  assert.equal(f.broker.handle(f.rpc, q), true);
  assert.equal(f.broker.handle(f.rpc, q), true);
  assert.equal(f.broker.list().length, 1);
  const pending = f.broker.list()[0]!;
  assert.equal(pending.requestId, "request_fixture");
  assert.throws(() =>
    f.broker.resolve(pending.id, { answers: { unknown: { answers: ["A"] } } }),
  );
  assert.throws(() =>
    f.broker.resolve(pending.id, { answers: { choice: { answers: ["B"] } } }),
  );
  const answer = {
    answers: {
      choice: { answers: ["A"] },
      secret: { answers: ["synthetic-value"] },
    },
  } satisfies ToolRequestUserInputResponse;
  assert.equal(f.broker.resolve(pending.id, answer), true);
  assert.equal(f.broker.resolve(pending.id, answer), false);
  assert.deepEqual(f.replies, [{ id: q.id, result: answer }]);
  assert.equal(f.broker.handle(f.rpc, elicitation()), true);
  const response = {
    action: "accept",
    content: null,
    _meta: null,
  } satisfies McpServerElicitationRequestResponse;
  assert.equal(f.broker.resolve(f.broker.list()[0]!.id, response), true);
  assert.deepEqual(f.replies[1], { id: 2, result: response });
  f.dispose();
  f.rpc.close();
});

test("form fields validate types, required keys, bounds and enum values before replying", () => {
  const f = fixture();
  const schema = {
    type: "object" as const,
    required: ["name", "count", "confirm", "choice"],
    properties: {
      name: { type: "string" as const, minLength: 2, maxLength: 4 },
      count: { type: "integer" as const, minimum: 1, maximum: 3 },
      confirm: { type: "boolean" as const },
      choice: { type: "string" as const, enum: ["yes", "no"] },
      titled: {
        type: "string" as const,
        oneOf: [{ const: "value", title: "Label" }],
      },
    },
  };
  assert.equal(
    f.broker.handle(
      f.rpc,
      elicitation({ mode: "form", requestedSchema: schema }),
    ),
    true,
  );
  const id = f.broker.list()[0]!.id;
  const valid = {
    name: "abc",
    count: 2,
    confirm: false,
    choice: "yes",
    titled: "value",
  };
  for (const content of [
    null,
    {},
    { ...valid, extra: true },
    { ...valid, name: "x" },
    { ...valid, name: "large" },
    { ...valid, count: 0 },
    { ...valid, count: 4 },
    { ...valid, count: 1.5 },
    { ...valid, confirm: "yes" },
    { ...valid, choice: "maybe" },
    { ...valid, titled: "Label" },
  ])
    assert.throws(() => f.broker.resolve(id, { action: "accept", content }));
  assert.equal(f.replies.length, 0);
  assert.equal(
    f.broker.resolve(id, { action: "accept", content: valid }),
    true,
  );
  assert.deepEqual(f.replies[0]?.result, {
    action: "accept",
    content: valid,
    _meta: null,
  });
  f.dispose();
  f.rpc.close();
});

test("unsupported schemas, unsafe links, foreign threads and malformed callbacks stay unclaimed", () => {
  const f = fixture();
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/fixture",
    "https://user:password@example.invalid/",
    "not a URL",
  ])
    assert.equal(f.broker.handle(f.rpc, elicitation({ url })), false);
  assert.equal(
    f.broker.handle(f.rpc, elicitation({ threadId: "another_thread" })),
    false,
  );
  assert.equal(
    f.broker.handle(f.rpc, elicitation({ mode: "openai/userVerification" })),
    false,
  );
  assert.equal(
    f.broker.handle(f.rpc, {
      ...question(),
      params: { threadId: "thread_fixture", questions: [{}] },
    }),
    false,
  );
  for (const schema of [
    null,
    {},
    { type: "object", properties: { nested: { type: "object" } } },
    { type: "object", properties: { a: { type: "string", pattern: "x" } } },
    { type: "object", properties: {}, required: ["absent"] },
  ])
    assert.equal(formFields(schema), undefined);
  assert.deepEqual(f.broker.list(), []);
  f.dispose();
  f.rpc.close();
});

test("disconnect, completion, remote resolution and process exit remove stale replies", () => {
  for (const ending of [
    "abort",
    "dispose",
    "completed",
    "resolved",
    "close",
  ] as const) {
    const f = fixture();
    f.broker.handle(f.rpc, elicitation());
    const id = f.broker.list()[0]!.id;
    if (ending === "abort") f.controller.abort();
    if (ending === "dispose") f.dispose();
    if (ending === "completed")
      f.input.write(
        JSON.stringify(
          protocolNotification({
            method: "turn/completed",
            params: {
              threadId: "thread_fixture",
              turn: protocolTurn("turn_fixture", "completed"),
            },
          }),
        ) + "\n",
      );
    if (ending === "resolved")
      f.input.write(
        JSON.stringify(
          protocolNotification({
            method: "serverRequest/resolved",
            params: { threadId: "thread_fixture", requestId: 2 },
          }),
        ) + "\n",
      );
    if (ending === "close") f.rpc.close();
    assert.equal(f.broker.resolve(id, { action: "accept" }), false);
    assert.deepEqual(f.broker.list(), []);
    assert.equal(
      f.replies.length,
      ending === "close" || ending === "resolved" || ending === "completed"
        ? 0
        : 1,
    );
    if (f.replies.length)
      assert.deepEqual(f.replies[0]?.result, {
        action: "cancel",
        content: null,
        _meta: null,
      });
    f.dispose();
    f.rpc.close();
  }
});

test("simultaneous transports and request ids never cross completion boundaries", () => {
  const f = fixture();
  const second = fixture();
  const controller = new AbortController();
  const release = f.broker.bind(
    second.rpc,
    "thread_fixture",
    "second_request",
    controller.signal,
  );
  f.broker.handle(f.rpc, elicitation());
  f.broker.handle(second.rpc, elicitation());
  assert.equal(f.broker.list().length, 2);
  f.controller.abort();
  assert.equal(f.broker.list()[0]?.requestId, "second_request");
  f.broker.resolve(f.broker.list()[0]!.id, { action: "decline" });
  assert.deepEqual(second.replies[0]?.result, {
    action: "decline",
    content: null,
    _meta: null,
  });
  release();
  f.rpc.close();
  second.dispose();
  second.rpc.close();
});

/** Ensures child callbacks stay owned by the parent HTTP completion. */
test("child interactions follow recorded parent links and ignore stale root turn completion", () => {
  const f = fixture();
  const notify = (value: Parameters<typeof protocolNotification>[0]): void => {
    f.input.write(JSON.stringify(protocolNotification(value)) + "\n");
  };
  f.broker.handle(f.rpc, question());
  notify({
    method: "turn/completed",
    params: {
      threadId: "thread_fixture",
      turn: protocolTurn("old_turn", "completed"),
    },
  });
  assert.equal(f.broker.list().length, 1);
  notify({
    method: "thread/started",
    params: {
      thread: {
        ...protocolThread("child_fixture"),
        parentThreadId: "thread_fixture",
      },
    },
  });
  assert.equal(
    f.broker.handle(
      f.rpc,
      elicitation(
        { threadId: "child_fixture", turnId: "child_turn" },
        "child_request",
      ),
    ),
    true,
  );
  assert.equal(f.broker.list().length, 2);
  notify({
    method: "turn/completed",
    params: {
      threadId: "child_fixture",
      turn: protocolTurn("child_turn", "completed"),
    },
  });
  assert.equal(f.broker.list().length, 1);
  assert.equal(f.replies.length, 0);
  f.controller.abort();
  assert.deepEqual(f.replies[0]?.result, { answers: {} });
  assert.equal(
    f.broker.handle(f.rpc, elicitation({ threadId: "child_fixture" })),
    false,
  );
  f.rpc.close();
});

test("pending callback capacity and cancellation are bounded", () => {
  const f = fixture();
  for (let id = 0; id < 128; id++)
    assert.equal(f.broker.handle(f.rpc, elicitation({}, id)), true);
  assert.equal(f.broker.handle(f.rpc, elicitation({}, 129)), false);
  assert.equal(
    f.broker.handle(f.rpc, elicitation({ message: "x".repeat(65536) }, 130)),
    false,
  );
  f.dispose();
  assert.equal(f.replies.length, 128);
  assert.equal(f.rpc.listenerCount("notification"), 0);
  f.rpc.close();
});

test("client channels cannot be shared by concurrent completions and are released on disconnect", () => {
  const f = fixture();
  const client = { channel: "synthetic-channel", owner: "synthetic-owner" };
  f.broker.bind(
    f.rpc,
    "other_thread",
    "other_request",
    f.controller.signal,
    () => undefined,
    client,
  );
  assert.equal(f.broker.hasChannel(client), true);
  assert.equal(f.broker.hasChannel({ ...client, owner: "other" }), false);
  assert.throws(
    () =>
      f.broker.bind(
        f.rpc,
        "third_thread",
        "third_request",
        f.controller.signal,
        () => undefined,
        client,
      ),
    /already active/,
  );
  f.controller.abort();
  assert.equal(f.broker.hasChannel(client), false);
  f.rpc.close();
});
