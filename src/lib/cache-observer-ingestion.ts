import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import {
  type CacheEvidenceBasis,
  type CacheInvocationObservation,
  type CacheObserverClassification,
  type CacheObserverState,
  type CacheRouteProvenance,
  classifyCacheObserverState,
  createCacheObserverState,
  isEstablishedReusablePrefix,
  observeCacheInvocation,
} from "./cache-observer.js";

export type CacheObserverUpdate =
  | { kind: "invocation"; observation: CacheInvocationObservation }
  | { kind: "created"; sessionId: string; parentSessionId: string }
  | { kind: "compaction"; sessionId: string }
  | { kind: "deleted"; sessionId: string }
  | { kind: "forked"; sessionId: string; parentSessionId?: string };

/** Content-free projection of one completed assistant message from message.list. */
export interface CacheObserverHistoryInvocation {
  sessionId: string;
  messageId: string;
  completedAtMs: number;
  /**
   * OpenCode message.list `time.created` — upstream v2.2.1 copies it from the
   * runner's step-started timestamp (message-updater.ts:230,254), so it marks
   * the host request-dispatch side, not exact provider acceptance. Omitted
   * when absent or invalid; never synthesized from `time.completed`.
   */
  dispatchAtMs?: number;
  route: CacheRouteProvenance;
  counts: CacheInvocationObservation["counts"];
}

export type CacheObserverListener = (
  classification: CacheObserverClassification | undefined,
) => void;

/** Bound retained exact-session state even when a window observes many forks. */
export const CACHE_OBSERVER_MAX_SESSIONS = 128;
const CACHE_OBSERVER_MAX_STARTED_STEPS = 512;
const PRIMARY_STEP_BASIS = {
  source: "opencode-v2.2.0-session-runner",
  reference: "packages/core/src/session/runner/llm.ts#233-287",
} satisfies CacheEvidenceBasis;

interface StartedStepEvidence {
  sessionId: string;
  messageId: string;
  route: CacheRouteProvenance;
  dispatchAtMs?: number;
}

interface PendingEndedStep {
  sessionId: string;
  event: Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }>;
}

interface LiveCompletionEvidence {
  messageId: string;
  completedAtMs: number;
}

/** Read-only query/subscription seam; each id is an exact session, never a tree aggregate. */
export interface CacheObserverIngestor {
  query(sessionId: string): CacheObserverClassification | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  /** Hide the reported ratio until this exact session yields a new qualifying primary end. */
  markObservationGap(sessionId: string): void;
  ingest(event: unknown): void;
  /** Merge historical message-list DTOs without allowing them to supersede live observations. */
  ingestHistory(
    invocations: readonly CacheObserverHistoryInvocation[],
    options?: { truncatedSessionIds?: readonly string[] },
  ): void;
  /**
   * Confirm the newest completed message from a fresh, gap-free history read.
   * An exact match of the latest estimate-qualifying invocation — message id,
   * completion, route, counters, and request-start timestamp — re-arms the
   * historical estimate after an observation gap, independently of ratio
   * availability.
   */
  confirmLatestHistory(invocation: CacheObserverHistoryInvocation): void;
  /** True when the newest live completion has exact Started/Ended correlation and counters. */
  hasUsableLiveObservation(sessionId: string): boolean;
  dispose(): void;
}

/**
 * OpenCode v2.2.0's runner calls the primary request path before its completed
 * step event. Selected model identity is correlated from the exact Started
 * event; session usage aggregates and mutable model catalogs are not invocation
 * route or dispatch-TTL evidence.
 */
export function cacheObserverUpdateFromOpenCodeEvent(
  event: unknown,
): CacheObserverUpdate | undefined {
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) return undefined;
  const sessionId = nonEmptyString(event.data.sessionID);
  if (sessionId === undefined) return undefined;

  if (event.type === "session.created") {
    const parentSessionId = nonEmptyString(event.data.parentID);
    return parentSessionId === undefined
      ? undefined
      : { kind: "created", sessionId, parentSessionId };
  }
  if (event.type === "session.deleted") return { kind: "deleted", sessionId };
  if (event.type === "session.forked") {
    const parentSessionId = nonEmptyString(event.data.parentID);
    return {
      kind: "forked",
      sessionId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    };
  }
  if (event.type === "session.compaction.ended") return { kind: "compaction", sessionId };

  if (event.type !== "session.step.ended" || !isRecord(event.data.tokens)) return undefined;
  const messageId = nonEmptyString(event.data.assistantMessageID);
  const order = eventOrder(event, messageId);
  if (order === undefined) return undefined;
  const tokens = event.data.tokens;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  // OpenCode v2.2.0 defines distinct fresh/cache-read/cache-write counters in
  // https://github.com/anomalyco/opencode/blob/v2.2.0/packages/ai/src/schema/events.ts#L20-L55
  // and maps them onto step tokens (normalizing missing values to zero) in
  // https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/session/usage.ts#L8-L18.
  // This supports host-reported telemetry only, not protocol or cache-validity inference.
  const fresh = ownFiniteNumber(tokens, "input");
  const read = cache === undefined ? undefined : ownFiniteNumber(cache, "read");
  const write = cache === undefined ? undefined : ownFiniteNumber(cache, "write");
  const counts: CacheInvocationObservation["counts"] = {
    ...(fresh === undefined ? {} : { fresh }),
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  };
  return {
    kind: "invocation",
    observation: {
      sessionId,
      order,
      primaryClassification: { kind: "primary", basis: PRIMARY_STEP_BASIS },
      counts,
    },
  };
}

