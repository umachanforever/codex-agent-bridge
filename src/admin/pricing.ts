/** Validated input, cached input and output prices in USD per million tokens. */
export type Rates = Readonly<Record<string, readonly [number, number, number]>>;

/** Reject malformed values rather than silently treating them as free usage. */
export function validateRates(value: unknown): Rates {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid price table.");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("At most 100 models.");
  for (const [model, rate] of entries) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model) ||
      ["constructor", "prototype", "__proto__"].includes(model) ||
      !Array.isArray(rate) ||
      rate.length !== 3 ||
      !rate.every(
        (n) =>
          typeof n === "number" &&
          Number.isFinite(n) &&
          n >= 0 &&
          n <= 1_000_000,
      )
    )
      throw new Error("Invalid model or price (0–1000000 USD/M).");
  }
  return Object.fromEntries(
    entries.map(([model, rate]) => [model, [...(rate as number[])]]),
  ) as unknown as Rates;
}

/** Public Standard short-context API prices, USD per million tokens. */
export const pricing = {
  source: "https://developers.openai.com/api/docs/pricing",
  checkedAt: "2026-09-24",
  currency: "USD",
  basis: "standard-short-context",
  rates: {
    "gpt-6-astra": [10, 1, 50],
    "gpt-6-sol": [2, 0.2, 10],
    "gpt-6-luna": [0.1, 0.01, 0.5],
    "gpt-5.6-sol": [4, 0.4, 20],
    "gpt-5.6-terra": [2, 0.2, 12],
    "gpt-5.6-luna": [0.2, 0.02, 1.2],
    "gpt-5.5": [5, 0.5, 30],
    "gpt-5.4": [2.5, 0.25, 15],
    "gpt-5.4-mini": [0.75, 0.075, 4.5],
    "gpt-5.4-nano": [0.2, 0.02, 1.25],
    "gpt-5.3-codex": [1.75, 0.175, 14],
    "gpt-5.2": [1.75, 0.175, 14],
    "gpt-5.1": [1.25, 0.125, 10],
    "gpt-5": [1.25, 0.125, 10],
    "gpt-5-mini": [0.25, 0.025, 2],
    "gpt-5-nano": [0.05, 0.005, 0.4],
  } as Readonly<Record<string, readonly [number, number, number]>>,
};

/** Reference valuation, not billing; never guess aliases or missing cache counts. */
export function referenceCost(
  model: string,
  input: number | null,
  output: number | null,
  cached: number | null,
  rates: Rates = pricing.rates,
): number | null {
  const rate = Object.hasOwn(rates, model) ? rates[model] : undefined;
  if (
    !rate ||
    input == null ||
    output == null ||
    cached == null ||
    ![input, output, cached].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    cached > input
  )
    return null;
  // Cached tokens are a subset of input; reasoning is already in output.
  return (
    ((input - cached) * rate[0] + cached * rate[1] + output * rate[2]) /
    1_000_000
  );
}
