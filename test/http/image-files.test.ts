import assert from "node:assert/strict";
import http from "node:http";
import { test, vi } from "vitest";
import { ImageFiles } from "../../src/http/image-files.js";
import { generatedImage } from "../../src/http/generated-image.js";
import { createProxyServer } from "../../src/http/server.js";
import {
  parseServeOptions,
  resolveServeOptions,
} from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";
import { createLogger } from "../../src/core/logger.js";
import { createFakeTransport, completeTurn } from "../support/transport.js";
import {
  protocolNotification,
  protocolResponse,
  protocolThread,
  protocolThreadStartResponse,
  protocolThreadResumeResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import type { ChatMessage } from "../../src/http/chat-validate.js";

/** Synthetic PNG bytes exercise original-image delivery without provider traffic. */
const bytes = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(1024 * 1024),
]);
/** Validated generated image whose intentionally incorrect metadata must be ignored. */
const image = generatedImage({
  status: "completed",
  result: bytes.toString("base64"),
  output_format: "jpeg",
});

/** Extracts the single image source returned in standard Markdown content. */
function source(markdown: string): string {
  const result = /!\[Generated image\]\(([^)]+)\)/u.exec(markdown)?.[1];
  assert.ok(result);
  return result;
}

test("cached image history restores only owned sources and expires without fetching", () => {
  const files = new ImageFiles();
  const url = source(files.publish(image, "http://127.0.0.1:8787"));
  const messages: ChatMessage[] = [
    { role: "assistant", content: `![Generated image](${url})` },
    { role: "user", content: "Make it blue." },
  ];
  const published = files.publish(image, "http://127.0.0.1:8787");
  assert.equal(published.trim(), `![Generated image](${source(published)})`);
  const restored = files.restore(messages, "http://127.0.0.1:8787");
  assert.equal(restored[0]?.content, "[Previously generated image]");
  assert.ok(
    restored[1]?.contentParts?.some(
      (part) =>
        part.type === "image" &&
        part.url === `data:image/png;base64,${bytes.toString("base64")}`,
    ),
  );
  assert.ok(
    restored[1]?.contentParts?.some(
      (part) => part.type === "text" && part.text.includes(url),
    ),
  );
  assert.deepEqual(files.restore(messages, "http://127.0.0.1:9999"), messages);
  for (const input of [
    url + "?token=other",
    url.replace("127.0.0.1", "example.invalid"),
    "http://[",
  ]) {
    const foreign: ChatMessage[] = [
      { role: "assistant", content: `![Generated image](${input})` },
      { role: "user", content: "Describe the image." },
    ];
    assert.deepEqual(files.restore(foreign, "http://127.0.0.1:8787"), foreign);
  }
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
  try {
    assert.deepEqual(
      files.restore(messages, "http://127.0.0.1:8787"),
      messages,
    );
  } finally {
    vi.restoreAllMocks();
  }
  const second = source(files.publish(image, "http://127.0.0.1:8787"));
  files.clear();
  const cleared: ChatMessage[] = [
    { role: "assistant", content: `![Generated image](${second})` },
    { role: "user", content: "Export the image." },
  ];
  assert.deepEqual(files.restore(cleared, "http://127.0.0.1:8787"), cleared);
});

