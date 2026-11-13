/**
 * Pure, bounded retention-estimate model for cache observation. This module does
 * not read storage, subscribe to host events, issue requests, or observe provider
 * cache validity. Every colour is an estimate: the retention window starts at the
 * request start of the newest successful primary LLM call on the scoped route,
 * plus a route-scoped retention policy, regardless of its cache read or write
 * counters.
 */

export const CACHE_OBSERVER_MAX_INVOCATIONS = 128;

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

/**
 * Omitted means the category was not reported. A reported zero is a real value;
 * the ingestion layer decides whether an all-zero set is usable telemetry.
 */
export interface CacheInvocationCounts {
  /** Host-reported fresh input tokens, distinct from cache reads and writes. */
  fresh?: number;
  /** Host-reported cache-read tokens. */
  read?: number;
  /** Host-reported cache-write tokens. */
  write?: number;
}

/**
 * A successful, eligible primary LLM request (finish `stop` or `tool-calls`).
 * Failed or incomplete requests are excluded by the ingestion layer before they
 * reach this model.
 */
export interface CacheInvocationObservation {
  sessionId: string;
  order: CacheInvocationOrder;
  /** Host request-start timestamp (step.started), not exact provider acceptance; completion time is never a TTL origin. */
  dispatchAtMs?: number;
  route?: CacheRouteProvenance;
  /** The concrete source that established this invocation as an eligible primary request. */
  basis: CacheEvidenceBasis;
  counts: CacheInvocationCounts;
  /** Best-effort current configuration snapshot captured during this live call. */
  configuredTtlMs?: CacheConfiguredTtlMs;
}

/** Host-configured retention values the observer accepts for a configurable route. */
export type CacheConfiguredTtlMs = 300_000 | 3_600_000;

/** Retention windows an estimate may use. */
export type CacheSupportedTtlMs = CacheConfiguredTtlMs | 1_800_000 | 86_400_000;

/**
 * Host-derived facts about one route. Absent fields mean the route's policy default
 * applies: the observer never assumes a direct OpenAI API route it cannot confirm.
 */
export interface CacheRouteConfiguration {
  /** The host's `cache.ttl` for a configurable route (direct Anthropic or Kimi). */
  configuredTtlMs?: CacheConfiguredTtlMs;
  /**
   * The active credential is an API key and the resolved provider sets no endpoint
   * override, so the route is the direct OpenAI API (not ChatGPT OAuth or a gateway).
   */
  directOpenAiApi?: boolean;
}

export interface CacheTtlEstimate {
  /**
   * configured: the host-configured `cache.ttl` for a configurable route; documented:
   * vendor documentation; empirical: owner-approved observed retention; fallback:
   * the generic 5-minute window for unknown, gateway, and OpenAI-family routes.
   */
  kind: "configured" | "documented" | "empirical" | "fallback";
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

/**
 * The reason union is the Native pill's reason vocabulary. Members this model no
 * longer produces are retained only so the pill's exhaustive reason mapping still
 * type-checks; they should be pruned with that consumer.
 */
export type CacheObserverReason =
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
  | "estimated-within-ttl"
  | "estimated-ttl-near-expiry"
  | "estimated-ttl-expired"
  | "out-of-order-invocation"
  | "observation-gap"
  | "route-unverified"
  | "invalidation-unverified"
  | "known-invalidation"
  | "compaction-boundary-uncertain"
  | "assumed-route-risk";

export interface CacheObserverClassification {
  color: CacheObserverColor;
  reason: CacheObserverReason;
  ttlEstimate?: CacheTtlEstimate;
  primaryCacheReadRatio?: CachePrimaryRatio;
  /** Distinguishes received but unusable usage counters from no observed step telemetry. */
  primaryCacheReadTelemetry?: "available" | "unavailable";
  /** Earliest instant to reconsider the estimate without a newer event. */
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
  };
}

export function observeCacheInvocation(
  state: CacheObserverState,
  observation: CacheInvocationObservation,
): CacheObserverState {
  assertSession(state, observation.sessionId);
  // A missing route is retained so a newer unrouted invocation cannot leave an
  // older estimate looking current; it classifies as route-unverified.
  if (observation.route !== undefined) assertRoute(state.scope.route, observation.route);
  assertOrder(observation.order);

  const withoutRevision = state.invocations.filter(
    (entry) => entry.order.messageId !== observation.order.messageId,
  );
  const invocations = [...withoutRevision, cloneInvocation(observation)].sort((a, b) =>
    compareOrder(a.order, b.order),
  );
  return {
    ...state,
    invocations: invocations.slice(-CACHE_OBSERVER_MAX_INVOCATIONS),
  };
}

