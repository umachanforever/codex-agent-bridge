import assert from "node:assert/strict";
import { test } from "vitest";
import { join } from "node:path";
import { AdminStore } from "../../src/admin/store.js";
import {
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { createProxyServer } from "../../src/http/server.js";
import { silentLogger } from "../support/logger.js";
import { withTempDir } from "../support/temp.js";
import { parseSseChunks } from "../support/http.js";
import {
  protocolNotification,
  protocolResponse,
  protocolThread,
  protocolThreadResumeResponse,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import {
  completeTurn,
  createFakeTransport,
  interruptTurn,
  suspendWithTools,
  type FakeTransportSend,
} from "../support/transport.js";
import { syntheticPdf } from "../support/pdf.js";

/** Starts an authenticated local profile with a synthetic external app-server. */
async function localProxy(
  run: (
    origin: string,
    send: FakeTransportSend,
    store: AdminStore,
  ) => Promise<void>,
  receive: (message: Record<string, unknown>, send: FakeTransportSend) => void,
): Promise<void> {
  const previous = process.env.CODEX_BRIDGE_TOKEN;
  process.env.CODEX_BRIDGE_TOKEN = "regression-test-key";
  try {
    await withTempDir(async (root) => {
      const config = await resolveServeOptions(
        parseServeOptions([
          "--port",
          "0",
          "--root",
          root,
          "--state-dir",
          root,
          "--local-bridge-model",
          "synthetic-model",
          "--max-requests",
          "0",
          "--body-limit",
          "134217728",
        ]),
      );
      const fake = createFakeTransport({
        fragmentCount: 17,
        onMessage: receive,
      });
      const store = new AdminStore(join(root, "admin"));
      const proxy = createProxyServer(config, silentLogger, store);
      proxy.setTransport(fake.rpc);
      proxy.setReady(true);
      const address = await proxy.listen();
      try {
        await run(`http://127.0.0.1:${address.port}`, fake.send, store);
      } finally {
        await proxy.close();
        store.close();
      }
    });
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_TOKEN;
    else process.env.CODEX_BRIDGE_TOKEN = previous;
  }
}

/** Posts a synthetic authenticated request without executing any model or tool. */
function post(
  origin: string,
  extra: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer regression-test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "codex-cli",
      messages: [{ role: "user", content: "synthetic" }],
      ...extra,
    }),
  });
}

test("two overlapping model streams keep interleaved text isolated", async () => {
  let threads = 0;
  const turns: Array<{ thread: string; turn: string }> = [];
  await localProxy(
    async (origin, _send, store) => {
      const results = await Promise.all(
        [1, 2].map(async () => {
          const response = await post(origin, { stream: true });
          assert.equal(response.status, 200);
          const chunks = parseSseChunks<{
            choices: Array<{ delta?: { content?: string } }>;
          }>(await response.text());
          return chunks
            .flatMap((c) => c.choices)
            .map((c) => c.delta?.content ?? "")
            .join("");
        }),
      );
      assert.deepEqual(results.sort(), [
        "thread_1:first:last",
        "thread_2:first:last",
      ]);
      const accounting = store.report() as {
        summary: {
          requests: number;
          successful: number;
          measured: number;
          total: number;
        };
      };
      assert.equal(accounting.summary.requests, 2);
      assert.equal(accounting.summary.successful, 2);
      assert.equal(accounting.summary.measured, 2);
      assert.equal(accounting.summary.total, 12);
    },
    (message, send) => {
      const id = message.id as number;
      if (message.method === "thread/start") {
        const thread = `thread_${++threads}`;
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread(thread)),
          ),
        );
      } else if (message.method === "turn/start") {
        const thread = (message.params as { threadId: string }).threadId;
        const turn = `turn_${thread}`;
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn(turn, "inProgress"),
          }),
        );
        turns.push({ thread, turn });
        // Neither request can finish until both model turns have started.
        if (turns.length === 2) {
          for (const text of ["first", "last"])
            for (const t of turns)
              send(
                protocolNotification({
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: t.thread,
                    turnId: t.turn,
                    itemId: `item_${t.thread}`,
                    delta: text === "first" ? `${t.thread}:first` : ":last",
                  },
                }),
              );
          for (const t of turns) completeTurn(send, t.thread, t.turn);
        }
      }
    },
  );
});

