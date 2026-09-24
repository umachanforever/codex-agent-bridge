import { record } from "./canonical.js";

/** Complete exact counters from one app-server token-usage snapshot. */
export interface TokenUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/** Counter names required before cumulative usage may be attributed. */
const TOKEN_USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

/** Exact zero baseline for a newly created app-server thread. */
export const ZERO_TOKEN_USAGE: Readonly<TokenUsageCounters> = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/** Reads one complete finite nonnegative counter snapshot. */
export function tokenUsageCounters(
  value: unknown,
): TokenUsageCounters | undefined {
  const breakdown = record(value);
  if (!breakdown) return undefined;
  return collectCounters((name) => breakdown[name]);
}

/** Subtracts only complete, finite, nonnegative snapshots without estimating. */
export function subtractTokenUsage(
  total: TokenUsageCounters,
  baseline: TokenUsageCounters,
): TokenUsageCounters | undefined {
  const end = tokenUsageCounters(total);
  const start = tokenUsageCounters(baseline);
  if (!end || !start) return undefined;
  return collectCounters((name) => end[name] - start[name]);
}

/** Builds a snapshot only after every required counter passes validation. */
function collectCounters(
  read: (name: keyof TokenUsageCounters) => unknown,
): TokenUsageCounters | undefined {
  const entries: Array<[keyof TokenUsageCounters, number]> = [];
  for (const name of TOKEN_USAGE_COUNTERS) {
    const value = read(name);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return undefined;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries) as unknown as TokenUsageCounters;
}
