/**
 * Pure, bounded evidence model for observing cache reuse. This module does not
 * read storage, subscribe to host events, issue requests, or infer cache policy.
 */

export const CACHE_OBSERVER_MAX_INVOCATIONS = 128;
export const CACHE_OBSERVER_MAX_COMPACTION_BOUNDARIES = 64;
export const CACHE_OBSERVER_MAX_INVALIDATIONS = 64;

export interface CacheEvidenceBasis {
  /** The concrete source that supplied this fact (not a guessed provider rule). */
  source: string;
  /** An opaque source reference, such as a message id or documentation locator. */
  reference: string;
}

/** Selected provider/model/variant from Started; this does not prove the effective HTTP route. */
export interface CacheRouteProvenance {
  providerId: string;
  modelId: string;
  variantId?: string;
  protocolId?: "anthropic-messages";
  basis: CacheEvidenceBasis;
}

export interface CacheInvocationOrder {
  /** Physical assistant-message completion time from ingestion. */
  completedAtMs: number;
  /** Stable source tie-breaker for invocations sharing a completion time. */
  messageId: string;
}

export type CachePrimaryClassification =
  | { kind: "primary"; basis: CacheEvidenceBasis }
  | { kind: "not-primary"; basis: CacheEvidenceBasis }
  | { kind: "unknown"; basis: CacheEvidenceBasis };

/** Omitted means the category was not present in the pre-normalized source. */
export interface CacheInvocationCounts {
  /** Host-reported fresh input tokens, distinct from cache reads and writes. */
  fresh?: number;
  /** Host-reported cache-read tokens. */
  read?: number;
  /** Host-reported cache-write tokens. */
  write?: number;
}

export interface CacheInvocationObservation {
  sessionId: string;
  order: CacheInvocationOrder;
  route?: CacheRouteProvenance;
  primaryClassification: CachePrimaryClassification;
  counts: CacheInvocationCounts;
}

export interface CacheCompactionBoundary {
  sessionId: string;
  order: CacheInvocationOrder;
  basis: CacheEvidenceBasis;
}

export interface CacheInvalidationObservation {
  sessionId: string;
  route: CacheRouteProvenance;
  order: CacheInvocationOrder;
  basis: CacheEvidenceBasis;
}

/** Explicit source assertion that the scoped route has no newer invalidation. */
export interface CacheInvalidationCoverage {
  sessionId: string;
  route: CacheRouteProvenance;
  verifiedThroughMs: number;
  basis: CacheEvidenceBasis;
}

export type CacheSupportedTtlMs = 300_000 | 3_600_000;

export type CacheTtlEvidence =
  | {
      kind: "configured";
      protocolId: "anthropic-messages";
      route: CacheRouteProvenance;
      configuredTtlMs: CacheSupportedTtlMs;
      /** Conservative configured-minimum boundary from request dispatch; not physical eviction. */
      expiresAtMs: number;
      basis: CacheEvidenceBasis;
    }
  | { kind: "unknown"; basis: string };

export interface CacheObserverScope {
  /** Each child session is classified independently; no tree roll-up occurs. */
  sessionId: string;
  route?: CacheRouteProvenance;
}

/** Immutable-by-convention value state; update helpers return a new bounded state. */
export interface CacheObserverState {
  readonly scope: CacheObserverScope;
  readonly invocations: readonly CacheInvocationObservation[];
  readonly invocationsTruncated: boolean;
  readonly compactionBoundaries: readonly CacheCompactionBoundary[];
  readonly invalidations: readonly CacheInvalidationObservation[];
  readonly invalidationCoverage?: CacheInvalidationCoverage;
  readonly ttlEvidence?: CacheTtlEvidence;
}

export interface CachePrimaryRatio {
  /** Host-reported usage telemetry only; not protocol, cache-validity, or TTL evidence. */
  value: number;
  messageId: string;
  /** Source assistant-message completion time; no age/staleness threshold is inferred. */
  observedAtMs: number;
  numerator: "cache-read";
  denominator: "fresh+read+write";
  basis: CacheEvidenceBasis;
}