test("HTTP text and inline image parts reach app-server while remote images fail before dispatch", async () => {
  const starts: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const injections: Array<Record<string, unknown>> = [];
  await localProxy(
    async (origin) => {
      for (const stream of [false, true]) {
        const response = await post(origin, {
          stream,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "result",
              strict: true,
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
          verbosity: "low",
          service_tier: "default",
          messages: [
            {
              role: "system",
              content: [
                { type: "text", text: "base" },
                { type: "text", text: "\npolicy" },
              ],
            },
            {
              role: "user",
              agent: { name: "synthetic-client" },
              conversationRequestId: "synthetic-request",
              content: [
                { type: "text", text: "hello\n" },
                { type: "text", text: "中文" },
              ],
            },
          ],
        });
        const raw = await response.text();
        assert.equal(response.status, 200, raw);
        if (stream) {
          assert(raw.endsWith("data: [DONE]\n\n"));
          const chunks = parseSseChunks<{
            choices: Array<{ delta?: { content?: string } }>;
          }>(raw);
          assert.equal(
            chunks
              .flatMap((c) => c.choices)
              .map((c) => c.delta?.content ?? "")
              .join(""),
            '{"ok":true}',
          );
        } else
          assert.equal(
            JSON.parse(raw).choices[0].message.content,
            '{"ok":true}',
          );
      }
      assert.deepEqual(
        starts.map((s) => s.baseInstructions),
        ["base\npolicy", "base\npolicy"],
      );
      for (const turn of turns)
        assert.equal(
          (turn.input as Array<{ text: string }>)[0]?.text,
          "hello\n中文",
        );
      for (const start of starts)
        assert.equal(
          (start.config as Record<string, unknown>).model_verbosity,
          "low",
        );
      for (const turn of turns) {
        assert.equal(turn.serviceTierForTurn, "default");
        assert.deepEqual(turn.outputSchema, {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        });
      }
      const imageUrl = "data:image/png;base64,AA==";
      const imageResponse = await post(origin, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              {
                type: "image_url",
                image_url: { url: imageUrl, detail: "low" },
              },
            ],
          },
        ],
      });
      assert.equal(imageResponse.status, 200, await imageResponse.text());
      assert.deepEqual(turns[2]?.input, [
        { type: "text", text: "inspect", text_elements: [] },
        { type: "image", url: imageUrl, detail: "low" },
      ]);
      const audioResponse = await post(origin, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "transcribe" },
              {
                type: "input_audio",
                input_audio: { data: "AA==", format: "mp3" },
              },
            ],
          },
        ],
      });
      assert.equal(audioResponse.status, 200, await audioResponse.text());
      assert.deepEqual(turns[3]?.input, [
        { type: "text", text: "transcribe", text_elements: [] },
        { type: "audio", url: "data:audio/mpeg;base64,AA==" },
      ]);
      const fileData = `data:application/pdf;base64,${syntheticPdf().toString("base64")}`;
      const fileResponse = await post(origin, {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize" },
              {
                type: "file",
                file: { filename: "sample.pdf", file_data: fileData },
              },
            ],
          },
        ],
      });
      assert.equal(fileResponse.status, 200, await fileResponse.text());
      assert.equal(injections.length, 0);
      const fileInput = turns[4]?.input as Array<{
        type: string;
        text?: string;
        url?: string;
      }>;
      assert.equal(fileInput[0]?.text, "summarize");
      assert.match(fileInput[1]?.text ?? "", /Synthetic PDF/);
      assert.equal(fileInput[2]?.type, "image");
      assert.match(fileInput[2]?.url ?? "", /^data:image\/png;base64,/);
      const response = await post(origin, {
        stream: true,
        messages: [
          { role: "system", content: "synthetic" },
          {
            role: "user",
            content: [
              { type: "text", text: "keep" },
              {
                type: "image_url",
                image_url: { url: "https://example.invalid/image" },
              },
            ],
          },
        ],
      });
      assert.equal(response.status, 400);
      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
      );
      const error = (await response.json()) as {
        error: { code: string; param: string };
      };
      assert.equal(error.error.code, "invalid_request");
      assert.equal(error.error.param, "messages.1.content.1.image_url.url");
      assert.equal(starts.length, 5);
    },
    (message, send) => {
      const id = message.id as number;
      if (message.method === "thread/start") {
        starts.push(message.params as Record<string, unknown>);
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread("compat_thread")),
          ),
        );
      } else if (message.method === "thread/inject_items") {
        injections.push(message.params as Record<string, unknown>);
        send(protocolResponse("thread/inject_items", id, {}));
      } else if (message.method === "turn/start") {
        turns.push(message.params as Record<string, unknown>);
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn("compat_turn", "inProgress"),
          }),
        );
        // The schema response must not expose commentary or an earlier draft.
        for (const [itemId, phase, text] of [
          ["progress", "commentary", "Working..."],
          ["draft", "final_answer", '{"ok":false}'],
        ] as const) {
          send(
            protocolNotification({
              method: "item/completed",
              params: {
                threadId: "compat_thread",
                turnId: "compat_turn",
                completedAtMs: 0,
                item: {
                  type: "agentMessage",
                  id: itemId,
                  text,
                  phase,
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
              },
            }),
          );
        }
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: "compat_thread",
              turnId: "compat_turn",
              itemId: "compat_message",
              delta: '{"ok":',
            },
          }),
        );
        send(
          protocolNotification({
            method: "item/completed",
            params: {
              threadId: "compat_thread",
              turnId: "compat_turn",
              completedAtMs: 1,
              item: {
                type: "agentMessage",
                id: "compat_message",
                text: '{"ok":true}',
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            },
          }),
        );
        completeTurn(send, "compat_thread", "compat_turn");
      }
    },
  );
}, 15_000);

