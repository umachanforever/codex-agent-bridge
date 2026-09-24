import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { test, vi, afterEach } from "vitest";
import {
  adaptLocalBridgeRequest,
  localBridgeAuthorizer,
} from "../../src/http/local-bridge.js";
import { parseServeOptions } from "../../src/core/config.js";
import { withTempDir } from "../support/temp.js";
import { validateRequest } from "../../src/http/chat-validate.js";
import { silentLogger } from "../support/logger.js";

afterEach(() => vi.unstubAllEnvs());

test("service profile is explicit and cannot conflict with legacy defaults", () => {
  const options = parseServeOptions(["--agent-service-model", "synthetic"]);
  assert.equal(options.agentService, true);
  assert.equal(options.localBridgeModel, "synthetic");
  assert.throws(
    () =>
      parseServeOptions([
        "--agent-service-model",
        "synthetic",
        "--local-bridge-model",
        "other",
      ]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseServeOptions(["--agent-service-model", " "]),
    /non-empty/,
  );
  const body = { messages: [{ role: "user", content: "synthetic" }] };
  assert.equal(
    (
      adaptLocalBridgeRequest(body, "synthetic", true) as {
        x_codex: { sandbox: string };
      }
    ).x_codex.sandbox,
    "disabled",
  );
  assert.equal(
    (
      adaptLocalBridgeRequest(body, "synthetic") as {
        x_codex: { sandbox: string };
      }
    ).x_codex.sandbox,
    "danger-full-access",
  );
});

test("future metadata is ignored without mutation or permission escalation", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: "keep",
        futureVersion: { arbitrary: true },
        sandbox: "danger-full-access",
      },
    ],
    stream_options: { include_usage: true, futureOption: true },
  };
  const before = JSON.stringify(body);
  const adapted = adaptLocalBridgeRequest(body, "synthetic", true);
  assert.doesNotThrow(() =>
    validateRequest(adapted, silentLogger, "synthetic", true),
  );
  assert.equal(JSON.stringify(body), before);
  assert.deepEqual((adapted as { messages: unknown[] }).messages, [
    { role: "user", content: "keep" },
  ]);
  assert.throws(
    () =>
      validateRequest(
        adaptLocalBridgeRequest(
          { ...body, stream_options: { include_usage: "yes" } },
          "synthetic",
          true,
        ),
        silentLogger,
        "synthetic",
        true,
      ),
    /include_usage/,
  );
});

test("file-backed bearer secrets fail closed and accept one terminal newline", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "key");
    vi.stubEnv("CODEX_BRIDGE_TOKEN", undefined);
    vi.stubEnv("CODEX_BRIDGE_TOKEN_FILE", file);
    assert.throws(() => localBridgeAuthorizer(true));
    await writeFile(file, "synthetic-secret\n");
    const authorize = localBridgeAuthorizer(true);
    assert.equal(
      authorize({
        headers: { authorization: "Bearer synthetic-secret" },
      } as IncomingMessage),
      true,
    );
    assert.equal(
      authorize({
        headers: { authorization: "Bearer wrong" },
      } as IncomingMessage),
      false,
    );
    assert.equal(authorize({ headers: {} } as IncomingMessage), false);
    vi.stubEnv("CODEX_BRIDGE_TOKEN", "conflict");
    assert.throws(() => localBridgeAuthorizer(true), /Set only/);
    vi.stubEnv("CODEX_BRIDGE_TOKEN", undefined);
    for (const value of ["", "\n", "bad key", "key\n\n"]) {
      await writeFile(file, value);
      assert.throws(() => localBridgeAuthorizer(true), /nonempty bearer/);
    }
  });
});
