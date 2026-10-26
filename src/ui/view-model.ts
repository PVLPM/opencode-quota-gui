import { BUILD_IDENTITY, type BuildIdentity } from "../contracts/build-identity";
import type { Bucket, ProviderCard, QuotaCardRow, Usage } from "../contracts/dashboard";
import { DASHBOARD_CONTRACT_VERSION } from "../contracts/dashboard";
import type { ConnectionState } from "./dashboard-client";
import { DashboardError } from "./dashboard-client";

/** Diagnostic only: never pass this warning to the contract/load-state gate. */
export function buildMismatchMessage(
  server: { contractVersion: number; version?: string; build?: string } | undefined,
  browser: BuildIdentity = BUILD_IDENTITY,
): string | undefined {
  if (!server || server.contractVersion !== DASHBOARD_CONTRACT_VERSION) return undefined;
  if (!browser.build || browser.build === "unknown") return undefined;
  if (server.build === browser.build && server.version === browser.version) return undefined;
  return "Build mismatch · restart OpenCode";
}

/**
 * Section state machine (design spec §10 "States", R33).
 *
 * Every section derives its presentation from this one resolver, so the state
 * rules are testable without a DOM: first load shows a skeleton, a failure with
 * no previous payload is a section-local error with retry, a failure with a
 * previous payload keeps that payload and marks it stale, and a contract-version
 * mismatch asks the user to reload instead of rendering a payload the frontend
 * cannot promise to understand.
 */

export interface FetchOutcome<T> {
  /** The last good payload, kept across failed refetches. */
  data?: T;
  /** The last failure, cleared by a successful fetch. */
  error?: unknown;
  loading: boolean;
}

export type LoadState<T> =
  | { kind: "skeleton" }
  | { kind: "reload-required"; message: string }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "ready"; data: T; stale: boolean; refreshing: boolean };

/**
 * Contract-version gate. A mismatched server means the payload shape is
 * unknown, so the dashboard asks for a reload rather than guessing.
 */
export function contractMismatchMessage(serverVersion: number): string | undefined {
  if (serverVersion === DASHBOARD_CONTRACT_VERSION) return undefined;
  return `This dashboard speaks contract version ${DASHBOARD_CONTRACT_VERSION}, the server offers version ${serverVersion}. Restart OpenCode, then reload the page to get a matching build.`;
}

/**
 * A failure is never rendered as a raw exception: server errors carry the
 * server's already-scrubbed message, and anything else (a dropped connection,
 * a parse failure) becomes one controlled sentence.
 */
export function describeError(error: unknown): string {
  if (error instanceof DashboardError) return error.message;
  return "The dashboard server did not answer. Check that the local dashboard is still running.";
}

export function resolveLoadState<T>(
  outcome: FetchOutcome<T>,
  contractMismatch?: string,
): LoadState<T> {
  if (contractMismatch !== undefined) {
    return { kind: "reload-required", message: contractMismatch };
  }
  if (outcome.data !== undefined) {
    return {
      kind: "ready",
      data: outcome.data,
      stale: outcome.error !== undefined,
      refreshing: outcome.loading,
    };
  }
  if (outcome.loading) return { kind: "skeleton" };
  if (outcome.error !== undefined) {
    return { kind: "error", message: describeError(outcome.error), retryable: true };
  }
  return { kind: "skeleton" };
}

/**
 * A card is visible unless the hidden-card list contains its `cardId` or its
 * `providerId`, or its authoritative bare provider-scope hash. Effective server
 * settings normalize legacy full scope ids to providerId; every full cardId is
 * now an exact hide. Row hiding is separate and unaffected by this list.
 */
export function visibleCards(cards: ProviderCard[], hiddenCards: string[]): ProviderCard[] {
  if (hiddenCards.length === 0) return cards;
  const hidden = new Set(hiddenCards);
  return cards.filter((card) => !isCardHidden(card, hidden));
}

interface ProviderVisibilityIdentity {
  providerId: string;
  providerScopeHash?: string;
}

/** Consume normalized settings; never guess old semantics from the current catalog. */
export function isLegacyProviderHidden(
  card: ProviderVisibilityIdentity,
  hidden: ReadonlySet<string>,
): boolean {
  return (
    hidden.has(card.providerId) ||
    (card.providerScopeHash !== undefined && hidden.has(card.providerScopeHash))
  );
}

export function isCardHidden(
  card: ProviderVisibilityIdentity & { cardId: string },
  hidden: ReadonlySet<string>,
): boolean {
  return hidden.has(card.cardId) || isLegacyProviderHidden(card, hidden);
}

/**
 * The stream coming back is the only transition that lost data: the server keeps
 * no replay, so everything broadcast while the connection was down is gone and
 * the dashboard has to refetch. The first connect is excluded — the initial load
 * already fetched, and refetching there would double every page load.
 */
export function shouldRefetchOnReconnect(
  previous: ConnectionState | undefined,
  next: ConnectionState,
): boolean {
  return previous === "reconnecting" && next === "live";
}

/**
 * Stale until a refetch that started after the reconnect lands (spec §10
 * States). Comparing epochs rather than the connection state is what keeps the
 * marker up between "the stream is back" and "the numbers are fresh again"; a
 * failed refetch leaves the anchor behind, so the marker stays.
 */
export function isStaleAfterReconnect(reconnectEpoch: number, freshEpoch: number): boolean {
  return reconnectEpoch > freshEpoch;
}

/** Rows hide by stable row id; a hidden row changes no payload and no polling (invariant 8). */
export function visibleRows(rows: QuotaCardRow[], hiddenRows: string[]): QuotaCardRow[] {
  if (hiddenRows.length === 0) return rows;
  const hidden = new Set(hiddenRows);
  return rows.filter((row) => !hidden.has(row.rowId));
}

/** True when the snapshot carries no provider accounts at all (`enabledProviders: []` or none configured). */
export function hasNoProviders(
  cards: ProviderCard[],
  enabledProviders: string[] | "auto",
): boolean {
  return cards.length === 0 && enabledProviders !== "auto";
}

export function describeNoProviders(enabledProviders: string[] | "auto"): string {
  if (enabledProviders === "auto") {
    return "No provider accounts are available for this workspace. Check the quota plugin configuration.";
  }
  if (enabledProviders.length === 0) {
    return "No providers are enabled. Turn at least one on under Settings → Advanced, or set providers to automatic.";
  }
  return "The enabled providers reported no accounts for this workspace.";
}

/** Activity is a timestamp, never a token quantity: zero tokens with activity stays visible (R22, R50). */
export function usageHasActivity(usage: Usage): boolean {
  return usage.stepCount > 0 || usage.sessionCount > 0;
}

/** `lifetime` always shows every discovered row, so its empty state is a genuine "nothing recorded yet". */
export function describeEmptyActivity(hasActivity: boolean): string {
  return hasActivity
    ? "No tokens were recorded in this range."
    : "No activity in this range. Widen the range to see earlier sessions.";
}

export function bucketHasValues(bucket: Bucket): boolean {
  const stack = bucket.tokens;
  return (
    stack.input > 0 ||
    stack.cacheRead > 0 ||
    stack.cacheWrite > 0 ||
    stack.output > 0 ||
    stack.reasoning > 0
  );
}

/** Categories with a non-zero value in a bucket, in the fixed stack order. */
export function nonZeroCategoryCount(bucket: Bucket): number {
  const stack = bucket.tokens;
  return [stack.input, stack.cacheRead, stack.cacheWrite, stack.output, stack.reasoning].filter(
    (value) => value > 0,
  ).length;
}
