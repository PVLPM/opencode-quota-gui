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
  /** Host request-start-side timestamp (step.started), not exact provider acceptance; completion time is not a TTL origin. */
  dispatchAtMs?: number;
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
      basis: CacheEvidenceBasis;
    }
  | { kind: "unknown"; basis: string };

export interface CacheTtlEstimate {
  kind: "configured" | "documented";
  ttlMs: CacheSupportedTtlMs;
  source: string;
  reference: string;
  assumption: string;
  /** Omitted when the source has no valid request-start timestamp. */
  dispatchAtMs?: number;
  /** Estimated boundary only; this is not proof of physical eviction. */
  deadlineAtMs?: number;
}

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
  ttlSemantics?: "configured-minimum" | "documented-estimate";
  configuredTtlMs?: CacheSupportedTtlMs;
  configuredTtlDeadlineAtMs?: number;
  ttlEstimate?: CacheTtlEstimate;
  reason:
    | "insufficient-evidence"
    | "observed-reuse-with-active-ttl"
    | "observed-write-with-active-ttl"
    | "ambiguous-invocation"
    | "history-truncated"
    | "ttl-unverified"
    | "ttl-expired"
    | "dispatch-time-unavailable"
    | "estimated-reuse-within-ttl"
    | "estimated-write-within-ttl"
    | "estimated-ttl-near-expiry"
    | "estimated-ttl-expired"
    | "out-of-order-invocation"
    | "observation-gap"
    | "route-unverified"
    | "invalidation-unverified"
    | "known-invalidation"
    | "compaction-boundary-uncertain"
    | "assumed-route-risk";
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
    // Without an established reusable prefix there is nothing to be at risk
    // about: ambiguous, route-less, or zero-count telemetry is absence of
    // evidence, not a warning.
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

  // Route and TTL-policy evidence must be evaluable before ambiguity can
  // escalate to risk; an unsupported or unknown route stays gray.
  if (!Number.isFinite(nowMs) || !hasValidRouteProvenance(state.scope.route)) {
    return {
      color: "gray",
      reason: "route-unverified",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }
  if (!hasValidRouteProvenance(latestReuse.route)) {
    return {
      color: "gray",
      reason: "route-unverified",
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  const policy = cacheTtlPolicy(state.scope.route, state.ttlEvidence);
  if (policy === undefined) {
    return {
      color: "gray",
      reason: "route-unverified",
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

  const ttlEstimate: CacheTtlEstimate = {
    kind: policy.kind,
    ttlMs: policy.ttlMs,
    source: policy.source,
    reference: policy.reference,
    assumption: policy.assumption,
  };
  if (!hasValidDispatchTime(latestReuse, nowMs)) {
    return {
      color: "gray",
      reason: "dispatch-time-unavailable",
      ttlEstimate,
      ...telemetryStatus,
      ...optionalRatio(ratio),
    };
  }

  const previousReuse = reusablePrefixes.at(-2);
  if (previousReuse !== undefined && hasValidDispatchTime(previousReuse, nowMs)) {
    const dispatchAtMs = latestReuse.dispatchAtMs;
    if (dispatchAtMs < previousReuse.dispatchAtMs) {
      return {
        color: "yellow",
        reason: "out-of-order-invocation",
        ttlEstimate: { ...ttlEstimate, dispatchAtMs },
        ...telemetryStatus,
        ...optionalRatio(ratio),
      };
    }
  }

  const dispatchAtMs = latestReuse.dispatchAtMs;
  const deadlineAtMs = dispatchAtMs + policy.ttlMs;
  const warningAtMs = dispatchAtMs + Math.floor(policy.ttlMs * 0.8);
  const completeEstimate: CacheTtlEstimate = {
    ...ttlEstimate,
    dispatchAtMs,
    deadlineAtMs,
  };
  const shared = {
    confidence: "best-effort" as const,
    ttlEstimate: completeEstimate,
    ...(policy.kind === "configured"
      ? {
          ttlSemantics: "configured-minimum" as const,
          configuredTtlMs: policy.ttlMs,
          configuredTtlDeadlineAtMs: deadlineAtMs,
        }
      : { ttlSemantics: "documented-estimate" as const }),
    ...telemetryStatus,
    ...optionalRatio(ratio),
  };

  if (deadlineAtMs <= nowMs) {
    return { color: "red", reason: "estimated-ttl-expired", ...shared };
  }
  if (warningAtMs <= nowMs) {
    return {
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
      recheckAtMs: deadlineAtMs,
      ...shared,
    };
  }

  // Green is reserved for explicit invocation-bound evidence (a configured
  // TTL). A documented provider-ID baseline is a meaningful assumption about
  // the effective endpoint — report it as yellow risk, never as evidenced reuse.
  if (policy.kind === "configured") {
    return {
      color: "green",
      reason: hasObservedRead(latestReuse.counts)
        ? "estimated-reuse-within-ttl"
        : "estimated-write-within-ttl",
      recheckAtMs: warningAtMs,
      ...shared,
    };
  }

  return {
    color: "yellow",
    reason: "assumed-route-risk",
    recheckAtMs: warningAtMs,
    ...shared,
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

/**
 * The estimate-bearing reusable-prefix predicate: a certain primary invocation
 * on the scoped route with an observed cache read or write. Exported so the
 * ingestor can identify the latest estimate-qualifying invocation without
 * depending on ratio availability.
 */
export function isEstablishedReusablePrefix(
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
  return route?.providerId === "anthropic";
}

interface CacheTtlPolicy {
  kind: CacheTtlEstimate["kind"];
  ttlMs: CacheSupportedTtlMs;
  source: string;
  reference: string;
  assumption: string;
}

const DOCUMENTED_TTL_POLICIES: readonly (CacheTtlPolicy & { providerIds: readonly string[] })[] = [
  {
    providerIds: ["anthropic"],
    kind: "documented",
    ttlMs: 300_000,
    source: "Anthropic prompt caching documentation",
    reference: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    assumption:
      "Assumes the direct Anthropic Messages route uses the documented 5-minute default; optional 1-hour TTL and custom or gateway endpoints are not observable, and the effective endpoint may be overridden by a gateway or proxy.",
  },
  {
    providerIds: [
      "moonshotai",
      "moonshotai-cn",
      "kimi-code-plan-global",
      "kimi-code-plan-cn",
      "kimi-for-coding",
      "kimi",
      "kimi-code",
    ],
    kind: "documented",
    ttlMs: 300_000,
    source: "Kimi context caching documentation",
    reference: "https://platform.kimi.ai/docs/guide/context-caching",
    assumption:
      "Uses the documented 5-minute Kimi TTL option as a baseline; an optional 1-hour policy and custom or gateway endpoints are not observable, and the effective endpoint may be overridden by a gateway or proxy.",
  },
  {
    providerIds: [
      "alibaba",
      "alibaba-cn",
      "alibaba-coding-plan",
      "alibaba-coding-plan-cn",
      "alibaba-token-plan",
      "alibaba-token-plan-cn",
    ],
    kind: "documented",
    ttlMs: 300_000,
    source: "Qwen context caching documentation",
    reference: "https://docs.qwencloud.com/developer-guides/run-and-scale/context-cache",
    assumption:
      "Assumes the selected direct Qwen service and model use the documented 5-minute cache; cache eligibility and custom or gateway endpoints are not observable, and the effective endpoint may be overridden by a gateway or proxy.",
  },
  {
    providerIds: ["amazon-bedrock"],
    kind: "documented",
    ttlMs: 300_000,
    source: "Amazon Bedrock prompt caching documentation",
    reference: "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html",
    assumption:
      "Uses the documented default 5-minute TTL; model-specific 1-hour eligibility and custom or gateway endpoints are not observable, and the effective endpoint may be overridden by a gateway or proxy.",
  },
];

function cacheTtlPolicy(
  route: CacheRouteProvenance,
  evidence: CacheTtlEvidence | undefined,
): CacheTtlPolicy | undefined {
  if (evidence?.kind === "unknown") return undefined;
  if (evidence?.kind === "configured") {
    if (
      !hasValidBasis(evidence.basis) ||
      !hasValidRouteProvenance(evidence.route) ||
      !sameRoute(route, evidence.route) ||
      !isAuthoritativeAnthropicRoute(route) ||
      evidence.protocolId !== "anthropic-messages" ||
      (evidence.configuredTtlMs !== 300_000 && evidence.configuredTtlMs !== 3_600_000)
    ) {
      return undefined;
    }
    return {
      kind: "configured",
      ttlMs: evidence.configuredTtlMs,
      source: evidence.basis.source,
      reference: evidence.basis.reference,
      assumption:
        "Uses the invocation-bound configured TTL; physical provider expiry is not observable.",
    };
  }
  if (!hasValidRouteProvenance(route)) return undefined;
  return DOCUMENTED_TTL_POLICIES.find((policy) => policy.providerIds.includes(route.providerId));
}

function hasValidDispatchTime(
  invocation: CacheInvocationObservation,
  nowMs: number,
): invocation is CacheInvocationObservation & { dispatchAtMs: number } {
  return (
    typeof invocation.dispatchAtMs === "number" &&
    Number.isFinite(invocation.dispatchAtMs) &&
    invocation.dispatchAtMs >= 0 &&
    invocation.dispatchAtMs <= invocation.order.completedAtMs &&
    invocation.dispatchAtMs <= nowMs
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

function hasValidRouteProvenance(
  route: CacheRouteProvenance | undefined,
): route is CacheRouteProvenance {
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
