import { record } from "../core/canonical.js";

/** Extracts the turn identifier a notification correlates to, if present. */
export function notificationTurnId(params: Record<string, unknown>): unknown {
  return typeof params.turnId === "string"
    ? params.turnId
    : record(params.turn)?.id;
}

/** Checks notification correlation without exposing foreign-thread activity. */
export function matchesTurn(
  value: unknown,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const params = record(value);
  if (!params) return true;
  return params.threadId === threadId && notificationTurnId(params) === turnId;
}
