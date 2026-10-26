import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { AdminStore } from "../../src/admin/store.js";
import { startProxyWithTransport } from "../support/http.js";
import { waitFor } from "../support/poll.js";
import { withTempDir } from "../support/temp.js";
import { createFakeTransport, completeTurn } from "../support/transport.js";
import {
  protocolResponse,
  protocolServerRequest,
  protocolThread,
  protocolThreadStartResponse,
  protocolTurn,
  protocolNotification,
} from "../support/protocol-fixtures.js";
import type { Interaction } from "../../src/app-server/interactions.js";

for (const stream of [false, true])
  test(`client extension answers resume an original ${stream ? "SSE" : "aggregate"} completion`, async () => {
    await withTempDir(async (root) => {
      const store = new AdminStore(join(root, "admin"));
      const callbackResults: unknown[] = [];
      const fake = createFakeTransport({
        fragmentCount: 3,
        onMessage(message, send) {
          if (message.method === "thread/start")
            send(
              protocolResponse(
                "thread/start",
                message.id as number,
                protocolThreadStartResponse(
                  protocolThread("thread_interactive"),
                ),
              ),
            );
          if (message.method === "turn/start") {
            // The callback deliberately precedes the turn/start response.
            send(
              protocolServerRequest({
                id: "input_fixture",
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "thread_interactive",
                  turnId: "turn_interactive",
                  itemId: "input_fixture",
                  isBlocking: true,
                  autoResolutionMs: null,
                  questions: [
                    {
                      id: "answer",
                      header: "Question",
                      question: "Continue?",
                      isOther: true,
                      isSecret: false,
                      options: null,
                    },
                  ],
                },
              }),
            );
            send(
              protocolResponse("turn/start", message.id as number, {
                turn: protocolTurn("turn_interactive", "inProgress"),
              }),
            );
          }
          if (message.id === "input_fixture" && "result" in message) {
            callbackResults.push(message.result);
            send(
              protocolNotification({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread_interactive",
                  turnId: "turn_interactive",
                  itemId: "message_fixture",
                  delta: "resumed",
                },
              }),
            );
            completeTurn(send, "thread_interactive", "turn_interactive");
          }
        },
      });
      const { proxy, origin } = await startProxyWithTransport(fake.rpc, {
        root,
        stateDir: join(root, "state"),
        administration: store,
      });
      const broker = proxy.interactions!;
      fake.rpc.on("request", (request) => broker.handle(fake.rpc, request));
      const channel = "1242ca65-5d54-4d5f-87b7-d3ba942af40c";
      const key = store.createKey("client");
      const other = store.createKey("other");
      // Reply requests must work even while the original completion fills capacity.
      store.saveSettings({
        model: "synthetic",
        timeoutMs: 30000,
        maxRequests: 1,
      });
      const post = (input: unknown, token = key.secret) =>
        fetch(`${origin}/v1/x_codex/interactions/respond`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
        });
      const list = (token = key.secret, id = channel) =>
        fetch(`${origin}/v1/x_codex/interactions?interaction_id=${id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      let completion: Promise<Response> | undefined;
      try {
        completion = fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key.secret}`,
          },
          body: JSON.stringify({
            model: "synthetic",
            stream,
            x_codex: { interaction_id: channel },
            messages: [{ role: "user", content: "ask a question" }],
          }),
        });
        await waitFor(
          () => broker.list().length === 1,
          () => "pending user question",
          2000,
        );
        const listed = await list();
        const item = (
          (await listed.json()) as { x_codex: { interactions: Interaction[] } }
        ).x_codex.interactions[0]!;
        assert.ok(item);
        const answer = {
          interaction_id: channel,
          id: item.id,
          response: { answers: { answer: { answers: ["continue"] } } },
        };
        assert.deepEqual(
          (
            (await (await list(other.secret)).json()) as {
              x_codex: { interactions: Interaction[] };
            }
          ).x_codex.interactions,
          [],
        );
        assert.deepEqual(
          (
            (await (await list(key.secret, "other-channel")).json()) as {
              x_codex: { interactions: Interaction[] };
            }
          ).x_codex.interactions,
          [],
        );
        assert.equal((await post(answer, other.secret)).status, 409);
        assert.equal(
          (await post({ ...answer, interaction_id: "wrong" })).status,
          409,
        );
        assert.equal(
          (
            await post({
              ...answer,
              response: { answers: { unknown: { answers: ["bad"] } } },
            })
          ).status,
          400,
        );
        assert.equal(callbackResults.length, 0);
        assert.equal((await post(answer)).status, 200);
        assert.equal((await post(answer)).status, 409);
        const response = await completion;
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /resumed/);
        if (stream) assert.match(text, /\[DONE\]/);
        assert.deepEqual(callbackResults, [answer.response]);
        assert.deepEqual(broker.list(), []);
      } finally {
        await proxy.close();
        store.close();
        fake.close();
        await completion?.catch(() => undefined);
      }
    });
  });