/**
 * Strip an OpenCode event to the content-free DTO carried on Native's shared RPC stream.
 * Started is published at first output (v2.2.0 `publish-llm-event.ts:121-135`). The actual
 * request uses resolved `model.cache` (`model-request.ts:277-294`), while
 * `SessionModelRequest.prepare` can rewrite the base URL and HTTP request through hooks
 * (`model-request.ts:303-329`). The mutable model catalog therefore cannot establish
 * invocation-bound TTL or effective-route evidence here.
 */
export function projectOpenCodeCacheObserverEvent(
  event: unknown,
): DashboardRpcCacheObserverEvent | undefined {
  const started = projectStartedStep(event);
  if (started !== undefined) return started;

  const update = cacheObserverUpdateFromOpenCodeEvent(event);
  if (update === undefined) return undefined;

  if (update.kind === "invocation") {
    const { completedAtMs, messageId } = update.observation.order;
    const { fresh, read, write } = update.observation.counts;
    const cache = {
      ...(read === undefined ? {} : { read }),
      ...(write === undefined ? {} : { write }),
    };
    return {
      type: "session.step.ended",
      created: completedAtMs,
      data: {
        sessionID: update.observation.sessionId,
        assistantMessageID: messageId,
        tokens: {
          ...(fresh === undefined ? {} : { input: fresh }),
          ...(read === undefined && write === undefined ? {} : { cache }),
        },
      },
    };
  }

  if (update.kind === "created") {
    return {
      type: "session.created",
      data: { sessionID: update.sessionId, parentID: update.parentSessionId },
    };
  }

  if (update.kind === "forked") {
    return {
      type: "session.forked",
      data: {
        sessionID: update.sessionId,
        ...(update.parentSessionId === undefined ? {} : { parentID: update.parentSessionId }),
      },
    };
  }

  const type = update.kind === "compaction" ? "session.compaction.ended" : "session.deleted";
  return { type, data: { sessionID: update.sessionId } };
}

/**
 * Immediately project a message.list item to the small cache-observer domain DTO.
 * Assistant content, metadata, tools, cost, and all unrelated message fields
 * are intentionally neither read nor copied.
 */
export function projectOpenCodeCacheObserverHistoryMessage(
  sessionId: string,
  message: unknown,
): CacheObserverHistoryInvocation | undefined {
  if (!sessionId.trim() || !isRecord(message) || message.type !== "assistant") return undefined;
  const messageId = nonEmptyString(message.id);
  const model = isRecord(message.model) ? message.model : undefined;
  const providerId = model === undefined ? undefined : nonEmptyString(model.providerID);
  const modelId = model === undefined ? undefined : nonEmptyString(model.id);
  const time = isRecord(message.time) ? message.time : undefined;
  const completedAtMs =
    time === undefined ? undefined : ownNonNegativeFiniteNumber(time, "completed");
  if (
    messageId === undefined ||
    providerId === undefined ||
    modelId === undefined ||
    completedAtMs === undefined
  ) {
    return undefined;
  }

  const variantId = normalizedVariantId(model?.variant);
  const tokenUsage = isRecord(message.tokens) ? message.tokens : undefined;
  const cache =
    tokenUsage !== undefined && isRecord(tokenUsage.cache) ? tokenUsage.cache : undefined;
  const fresh =
    tokenUsage === undefined ? undefined : ownNonNegativeFiniteNumber(tokenUsage, "input");
  const read = cache === undefined ? undefined : ownNonNegativeFiniteNumber(cache, "read");
  const write = cache === undefined ? undefined : ownNonNegativeFiniteNumber(cache, "write");
  // The public schema's `time.created` is copied from the runner's
  // step-started timestamp (upstream v2.2.1 message-updater.ts:230,254): a
  // host request-dispatch-side time, not exact provider acceptance. Keep it
  // only as a narrow valid timestamp: finite, non-negative, and not after
  // completion. Completion is never used as a request start.
  const rawDispatchAtMs =
    time === undefined ? undefined : ownNonNegativeFiniteNumber(time, "created");
  const dispatchAtMs =
    rawDispatchAtMs === undefined || rawDispatchAtMs > completedAtMs ? undefined : rawDispatchAtMs;

  return {
    sessionId,
    messageId,
    completedAtMs,
    ...(dispatchAtMs === undefined ? {} : { dispatchAtMs }),
    route: {
      providerId,
      modelId,
      ...(variantId === undefined ? {} : { variantId }),
      basis: {
        source: "OpenCode message.list assistant model identity",
        reference: messageId,
      },
    },
    counts: {
      ...(fresh === undefined ? {} : { fresh }),
      ...(read === undefined ? {} : { read }),
      ...(write === undefined ? {} : { write }),
    },
  };
}

