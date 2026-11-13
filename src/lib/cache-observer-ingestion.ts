import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import {
  type CacheConfiguredTtlMs,
  type CacheEvidenceBasis,
  type CacheInvocationObservation,
  type CacheObserverClassification,
  type CacheObserverState,
  type CacheRouteProvenance,
  classifyCacheObserverState,
  createCacheObserverState,
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
  configuredTtlMs?: CacheConfiguredTtlMs;
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
  /** The route of the latest retained successful invocation, if correlated. */
  route(sessionId: string): CacheRouteProvenance | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  /**
   * Clears correlation fences at an event-coverage gap. The last observed estimate
   * and cache share persist; only newer evidence replaces them.
   */
  markObservationGap(sessionId: string): void;
  ingest(event: unknown): void;
  /** Merge historical message-list DTOs without allowing them to supersede newer live observations. */
  ingestHistory(invocations: readonly CacheObserverHistoryInvocation[]): void;
  captureConfiguration(
    sessionId: string,
    messageId: string,
  ): (ttl: CacheConfiguredTtlMs | undefined) => void;
  /** True when the newest live completion has exact Started/Ended correlation and counters. */
  hasUsableLiveObservation(sessionId: string): boolean;
  dispose(): void;
}

/**
 * A raw host step.ended is cache evidence only when its finish is successful. Projected
 * DTOs carry no finish, so the ingestor re-reads them through the ungated update function
 * after projection has already applied this same gate.
 */
function isUnsuccessfulStepEnded(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type === "session.step.ended" &&
    isRecord(event.data) &&
    !isEligibleStepFinish(event.data.finish)
  );
}

/**
 * Raw host-event boundary: failed, length-truncated, content-filtered, errored, unknown,
 * and unfinished steps leave the estimate unchanged.
 */
export function cacheObserverUpdateFromRawOpenCodeEvent(
  event: unknown,
): CacheObserverUpdate | undefined {
  if (isUnsuccessfulStepEnded(event)) return undefined;
  return cacheObserverUpdateFromOpenCodeEvent(event);
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
      basis: PRIMARY_STEP_BASIS,
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
  // Only successful steps reach the observer; a failed or incomplete step is dropped here.
  if (isUnsuccessfulStepEnded(event)) return undefined;

  const update = cacheObserverUpdateFromOpenCodeEvent(event);
  if (update === undefined) {
    return projectSessionStatusEvent(event) ?? projectSessionMetadataEvent(event);
  }

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
 * Project the host's authoritative session execution state to the content-free
 * status DTO. `session.status` busy/retry, `session.idle` and the execution
 * lifecycle events are the confirmed busy sources; error details, messages and
 * every other field are neither read nor copied.
 */
function projectSessionStatusEvent(
  event: unknown,
): Extract<DashboardRpcCacheObserverEvent, { type: "session.status" }> | undefined {
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) return undefined;
  if (typeof event.created !== "number" || !Number.isFinite(event.created) || event.created < 0) {
    return undefined;
  }
  const sessionId = nonEmptyString(event.data.sessionID);
  if (sessionId === undefined) return undefined;

  let state: "busy" | "idle";
  if (event.type === "session.status") {
    const status = isRecord(event.data.status) ? event.data.status.type : undefined;
    if (status === "busy" || status === "retry") state = "busy";
    else if (status === "idle") state = "idle";
    else return undefined;
  } else if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
    state = "idle";
  } else if (event.type === "session.execution.started") {
    state = "busy";
  } else if (
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  ) {
    state = "idle";
  } else {
    return undefined;
  }
  return { type: "session.status", created: event.created, data: { sessionID: sessionId, state } };
}

const MAX_RELAYED_TITLE_CODEUNITS = 200;
const MAX_RELAYED_ID_CODEUNITS = 256;

/**
 * A relayed session title: control characters removed, whitespace collapsed,
 * bounded to what the event guard accepts. An empty result omits the field.
 */
function boundedRelayedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = Array.from(value.normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return " ";
    return character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > MAX_RELAYED_TITLE_CODEUNITS
    ? clean.slice(0, MAX_RELAYED_TITLE_CODEUNITS)
    : clean;
}

function boundedRelayedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean || clean.length > MAX_RELAYED_ID_CODEUNITS) return undefined;
  for (const character of clean) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return undefined;
  }
  return clean;
}

/**
 * Project the host's session-identity updates to the content-free metadata
 * DTO: renames carry the new title, model/agent selections their reference.
 * `previous` values and every other field are neither read nor copied.
 */
