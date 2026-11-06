import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import {
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
  route?: CacheRouteProvenance;
}

/** Read-only query/subscription seam; each id is an exact session, never a tree aggregate. */
export interface CacheObserverIngestor {
  query(sessionId: string): CacheObserverClassification | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  /** Hide the reported ratio until this exact session yields a new qualifying primary end. */
  markObservationGap(sessionId: string): void;
  ingest(event: unknown): void;
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

export function createCacheObserverIngestor(
  options: { now?: () => number } = {},
): CacheObserverIngestor {
  const now = options.now ?? Date.now;
  const states = new Map<string, CacheObserverState>();
  const listeners = new Map<string, Set<CacheObserverListener>>();
  const startedSteps = new Map<string, StartedStepEvidence>();
  const ratioFencedSessions = new Set<string>();
  let disposed = false;

  function query(sessionId: string): CacheObserverClassification | undefined {
    if (!sessionId.trim()) return undefined;
    const state = states.get(sessionId);
    if (state !== undefined) {
      states.delete(sessionId);
      states.set(sessionId, state);
    }
    if (state === undefined) return undefined;
    const classification = classifyCacheObserverState(state, now());
    if (!ratioFencedSessions.has(sessionId) || classification.primaryCacheReadRatio === undefined) {
      return classification;
    }
    const { primaryCacheReadRatio: _fencedRatio, ...lastObservedClassification } = classification;
    return lastObservedClassification;
  }

  function notify(sessionId: string): void {
    const classification = query(sessionId);
    for (const listener of Array.from(listeners.get(sessionId) ?? [])) {
      try {
        listener(classification);
      } catch {
        // A consumer failure must not interrupt host-event ingestion.
      }
    }
  }

  function clearStartedSteps(sessionId: string): void {
    for (const [key, started] of startedSteps) {
      if (started.sessionId === sessionId) startedSteps.delete(key);
    }
  }

  function markObservationGap(sessionId: string): void {
    if (disposed || !sessionId.trim() || !states.has(sessionId)) return;
    ratioFencedSessions.add(sessionId);
    notify(sessionId);
  }

  function ingest(event: unknown): void {
    if (disposed) return;
    const started = startedStepFromDto(event);
    if (started !== undefined) {
      const state = states.get(started.sessionId);
      if (
        state?.scope.route !== undefined &&
        started.route !== undefined &&
        !sameRouteProvenance(state.scope.route, started.route)
      ) {
        // A changed selected provider/model/variant starts a new evidence epoch. The Started
        // model identity is not proof of the effective HTTP route or protocol.
        clearStartedSteps(started.sessionId);
        states.delete(started.sessionId);
        ratioFencedSessions.delete(started.sessionId);
        states.set(
          started.sessionId,
          createCacheObserverState({ sessionId: started.sessionId, route: started.route }),
        );
        notify(started.sessionId);
      }
      const key = startedStepKey(started.sessionId, started.messageId);
      startedSteps.delete(key);
      startedSteps.set(key, started);
      while (startedSteps.size > CACHE_OBSERVER_MAX_STARTED_STEPS) {
        const oldestKey = startedSteps.keys().next().value;
        if (oldestKey === undefined) break;
        startedSteps.delete(oldestKey);
      }
      return;
    }

    const update = cacheObserverUpdateFromOpenCodeEvent(event);
    if (update === undefined) return;

    if (update.kind === "created") {
      clearStartedSteps(update.sessionId);
      return;
    }

    if (update.kind !== "invocation") {
      clearStartedSteps(update.sessionId);
      ratioFencedSessions.delete(update.sessionId);
      if (states.delete(update.sessionId)) notify(update.sessionId);
      return;
    }

    const sessionId = update.observation.sessionId;
    const startedKey = startedStepKey(sessionId, update.observation.order.messageId);
    const startedEvidence = startedSteps.get(startedKey);
    startedSteps.delete(startedKey);

    let state = states.get(sessionId);
    if (state === undefined) {
      state = createCacheObserverState({
        sessionId,
        ...(startedEvidence?.route === undefined ? {} : { route: startedEvidence.route }),
      });
    } else if (state.scope.route === undefined && startedEvidence?.route !== undefined) {
      state = { ...state, scope: { ...state.scope, route: startedEvidence.route } };
    }

    if (
      state.invocations.some(
        (entry) => entry.order.messageId === update.observation.order.messageId,
      )
    ) {
      return;
    }

    const observation = update.observation;
    const matchedRoute =
      startedEvidence?.route !== undefined &&
      sameRouteProvenance(state.scope.route, startedEvidence.route)
        ? startedEvidence.route
        : undefined;
    state = observeCacheInvocation(state, {
      ...observation,
      ...(matchedRoute === undefined ? {} : { route: matchedRoute }),
    });

    if (!states.has(sessionId) && states.size >= CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = states.keys().next().value;
      if (oldestSessionId !== undefined) {
        states.delete(oldestSessionId);
        ratioFencedSessions.delete(oldestSessionId);
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

  function subscribe(sessionId: string, listener: CacheObserverListener): () => void {
    if (disposed || !sessionId.trim()) return () => undefined;
    let sessionListeners = listeners.get(sessionId);
    if (sessionListeners === undefined) {
      sessionListeners = new Set();
      listeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    return () => {
      sessionListeners?.delete(listener);
      if (sessionListeners?.size === 0) {
        listeners.delete(sessionId);
      }
    };
  }

  function dispose(): void {
    disposed = true;
    states.clear();
    listeners.clear();
    startedSteps.clear();
    ratioFencedSessions.clear();
  }

  return { query, subscribe, markObservationGap, ingest, dispose };
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