/** True only for a completed compaction boundary in the public message-list DTO. */
export function isCompletedCacheObserverHistoryCompaction(message: unknown): boolean {
  return isRecord(message) && message.type === "compaction" && message.status === "completed";
}

export function createCacheObserverIngestor(
  options: { now?: () => number } = {},
): CacheObserverIngestor {
  const now = options.now ?? Date.now;
  const states = new Map<string, CacheObserverState>();
  const listeners = new Map<string, Set<CacheObserverListener>>();
  const startedSteps = new Map<string, StartedStepEvidence>();
  const pendingEndedSteps = new Map<string, PendingEndedStep>();
  const liveStepKeys = new Map<string, string>();
  const latestLiveRoutes = new Map<string, CacheRouteProvenance>();
  const latestLiveCompletedAt = new Map<string, number>();
  const latestLiveCompletion = new Map<string, LiveCompletionEvidence>();
  const latestUsableLiveCompletion = new Map<string, LiveCompletionEvidence>();
  const ratioFencedSessions = new Set<string>();
  const observationGapSessions = new Set<string>();
  /**
   * Sessions with retained gapped state whose fresh history was merged after
   * their latest observation gap. Only gapped sessions are marked, and every
   * gap, lifecycle reset, eviction, and restore clears the marker, so the set
   * stays bounded by the retained-state bound (CACHE_OBSERVER_MAX_SESSIONS).
   */
  const freshHistorySinceGap = new Set<string>();
  const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function query(sessionId: string): CacheObserverClassification | undefined {
    if (!sessionId.trim()) return undefined;
    const state = states.get(sessionId);
    if (state !== undefined) {
      states.delete(sessionId);
      states.set(sessionId, state);
    }
    if (state === undefined) return undefined;
    let classification = classifyCacheObserverState(state, now());
    if (observationGapSessions.has(sessionId)) {
      const {
        recheckAtMs: _recheckAtMs,
        ttlEstimate: _ttlEstimate,
        ttlSemantics: _ttlSemantics,
        configuredTtlMs: _configuredTtlMs,
        configuredTtlDeadlineAtMs: _configuredTtlDeadlineAtMs,
        ...withoutCacheEstimate
      } = classification;
      classification = {
        ...withoutCacheEstimate,
        color: "gray",
        reason: "observation-gap",
      };
    }
    if (!ratioFencedSessions.has(sessionId) || classification.primaryCacheReadRatio === undefined) {
      return classification;
    }
    const { primaryCacheReadRatio: _fencedRatio, ...lastObservedClassification } = classification;
    return { ...lastObservedClassification, primaryCacheReadTelemetry: "unavailable" };
  }

  function notify(sessionId: string): void {
    const classification = query(sessionId);
    const sessionListeners = listeners.get(sessionId);
    if (sessionListeners === undefined || sessionListeners.size === 0) {
      clearRecheckTimer(sessionId);
      return;
    }
    for (const listener of Array.from(sessionListeners)) {
      try {
        listener(classification);
      } catch {
        // A consumer failure must not interrupt host-event ingestion.
      }
    }
    scheduleRecheck(sessionId, classification);
  }

  function clearRecheckTimer(sessionId: string): void {
    const timer = recheckTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    recheckTimers.delete(sessionId);
  }

  function scheduleRecheck(
    sessionId: string,
    classification: CacheObserverClassification | undefined,
  ): void {
    clearRecheckTimer(sessionId);
    if ((listeners.get(sessionId)?.size ?? 0) === 0 || classification?.recheckAtMs === undefined)
      return;

    const MAX_TIMEOUT_MS = 2_147_483_647;
    const delayMs = Math.min(Math.max(1, classification.recheckAtMs - now()), MAX_TIMEOUT_MS);
    const scheduledAtMs = classification.recheckAtMs;
    const timer = setTimeout(() => {
      recheckTimers.delete(sessionId);
      if (disposed || (listeners.get(sessionId)?.size ?? 0) === 0) return;
      const updated = query(sessionId);
      if (scheduledAtMs > now()) {
        scheduleRecheck(sessionId, updated);
        return;
      }
      for (const listener of Array.from(listeners.get(sessionId) ?? [])) {
        try {
          listener(updated);
        } catch {
          // A consumer failure cannot interrupt time-driven classification.
        }
      }
      scheduleRecheck(sessionId, updated);
    }, delayMs);
    recheckTimers.set(sessionId, timer);
  }

  function clearStartedSteps(sessionId: string): void {
    for (const [key, started] of startedSteps) {
      if (started.sessionId === sessionId) startedSteps.delete(key);
    }
  }

  function clearPendingEndedSteps(sessionId: string): void {
    for (const [key, ended] of pendingEndedSteps) {
      if (ended.sessionId === sessionId) pendingEndedSteps.delete(key);
    }
  }

  function clearPendingSteps(sessionId: string): void {
    clearStartedSteps(sessionId);
    clearPendingEndedSteps(sessionId);
  }

  function markObservationGap(sessionId: string): void {
    if (disposed || !sessionId.trim()) return;
    clearPendingSteps(sessionId);
    clearLiveContext(sessionId);
    freshHistorySinceGap.delete(sessionId);
    clearRecheckTimer(sessionId);
    // Without retained state there is no pre-gap estimate or ratio to hide;
    // later post-gap evidence classifies on its own merits.
    if (!states.has(sessionId)) return;
    observationGapSessions.add(sessionId);
    ratioFencedSessions.add(sessionId);
    notify(sessionId);
  }

  function ingest(event: unknown): void {
    ingestEvent(event, "live");
  }

  function ingestEvent(event: unknown, source: "live" | "history"): void {
    if (disposed) return;
    const started = startedStepFromDto(event);
    if (started !== undefined) {
      const key = startedStepKey(started.sessionId, started.messageId);
      if (source === "live") {
        rememberLiveStep(key, started.sessionId);
        const previousRoute = latestLiveRoutes.get(started.sessionId);
        if (previousRoute !== undefined && !sameRouteProvenance(previousRoute, started.route)) {
          latestLiveCompletedAt.delete(started.sessionId);
          latestLiveCompletion.delete(started.sessionId);
          latestUsableLiveCompletion.delete(started.sessionId);
        }
        latestLiveRoutes.delete(started.sessionId);
        latestLiveRoutes.set(started.sessionId, started.route);
        while (latestLiveRoutes.size > CACHE_OBSERVER_MAX_SESSIONS) {
          const oldestSessionId = latestLiveRoutes.keys().next().value;
          if (oldestSessionId === undefined) break;
          latestLiveRoutes.delete(oldestSessionId);
          latestLiveCompletedAt.delete(oldestSessionId);
          latestLiveCompletion.delete(oldestSessionId);
          latestUsableLiveCompletion.delete(oldestSessionId);
        }
      }
      const state = states.get(started.sessionId);
      if (
        source === "live" &&
        state?.scope.route !== undefined &&
        started.route !== undefined &&
        !sameRouteProvenance(state.scope.route, started.route)
      ) {
        // A changed selected provider/model/variant starts a new evidence epoch. The Started
        // model identity is not proof of the effective HTTP route or protocol.
        clearStartedSteps(started.sessionId);
        states.delete(started.sessionId);
        ratioFencedSessions.delete(started.sessionId);
        observationGapSessions.delete(started.sessionId);
        freshHistorySinceGap.delete(started.sessionId);
        states.set(
          started.sessionId,
          createCacheObserverState({ sessionId: started.sessionId, route: started.route }),
        );
        notify(started.sessionId);
      }
      startedSteps.delete(key);
      startedSteps.set(key, started);
      while (startedSteps.size > CACHE_OBSERVER_MAX_STARTED_STEPS) {
        const oldestKey = startedSteps.keys().next().value;
        if (oldestKey === undefined) break;
        startedSteps.delete(oldestKey);
      }
      const pendingEnd = pendingEndedSteps.get(key);
      if (pendingEnd !== undefined) {
        pendingEndedSteps.delete(key);
        // The Ended may have arrived first on the shared stream. Re-ingest only
        // its content-free projected DTO once exact session/message correlation
        // is now available.
        ingestEvent(pendingEnd.event, source);
      }
      return;
    }

    const update = cacheObserverUpdateFromOpenCodeEvent(event);
    if (update === undefined) return;

    if (update.kind === "created") {
      clearPendingSteps(update.sessionId);
      return;
    }

    if (update.kind !== "invocation") {
      clearPendingSteps(update.sessionId);
      ratioFencedSessions.delete(update.sessionId);
      observationGapSessions.delete(update.sessionId);
      freshHistorySinceGap.delete(update.sessionId);
      clearRecheckTimer(update.sessionId);
      if (source === "live") {
        clearLiveContext(update.sessionId);
      }
      if (states.delete(update.sessionId)) notify(update.sessionId);
      return;
    }

    const sessionId = update.observation.sessionId;
    const startedKey = startedStepKey(sessionId, update.observation.order.messageId);
    if (source === "live") {
      rememberLiveStep(startedKey, sessionId);
      const previousCompletedAt = latestLiveCompletedAt.get(sessionId);
      latestLiveCompletedAt.set(
        sessionId,
        Math.max(previousCompletedAt ?? 0, update.observation.order.completedAtMs),
      );
      rememberLiveCompletion(sessionId, {
        messageId: update.observation.order.messageId,
        completedAtMs: update.observation.order.completedAtMs,
      });
    }
    const startedEvidence = startedSteps.get(startedKey);
    startedSteps.delete(startedKey);

    const endedEvent: Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }> = {
      type: "session.step.ended",
      created: update.observation.order.completedAtMs,
      data: {
        sessionID: sessionId,
        assistantMessageID: update.observation.order.messageId,
        tokens: {
          ...(update.observation.counts.fresh === undefined
            ? {}
            : { input: update.observation.counts.fresh }),
          ...(update.observation.counts.read === undefined &&
          update.observation.counts.write === undefined
            ? {}
            : {
                cache: {
                  ...(update.observation.counts.read === undefined
                    ? {}
                    : { read: update.observation.counts.read }),
                  ...(update.observation.counts.write === undefined
                    ? {}
                    : { write: update.observation.counts.write }),
                },
              }),
        },
      },
    };

    if (startedEvidence === undefined) {
      pendingEndedSteps.delete(startedKey);
      pendingEndedSteps.set(startedKey, { sessionId, event: endedEvent });
      while (pendingEndedSteps.size > CACHE_OBSERVER_MAX_STARTED_STEPS) {
        const oldestKey = pendingEndedSteps.keys().next().value;
        if (oldestKey === undefined) break;
        pendingEndedSteps.delete(oldestKey);
      }
    } else {
      pendingEndedSteps.delete(startedKey);
    }

    let state = states.get(sessionId);
    if (state === undefined) {
      state = createCacheObserverState({
        sessionId,
        ...(startedEvidence?.route === undefined ? {} : { route: startedEvidence.route }),
      });
    } else if (state.scope.route === undefined && startedEvidence?.route !== undefined) {
      state = { ...state, scope: { ...state.scope, route: startedEvidence.route } };
    }

    const previousInvocation = state.invocations.find(
      (entry) => entry.order.messageId === update.observation.order.messageId,
    );
    if (
      source === "live" &&
      startedEvidence !== undefined &&
      hasObservedCounts(update.observation.counts)
    ) {
      rememberUsableLiveCompletion(sessionId, {
        messageId: update.observation.order.messageId,
        completedAtMs: update.observation.order.completedAtMs,
      });
    }
    const previousHasCounts =
      previousInvocation !== undefined &&
      (previousInvocation.counts.fresh !== undefined ||
        previousInvocation.counts.read !== undefined ||
        previousInvocation.counts.write !== undefined);
    if (previousInvocation !== undefined && (startedEvidence === undefined || previousHasCounts))
      return;

    // Ended counters are useful only after an exact Started correlation. Keep
    // the event receipt, but do not treat its untrusted zero-normalized values
    // as a real cache-read denominator.
    const observation =
      startedEvidence === undefined ? { ...update.observation, counts: {} } : update.observation;
    const matchedRoute =
      startedEvidence?.route !== undefined &&
      sameRouteProvenance(state.scope.route, startedEvidence.route)
        ? startedEvidence.route
        : undefined;
    state = observeCacheInvocation(state, {
      ...observation,
      ...(startedEvidence?.dispatchAtMs === undefined
        ? {}
        : { dispatchAtMs: startedEvidence.dispatchAtMs }),
      ...(matchedRoute === undefined ? {} : { route: matchedRoute }),
    });

    if (
      source === "live" &&
      startedEvidence?.dispatchAtMs !== undefined &&
      startedEvidence.dispatchAtMs <= observation.order.completedAtMs &&
      matchedRoute !== undefined &&
      (isPositiveFinite(update.observation.counts.read) ||
        isPositiveFinite(update.observation.counts.write))
    ) {
      observationGapSessions.delete(sessionId);
      freshHistorySinceGap.delete(sessionId);
    }

    if (!states.has(sessionId) && states.size >= CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = states.keys().next().value;
      if (oldestSessionId !== undefined) {
        states.delete(oldestSessionId);
        ratioFencedSessions.delete(oldestSessionId);
        observationGapSessions.delete(oldestSessionId);
        freshHistorySinceGap.delete(oldestSessionId);
        clearRecheckTimer(oldestSessionId);
        notify(oldestSessionId);
      }
    }
    states.delete(sessionId);
    states.set(sessionId, state);
    if (
      classifyCacheObserverState(state, now()).primaryCacheReadRatio?.messageId ===
      observation.order.messageId
    ) {
      ratioFencedSessions.delete(sessionId);
    }
    notify(sessionId);
  }

  /** Record a merged history read as the restore basis for a gapped session. */
  function markFreshHistoryIfGapped(sessionId: string): void {
    if (observationGapSessions.has(sessionId)) freshHistorySinceGap.add(sessionId);
  }

  function rememberLiveStep(key: string, sessionId: string): void {
    liveStepKeys.delete(key);
    liveStepKeys.set(key, sessionId);
    while (liveStepKeys.size > CACHE_OBSERVER_MAX_STARTED_STEPS) {
      const oldestKey = liveStepKeys.keys().next().value;
      if (oldestKey === undefined) break;
      liveStepKeys.delete(oldestKey);
    }
  }

  function clearLiveContext(sessionId: string): void {
    for (const [key, ownerSessionId] of liveStepKeys) {
      if (ownerSessionId === sessionId) liveStepKeys.delete(key);
    }
    latestLiveRoutes.delete(sessionId);
    latestLiveCompletedAt.delete(sessionId);
    latestLiveCompletion.delete(sessionId);
    latestUsableLiveCompletion.delete(sessionId);
  }

  function rememberLiveCompletion(sessionId: string, completion: LiveCompletionEvidence): void {
    rememberNewestCompletion(latestLiveCompletion, sessionId, completion);
  }

  function rememberUsableLiveCompletion(
    sessionId: string,
    completion: LiveCompletionEvidence,
  ): void {
    rememberNewestCompletion(latestUsableLiveCompletion, sessionId, completion);
  }

  function rememberNewestCompletion(
    completions: Map<string, LiveCompletionEvidence>,
    sessionId: string,
    completion: LiveCompletionEvidence,
  ): void {
    const previous = completions.get(sessionId);
    if (previous !== undefined && compareLiveCompletion(completion, previous) < 0) return;
    completions.delete(sessionId);
    completions.set(sessionId, completion);
    while (completions.size > CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = completions.keys().next().value;
      if (oldestSessionId === undefined) break;
      completions.delete(oldestSessionId);
    }
  }

  function hasUsableLiveObservation(sessionId: string): boolean {
    const latest = latestLiveCompletion.get(sessionId);
    const usable = latestUsableLiveCompletion.get(sessionId);
    return (
      latest !== undefined &&
      usable !== undefined &&
      latest.messageId === usable.messageId &&
      latest.completedAtMs === usable.completedAtMs
    );
  }

  function ingestHistory(
    invocations: readonly CacheObserverHistoryInvocation[],
    historyOptions: { truncatedSessionIds?: readonly string[] } = {},
  ): void {
    if (disposed) return;
    for (const invocation of invocations) {
      const key = startedStepKey(invocation.sessionId, invocation.messageId);
      const pendingLiveEnd = pendingEndedSteps.get(key);
      const recoveringUnmatchedLiveEnd = pendingLiveEnd !== undefined && !startedSteps.has(key);
      if (liveStepKeys.has(key) && !recoveringUnmatchedLiveEnd) continue;
      const liveCompletedAt = latestLiveCompletedAt.get(invocation.sessionId);
      if (
        !recoveringUnmatchedLiveEnd &&
        liveCompletedAt !== undefined &&
        invocation.completedAtMs >= liveCompletedAt
      ) {
        continue;
      }
      const liveRoute = latestLiveRoutes.get(invocation.sessionId);
      if (
        !recoveringUnmatchedLiveEnd &&
        liveRoute !== undefined &&
        !sameRouteProvenance(liveRoute, invocation.route)
      ) {
        continue;
      }

      const startedEvent: Extract<
        DashboardRpcCacheObserverEvent,
        { type: "session.step.started" }
      > = {
        type: "session.step.started",
        created: invocation.completedAtMs,
        data: {
          sessionID: invocation.sessionId,
          assistantMessageID: invocation.messageId,
          model: {
            providerID: invocation.route.providerId,
            id: invocation.route.modelId,
            ...(invocation.route.variantId === undefined
              ? {}
              : { variant: invocation.route.variantId }),
          },
          ...(invocation.dispatchAtMs === undefined ? {} : { started: invocation.dispatchAtMs }),
        },
      };
      const { fresh, read, write } = invocation.counts;
      const endedEvent: Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }> = {
        type: "session.step.ended",
        created: invocation.completedAtMs,
        data: {
          sessionID: invocation.sessionId,
          assistantMessageID: invocation.messageId,
          tokens: {
            ...(fresh === undefined ? {} : { input: fresh }),
            ...(read === undefined && write === undefined
              ? {}
              : {
                  cache: {
                    ...(read === undefined ? {} : { read }),
                    ...(write === undefined ? {} : { write }),
                  },
                }),
          },
        },
      };
      if (recoveringUnmatchedLiveEnd && pendingLiveEnd !== undefined) {
        pendingEndedSteps.set(key, {
          sessionId: invocation.sessionId,
          event: mergeHistoricalCountersIntoLiveEnd(pendingLiveEnd.event, endedEvent),
        });
        ingestEvent(startedEvent, "history");
        markFreshHistoryIfGapped(invocation.sessionId);
        continue;
      }
      ingestEvent(startedEvent, "history");
      ingestEvent(endedEvent, "history");
      markFreshHistoryIfGapped(invocation.sessionId);
    }

    for (const sessionId of historyOptions.truncatedSessionIds ?? []) {
      const state = states.get(sessionId);
      if (state === undefined || state.invocationsTruncated) continue;
      states.set(sessionId, { ...state, invocationsTruncated: true });
      notify(sessionId);
    }
  }

  function confirmLatestHistory(invocation: CacheObserverHistoryInvocation): void {
    if (disposed) return;
    const sessionId = invocation.sessionId;
    const wasRatioFenced = ratioFencedSessions.has(sessionId);
    const wasObservationGapped = observationGapSessions.has(sessionId);
    if (!wasRatioFenced && !wasObservationGapped) return;
    const state = states.get(sessionId);
    // The estimate follows the newest estimate-qualifying invocation (an
    // established reusable prefix), which exists even when the host reported
    // no usable read counter — ratio availability must not gate recovery.
    const latestQualifyingId =
      state === undefined ? undefined : latestQualifyingInvocationId(state);
    const previous = state?.invocations.find(
      (entry) => entry.order.messageId === invocation.messageId,
    );
    if (
      latestQualifyingId !== invocation.messageId ||
      previous === undefined ||
      previous.order.completedAtMs !== invocation.completedAtMs ||
      !sameRouteProvenance(previous.route, invocation.route) ||
      previous.counts.fresh !== invocation.counts.fresh ||
      previous.counts.read !== invocation.counts.read ||
      previous.counts.write !== invocation.counts.write
    )
      return;
    if (wasRatioFenced) ratioFencedSessions.delete(sessionId);
    // The historical estimate is restored only when the fresh, gap-free read
    // re-confirms the exact latest qualifying invocation — including its
    // request-start timestamp — and that read was merged after the newest
    // gap. Unchecked pre-gap estimates stay hidden.
    if (
      wasObservationGapped &&
      previous.dispatchAtMs !== undefined &&
      previous.dispatchAtMs === invocation.dispatchAtMs &&
      freshHistorySinceGap.has(sessionId)
    ) {
      observationGapSessions.delete(sessionId);
      freshHistorySinceGap.delete(sessionId);
    }
    notify(sessionId);
  }

  function subscribe(sessionId: string, listener: CacheObserverListener): () => void {
    if (disposed || !sessionId.trim()) return () => undefined;
    let sessionListeners = listeners.get(sessionId);
    if (sessionListeners === undefined) {
      sessionListeners = new Set();
      listeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    if (sessionListeners.size === 1) scheduleRecheck(sessionId, query(sessionId));
    return () => {
      sessionListeners?.delete(listener);
      if (sessionListeners?.size === 0) {
        listeners.delete(sessionId);
        clearRecheckTimer(sessionId);
      }
    };
  }

  function dispose(): void {
    disposed = true;
    states.clear();
    listeners.clear();
    startedSteps.clear();
    pendingEndedSteps.clear();
    liveStepKeys.clear();
    latestLiveRoutes.clear();
    latestLiveCompletedAt.clear();
    latestLiveCompletion.clear();
    latestUsableLiveCompletion.clear();
    ratioFencedSessions.clear();
    observationGapSessions.clear();
    freshHistorySinceGap.clear();
    for (const timer of recheckTimers.values()) clearTimeout(timer);
    recheckTimers.clear();
  }

  return {
    query,
    subscribe,
    markObservationGap,
    ingest,
    ingestHistory,
    confirmLatestHistory,
    hasUsableLiveObservation,
    dispose,
  };
}

