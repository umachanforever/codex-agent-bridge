import assert from "node:assert/strict";
import { test } from "vitest";
import {
  bindingHash,
  canonicalJson,
  record,
} from "../../src/core/canonical.js";

/** Pins canonical object ordering, nested arrays, and stable binding identity. */
test("canonical bindings ignore object insertion order", () => {
  const first = { z: [{ b: 2, a: 1 }], a: "text" };
  const second = { a: "text", z: [{ a: 1, b: 2 }] };
  assert.equal(canonicalJson(first), '{"a":"text","z":[{"a":1,"b":2}]}');
  assert.equal(canonicalJson(second), canonicalJson(first));
  assert.equal(bindingHash(second), bindingHash(first));
  assert.notEqual(bindingHash({ a: "other" }), bindingHash(first));
});

/** Ensures malformed object candidates and absent JSON values remain predictable. */
test("canonical helpers reject non-records and preserve null placeholders", () => {
  assert.equal(record(null), undefined);
  assert.equal(record([]), undefined);
  assert.equal(record("value"), undefined);
  assert.deepEqual(record({ value: 1 }), { value: 1 });
  assert.equal(canonicalJson([undefined, null]), "[null,null]");
  assert.equal(canonicalJson({ missing: undefined }), '{"missing":null}');
});
