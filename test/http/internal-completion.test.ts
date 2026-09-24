import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { AdminStore } from "../../src/admin/store.js";
import { withTempDir } from "../support/temp.js";
import { startProxyWithTransport } from "../support/http.js";
import {
  protocolNotification,
  protocolResponse,
  protocolThread,
  protocolThreadStartResponse,
  protocolTurn,
} from "../support/protocol-fixtures.js";
import { completeTurn, createFakeTransport } from "../support/transport.js";

/** Exercises the internal completion seam through a synthetic app-server. */
test("internal text completion shares Codex execution without HTTP authorization", async () => {
  await withTempDir(async (root) => {
    let turns = 0;
    const administration = new AdminStore(join(root, "admin"));
    const fake = createFakeTransport({
      onMessage(raw, send) {
        const message = raw as { id: number; method: string };
        if (message.method === "thread/start") {
          send(
            protocolResponse("thread/start", message.id, {
              ...protocolThreadStartResponse(protocolThread("thr_internal")),
              instructionSources: [],
            }),
          );
        } else if (message.method === "thread/inject_items") {
          send(protocolResponse("thread/inject_items", message.id, {}));
        } else if (message.method === "turn/start") {
          turns += 1;
          send(
            protocolResponse("turn/start", message.id, {
              turn: protocolTurn("turn_internal", "inProgress"),
            }),
          );
          send(
            protocolNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thr_internal",
                turnId: "turn_internal",
                itemId: "answer",
                delta: "synthetic answer",
              },
            }),
          );
          completeTurn(send, "thr_internal", "turn_internal");
        }
      },
    });
    const { proxy } = await startProxyWithTransport(fake.rpc, {
      root,
      stateDir: root,
      administration,
    });
    try {
      const request = {
        model: "synthetic",
        messages: [{ role: "user", content: "Return synthetic text." }],
        x_codex: { sandbox: "disabled", web_search: "disabled" },
      };
      assert.equal(
        await proxy.completeText(request, new AbortController().signal),
        "synthetic answer",
      );
      assert.equal(turns, 1);
      const report = administration.report() as {
        rows: Array<{
          key_id: string;
          model: string;
          status: number;
          total: number;
        }>;
      };
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0]?.key_id, "legacy");
      assert.equal(report.rows[0]?.model, "synthetic");
      assert.equal(report.rows[0]?.status, 200);
      assert.equal(report.rows[0]?.total, 6);
      await assert.rejects(
        proxy.completeText(
          { ...request, stream: true },
          new AbortController().signal,
        ),
        /non-streaming and tool-free/,
      );
      assert.equal(turns, 1);
      const aborted = new AbortController();
      aborted.abort(new Error("cancelled"));
      await assert.rejects(
        proxy.completeText(request, aborted.signal),
        /cancelled/,
      );
      assert.equal(turns, 1);
    } finally {
      await proxy.close();
      fake.close();
      administration.close();
    }
  });
});