function projectStartedStep(
  event: unknown,
): Extract<DashboardRpcCacheObserverEvent, { type: "session.step.started" }> | undefined {
  if (
    !isRecord(event) ||
    event.type !== "session.step.started" ||
    !isRecord(event.data) ||
    typeof event.created !== "number" ||
    !Number.isFinite(event.created)
  ) {
    return undefined;
  }

  const sessionId = nonEmptyString(event.data.sessionID);
  const messageId = nonEmptyString(event.data.assistantMessageID);
  const model = isRecord(event.data.model) ? event.data.model : undefined;
  const providerId = model === undefined ? undefined : nonEmptyString(model.providerID);
  const modelId = model === undefined ? undefined : nonEmptyString(model.id);
  if (
    sessionId === undefined ||
    messageId === undefined ||
    providerId === undefined ||
    modelId === undefined
  )
    return undefined;

  const variantId = model === undefined ? undefined : normalizedVariantId(model.variant);
  const dispatchAtMs = ownFiniteNumber(event.data, "started");

  return {
    type: "session.step.started",
    created: event.created,
    data: {
      sessionID: sessionId,
      assistantMessageID: messageId,
      model: {
        providerID: providerId,
        id: modelId,
        ...(variantId === undefined ? {} : { variant: variantId }),
      },
      ...(dispatchAtMs === undefined || dispatchAtMs < 0 ? {} : { started: dispatchAtMs }),
    },
  };
}