test("invalid PDF rendering ends before any app-server thread", async () => {
  let starts = 0;
  let turns = 0;
  await localProxy(
    async (origin) => {
      const fileData = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nsynthetic").toString("base64")}`;
      const response = await post(origin, {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                file: { filename: "sample.pdf", file_data: fileData },
              },
            ],
          },
        ],
      });
      assert.equal(response.status, 400);
      assert.equal(starts, 0);
      assert.equal(turns, 0);
    },
    (message) => {
      if (message.method === "thread/start") starts += 1;
      else if (message.method === "turn/start") turns += 1;
    },
  );
});

test("invalid structured output returns an error without corrupt content or a successful DONE", async () => {
  await localProxy(
    async (origin, _send, store) => {
      for (const stream of [false, true]) {
        const response = await post(origin, {
          stream,
          response_format: {
            type: "json_schema",
            json_schema: { schema: { type: "object" } },
          },
        });
        const raw = await response.text();
        assert.equal(response.status, 502, raw);
        assert.equal(JSON.parse(raw).error.code, "invalid_structured_output");
        assert(!raw.includes("[DONE]"));
        assert(!raw.includes("broken-prefix"));
      }
      const summary = store.report().summary as {
        requests: number;
        successful: number;
      };
      assert.equal(summary.requests, 2);
      assert.equal(summary.successful, 0);
    },
    (message, send) => {
      const id = message.id as number;
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread(`invalid_${id}`)),
          ),
        );
      else if (message.method === "turn/start") {
        const threadId = (message.params as { threadId: string }).threadId;
        const turnId = `invalid_turn_${id}`;
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn(turnId, "inProgress"),
          }),
        );
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "invalid",
              delta: "broken-prefix",
            },
          }),
        );
        completeTurn(send, threadId, turnId);
      }
    },
  );
});

