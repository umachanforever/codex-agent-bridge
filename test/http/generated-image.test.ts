import assert from "node:assert/strict";
import { test } from "vitest";
import type { ThreadItem } from "../../protocol/generated/typescript/v2/ThreadItem.js";
import { generatedImage } from "../../src/http/generated-image.js";
import {
  EventNormalizer,
  aggregateNormalizedEvents,
} from "../../src/http/chat-normalize.js";

/** Synthetic PNG signature with placeholder bytes; never a production capture. */
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString(
  "base64",
);
/** Complete pinned-protocol image item used by every normalization assertion. */
const item: ThreadItem = {
  type: "imageGeneration",
  id: "img_fixture",
  status: "completed",
  revisedPrompt: null,
  failure: null,
  result: png,
};

test("native images become standard content with path-free activity and deduplication", async () => {
  const normalizer = new EventNormalizer();
  assert.deepEqual(normalizer.normalize("item/started", { item }), []);
  const events = normalizer.normalize("item/completed", { item });
  const aggregate = await aggregateNormalizedEvents(
    (async function* () {
      yield* events;
    })(),
  );
  assert.match(
    aggregate.content,
    /!\[Generated image\]\(data:image\/png;base64,/u,
  );
  assert.equal(aggregate.toolCalls.length, 0);
  assert.deepEqual(aggregate.activityResults[0]?.result.content, {
    mime: "image/png",
    bytes: 12,
  });
  assert.deepEqual(normalizer.normalize("item/completed", { item }), []);
});

test("generation failures, opaque IDs and unsafe image data never become successful content", () => {
  for (const altered of [
    { ...item, status: "failed" },
    { ...item, result: "not an image" },
    { ...item, result: Buffer.from("<svg>unsafe</svg>").toString("base64") },
    {
      ...item,
      result: undefined,
      fileId: "private-file",
      savedPath: "/private/secret",
    },
  ]) {
    const result = new EventNormalizer().normalize("item/completed", {
      item: altered,
    });
    const terminal = result.length
      ? result
      : new EventNormalizer().normalize("item/completed", {
          item: { ...altered, status: "failed" },
        });
    assert.ok(terminal[0]?.terminalError);
    assert.equal(JSON.stringify(result).includes("/private/secret"), false);
  }
  assert.throws(() =>
    generatedImage({ ...item, result: "a".repeat(28 * 1024 * 1024) }),
  );
});

test("structured JSON output fails explicitly instead of appending image Markdown", () => {
  const result = new EventNormalizer(undefined, undefined, true).normalize(
    "item/completed",
    { item },
  );
  assert.equal(
    result[0]?.terminalError?.code,
    "image_generation_structured_output",
  );
});

test("correlated raw image output is exposed once with native lifecycle replay", () => {
  const normalizer = new EventNormalizer();
  const events = normalizer.normalize("rawResponseItem/completed", {
    item: {
      type: "image_generation_call",
      id: item.id,
      status: "completed",
      result: png,
    },
  });
  assert.ok(
    events.some((event) => event.delta?.content?.includes("data:image/png")),
  );
  assert.deepEqual(
    normalizer.normalize("item/completed", {
      item: {
        type: "imageGeneration",
        id: item.id,
        status: "completed",
        failure: null,
        fileId: "opaque",
      },
    }),
    [],
  );
  assert.deepEqual(
    normalizer.normalize("rawResponseItem/completed", {
      item: { type: "other" },
    }),
    [],
  );
});

test("path-only lifecycle waits for late raw bytes and otherwise fails at turn completion", () => {
  const lifecycle = { ...item, result: undefined, fileId: "opaque" };
  const normalizer = new EventNormalizer();
  assert.deepEqual(
    normalizer.normalize("item/completed", { item: lifecycle }),
    [],
  );
  assert.ok(
    normalizer.normalize("turn/completed", { turn: { status: "completed" } })[0]
      ?.terminalError,
  );
  const recovered = new EventNormalizer();
  recovered.normalize("item/completed", { item: lifecycle });
  assert.ok(
    recovered
      .normalize("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: item.id,
          status: "completed",
          result: png,
        },
      })
      .some((event) => event.delta?.content),
  );
  assert.equal(
    recovered.normalize("turn/completed", { turn: { status: "completed" } })[0]
      ?.terminalError,
    undefined,
  );
});
