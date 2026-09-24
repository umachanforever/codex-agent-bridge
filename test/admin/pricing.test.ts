import { expect, test } from "vitest";
import { referenceCost, validateRates } from "../../src/admin/pricing.js";
import { AdminStore } from "../../src/admin/store.js";
import { withTempDir } from "../support/temp.js";
import { tokens, dollars } from "../../web/src/format.js";

test("public standard prices separate cached input and preserve unknowns", () => {
  expect(referenceCost("gpt-5.6-sol", 1_000_000, 1_000_000, 500_000)).toBe(
    22.2,
  );
  expect(referenceCost("gpt-6-luna", 1_000_000, 1_000_000, 0)).toBe(0.6);
  expect(referenceCost("gpt-6-luna", 0, 0, 0)).toBe(0);
  for (const model of [
    "unknown",
    "codex-cli",
    "gpt-6-luna-custom",
    "constructor",
  ]) {
    expect(referenceCost(model, 1, 1, 0)).toBeNull();
  }
  for (const cached of [null, -1, 11, NaN, 0.5]) {
    expect(referenceCost("gpt-6-luna", 10, 1, cached)).toBeNull();
  }
  expect(referenceCost("gpt-6-luna", null, 1, 0)).toBeNull();
  expect(referenceCost("gpt-6-luna", 1, null, 0)).toBeNull();
});

test("token and cost formatting distinguish small, zero and unknown values", () => {
  expect(tokens(1)).toBe("0.00 M");
  expect(tokens(1_236_789)).toBe("1.24 M");
  expect(tokens(1_500_000)).toBe("1.50 M");
  expect(tokens(0)).toBe("0.00 M");
  expect(tokens(null)).toBe("未知");
  expect(dollars(null)).toBe("未定价 / 计数不足");
  expect(dollars(0)).toBe("US$0.00");
  expect(dollars(0.0000001)).toBe("< US$0.01");
  expect(dollars(1.236)).toBe("US$1.24");
  expect(dollars(0.01)).toBe("US$0.01");
});

test("manual prices persist, reject stale edits and revalue existing records", async () => {
  await withTempDir(async (root) => {
    let store = new AdminStore(root);
    try {
      const revision = store.prices().revision;
      for (const invalid of [
        null,
        [],
        { test: [1, null, 2] },
        { test: [-1, 0, 1] },
        { test: [Infinity, 0, 1] },
        { constructor: [1, 0, 2] },
      ]) {
        expect(() => validateRates(invalid)).toThrow();
      }
      store.record({
        id: "custom",
        model: "custom",
        keyId: "one",
        started: Date.now(),
        duration: 1,
        status: 200,
        error: null,
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          total_tokens: 2_000_000,
          prompt_tokens_details: { cached_tokens: 500_000 },
        },
      });
      store.savePrices({ custom: [2, 0.2, 10] }, revision);
      expect(store.report().summary).toMatchObject({
        priced: 1,
        costUsd: 11.1,
      });
      expect(() => store.savePrices({}, revision)).toThrow(/reload/);
      store.close();
      store = new AdminStore(root);
      expect(store.prices()).toMatchObject({
        custom: true,
        rates: { custom: [2, 0.2, 10] },
      });
      expect(store.report().summary).toMatchObject({
        priced: 1,
        costUsd: 11.1,
      });
      store.savePrices({}, store.prices().revision);
      expect(store.report().summary).toMatchObject({
        priced: 0,
        costUsd: null,
      });
    } finally {
      store.close();
    }
  });
});

test("cost aggregation covers all filtered rows, independent of pagination", async () => {
  await withTempDir(async (root) => {
    const store = new AdminStore(root);
    try {
      for (let i = 0; i < 52; i++) {
        store.record({
          id: String(i),
          keyId: i < 51 ? "one" : "two",
          model: "gpt-6-luna",
          started: Date.now(),
          duration: 1,
          status: 200,
          error: null,
          usage:
            i === 51
              ? null
              : {
                  prompt_tokens: 1_000_000,
                  completion_tokens: 1_000_000,
                  total_tokens: 2_000_000,
                  prompt_tokens_details: { cached_tokens: 0 },
                  completion_tokens_details: { reasoning_tokens: 500_000 },
                },
        });
      }
      const report = store.report({ offset: 50 }) as {
        summary: { costUsd: number | null; priced: number };
        rows: { costUsd: number | null }[];
        byModel: { costUsd: number }[];
        trend: { costUsd: number }[];
      };
      expect(report.rows).toHaveLength(2);
      expect(report.summary.priced).toBe(51);
      expect(report.summary.costUsd).toBeCloseTo(30.6);
      expect(report.byModel[0]!.costUsd).toBeCloseTo(30.6);
      expect(report.trend[0]!.costUsd).toBeCloseTo(30.6);
      expect(store.report({ keyId: "two" }).summary).toMatchObject({
        priced: 0,
        costUsd: null,
      });
      expect(store.report({ model: "missing" }).summary).toMatchObject({
        priced: 0,
        costUsd: null,
      });
    } finally {
      store.close();
    }
  });
});
