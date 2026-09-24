import assert from "node:assert/strict";
import { test } from "vitest";
import {
  subtractTokenUsage,
  tokenUsageCounters,
  ZERO_TOKEN_USAGE,
} from "../../src/core/token-usage.js";

/** Checks exact counters and rejects an incomplete or invalid snapshot as a whole. */
test("token snapshots preserve exact values and reject invalid counters", () => {
  const counters = {
    ...ZERO_TOKEN_USAGE,
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  };
  assert.deepEqual(
    tokenUsageCounters({ ...counters, metadata: "ignored" }),
    counters,
  );
  assert.deepEqual(subtractTokenUsage(counters, ZERO_TOKEN_USAGE), counters);
  assert.deepEqual(subtractTokenUsage(counters, counters), ZERO_TOKEN_USAGE);
  for (const key of Object.keys(counters)) {
    for (const value of [undefined, null, "1", -1, NaN, Infinity, -Infinity]) {
      assert.equal(
        tokenUsageCounters({ ...counters, [key]: value }),
        undefined,
      );
    }
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      assert.equal(
        subtractTokenUsage({ ...counters, [key]: value }, ZERO_TOKEN_USAGE),
        undefined,
      );
      assert.equal(
        subtractTokenUsage(counters, { ...counters, [key]: value }),
        undefined,
      );
    }
  }
  assert.equal(subtractTokenUsage(ZERO_TOKEN_USAGE, counters), undefined);
});
