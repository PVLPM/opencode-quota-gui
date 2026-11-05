import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import {
  type CacheEvidenceBasis,
  type CacheInvocationObservation,
  type CacheObserverClassification,
  type CacheObserverState,
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

/** Read-only query/subscription seam; each id is an exact session, never a tree aggregate. */
export interface CacheObserverIngestor {
  query(sessionId: string): CacheObserverClassification | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  ingest(event: unknown): void;
  dispose(): void;
}

/**
 * Only a completed assistant step proves a message-level invocation. The host
 * does not prove that it was primary or supply route/TTL/invalidation evidence,
 * so those remain unknown. Session usage aggregates are not invocation data.
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
  const fresh = ownFiniteNumber(tokens, "input");
  const read = cache === undefined ? undefined : ownFiniteNumber(cache, "read");
  const write = cache === undefined ? undefined : ownFiniteNumber(cache, "write");
  const counts: CacheInvocationObservation["counts"] = {
    ...(fresh === undefined ? {} : { fresh }),
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  };
  const basis = eventBasis("session.step.ended", order.messageId);

  return {
    kind: "invocation",
    observation: {
      sessionId,
      order,
      primaryClassification: { kind: "unknown", basis },
      counts,
    },
  };
}

/** Strip an OpenCode event to the content-free DTO carried on Native's shared RPC stream. */
export function projectOpenCodeCacheObserverEvent(
  event: unknown,
): DashboardRpcCacheObserverEvent | undefined {
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
  let disposed = false;

  function query(sessionId: string): CacheObserverClassification | undefined {
    if (!sessionId.trim()) return undefined;
    const state = states.get(sessionId);
    if (state !== undefined) {
      states.delete(sessionId);
      states.set(sessionId, state);
    }
    return state === undefined ? undefined : classifyCacheObserverState(state, now());
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

  function ingest(event: unknown): void {
    if (disposed) return;
    const update = cacheObserverUpdateFromOpenCodeEvent(event);
    if (update === undefined) return;

    if (update.kind === "created") return;

    if (update.kind !== "invocation") {
      if (states.delete(update.sessionId)) notify(update.sessionId);
      return;
    }

    const sessionId = update.observation.sessionId;
    let state = states.get(sessionId) ?? createCacheObserverState({ sessionId });
    if (
      state.invocations.some(
        (entry) => entry.order.messageId === update.observation.order.messageId,
      )
    ) {
      return;
    }
    state = observeCacheInvocation(state, update.observation);
    if (!states.has(sessionId) && states.size >= CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = states.keys().next().value;
      if (oldestSessionId !== undefined) {
        states.delete(oldestSessionId);
        notify(oldestSessionId);
      }
    }
    states.delete(sessionId);
    states.set(sessionId, state);
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
  }

  return { query, subscribe, ingest, dispose };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

function eventBasis(type: string, reference: string): CacheEvidenceBasis {
  return { source: `OpenCode event ${type}`, reference };
}