function startedStepFromDto(event: unknown): StartedStepEvidence | undefined {
  if (
    !isRecord(event) ||
    event.type !== "session.step.started" ||
    !isRecord(event.data) ||
    !isRecord(event.data.model)
  ) {
    return undefined;
  }
  const sessionId = nonEmptyString(event.data.sessionID);
  const messageId = nonEmptyString(event.data.assistantMessageID);
  const providerId = nonEmptyString(event.data.model.providerID);
  const modelId = nonEmptyString(event.data.model.id);
  if (
    sessionId === undefined ||
    messageId === undefined ||
    providerId === undefined ||
    modelId === undefined
  )
    return undefined;

  const variantId = normalizedVariantId(event.data.model.variant);
  const dispatchAtMs = ownFiniteNumber(event.data, "started");
  const basis: CacheEvidenceBasis = {
    source: "OpenCode session.step.started selected model identity",
    reference: messageId,
  };
  return {
    sessionId,
    messageId,
    route: {
      providerId,
      modelId,
      ...(variantId === undefined ? {} : { variantId }),
      basis,
    },
    ...(dispatchAtMs === undefined || dispatchAtMs < 0 ? {} : { dispatchAtMs }),
  };
}

function startedStepKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}

/**
 * The newest estimate-qualifying invocation's message id — the same
 * established-reusable-prefix predicate classifyCacheObserverState uses for
 * its estimate's latestReuse. Ingestor states never carry compaction
 * boundaries (a compaction resets the whole state), so no boundary filter is
 * applied here.
 */