test("visual replay preserves client tool-result adjacency and bounds repeated image expansion", () => {
  const files = new ImageFiles();
  const markdown = files.publish(image, "http://127.0.0.1:8787");
  const history: ChatMessage[] = [
    { role: "user", content: "Draw one image." },
    {
      role: "assistant",
      content: markdown,
      toolCalls: [{ id: "call_fixture", name: "lookup", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call_fixture", content: "done" },
  ];
  const restored = files.restore(history, "http://127.0.0.1:8787");
  assert.deepEqual(
    restored.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.deepEqual(restored[1]?.toolCalls, history[1]?.toolCalls);
  assert.equal(restored[2]?.toolCallId, "call_fixture");
  assert.throws(
    () =>
      files.restore(
        [
          { role: "assistant", content: markdown.repeat(41) },
          { role: "user", content: "Edit these images." },
        ],
        "http://127.0.0.1:8787",
      ),
    /40 MiB replay limit/u,
  );
  files.clear();
});

test("image capacity evicts older capabilities without retaining unbounded metadata", () => {
  const files = new ImageFiles();
  const first = files.publish(image, "http://127.0.0.1:8787");
  for (let i = 0; i < 128; i++) files.publish(image, "http://127.0.0.1:8787");
  const history: ChatMessage[] = [
    { role: "assistant", content: first },
    { role: "user", content: "Describe the image." },
  ];
  assert.deepEqual(files.restore(history, "http://127.0.0.1:8787"), history);
  files.clear();
});

test.each([false, true])(
  "authenticated image delivery, native=%s, supports JSON and SSE",
  async (native) => {
    const previous = process.env.CODEX_BRIDGE_TOKEN;
    process.env.CODEX_BRIDGE_TOKEN = "synthetic-image-key";
    try {
      await withTempDir(async (root) => {
        const logs: unknown[] = [];
        const config = await resolveServeOptions(
          parseServeOptions([
            "--port",
            "0",
            "--root",
            root,
            "--state-dir",
            root,
            "--local-bridge-model",
            "gpt-6-luna",
          ]),
        );
        let counter = 0;
        let injected = false;
        const fake = createFakeTransport({
          onMessage(message, send) {
            const id = message.id as number;
            if (message.method === "thread/start") {
              const params = message.params as {
                baseInstructions: string;
                dynamicTools?: unknown[];
              };
              if (params.dynamicTools?.length)
                assert.match(
                  params.baseInstructions,
                  /Do not automatically call present_files/u,
                );
              send(
                protocolResponse(
                  "thread/start",
                  id,
                  protocolThreadStartResponse(
                    protocolThread(`thread_${++counter}`),
                    root,
                  ),
                ),
              );
            } else if (message.method === "thread/read") {
              send(
                protocolResponse("thread/read", id, {
                  readState: null,
                  thread: protocolThread(
                    (message.params as { threadId: string }).threadId,
                  ),
                }),
              );
            } else if (message.method === "thread/resume") {
              send(
                protocolResponse(
                  "thread/resume",
                  id,
                  protocolThreadResumeResponse(
                    protocolThread(
                      (message.params as { threadId: string }).threadId,
                    ),
                    root,
                  ),
                ),
              );
            } else if (message.method === "thread/inject_items") {
              injected = true;
              const items = (message.params as { items: unknown[] }).items;
              assert.match(JSON.stringify(items), /call_imgfile_/u);
              send(protocolResponse("thread/inject_items", id, {}));
            } else if (message.method === "turn/start") {
              const threadId = (message.params as { threadId: string })
                .threadId;
              const turnId = `turn_${counter}`;
              send(
                protocolResponse("turn/start", id, {
                  turn: protocolTurn(turnId, "inProgress"),
                }),
              );
              if (!injected)
                send(
                  protocolNotification({
                    method: "item/completed",
                    params: {
                      threadId,
                      turnId,
                      completedAtMs: 1,
                      item: {
                        type: "imageGeneration",
                        id: `img_${counter}`,
                        status: "completed",
                        failure: null,
                        revisedPrompt: null,
                        result: bytes.toString("base64"),
                      },
                    },
                  }),
                );
              completeTurn(send, threadId, turnId);
            } else if (message.method === "turn/interrupt")
              send(protocolResponse("turn/interrupt", id, {}));
          },
        });
        const proxy = createProxyServer(
          config,
          createLogger("info", (entry) => logs.push(entry)),
        );
        proxy.setTransport(fake.rpc);
        proxy.setReady(true);
        const address = await proxy.listen();
        const origin = `http://127.0.0.1:${address.port}`;
        try {
          for (const stream of [false, true]) {
            const response = await fetch(origin + "/v1/chat/completions", {
              method: "POST",
              headers: {
                authorization: "Bearer synthetic-image-key",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-6-luna",
                messages: [{ role: "user", content: "Generate one image." }],
                stream,
                tools: [
                  ...(native
                    ? [
                        {
                          type: "function",
                          function: {
                            name: "Bash",
                            parameters: {
                              type: "object",
                              properties: { command: { type: "string" } },
                              required: ["command"],
                            },
                          },
                        },
                      ]
                    : []),
                  {
                    type: "function",
                    function: {
                      name: "present_files",
                      parameters: {
                        type: "object",
                        properties: {
                          files: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                ],
              }),
            });
            assert.equal(response.status, 200);
            const text = await response.text();
            assert.ok(text.length < 6000);
            assert.ok(!text.includes("data:image/"));
            let content: string;
            let call:
              | {
                  id: string;
                  type: "function";
                  function: { name: string; arguments: string };
                }
              | undefined;
            let responseId: string | undefined;
            if (stream) {
              const frames = text
                .split("\n")
                .filter((line) => line.startsWith("data: {"))
                .map(
                  (line) =>
                    JSON.parse(line.slice(6)) as {
                      choices?: {
                        delta?: {
                          content?: string;
                          tool_calls?: {
                            id: string;
                            type: "function";
                            function: { name: string; arguments: string };
                          }[];
                        };
                        finish_reason?: string;
                      }[];
                    },
                );
              call = frames.flatMap(
                (frame) => frame.choices?.[0]?.delta?.tool_calls ?? [],
              )[0];
              assert.equal(Boolean(call), native);
              assert.equal(
                frames.at(-1)?.choices?.[0]?.finish_reason,
                native ? "tool_calls" : "stop",
              );
              content = frames
                .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
                .join("");
            } else {
              const result = JSON.parse(text) as {
                id: string;
                choices: {
                  message: {
                    content: string;
                    tool_calls?: {
                      id: string;
                      type: "function";
                      function: { name: string; arguments: string };
                    }[];
                  };
                  finish_reason: string;
                }[];
              };
              content = result.choices[0]!.message.content ?? "";
              call = result.choices[0]!.message.tool_calls?.[0];
              responseId = result.id;
              assert.equal(Boolean(call), native);
              assert.equal(
                result.choices[0]!.finish_reason,
                native ? "tool_calls" : "stop",
              );
            }
            if (native) {
              assert.equal(call!.function.name, "Bash");
              assert.ok(!content.includes("!["));
              const command = (
                JSON.parse(call!.function.arguments) as { command: string }
              ).command;
              const url = command.match(
                /http:\/\/127\.0\.0\.1:\d+\/v1\/x_codex\/images\/[a-f0-9]{64}\.png/u,
              )?.[0];
              assert.ok(url);
              assert.match(command, / && cp -n /u);
              content = `![Generated image](${url})`;
            }
            const imageUrl = source(content);
            assert.match(
              imageUrl,
              /\/v1\/x_codex\/images\/[a-f0-9]{64}\.png$/u,
            );
            const file = await fetch(imageUrl, {
              headers: { origin: "https://client.invalid" },
            });
            assert.equal(file.status, 200);
            assert.equal(file.headers.get("content-type"), "image/png");
            assert.equal(file.headers.get("access-control-allow-origin"), "*");
            assert.equal(file.headers.get("cache-control"), "no-store");
            assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
            const head = await fetch(imageUrl, { method: "HEAD" });
            assert.equal(head.status, 200);
            assert.equal(
              head.headers.get("content-length"),
              String(bytes.length),
            );
            assert.equal((await head.arrayBuffer()).byteLength, 0);
            assert.equal(
              (
                await fetch(
                  imageUrl.replace(
                    /([a-f0-9]{64})\.png$/u,
                    "0".repeat(64) + ".png",
                  ),
                )
              ).status,
              404,
            );
            const hostileStatus = await new Promise<number>(
              (resolve, reject) => {
                const request = http.get(
                  imageUrl,
                  { headers: { host: "evil.invalid" } },
                  (response) => {
                    response.resume();
                    resolve(response.statusCode!);
                  },
                );
                request.on("error", reject);
              },
            );
            assert.equal(hostileStatus, 403);
            if (native && !stream) {
              const follow = await fetch(origin + "/v1/chat/completions", {
                method: "POST",
                headers: {
                  authorization: "Bearer synthetic-image-key",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: "gpt-6-luna",
                  previous_response_id: responseId,
                  messages: [
                    { role: "assistant", content: null, tool_calls: [call] },
                    {
                      role: "tool",
                      tool_call_id: call!.id,
                      content: "Original saved successfully.",
                    },
                  ],
                  tools: [
                    {
                      type: "function",
                      function: {
                        name: "Bash",
                        parameters: {
                          type: "object",
                          properties: { command: { type: "string" } },
                          required: ["command"],
                        },
                      },
                    },
                    {
                      type: "function",
                      function: {
                        name: "present_files",
                        parameters: {
                          type: "object",
                          properties: {
                            files: { type: "array", items: { type: "string" } },
                          },
                        },
                      },
                    },
                  ],
                }),
              });
              const result = (await follow.json()) as {
                choices: { finish_reason: string }[];
                x_codex: { threadReused: boolean };
              };
              assert.equal(follow.status, 200);
              assert.equal(result.choices[0]!.finish_reason, "stop");
              assert.equal(result.x_codex.threadReused, true);
              assert.equal(injected, true);
              injected = false;
            }
            assert.ok(
              !JSON.stringify(logs).includes(
                new URL(imageUrl).pathname.split("/").at(-1)!,
              ),
            );
          }
          assert.equal((await fetch(origin + "/v1/models")).status, 401);
          assert.equal(
            (
              await fetch(origin + "/v1/models", {
                headers: {
                  origin: "https://client.invalid",
                  authorization: "Bearer synthetic-image-key",
                },
              })
            ).status,
            403,
          );
          const forwardedContent = await new Promise<string>(
            (resolve, reject) => {
              const request = http.request(
                origin + "/v1/chat/completions",
                {
                  method: "POST",
                  headers: {
                    host: "localhost:45678",
                    authorization: "Bearer synthetic-image-key",
                    "content-type": "application/json",
                  },
                },
                (response) => {
                  let text = "";
                  response.setEncoding("utf8");
                  response.on("data", (chunk) => {
                    text += String(chunk);
                  });
                  response.on("end", () => {
                    try {
                      assert.equal(response.statusCode, 200);
                      resolve(
                        (
                          JSON.parse(text) as {
                            choices: { message: { content: string } }[];
                          }
                        ).choices[0]!.message.content,
                      );
                    } catch (error) {
                      reject(error);
                    }
                  });
                },
              );
              request.on("error", reject);
              request.end(
                JSON.stringify({
                  model: "gpt-6-luna",
                  messages: [{ role: "user", content: "Generate one image." }],
                  tools: [
                    {
                      type: "function",
                      function: {
                        name: "show_widget",
                        parameters: { type: "object", properties: {} },
                      },
                    },
                  ],
                }),
              );
            },
          );
          assert.ok(
            source(forwardedContent).startsWith(
              "http://localhost:45678/v1/x_codex/images/",
            ),
          );
          const fallback = await fetch(origin + "/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: "Bearer synthetic-image-key",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-6-luna",
              messages: [{ role: "user", content: "Generate one image." }],
            }),
          });
          assert.equal(fallback.status, 200);
          assert.ok((await fallback.text()).includes("data:image/png;base64,"));
        } finally {
          await proxy.close();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_BRIDGE_TOKEN;
      else process.env.CODEX_BRIDGE_TOKEN = previous;
    }
  },
  15000,
);