export function classifyCacheObserverState(
  state: CacheObserverState,
  nowMs: number,
  routeConfiguration: CacheRouteConfiguration = {},
): CacheObserverClassification {
  const latest = last(state.invocations);
  if (latest === undefined) return { color: "gray", reason: "insufficient-evidence" };

  // The cache share belongs to the newest successful call and stays independent
  // of the retention estimate, so a route-unverified estimate still shows it.
  const telemetry = primaryRatioOf(latest);
  const reported = {
    primaryCacheReadTelemetry: telemetry.status,
    ...optionalRatio(telemetry.ratio),
  };

  if (!Number.isFinite(nowMs) || !hasValidRouteProvenance(state.scope.route)) {
    return { color: "gray", reason: "route-unverified", ...reported };
  }
  if (!hasValidRouteProvenance(latest.route)) {
    return { color: "gray", reason: "route-unverified", ...reported };
  }

  const policy = retentionPolicy(
    latest.route,
    latest.configuredTtlMs === undefined
      ? routeConfiguration
      : { configuredTtlMs: latest.configuredTtlMs },
  );
  const ttlEstimate: CacheTtlEstimate = {
    kind: policy.kind,
    ttlMs: policy.ttlMs,
    source: policy.source,
    reference: policy.reference,
    assumption: policy.assumption,
  };
  if (!hasValidDispatchTime(latest, nowMs)) {
    return { color: "gray", reason: "dispatch-time-unavailable", ttlEstimate, ...reported };
  }

  const dispatchAtMs = latest.dispatchAtMs;
  const deadlineAtMs = dispatchAtMs + policy.ttlMs;
  const warningAtMs = dispatchAtMs + Math.floor(policy.ttlMs * 0.8);
  const estimate: CacheTtlEstimate = { ...ttlEstimate, dispatchAtMs, deadlineAtMs };

  if (deadlineAtMs <= nowMs) {
    return { color: "red", reason: "estimated-ttl-expired", ttlEstimate: estimate, ...reported };
  }
  if (warningAtMs <= nowMs) {
    return {
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
      ttlEstimate: estimate,
      recheckAtMs: deadlineAtMs,
      ...reported,
    };
  }
  return {
    color: "green",
    reason: greenReasonFor(latest.counts),
    ttlEstimate: estimate,
    recheckAtMs: warningAtMs,
    ...reported,
  };
}

const DURATION_UNIT_MS: Readonly<Record<"ms" | "s" | "m" | "h" | "d", number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * The host's `cache.ttl` value (`<number><ms|s|m|h|d>`, models.dev duration format)
 * as one of the windows the observer accepts. Any other value is unsupported and
 * yields undefined, so the route's default applies.
 */
export function cacheConfiguredTtlMsFromHostValue(
  value: unknown,
): CacheConfiguredTtlMs | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (match === null) return undefined;
  const ttlMs = Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS];
  return ttlMs === 300_000 || ttlMs === 3_600_000 ? ttlMs : undefined;
}

/**
 * The model-specific default prompt-cache lifetime OpenAI documents for direct API
 * use: 30 minutes for GPT-5.5 (typical) and GPT-5.6 and later (minimum default).
 * Other models have no documented model-specific lifetime and get undefined.
 */
export function openAiDocumentedTtlMs(modelId: string): 1_800_000 | undefined {
  if (modelId === "gpt-5.5" || modelId === "gpt-5.5-pro") return 1_800_000;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(modelId);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6) ? 1_800_000 : undefined;
}