function latestQualifyingInvocationId(state: CacheObserverState): string | undefined {
  for (let index = state.invocations.length - 1; index >= 0; index -= 1) {
    const entry = state.invocations[index];
    if (isEstablishedReusablePrefix(state.scope.route, entry)) return entry.order.messageId;
  }
  return undefined;
}

function sameRouteProvenance(
  left: CacheRouteProvenance | undefined,
  right: CacheRouteProvenance | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.variantId === right.variantId &&
    left.protocolId === right.protocolId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** OpenCode v2.2.0 `ModelResolver.withVariant` maps `default` to an omitted variant. */
function normalizedVariantId(value: unknown): string | undefined {
  const variantId = nonEmptyString(value);
  return variantId === "default" ? undefined : variantId;
}

function ownFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPositiveFinite(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function ownNonNegativeFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = ownFiniteNumber(record, key);
  return value !== undefined && value >= 0 ? value : undefined;
}

function hasObservedCounts(counts: CacheInvocationObservation["counts"]): boolean {
  return counts.fresh !== undefined || counts.read !== undefined || counts.write !== undefined;
}

function compareLiveCompletion(
  left: LiveCompletionEvidence,
  right: LiveCompletionEvidence,
): number {
  if (left.completedAtMs !== right.completedAtMs) {
    return left.completedAtMs - right.completedAtMs;
  }
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
}

function mergeHistoricalCountersIntoLiveEnd(
  liveEvent: Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }>,
  historyEvent: Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }>,
): Extract<DashboardRpcCacheObserverEvent, { type: "session.step.ended" }> {
  const liveTokens = liveEvent.data.tokens;
  const historyTokens = historyEvent.data.tokens;
  const liveCache = isRecord(liveTokens.cache) ? liveTokens.cache : undefined;
  const historyCache = isRecord(historyTokens.cache) ? historyTokens.cache : undefined;
  const fresh = ownFiniteNumber(liveTokens, "input") ?? ownFiniteNumber(historyTokens, "input");
  const read =
    (liveCache === undefined ? undefined : ownFiniteNumber(liveCache, "read")) ??
    (historyCache === undefined ? undefined : ownFiniteNumber(historyCache, "read"));
  const write =
    (liveCache === undefined ? undefined : ownFiniteNumber(liveCache, "write")) ??
    (historyCache === undefined ? undefined : ownFiniteNumber(historyCache, "write"));

  return {
    type: "session.step.ended",
    created: liveEvent.created,
    data: {
      sessionID: liveEvent.data.sessionID,
      assistantMessageID: liveEvent.data.assistantMessageID,
      tokens: {
        ...(fresh === undefined ? {} : { input: fresh }),
        ...(read === undefined && write === undefined
          ? {}
          : {
              cache: {
                ...(read === undefined ? {} : { read }),
                ...(write === undefined ? {} : { write }),
              },
            }),
      },
    },
  };
}

function eventOrder(
  event: Record<string, unknown>,
  messageId: string | undefined,
): { completedAtMs: number; messageId: string } | undefined {
  if (
    messageId === undefined ||
    typeof event.created !== "number" ||
    !Number.isFinite(event.created)
  ) {
    return undefined;
  }
  return { completedAtMs: event.created, messageId };
}
