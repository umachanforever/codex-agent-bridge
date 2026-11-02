import assert from "node:assert/strict";
import { exec } from "node:child_process";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "vitest";
import {
  nativeImageDownload,
  nativeImageTool,
} from "../../src/http/image-delivery.js";
import { withTempDir } from "../support/temp.js";

/** Compatible normalized client Bash schema. */
const schema = {
  type: "object",
  properties: {
    command: { type: "string" },
    description: { type: "string" },
    timeout: { type: "number" },
  },
  required: ["command"],
};
/** Client features required for native file-card delivery. */
const tools = [
  { name: "present_files" },
  { name: "Bash", inputSchema: schema },
];

test("native delivery requires compatible client tools", () => {
  assert.equal(nativeImageTool(tools), schema);
  assert.equal(nativeImageTool(tools.slice(1)), undefined);
  assert.equal(nativeImageTool([{ name: "show_widget" }]), undefined);
  for (const required of [["unsafe"], ["description"]]) {
    assert.equal(
      nativeImageTool([
        { name: "show_widget" },
        {
          name: "Bash",
          inputSchema: {
            properties: { command: { type: "string" } },
            required,
          },
        },
      ]),
      undefined,
    );
  }
});

test("download rejects foreign and malformed capability sources", () => {
  const origin = "http://127.0.0.1:8787";
  const path = "/v1/x_codex/images/" + "a".repeat(64) + ".png";
  for (const source of [
    "https://foreign.invalid" + path,
    origin + path + "?extra=1",
    origin + path + "#fragment",
    origin + "/secret",
    origin + path.replace(".png", "Xpng"),
  ])
    assert.throws(
      () => nativeImageDownload([source], origin, schema),
      /Invalid generated image source/u,
    );
  assert.throws(() => nativeImageDownload([], origin, schema));
  assert.throws(() =>
    nativeImageDownload(
      Array(17).fill(origin + path) as string[],
      origin,
      schema,
    ),
  );
});

test("single-line client command preserves original bytes and rejects invalid files", async () => {
  await withTempDir(async (root) => {
    let data = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("synthetic original"),
    ]);
    const server = http.createServer((_request, response) =>
      response.end(data),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const source = origin + "/v1/x_codex/images/" + "a".repeat(64) + ".png";
    try {
      const call = nativeImageDownload([source, source], origin, schema);
      const args = JSON.parse(call.arguments) as { command: string };
      assert.equal(args.command.includes("\n"), false);
      assert.match(args.command, / && cp -n /u);
      assert.doesNotMatch(args.command, /present_files|show_widget|<<PY/u);
      await promisify(exec)(args.command, { cwd: root });
      const names = await readdir(root + "/outputs");
      assert.equal(names.length, 1);
      assert.deepEqual(await readFile(root + "/outputs/" + names[0]!), data);
      await assert.rejects(promisify(exec)(args.command, { cwd: root }));
      assert.deepEqual(await readFile(root + "/outputs/" + names[0]!), data);
      data = Buffer.from("invalid image");
      const invalid = JSON.parse(
        nativeImageDownload([source], origin, schema).arguments,
      ) as { command: string };
      await assert.rejects(promisify(exec)(invalid.command, { cwd: root }));
      assert.deepEqual(await readdir(root + "/outputs"), names);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