export type CacheObserverColor = "gray" | "green" | "yellow" | "red";

export interface CacheObserverClassification {
  color: CacheObserverColor;
  confidence?: "best-effort";
  ttlSemantics?: "configured-minimum";
  configuredTtlMs?: CacheSupportedTtlMs;
  configuredTtlDeadlineAtMs?: number;
  reason:
    | "insufficient-evidence"
    | "observed-reuse-with-active-ttl"
    | "observed-write-with-active-ttl"
    | "ambiguous-invocation"
    | "history-truncated"
    | "ttl-unverified"
    | "ttl-expired"
    | "route-unverified"
    | "invalidation-unverified"
    | "known-invalidation"
    | "compaction-boundary-uncertain";
  primaryCacheReadRatio?: CachePrimaryRatio;
  /** Distinguishes received but unusable usage counters from no observed step telemetry. */
  primaryCacheReadTelemetry?: "available" | "unavailable";
  /** @deprecated Retained for older consumers; configured TTL is not a physical expiry claim. */
  verifiedExpiresAtMs?: number;
  /** Earliest instant to reconsider configured-minimum evidence without a newer event. */
  recheckAtMs?: number;
}

export function createCacheObserverState(scope: CacheObserverScope): CacheObserverState {
  if (!scope.sessionId.trim()) throw new TypeError("cache observer sessionId must be non-empty");
  return {
    scope: {
      ...scope,
      ...(scope.route === undefined
        ? {}
        : { route: { ...scope.route, basis: { ...scope.route.basis } } }),
    },
    invocations: [],
    invocationsTruncated: false,
    compactionBoundaries: [],
    invalidations: [],
  };
}

export function observeCacheInvocation(
  state: CacheObserverState,
  observation: CacheInvocationObservation,
): CacheObserverState {
  assertSession(state, observation.sessionId);
  // A missing route is retained as ambiguous evidence so a newer unknown
  // invocation cannot leave an older green result looking current.
  if (observation.route !== undefined) assertRoute(state.scope.route, observation.route);
  assertOrder(observation.order);

  const withoutRevision = state.invocations.filter(
    (entry) => entry.order.messageId !== observation.order.messageId,
  );
  const invocations = [...withoutRevision, cloneInvocation(observation)].sort((a, b) =>
    compareOrder(a.order, b.order),
  );
  const invocationsTruncated =
    state.invocationsTruncated || invocations.length > CACHE_OBSERVER_MAX_INVOCATIONS;
  return {
    ...state,
    invocations: invocations.slice(-CACHE_OBSERVER_MAX_INVOCATIONS),
    invocationsTruncated,
  };
}

export function observeCacheCompactionBoundary(
  state: CacheObserverState,
  boundary: CacheCompactionBoundary,
): CacheObserverState {
  assertSession(state, boundary.sessionId);
  assertOrder(boundary.order);

  const boundaries = state.compactionBoundaries
    .filter((entry) => entry.order.messageId !== boundary.order.messageId)
    .concat({ ...boundary, basis: { ...boundary.basis }, order: { ...boundary.order } })
    .sort((a, b) => compareOrder(a.order, b.order));
  return {
    ...state,
    compactionBoundaries: boundaries.slice(-CACHE_OBSERVER_MAX_COMPACTION_BOUNDARIES),
  };
}

export function observeCacheInvalidation(
  state: CacheObserverState,
  invalidation: CacheInvalidationObservation,
): CacheObserverState {
  assertSession(state, invalidation.sessionId);
  assertRoute(state.scope.route, invalidation.route);
  assertOrder(invalidation.order);

  const invalidations = state.invalidations
    .filter((entry) => entry.order.messageId !== invalidation.order.messageId)
    .concat({
      ...invalidation,
      route: { ...invalidation.route, basis: { ...invalidation.route.basis } },
      basis: { ...invalidation.basis },
      order: { ...invalidation.order },
    })
    .sort((a, b) => compareOrder(a.order, b.order));
  return {
    ...state,
    invalidations: invalidations.slice(-CACHE_OBSERVER_MAX_INVALIDATIONS),
  };
}

