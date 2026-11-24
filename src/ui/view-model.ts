import { BUILD_IDENTITY, type BuildIdentity } from "../contracts/build-identity";
import { isCardHidden, isLegacyProviderHidden } from "../contracts/card-visibility";
import type { Bucket, ProviderCard, QuotaCardRow, Usage } from "../contracts/dashboard";
import {
  ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS,
  DASHBOARD_CONTRACT_VERSION,
} from "../contracts/dashboard";
import { isRecord, isText } from "../contracts/dto-guards";
import { effectiveHiddenRowIds, type RowVisibilityControl } from "../contracts/row-visibility";
import type { ConnectionState } from "./dashboard-client";
import { DashboardError } from "./dashboard-client";

/** UI consumers keep the existing view-model import path. */
export { isCardHidden, isLegacyProviderHidden };

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
  | { kind: "error"; message: string; retryable: boolean; recoverable: boolean }
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
  if (isHostRpcTimeout(error)) {
    return "OpenCode stopped waiting for this request. The read may still be finishing in the background; Retry in a moment.";
  }
  return "OpenCode did not return the dashboard data. Retry, or restart OpenCode if this keeps happening.";
}

/** The official RPC client's per-request deadline: a transport `TimeoutError`, host still alive. */
export function isHostRpcTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const clientError = error as { name?: unknown; reason?: unknown; cause?: unknown };
  const cause = clientError.cause;
  return (
    clientError.name === "ClientError" &&
    clientError.reason === "Transport" &&
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "TimeoutError"
  );
}

/** Re-join an analytics read the host timed out on, until the server read budget has passed. */
export function shouldRejoinAnalyticsRead(failure: unknown, elapsedMs: number): boolean {
  return isHostRpcTimeout(failure) && elapsedMs < ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * After the re-join budget is spent, one plain read still joins a result the
 * worker committed at the deadline (the snapshot service serves or joins it).
 */
export function shouldProbeAnalyticsRead(cause: unknown, elapsedMs: number): boolean {
  return isHostRpcTimeout(cause) && elapsedMs >= ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * A background analytics read with no route-owned query (prefetch) needs the
 * same re-join loop. `cancelled` stops issuing further attempts after the shell
 * that owns the retained payload is gone.
 */
export async function rejoinAnalyticsRead<T>(
  read: () => Promise<T>,
  cancelled?: () => boolean,
): Promise<T> {
  const startedAt = Date.now();
  let probeUsed = false;
  for (;;) {
    if (cancelled?.() === true) throw new Error("analytics read cancelled");
    try {
      return await read();
    } catch (failure) {
      if (!isHostRpcTimeout(failure)) throw failure;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS) continue;
      if (probeUsed) throw failure;
      probeUsed = true;
    }
  }
}

/**
 * Declared 4xx conditions cannot succeed on an immediate automatic retry (a
 * missing project stays missing); transport and unexpected server failures can.
 */
const PERMANENT_READ_CODES: ReadonlySet<string> = new Set([
  "bad-request",
  "bad-host",
  "bad-origin",
  "unsupported-media-type",
  "body-too-large",
  "method-not-allowed",
  "not-found",
  "config-changed",
  "config-read-error",
  "config-target-error",
  "unknown-setting",
  "invalid-setting",
  "project-not-found",
  "session-not-found",
]);

export function isRecoverableReadFailure(cause: unknown): boolean {
  if (cause instanceof DashboardError) {
    return cause.status >= 500 && !PERMANENT_READ_CODES.has(cause.code);
  }
  if (isRecord(cause) && "type" in cause) {
    const type = cause.type;
    if (isText(type)) return !PERMANENT_READ_CODES.has(type);
  }
  // Unknown shape: a dropped connection or parse failure is transport-like.
  return true;
}

/**
 * A settings-revision conflict arrives in two shapes: the browser client throws
 * a `DashboardError`, while the official native RPC client unwraps the server's
 * `RpcError` into a plain `{ type, message, data? }` object. Recognize only the
 * declared `config-changed` code on either transport so an unrelated failure is
 * never treated as a conflict, and no error text is trusted for control flow.
 */
export function isConfigChangedError(error: unknown): boolean {
  if (error instanceof DashboardError) return error.isConfigChanged;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { type?: unknown; message?: unknown };
  return candidate.type === "config-changed" && typeof candidate.message === "string";
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
    return {
      kind: "error",
      message: describeError(outcome.error),
      retryable: true,
      recoverable: isRecoverableReadFailure(outcome.error),
    };
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

/**
 * Rows hide by stable row id; a hidden row changes no payload and no polling
 * (invariant 8). A pre-window `aggregate` id resolves to the first emitted row
 * it used to match, and a declared control hides every emitted shape it owns,
 * so an upgrade or a provider shape change never re-shows a hidden row.
 */
export function visibleRows(
  rows: QuotaCardRow[],
  hiddenRows: string[],
  controls: readonly RowVisibilityControl[] = [],
): QuotaCardRow[] {
  if (hiddenRows.length === 0) return rows;
  const hidden = effectiveHiddenRowIds(
    rows.map((row) => row.rowId),
    hiddenRows,
    controls,
  );
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