test("managed key revocation gates HTTP admission without touching the legacy bearer", async () => {
  await localProxy(
    async (origin, _send, store) => {
      const key = store.createKey("synthetic-client");
      const health = () =>
        fetch(`${origin}/health`, {
          headers: { authorization: `Bearer ${key.secret}` },
        });
      assert.equal((await health()).status, 200);
      store.setKeyEnabled(key.id, false);
      assert.equal((await health()).status, 401);
      assert.equal(
        (
          await fetch(`${origin}/health`, {
            headers: { authorization: "Bearer regression-test-key" },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/health`, {
            headers: { authorization: "Bearer synthetic-admin-preview-token" },
          })
        ).status,
        401,
      );
    },
    () => assert.fail("Health must not invoke app-server"),
  );
});

test("HTTP follow-ups accept WorkBuddy assistant response metadata in both modes", async () => {
  await localProxy(
    async (origin) => {
      const first = await post(origin, {});
      assert.equal(first.status, 200);
      const reply = (await first.json()).choices[0].message;
      for (const stream of [false, true]) {
        const response = await post(origin, {
          stream,
          messages: [
            { role: "user", content: "synthetic" },
            {
              ...reply,
              messageId: "synthetic-message",
              entryId: "synthetic-entry",
              compactType: "pre-message-auto",
              isCompactInternal: true,
              isCompacted: true,
              isSummary: true,
              skipRun: true,
              model: "old-model",
              rawUsage: {},
              requestModelId: "old-id",
              requestModelName: "old-name",
              traceId: "synthetic-trace",
              usage: {},
            },
            { role: "user", content: "synthetic follow-up" },
          ],
        });
        const raw = await response.text();
        assert.equal(response.status, 200, raw);
        if (stream) assert(raw.endsWith("data: [DONE]\n\n"));
        else assert.equal(JSON.parse(raw).choices[0].message.content, "ok");
      }
    },
    (message, send) => {
      const id = message.id as number;
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread(`metadata_${id}`)),
          ),
        );
      else if (message.method === "thread/resume")
        send(
          protocolResponse(
            "thread/resume",
            id,
            protocolThreadResumeResponse(
              protocolThread((message.params as { threadId: string }).threadId),
            ),
          ),
        );
      else if (message.method === "thread/inject_items")
        send(protocolResponse("thread/inject_items", id, {}));
      else if (message.method === "turn/start") {
        const thread = (message.params as { threadId: string }).threadId;
        const turn = `metadata_turn_${id}`;
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn(turn, "inProgress"),
          }),
        );
        send(
          protocolNotification({
            method: "item/agentMessage/delta",
            params: {
              threadId: thread,
              turnId: turn,
              itemId: `metadata_item_${id}`,
              delta: "ok",
            },
          }),
        );
        completeTurn(send, thread, turn);
      }
    },
  );
});

test("fragmented native Bash arguments larger than 128 KiB remain one valid JSON object", async () => {
  const args = {
    command: '中文 "quoted" \\path\n'.repeat(9000),
    description: "synthetic only",
  };
  assert(Buffer.byteLength(JSON.stringify(args)) > 128 * 1024);
  await localProxy(
    async (origin) => {
      const response = await post(origin, {
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "Bash",
              parameters: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  description: { type: "string" },
                },
                required: ["command", "description"],
              },
            },
          },
        ],
      });
      assert.equal(response.status, 200);
      const chunks = parseSseChunks<{
        choices: Array<{
          finish_reason: string | null;
          delta?: {
            tool_calls?: Array<{
              index: number;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      }>(await response.text());
      const calls = chunks
        .flatMap((c) => c.choices)
        .flatMap((c) => c.delta?.tool_calls ?? []);
      assert.deepEqual([...new Set(calls.map((c) => c.index))], [0]);
      assert.equal(calls.map((c) => c.function?.name ?? "").join(""), "Bash");
      assert.deepEqual(
        JSON.parse(calls.map((c) => c.function?.arguments ?? "").join("")),
        args,
      );
      assert(
        chunks.some((c) =>
          c.choices.some((c) => c.finish_reason === "tool_calls"),
        ),
      );
    },
    (message, send) => {
      const id = message.id as number;
      if (message.method === "thread/start")
        send(
          protocolResponse(
            "thread/start",
            id,
            protocolThreadStartResponse(protocolThread("large_tool_thread")),
          ),
        );
      else if (message.method === "turn/start") {
        send(
          protocolResponse("turn/start", id, {
            turn: protocolTurn("large_tool_turn", "inProgress"),
          }),
        );
        suspendWithTools(send, "large_tool_thread", "large_tool_turn", [
          { id: 101, callId: "large_bash", tool: "Bash", arguments: args },
        ]);
      } else if (message.method === "turn/interrupt") {
        send(protocolResponse("turn/interrupt", id, {}));
        interruptTurn(send, "large_tool_thread", "large_tool_turn");
      }
    },
  );
});