/** Providers whose host `cache.ttl` the observer reads: direct Anthropic and Kimi. */
export function isCacheConfigurableProviderId(providerId: string): boolean {
  return providerId === "anthropic" || KIMI_PROVIDER_IDS.has(providerId);
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
    basis: { ...entry.basis },
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

function greenReasonFor(counts: CacheInvocationCounts): CacheObserverReason {
  if (isPositiveFinite(counts.read)) return "estimated-reuse-within-ttl";
  if (isPositiveFinite(counts.write)) return "estimated-write-within-ttl";
  return "estimated-within-ttl";
}

function isPositiveFinite(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Cache share of one successful call: read / (fresh + read + write). A reported
 * zero read is a valid 0%; a call with missing counters, or with no input at
 * all, has no usable share.
 */
function primaryRatioOf(invocation: CacheInvocationObservation): {
  status: "available" | "unavailable";
  ratio?: CachePrimaryRatio;
} {
  const { fresh, read, write } = invocation.counts;
  if (!isNonNegativeFinite(fresh) || !isNonNegativeFinite(read) || !isNonNegativeFinite(write)) {
    return { status: "unavailable" };
  }
  const denominator = fresh + read + write;
  if (!(denominator > 0) || !Number.isFinite(denominator)) return { status: "unavailable" };

  return {
    status: "available",
    ratio: {
      value: read / denominator,
      messageId: invocation.order.messageId,
      observedAtMs: invocation.order.completedAtMs,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { ...invocation.basis },
    },
  };
}

interface RetentionPolicy {
  kind: CacheTtlEstimate["kind"];
  ttlMs: CacheSupportedTtlMs;
  source: string;
  reference: string;
  assumption: string;
}

const ROUTE_DEFAULT_ASSUMPTION =
  "assuming direct standard route/default TTL; custom endpoint, gateway, changed configuration or provider eviction may cause miss";

const GENERIC_FALLBACK_ASSUMPTION =
  "generic 5-minute fallback; no vendor retention is inferred for this route; gateway, custom endpoint, changed configuration or provider eviction may cause a miss";

const KIMI_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "moonshotai",
  "moonshotai-cn",
  "kimi-code-plan-global",
  "kimi-code-plan-cn",
  "kimi-for-coding",
  "kimi",
  "kimi-code",
]);

/**
 * Route-scoped retention policy, matched by exact provider id (and model for the
 * one empirical OpenCode Go entry), so a gateway never inherits a vendor window.
 * A host-configured `cache.ttl` applies only to a configurable route; every other
 * route keeps its policy default.
 */
function retentionPolicy(
  route: CacheRouteProvenance,
  routeConfiguration: CacheRouteConfiguration,
): RetentionPolicy {
  const configuredTtlMs = routeConfiguration.configuredTtlMs;
  if (configuredTtlMs !== undefined && isCacheConfigurableProviderId(route.providerId)) {
    return {
      kind: "configured",
      ttlMs: configuredTtlMs,
      source: "Current host settings snapshot",
      reference: "opencode-config:provider-settings.cache.ttl",
      assumption:
        "Best-effort current host cache.ttl snapshot; may differ from dispatch settings or effective route. Physical provider expiry is not observable.",
    };
  }
  if (route.providerId === "anthropic") {
    return {
      kind: "documented",
      ttlMs: 300_000,
      source: "Anthropic prompt caching documentation",
      reference: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      assumption: ROUTE_DEFAULT_ASSUMPTION,
    };
  }
  if (KIMI_PROVIDER_IDS.has(route.providerId)) {
    return {
      kind: "documented",
      ttlMs: 300_000,
      source: "Kimi context caching documentation",
      reference: "https://platform.kimi.ai/docs/guide/context-caching",
      assumption: ROUTE_DEFAULT_ASSUMPTION,
    };
  }
  if (route.providerId === "deepseek") {
    return {
      kind: "empirical",
      ttlMs: 86_400_000,
      source: "DeepSeek direct retention (owner-approved empirical policy)",
      reference: "cache-observer-policy:deepseek-direct-24h",
      assumption:
        "Empirical 24-hour estimate for direct DeepSeek; physical retention is not observable and provider eviction may cause a miss.",
    };
  }
  if (route.providerId === "opencode-go" && route.modelId === "deepseek-v4.1-flash") {
    return {
      kind: "empirical",
      ttlMs: 3_600_000,
      source: "OpenCode Go deepseek-v4.1-flash retention (owner-approved empirical policy)",
      reference: "cache-observer-policy:opencode-go-deepseek-v4.1-flash-60m",
      assumption:
        "Empirical 60-minute estimate for this OpenCode Go model; physical retention is not observable and provider eviction may cause a miss.",
    };
  }
  const openAiTtlMs = openAiDocumentedTtlMs(route.modelId);
  if (
    route.providerId === "openai" &&
    routeConfiguration.directOpenAiApi &&
    openAiTtlMs !== undefined
  ) {
    return {
      kind: "documented",
      ttlMs: openAiTtlMs,
      source: "OpenAI prompt caching documentation (model-specific default lifetime)",
      reference: "https://developers.openai.com/api/docs/guides/prompt-caching",
      assumption:
        "Documented default 30-minute lifetime for this GPT model family on the direct OpenAI API; the optional 12-hour lifetime and physical eviction are not observable.",
    };
  }
  return {
    kind: "fallback",
    ttlMs: 300_000,
    source: "Generic 5-minute fallback for unknown, gateway, or OpenAI-family routes",
    reference: "cache-observer-policy:generic-5m-fallback",
    assumption: GENERIC_FALLBACK_ASSUMPTION,
  };
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
