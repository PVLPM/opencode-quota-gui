import type { CostedTokens, DashboardEvent, DashboardEventTopic, TokenStack } from "./dashboard.js";

/**
 * Runtime guards for the contract boundary (spec §5).
 *
 * Browser-safe: no Node, no DOM, no `src/lib` imports. Guards are structural;
 * the HTTP layer (P4) maps a rejected payload to `bad-request`.
 */

export const DASHBOARD_EVENT_TOPICS = [
  "quota.changed",
  "sessions.changed",
  "settings.changed",
] as const satisfies readonly DashboardEventTopic[];

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `total` is the sum of the five additive token categories (spec §5.5 invariant 1). */
export function sumTokenStack(stack: TokenStack): number {
  return stack.input + stack.cacheRead + stack.cacheWrite + stack.output + stack.reasoning;
}

export function isTokenStack(value: unknown): value is TokenStack {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeFiniteNumber(value.input) &&
    isNonNegativeFiniteNumber(value.cacheRead) &&
    isNonNegativeFiniteNumber(value.cacheWrite) &&
    isNonNegativeFiniteNumber(value.output) &&
    isNonNegativeFiniteNumber(value.reasoning)
  );
}

export function isCostedTokens(value: unknown): value is CostedTokens {
  if (!isRecord(value) || !isTokenStack(value)) return false;
  return (
    isNonNegativeFiniteNumber(value.total) &&
    value.total === sumTokenStack(value) &&
    (value.apiEquivalentCostUsd === null ||
      isNonNegativeFiniteNumber(value.apiEquivalentCostUsd)) &&
    isNonNegativeFiniteNumber(value.unpricedTokens) &&
    isNonNegativeFiniteNumber(value.unknownTokens)
  );
}

export function isDashboardEvent(value: unknown): value is DashboardEvent {
  if (!isRecord(value)) return false;
  if (!isNonNegativeFiniteNumber(value.at)) return false;
  if (
    typeof value.topic !== "string" ||
    !(DASHBOARD_EVENT_TOPICS as readonly string[]).includes(value.topic)
  ) {
    return false;
  }
  return value.scope === undefined || value.scope === "visibility";
}