function projectSessionMetadataEvent(
  event: unknown,
): Extract<DashboardRpcCacheObserverEvent, { type: "session.metadata" }> | undefined {
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) return undefined;
  if (typeof event.created !== "number" || !Number.isFinite(event.created) || event.created < 0) {
    return undefined;
  }
  const sessionId = nonEmptyString(event.data.sessionID);
  if (sessionId === undefined || sessionId.length > MAX_RELAYED_ID_CODEUNITS) return undefined;

  if (event.type === "session.renamed") {
    const title = boundedRelayedTitle(event.data.title);
    return title === undefined
      ? undefined
      : { type: "session.metadata", created: event.created, data: { sessionID: sessionId, title } };
  }
  if (event.type === "session.agent.selected") {
    const agent = boundedRelayedId(event.data.agent);
    return agent === undefined
      ? undefined
      : { type: "session.metadata", created: event.created, data: { sessionID: sessionId, agent } };
  }
  if (event.type === "session.model.selected") {
    const model = isRecord(event.data.model) ? event.data.model : undefined;
    if (model === undefined) return undefined;
    const providerId = boundedRelayedId(model.providerID);
    const modelId = boundedRelayedId(model.id);
    if (providerId === undefined || modelId === undefined) return undefined;
    const variant = boundedRelayedId(model.variant);
    return {
      type: "session.metadata",
      created: event.created,
      data: {
        sessionID: sessionId,
        model: {
          providerID: providerId,
          id: modelId,
          ...(variant === undefined ? {} : { variant }),
        },
      },
    };
  }
  return undefined;
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
  // An unfinished, errored, or incomplete assistant message is not a successful request.
  if (!isEligibleStepFinish(message.finish) || message.error !== undefined) return undefined;
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
    return classifyCacheObserverState(state, now());
  }

  function route(sessionId: string): CacheRouteProvenance | undefined {
    if (!sessionId.trim()) return undefined;
    const observed = states.get(sessionId)?.invocations.at(-1)?.route;
    if (observed === undefined) return undefined;
    return {
      ...observed,
      basis: { ...observed.basis },
    };
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
    // Only the in-flight correlation fences are dropped. The retained estimate and
    // cache share are the last observed evidence, so they persist through the gap.
    clearPendingSteps(sessionId);
    clearLiveContext(sessionId);
  }

  function ingest(event: unknown): void {
    ingestEvent(event, "live");
  }

  function captureConfiguration(sessionId: string, messageId: string) {
    const key = startedStepKey(sessionId, messageId);
    const started = startedSteps.get(key);
    return (ttl: CacheConfiguredTtlMs | undefined): void => {
      if (
        started !== undefined &&
        startedSteps.get(key) === started &&
        (ttl === 300_000 || ttl === 3_600_000)
      )
        started.configuredTtlMs = ttl;
    };
  }

  function ingestEvent(event: unknown, source: "live" | "history"): void {
    if (disposed) return;
    const started = startedStepFromDto(event);
    if (started !== undefined) {
      const key = startedStepKey(started.sessionId, started.messageId);
      if (source === "live") {
        rememberLiveStep(key, started.sessionId);
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
    if (
      state?.scope.route !== undefined &&
      startedEvidence?.route !== undefined &&
      !sameRouteProvenance(state.scope.route, startedEvidence.route) &&
      update.observation.order.completedAtMs >= (state.invocations.at(-1)?.order.completedAtMs ?? 0)
    ) {
      state = createCacheObserverState({ sessionId, route: startedEvidence.route });
    }
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
      ...(startedEvidence?.configuredTtlMs === undefined
        ? {}
        : { configuredTtlMs: startedEvidence.configuredTtlMs }),
    });

    if (!states.has(sessionId) && states.size >= CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = states.keys().next().value;
      if (oldestSessionId !== undefined) {
        states.delete(oldestSessionId);
        clearRecheckTimer(oldestSessionId);
        notify(oldestSessionId);
      }
    }
    states.delete(sessionId);
    states.set(sessionId, state);
    notify(sessionId);
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

  function ingestHistory(invocations: readonly CacheObserverHistoryInvocation[]): void {
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
      const liveRoute =
        liveCompletedAt === undefined ? undefined : states.get(invocation.sessionId)?.scope.route;
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
        continue;
      }
      ingestEvent(startedEvent, "history");
      ingestEvent(endedEvent, "history");
    }
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
    for (const timer of recheckTimers.values()) clearTimeout(timer);
    recheckTimers.clear();
  }

  return {
    query,
    route,
    subscribe,
    markObservationGap,
    ingest,
    ingestHistory,
    captureConfiguration,
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

/**
 * A successful primary request: `stop`, or `tool-calls` handing off to tools.
 * Length-truncated, content-filtered, errored, and unknown finishes are not
 * successful requests and never start a retention estimate.
 */
const ELIGIBLE_STEP_FINISHES: ReadonlySet<unknown> = new Set(["stop", "tool-calls"]);

function isEligibleStepFinish(finish: unknown): boolean {
  return ELIGIBLE_STEP_FINISHES.has(finish);
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
