import { expect, test, vi } from "vitest";
import {
  boundedText,
  discoverPrices,
} from "../../src/admin/price-discovery.js";

/** Synthetic official-looking text; no live model or network is used. */
const document = "Standard USD per 1M tokens\n| synthetic | $2 | $0.2 | $10 |";
/** Returns a fresh response for each test invocation. */
const fetcher = vi.fn<typeof fetch>(async () => new Response(document));
/** Synthetic extraction with exact source evidence. */
const row = {
  model: "synthetic",
  input: 2,
  cached: 0.2,
  output: 10,
  evidence: "| synthetic | $2 | $0.2 | $10 |",
};

test("discovery fetches fixed source and returns evidence without applying prices", async () => {
  const complete = vi.fn(async () => JSON.stringify({ rows: [row] }));
  const result = await discoverPrices(
    complete,
    new AbortController().signal,
    fetcher,
  );
  expect(result.rates).toEqual({ synthetic: [2, 0.2, 10] });
  expect(result.documentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(fetcher).toHaveBeenCalledWith(
    "https://developers.openai.com/api/docs/pricing.md",
    expect.objectContaining({ redirect: "error" }),
  );
  expect(complete).toHaveBeenCalledOnce();
  expect(complete.mock.calls[0]).toEqual([
    expect.objectContaining({
      model: "gpt-6-luna",
      x_codex: { sandbox: "disabled", web_search: "disabled" },
    }),
    expect.any(AbortSignal),
  ]);
});

test("discovery rejects fabricated evidence, malformed and duplicate prices", async () => {
  for (const rows of [
    [],
    [row, row],
    [{ ...row, evidence: "invented" }],
    [{ ...row, input: 100 }],
    [{ ...row, cached: null }],
  ]) {
    await expect(
      discoverPrices(
        async () => JSON.stringify({ rows }),
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow();
  }
  await expect(
    discoverPrices(
      async () => "not JSON",
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow();
});

test("source failures never dispatch a model and response size is bounded", async () => {
  const complete = vi.fn(async () => "");
  await expect(
    discoverPrices(
      complete,
      new AbortController().signal,
      async () => new Response("unavailable", { status: 503 }),
    ),
  ).rejects.toThrow();
  await expect(
    discoverPrices(
      complete,
      new AbortController().signal,
      async () => new Response("login page"),
    ),
  ).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
  await expect(boundedText(new Response("too large"), 2)).rejects.toThrow(
    /large/,
  );
});
