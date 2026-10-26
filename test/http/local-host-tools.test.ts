import assert from "node:assert/strict";
import { test } from "vitest";
import { adaptLocalBridgeRequest } from "../../src/http/local-bridge.js";

test("both compatibility profiles enable full access with client tools unless explicitly restricted", () => {
  const body = {
    model: "synthetic-model",
    messages: [{ role: "user", content: "synthetic" }],
    tools: [{ type: "function", function: { name: "Bash" } }],
  };
  /** Reads the effective sandbox from a synthetic compatibility request. */
  const sandbox = (x_codex?: { sandbox: string }): unknown =>
    (
      adaptLocalBridgeRequest(
        { ...body, ...(x_codex ? { x_codex } : {}) },
        "synthetic-model",
      ) as { x_codex: { sandbox: string } }
    ).x_codex.sandbox;
  assert.equal(sandbox(), "danger-full-access");
  for (const mode of [
    "disabled",
    "read-only",
    "workspace-write",
    "danger-full-access",
  ])
    assert.equal(sandbox({ sandbox: mode }), mode);
});
