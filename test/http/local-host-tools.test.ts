import assert from "node:assert/strict";
import { test } from "vitest";
import { adaptLocalBridgeRequest } from "../../src/http/local-bridge.js";

test("local host tools opt-in enables built-in access with client tools", () => {
  const body = {
    model: "synthetic-model",
    messages: [{ role: "user", content: "synthetic" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
  };
  /** Reads the effective sandbox from a synthetic compatibility request. */
  const sandbox = (
    agentService: boolean,
    localHostTools: boolean,
    x_codex?: { sandbox: string },
  ): unknown =>
    (
      adaptLocalBridgeRequest(
        { ...body, ...(x_codex ? { x_codex } : {}) },
        "synthetic-model",
        agentService,
        localHostTools,
      ) as { x_codex: { sandbox: string } }
    ).x_codex.sandbox;
  assert.equal(sandbox(false, false), "disabled");
  assert.equal(sandbox(false, true), "danger-full-access");
  assert.equal(sandbox(true, true), "disabled");
  assert.equal(sandbox(false, true, { sandbox: "read-only" }), "read-only");
});