export function setCacheInvalidationCoverage(
  state: CacheObserverState,
  coverage: CacheInvalidationCoverage,
): CacheObserverState {
  assertSession(state, coverage.sessionId);
  assertRoute(state.scope.route, coverage.route);
  return {
    ...state,
    invalidationCoverage: {
      ...coverage,
      route: { ...coverage.route, basis: { ...coverage.route.basis } },
      basis: { ...coverage.basis },
    },
  };
}

export function setCacheTtlEvidence(
  state: CacheObserverState,
  ttlEvidence: CacheTtlEvidence,
): CacheObserverState {
  return {
    ...state,
    ttlEvidence:
      ttlEvidence.kind === "configured"
        ? {
            ...ttlEvidence,
            route: { ...ttlEvidence.route, basis: { ...ttlEvidence.route.basis } },
            basis: { ...ttlEvidence.basis },
          }
        : { ...ttlEvidence },
  };
}

export function classifyCacheObserverState(
  state: CacheObserverState,
  nowMs: number,
): CacheObserverClassification {
  const boundary = latestBoundary(state.compactionBoundaries);
  const currentInvocations = state.invocations.filter(
    (entry) => boundary === undefined || compareOrder(entry.order, boundary.order) > 0,
  );
  const currentInvalidations = state.invalidations.filter(
    (entry) =>
      hasValidBasis(entry.basis) &&
      hasValidRouteProvenance(entry.route) &&
      sameRoute(state.scope.route, entry.route) &&
      (boundary === undefined || compareOrder(entry.order, boundary.order) > 0),
  );
  const reusablePrefixes = currentInvocations.filter((entry) =>
    isEstablishedReusablePrefix(state.scope.route, entry),
  );
  const latestReuse = last(reusablePrefixes);
  const latestInvalidation = last(currentInvalidations);
  const latestAmbiguous = last(
    currentInvocations.filter((entry) => isAmbiguousInvocation(state.scope.route, entry)),
  );
  const telemetry = lastPrimaryRatio(currentInvocations);
  const ratio = telemetry?.ratio;
  const telemetryStatus = optionalPrimaryCacheReadTelemetry(telemetry?.status);

  if (latestReuse === undefined) {
    const hadReuseBeforeBoundary =
      boundary !== undefined &&
      state.invocations.some(
        (entry) =>
          compareOrder(entry.order, boundary.order) <= 0 &&
          isEstablishedReusablePrefix(state.scope.route, entry),
      );
    if (latestAmbiguous !== undefined) {
      return {
        color: "yellow",
        reason: "ambiguous-invocation",
        ...telemetryStatus,
        ...optionalRatio(ratio),
      };
    }
    if (hadReuseBeforeBoundary) {
      return {
        color: "yellow",
        reason: "compaction-boundary-uncertain",
        ...telemetryStatus,
        ...optionalRatio(ratio),
      };
    }
    if (state.invocationsTruncated) {
      return {
        color: "yellow",
        reason: "history-truncated",
        ...telemetryStatus,
        ...optionalRatio(ratio),
      };
    }
    return {
      color: "gray",
      reason: "insufficient-evidence",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  if (
    latestInvalidation !== undefined &&
    compareOrder(latestInvalidation.order, latestReuse.order) > 0
  ) {
    if (
      latestAmbiguous !== undefined &&
      compareOrder(latestAmbiguous.order, latestInvalidation.order) > 0
    ) {
      return {
        color: "yellow",
        reason: "ambiguous-invocation",
        ...telemetryStatus,
        ...optionalRatio(ratio),
      };
    }
    return {
      color: "red",
      reason: "known-invalidation",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  if (latestAmbiguous !== undefined && compareOrder(latestAmbiguous.order, latestReuse.order) > 0) {
    return {
      color: "yellow",
      reason: "ambiguous-invocation",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  if (
    !Number.isFinite(nowMs) ||
    !hasValidRouteProvenance(state.scope.route) ||
    !hasValidRouteProvenance(latestReuse.route)
  ) {
    return {
      color: "yellow",
      reason: "route-unverified",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  const ttl = state.ttlEvidence;
  if (
    ttl?.kind !== "configured" ||
    !hasValidBasis(ttl.basis) ||
    !hasValidRouteProvenance(ttl.route) ||
    !sameRoute(state.scope.route, ttl.route) ||
    !isSupportedAnthropicTtl(state.scope.route, ttl)
  ) {
    return {
      color: "yellow",
      reason: "ttl-unverified",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }
  if (!Number.isFinite(ttl.expiresAtMs) || ttl.expiresAtMs <= nowMs) {
    return {
      color: "yellow",
      reason: "ttl-expired",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  return {
    color: "green",
    confidence: "best-effort",
    ttlSemantics: "configured-minimum",
    configuredTtlMs: ttl.configuredTtlMs,
    configuredTtlDeadlineAtMs: ttl.expiresAtMs,
    reason: hasObservedRead(latestReuse.counts)
      ? "observed-reuse-with-active-ttl"
      : "observed-write-with-active-ttl",
    recheckAtMs: ttl.expiresAtMs,
    ...telemetryStatus,
    ...optionalRatio(ratio),
  };
}

function assertSession(state: CacheObserverState, sessionId: string): void {
  if (sessionId !== state.scope.sessionId) {
    throw new TypeError("cache observer evidence belongs to a different session");
  }
}

function assertRoute(
  expected: CacheRouteProvenance | undefined,
  observed: CacheRouteProvenance | undefined,
): void {
  if (!sameRoute(expected, observed)) {
    throw new TypeError("cache observer evidence belongs to a different or unknown route");
  }
}

function assertOrder(order: CacheInvocationOrder): void {
  if (!Number.isFinite(order.completedAtMs) || !order.messageId.trim()) {
    throw new TypeError("cache observer ordering requires a finite completion time and message id");
  }
}

function cloneInvocation(entry: CacheInvocationObservation): CacheInvocationObservation {
  return {
    ...entry,
    order: { ...entry.order },
    ...(entry.route === undefined
      ? {}
      : { route: { ...entry.route, basis: { ...entry.route.basis } } }),
    primaryClassification: {
      ...entry.primaryClassification,
      basis: { ...entry.primaryClassification.basis },
    },
    counts: { ...entry.counts },
  };
}

function compareOrder(a: CacheInvocationOrder, b: CacheInvocationOrder): number {
  if (a.completedAtMs !== b.completedAtMs) return a.completedAtMs - b.completedAtMs;
  return compareText(a.messageId, b.messageId);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function last<T>(entries: readonly T[]): T | undefined {
  return entries[entries.length - 1];
}

function latestBoundary(
  boundaries: readonly CacheCompactionBoundary[],
): CacheCompactionBoundary | undefined {
  return last(boundaries.filter((boundary) => hasValidBasis(boundary.basis)));
}

function hasObservedRead(counts: CacheInvocationCounts): boolean {
  return isPositiveFinite(counts.read);
}

function isPositiveFinite(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCertainPrimaryForRoute(
  route: CacheRouteProvenance | undefined,
  invocation: CacheInvocationObservation,
): boolean {
  return (
    invocation.primaryClassification.kind === "primary" &&
    hasValidBasis(invocation.primaryClassification.basis) &&
    hasValidRouteProvenance(route) &&
    hasValidRouteProvenance(invocation.route) &&
    sameRoute(route, invocation.route)
  );
}

function isEstablishedReusablePrefix(
  route: CacheRouteProvenance | undefined,
  invocation: CacheInvocationObservation,
): boolean {
  return (
    isCertainPrimaryForRoute(route, invocation) &&
    (hasObservedRead(invocation.counts) || isPositiveFinite(invocation.counts.write))
  );
}

function isAmbiguousInvocation(
  route: CacheRouteProvenance | undefined,
  invocation: CacheInvocationObservation,
): boolean {
  const classification = invocation.primaryClassification;
  if (classification.kind === "not-primary" && hasValidBasis(classification.basis)) return false;
  if (classification.kind !== "primary" || !isCertainPrimaryForRoute(route, invocation))
    return true;

  if (hasObservedRead(invocation.counts) || isPositiveFinite(invocation.counts.write)) {
    return false;
  }
  // A primary invocation with no observed cache read or write cannot confirm
  // that an earlier reusable prefix is still valid. Treat it as uncertainty,
  // including the case where both counters are explicitly zero.
  return true;
}

/** Keep only the latest classified primary's host counters; never infer route or cache policy. */
function lastPrimaryRatio(
  invocations: readonly CacheInvocationObservation[],
): { status: "available" | "unavailable"; ratio?: CachePrimaryRatio } | undefined {
  let lastCandidate: CacheInvocationObservation | undefined;
  for (const invocation of invocations) {
    const classification = invocation.primaryClassification;
    if (classification.kind !== "not-primary" || !hasValidBasis(classification.basis)) {
      lastCandidate = invocation;
    }
  }

  if (
    lastCandidate === undefined ||
    lastCandidate.primaryClassification.kind !== "primary" ||
    !hasValidBasis(lastCandidate.primaryClassification.basis)
  ) {
    return undefined;
  }
  const { fresh, read, write } = lastCandidate.counts;
  if (
    !isPresentNonNegativeFinite(fresh) ||
    !isPresentPositiveFinite(read) ||
    !isPresentNonNegativeFinite(write)
  ) {
    return { status: "unavailable" };
  }
  const denominator = fresh + read + write;
  if (!(denominator > 0) || !Number.isFinite(denominator)) {
    return { status: "unavailable" };
  }

  return {
    status: "available",
    ratio: {
      value: read / denominator,
      messageId: lastCandidate.order.messageId,
      observedAtMs: lastCandidate.order.completedAtMs,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { ...lastCandidate.primaryClassification.basis },
    },
  };
}

function isPresentPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPresentNonNegativeFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAuthoritativeAnthropicRoute(route: CacheRouteProvenance | undefined): boolean {
  return route?.providerId === "anthropic" && route.protocolId === "anthropic-messages";
}

function isSupportedAnthropicTtl(
  route: CacheRouteProvenance | undefined,
  evidence: Extract<CacheTtlEvidence, { kind: "configured" }>,
): boolean {
  return (
    isAuthoritativeAnthropicRoute(route) &&
    evidence.protocolId === "anthropic-messages" &&
    (evidence.configuredTtlMs === 300_000 || evidence.configuredTtlMs === 3_600_000)
  );
}

function hasValidBasis(basis: CacheEvidenceBasis | undefined): boolean {
  return (
    typeof basis?.source === "string" &&
    basis.source.trim().length > 0 &&
    typeof basis.reference === "string" &&
    basis.reference.trim().length > 0
  );
}

function hasValidRouteProvenance(route: CacheRouteProvenance | undefined): boolean {
  return (
    typeof route?.providerId === "string" &&
    route.providerId.trim().length > 0 &&
    typeof route.modelId === "string" &&
    route.modelId.trim().length > 0 &&
    hasValidBasis(route.basis)
  );
}

function sameRoute(
  left: CacheRouteProvenance | undefined,
  right: CacheRouteProvenance | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.providerId === right.providerId &&
        left.modelId === right.modelId &&
        left.variantId === right.variantId &&
        left.protocolId === right.protocolId;
}

function optionalRatio(ratio: CachePrimaryRatio | undefined): {
  primaryCacheReadRatio?: CachePrimaryRatio;
} {
  return ratio === undefined ? {} : { primaryCacheReadRatio: ratio };
}

function optionalPrimaryCacheReadTelemetry(status: "available" | "unavailable" | undefined): {
  primaryCacheReadTelemetry?: "available" | "unavailable";
} {
  return status === undefined ? {} : { primaryCacheReadTelemetry: status };
}
