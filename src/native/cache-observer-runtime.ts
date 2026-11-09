import type { CacheObserverClassification } from "../lib/cache-observer.js";
import {
  CACHE_OBSERVER_MAX_SESSIONS,
  type CacheObserverHistoryInvocation,
  type CacheObserverListener,
  cacheObserverUpdateFromOpenCodeEvent,
  createCacheObserverIngestor,
  isCompletedCacheObserverHistoryCompaction,
  projectOpenCodeCacheObserverHistoryMessage,
} from "../lib/cache-observer-ingestion.js";
import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";

export interface NativeCacheObserverChild {
  sessionId: string;
  label: string;
}

export interface NativeCacheObserverChildrenSnapshot {
  status: "loading" | "ready" | "error";
  children: NativeCacheObserverChild[];
}

export type NativeCacheObserverHostEventState =
  | "unverified"
  | "observed"
  | "unavailable"
  | "stopped";

/** RPC reachability and upstream host-event evidence are separate signals. */
export interface NativeCacheObserverTransport {
  rpc: NativeDashboardConnection;
  hostEvents: NativeCacheObserverHostEventState;
  /** Timestamp of the most recent host event received, not a liveness lease. */
  lastHostEventAtMs?: number;
}

export interface NativeCacheObserver {
  query(sessionId: string): CacheObserverClassification | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  /** Notifies exact sessions whose history was invalidated by an observation gap. */
  subscribeGaps(listener: (sessionId: string) => void): () => void;
  /** One-shot direct-child discovery; it does not start or retain a transport. */
  children(sessionId: string): Promise<NativeCacheObserverChild[]>;
  /** Lazily reads selected session history; callers cancel with a signal on selection changes. */
  bootstrapHistory(sessionIds: readonly string[], signal?: AbortSignal): Promise<void>;
  /** Event-driven direct-child snapshot; refreshes after lifecycle events and reconnects. */
  subscribeChildren(
    sessionId: string,
    listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
  ): () => void;
  transport(): NativeCacheObserverTransport;
  subscribeTransport(listener: (transport: NativeCacheObserverTransport) => void): () => void;
}

export interface NativeCacheObserverRuntime extends NativeCacheObserver {
  dispose(): void;
}

type NativeCacheObserverMessageListQuery =
  | { sessionID: string; limit: 200; order: "desc"; cursor?: undefined }
  | { sessionID: string; limit: 200; cursor: string; order?: undefined };

/** Fans observer interest into Native's existing shared RPC event subscription. */
export function createNativeCacheObserverRuntime(options: {
  subscribeEvents: (listener: (event: DashboardRpcCacheObserverEvent) => void) => () => void;
  rpcConnection: () => NativeDashboardConnection;
  subscribeRpcConnection?: (listener: (state: NativeDashboardConnection) => void) => () => void;
  subscribeReconnect?: (listener: () => void) => () => void;
  subscribeEventStreamRetire?: (listener: () => void) => () => void;
  listChildren: (
    parentSessionId: string,
  ) => Promise<ReadonlyArray<{ id: string; parentID?: string; title?: string }>>;
  listMessages?: (
    input: NativeCacheObserverMessageListQuery,
    requestOptions: { signal: AbortSignal },
  ) => Promise<{
    data: ReadonlyArray<unknown>;
    cursor?: { next?: string | null };
  }>;
  now?: () => number;
}): NativeCacheObserverRuntime {
  interface ChildWatcher {
    parentSessionId: string;
    listeners: Set<(snapshot: NativeCacheObserverChildrenSnapshot) => void>;
    children: Map<string, NativeCacheObserverChild>;
    pendingCreatedChildren: Map<string, NativeCacheObserverChild>;
    deletedSessionIds: Set<string>;
    status: NativeCacheObserverChildrenSnapshot["status"];
    refreshVersion: number;
  }

  const ingestor = createCacheObserverIngestor(
    options.now === undefined ? {} : { now: options.now },
  );
  const interestedSessions = new Map<string, number>();
  const historyInterestCounts = new Map<string, number>();
  const pendingObservationGaps = new Set<string>();
  const childWatchers = new Map<string, ChildWatcher>();
  /** Child ownership exists only while an exact parent has active child listeners. */
  const childOwners = new Map<string, string>();
  const transportListeners = new Set<(transport: NativeCacheObserverTransport) => void>();
  const gapListeners = new Set<(sessionId: string) => void>();
  const historyLoadedSessions = new Set<string>();
  const historyEpochs = new Map<string, number>();
  let releaseEventListener: (() => void) | undefined;
  let activeHistoryController: AbortController | undefined;
  let activeHistorySessionIds = new Set<string>();
  let hostEventState: NativeCacheObserverHostEventState = "unverified";
  let lastHostEventAtMs: number | undefined;
  let disposed = false;

  function query(sessionId: string): CacheObserverClassification | undefined {
    return ingestor.query(sessionId);
  }

  function notifyChildren(watcher: ChildWatcher): void {
    const snapshot: NativeCacheObserverChildrenSnapshot = {
      status: watcher.status,
      children: [...watcher.children.values()].map((child) => ({ ...child })),
    };
    for (const listener of Array.from(watcher.listeners)) {
      try {
        listener(snapshot);
      } catch {
        // A child-list consumer cannot interrupt lifecycle-event ingestion.
      }
    }
  }

  function setWatcherChildren(
    watcher: ChildWatcher,
    nextChildren: Map<string, NativeCacheObserverChild>,
  ): boolean {
    const ownedChildren = new Map<string, NativeCacheObserverChild>();
    for (const [sessionId, child] of nextChildren) {
      const owner = childOwners.get(sessionId);
      if (owner !== undefined && owner !== watcher.parentSessionId) continue;
      ownedChildren.set(sessionId, child);
    }

    let changed = watcher.children.size !== ownedChildren.size;
    for (const [sessionId, oldChild] of watcher.children) {
      const nextChild = ownedChildren.get(sessionId);
      if (nextChild?.label === oldChild.label) continue;
      changed = true;
      if (nextChild === undefined && childOwners.get(sessionId) === watcher.parentSessionId) {
        childOwners.delete(sessionId);
        markObservationGapIfUnobserved(sessionId);
      }
    }
    for (const [sessionId, child] of ownedChildren) {
      if (watcher.children.get(sessionId)?.label !== child.label) changed = true;
      childOwners.set(sessionId, watcher.parentSessionId);
    }
    watcher.children = new Map(
      [...ownedChildren.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    return changed;
  }

  function projectChildren(
    parentSessionId: string,
    records: ReadonlyArray<{ id: string; parentID?: string; title?: string }>,
  ): Map<string, NativeCacheObserverChild> {
    const result = new Map<string, NativeCacheObserverChild>();
    for (const record of records) {
      if (record.parentID !== parentSessionId || !isSafeSessionId(record.id)) continue;
      result.set(record.id, {
        sessionId: record.id,
        label: safeChildLabel(record.title),
      });
    }
    return new Map(
      [...result.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }

  function watcherIsCurrent(watcher: ChildWatcher, version: number): boolean {
    return (
      !disposed &&
      childWatchers.get(watcher.parentSessionId) === watcher &&
      watcher.refreshVersion === version
    );
  }

  async function refreshChildren(
    watcher: ChildWatcher,
    refreshOptions: { reconcilePendingCreates?: boolean } = {},
  ): Promise<void> {
    const version = ++watcher.refreshVersion;
    watcher.status = "loading";
    notifyChildren(watcher);
    try {
      const records = await options.listChildren(watcher.parentSessionId);
      if (!watcherIsCurrent(watcher, version)) return;

      const children = projectChildren(watcher.parentSessionId, records);
      const seenIds = new Set(children.keys());
      for (const sessionId of watcher.deletedSessionIds) {
        if (seenIds.has(sessionId)) children.delete(sessionId);
        else watcher.deletedSessionIds.delete(sessionId);
      }
      for (const [sessionId, child] of watcher.pendingCreatedChildren) {
        if (children.has(sessionId)) {
          watcher.pendingCreatedChildren.delete(sessionId);
          continue;
        }
        if (refreshOptions.reconcilePendingCreates) {
          watcher.pendingCreatedChildren.delete(sessionId);
          continue;
        }
        if (!watcher.deletedSessionIds.has(sessionId)) children.set(sessionId, child);
      }

      setWatcherChildren(watcher, children);
      watcher.status = "ready";
      notifyChildren(watcher);
    } catch {
      if (!watcherIsCurrent(watcher, version)) return;
      watcher.status = "error";
      notifyChildren(watcher);
    }
  }

  function updateWatcherChild(
    watcher: ChildWatcher,
    sessionId: string,
    child: NativeCacheObserverChild | undefined,
  ): void {
    const nextChildren = new Map(watcher.children);
    if (child === undefined) nextChildren.delete(sessionId);
    else nextChildren.set(sessionId, child);
    if (setWatcherChildren(watcher, nextChildren)) notifyChildren(watcher);
  }

  function handleChildCreated(sessionId: string, parentSessionId: string | undefined): boolean {
    const knownParent = childOwners.get(sessionId);
    const ownerSessionId = parentSessionId ?? knownParent;
    if (ownerSessionId === undefined) return false;
    const watcher = childWatchers.get(ownerSessionId);
    if (watcher === undefined || !isSafeSessionId(sessionId)) return false;
    if (knownParent !== undefined && knownParent !== ownerSessionId) return false;

    watcher.deletedSessionIds.delete(sessionId);
    const isNewChild = !watcher.children.has(sessionId);
    if (isNewChild) {
      const child = {
        sessionId,
        label: safeChildLabel(undefined),
      };
      watcher.pendingCreatedChildren.set(sessionId, child);
      updateWatcherChild(watcher, sessionId, child);
      void refreshChildren(watcher);
    }
    return true;
  }

  function handleSessionDeleted(sessionId: string): boolean {
    let wasOwnedChild = childOwners.has(sessionId);
    for (const watcher of childWatchers.values()) {
      watcher.pendingCreatedChildren.delete(sessionId);
      // Keep in-flight list responses from resurrecting a just-deleted child.
      if (watcher.parentSessionId !== sessionId && watcher.status === "loading") {
        watcher.deletedSessionIds.add(sessionId);
        if (watcher.deletedSessionIds.size > MAX_CHILD_DELETION_TOMBSTONES) {
          watcher.deletedSessionIds.clear();
          watcher.refreshVersion += 1;
          void refreshChildren(watcher);
        }
      }
      if (watcher.children.has(sessionId)) {
        updateWatcherChild(watcher, sessionId, undefined);
        wasOwnedChild = true;
      }
      if (watcher.parentSessionId === sessionId) {
        watcher.refreshVersion += 1;
        watcher.pendingCreatedChildren.clear();
        setWatcherChildren(watcher, new Map());
        watcher.status = "ready";
        notifyChildren(watcher);
      }
    }
    return wasOwnedChild;
  }

  function transport(): NativeCacheObserverTransport {
    return {
      rpc: options.rpcConnection(),
      hostEvents: hostEventState,
      ...(lastHostEventAtMs === undefined ? {} : { lastHostEventAtMs }),
    };
  }

  function notifyTransport(): void {
    if (transportListeners.size === 0) return;
    const current = transport();
    for (const listener of Array.from(transportListeners)) {
      try {
        listener(current);
      } catch {
        // A transport observer cannot break cache-event delivery.
      }
    }
  }

  function markObservationGapIfUnobserved(sessionId: string): void {
    if (childOwners.has(sessionId)) return;
    const historyCount = historyInterestCounts.get(sessionId) ?? 0;
    const interestCount = interestedSessions.get(sessionId) ?? 0;
    if (historyCount > 0 && interestCount <= historyCount) {
      pendingObservationGaps.add(sessionId);
      return;
    }
    if (interestCount === 0) markObservationGap(sessionId);
  }

  function markObservationGap(sessionId: string): void {
    bumpHistoryEpoch(sessionId, true);
    ingestor.markObservationGap(sessionId);
    if (activeHistorySessionIds.has(sessionId)) activeHistoryController?.abort();
    for (const listener of Array.from(gapListeners)) {
      try {
        listener(sessionId);
      } catch {
        /* A consumer cannot interrupt invalidation. */
      }
    }
  }

  function markActiveObservationGaps(): void {
    const sessionIds = new Set([
      ...interestedSessions.keys(),
      ...childWatchers.keys(),
      ...childOwners.keys(),
    ]);
    for (const sessionId of sessionIds) markObservationGap(sessionId);
  }

  function historyEpoch(sessionId: string): number {
    return historyEpochs.get(sessionId) ?? 0;
  }

  function bumpHistoryEpoch(sessionId: string, invalidateLoadedHistory = false): void {
    historyEpochs.set(sessionId, historyEpoch(sessionId) + 1);
    if (invalidateLoadedHistory) historyLoadedSessions.delete(sessionId);
    trimHistoryEpochs();
  }

  function trimHistoryEpochs(): void {
    while (historyEpochs.size > CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = [...historyEpochs.keys()].find(
        (candidate) =>
          !interestedSessions.has(candidate) &&
          !childWatchers.has(candidate) &&
          !childOwners.has(candidate),
      );
      if (oldestSessionId === undefined) break;
      historyEpochs.delete(oldestSessionId);
    }
  }

  function markHistoryLoaded(sessionId: string): void {
    historyLoadedSessions.delete(sessionId);
    historyLoadedSessions.add(sessionId);
    while (historyLoadedSessions.size > CACHE_OBSERVER_MAX_SESSIONS) {
      const oldestSessionId = historyLoadedSessions.values().next().value;
      if (oldestSessionId === undefined) break;
      historyLoadedSessions.delete(oldestSessionId);
    }
  }

  function releaseHistoryInterests(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const count = interestedSessions.get(sessionId) ?? 0;
      if (count <= 1) interestedSessions.delete(sessionId);
      else interestedSessions.set(sessionId, count - 1);

      const historyCount = historyInterestCounts.get(sessionId) ?? 0;
      if (historyCount <= 1) historyInterestCounts.delete(sessionId);
      else historyInterestCounts.set(sessionId, historyCount - 1);

      if (historyCount <= 1 && pendingObservationGaps.delete(sessionId)) {
        markObservationGapIfUnobserved(sessionId);
      }
    }
    if (interestedSessions.size === 0 && childWatchers.size === 0) {
      releaseEventListener?.();
      releaseEventListener = undefined;
    }
    trimHistoryEpochs();
  }

  async function bootstrapHistory(
    requestedSessionIds: readonly string[],
    callerSignal?: AbortSignal,
  ): Promise<void> {
    if (disposed) throw new Error("Cache observer runtime is closed");
    const sessionIds = [...new Set(requestedSessionIds)];
    for (const sessionId of sessionIds) {
      if (!isSafeSessionId(sessionId)) throw new TypeError("Invalid session id");
    }
    if (sessionIds.length > 0 && options.listMessages === undefined) {
      throw new Error("Historical cache observer is unavailable");
    }

    activeHistoryController?.abort();
    if (sessionIds.length === 0) return;
    const controller = new AbortController();
    activeHistoryController = controller;
    activeHistorySessionIds = new Set(sessionIds);
    const abortForCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", abortForCaller, { once: true });

    for (const sessionId of sessionIds) {
      interestedSessions.set(sessionId, (interestedSessions.get(sessionId) ?? 0) + 1);
      historyInterestCounts.set(sessionId, (historyInterestCounts.get(sessionId) ?? 0) + 1);
    }
    attachEventListener();
    const initialEpochs = new Map(
      sessionIds.map((sessionId) => [sessionId, historyEpoch(sessionId)]),
    );

    try {
      for (const sessionId of sessionIds) {
        throwIfAborted(controller.signal);
        const expectedEpoch = initialEpochs.get(sessionId) ?? 0;
        if (
          historyLoadedSessions.has(sessionId) ||
          historyEpoch(sessionId) !== expectedEpoch ||
          ingestor.hasUsableLiveObservation(sessionId)
        ) {
          continue;
        }
        const history: CacheObserverHistoryInvocation[] = [];
        const seenCursors = new Set<string>();
        let stopPagination = false;
        let cursor: string | undefined;

        while (true) {
          throwIfAborted(controller.signal);
          if (
            historyEpoch(sessionId) !== expectedEpoch ||
            ingestor.hasUsableLiveObservation(sessionId)
          ) {
            break;
          }
          const page = await awaitWithAbort(
            options.listMessages!(
              {
                sessionID: sessionId,
                limit: 200,
                ...(cursor === undefined ? { order: "desc" as const } : { cursor }),
              },
              { signal: controller.signal },
            ),
            controller.signal,
          );
          throwIfAborted(controller.signal);
          if (historyEpoch(sessionId) !== expectedEpoch) break;
          if (!Array.isArray(page.data)) throw new TypeError("Invalid message.list response");

          for (const message of page.data) {
            if (isCompletedCacheObserverHistoryCompaction(message)) {
              stopPagination = true;
              break;
            }
            const projected = projectOpenCodeCacheObserverHistoryMessage(sessionId, message);
            if (projected === undefined) continue;
            history.push(projected);
            stopPagination = true;
            break;
          }
          if (stopPagination) break;

          const nextCursor = page.cursor?.next;
          if (nextCursor === undefined || nextCursor === null || nextCursor === "") break;
          if (typeof nextCursor !== "string") throw new TypeError("Invalid message.list cursor");
          if (seenCursors.has(nextCursor)) throw new Error("Repeated message.list cursor");
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        throwIfAborted(controller.signal);
        if (historyEpoch(sessionId) !== expectedEpoch) continue;
        ingestor.ingestHistory(history);
        throwIfAborted(controller.signal);
        if (historyEpoch(sessionId) !== expectedEpoch) continue;
        // This is the first completed assistant after the newest compaction
        // boundary, fetched with the same epoch throughout pagination.
        if (history[0] !== undefined) ingestor.confirmLatestHistory(history[0]);
        markHistoryLoaded(sessionId);
      }
    } finally {
      callerSignal?.removeEventListener("abort", abortForCaller);
      releaseHistoryInterests(sessionIds);
      if (activeHistoryController === controller) {
        activeHistoryController = undefined;
        activeHistorySessionIds.clear();
      }
    }
  }

  function setHostEventState(state: NativeCacheObserverHostEventState, atMs?: number): void {
    const nextAt =
      state === "observed" && typeof atMs === "number" && Number.isFinite(atMs) && atMs >= 0
        ? Math.max(lastHostEventAtMs ?? 0, atMs)
        : lastHostEventAtMs;
    if (hostEventState === state && lastHostEventAtMs === nextAt) return;
    hostEventState = state;
    lastHostEventAtMs = nextAt;
    notifyTransport();
  }

  let initialTransportReady = options.rpcConnection() === "live";
  const releaseRpcConnection = options.subscribeRpcConnection?.((state) => {
    if (state === "reconnecting" || state === "closed") markActiveObservationGaps();
    notifyTransport();
    if (state !== "live" || initialTransportReady) return;
    initialTransportReady = true;
    for (const watcher of childWatchers.values()) void refreshChildren(watcher);
  });
  const releaseReconnect = options.subscribeReconnect?.(() => {
    for (const watcher of childWatchers.values()) {
      void refreshChildren(watcher, { reconcilePendingCreates: true });
    }
  });
  const releaseEventStreamRetire = options.subscribeEventStreamRetire?.(markActiveObservationGaps);

  async function children(sessionId: string): Promise<NativeCacheObserverChild[]> {
    if (disposed) throw new Error("Cache observer runtime is closed");
    if (!isSafeSessionId(sessionId)) throw new TypeError("Invalid parent session id");

    const records = await options.listChildren(sessionId);
    return [...projectChildren(sessionId, records).values()];
  }

  function subscribeChildren(
    sessionId: string,
    listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
  ): () => void {
    if (disposed) return () => undefined;
    if (!isSafeSessionId(sessionId)) throw new TypeError("Invalid parent session id");

    let watcher = childWatchers.get(sessionId);
    const isNewWatcher = watcher === undefined;
    if (watcher === undefined) {
      watcher = {
        parentSessionId: sessionId,
        listeners: new Set(),
        children: new Map(),
        pendingCreatedChildren: new Map(),
        deletedSessionIds: new Set(),
        status: "loading",
        refreshVersion: 0,
      };
      childWatchers.set(sessionId, watcher);
    }
    watcher.listeners.add(listener);
    if (!isNewWatcher) {
      try {
        listener({
          status: watcher.status,
          children: [...watcher.children.values()].map((child) => ({ ...child })),
        });
      } catch {
        // A child-list consumer cannot interrupt discovery.
      }
    }
    if (isNewWatcher) {
      attachEventListener();
      void refreshChildren(watcher);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      watcher?.listeners.delete(listener);
      if (watcher?.listeners.size !== 0) return;
      watcher.refreshVersion += 1;
      childWatchers.delete(sessionId);
      markObservationGapIfUnobserved(sessionId);
      for (const childSessionId of watcher.children.keys()) {
        if (childOwners.get(childSessionId) === sessionId) {
          childOwners.delete(childSessionId);
          markObservationGapIfUnobserved(childSessionId);
        }
      }
      watcher.children.clear();
      watcher.pendingCreatedChildren.clear();
      if (interestedSessions.size === 0 && childWatchers.size === 0) {
        releaseEventListener?.();
        releaseEventListener = undefined;
      }
    };
  }

  function attachEventListener(): void {
    if (
      disposed ||
      releaseEventListener !== undefined ||
      (interestedSessions.size === 0 && childWatchers.size === 0)
    ) {
      return;
    }
    releaseEventListener = options.subscribeEvents((event) => {
      if (event.type === "source.status") {
        if (event.data.state !== "observed") markActiveObservationGaps();
        setHostEventState(event.data.state, event.created);
        return;
      }
      const update = cacheObserverUpdateFromOpenCodeEvent(event);
      const startedSessionId =
        event.type === "session.step.started" ? event.data.sessionID : undefined;
      if (startedSessionId !== undefined) bumpHistoryEpoch(startedSessionId);
      if (update?.kind === "invocation") {
        bumpHistoryEpoch(update.observation.sessionId);
      } else if (update?.kind === "compaction" || update?.kind === "deleted") {
        bumpHistoryEpoch(update.sessionId, true);
      }
      if (update !== undefined || startedSessionId !== undefined) {
        const timestamp = "created" in event ? event.created : undefined;
        setHostEventState(
          "observed",
          typeof timestamp === "number" && Number.isFinite(timestamp)
            ? timestamp
            : (options.now?.() ?? Date.now()),
        );
      }
      if (update === undefined) {
        if (startedSessionId === undefined) return;
        if (!interestedSessions.has(startedSessionId) && !childOwners.has(startedSessionId)) return;
        ingestor.ingest(event);
        return;
      }

      let isOwnedChild = false;
      if (update.kind === "created") {
        isOwnedChild = handleChildCreated(update.sessionId, update.parentSessionId);
      } else if (update.kind === "forked") {
        isOwnedChild = handleChildCreated(update.sessionId, update.parentSessionId);
      } else if (update.kind === "deleted") {
        isOwnedChild = handleSessionDeleted(update.sessionId);
      }

      const sessionId =
        update.kind === "invocation" ? update.observation.sessionId : update.sessionId;
      if (!interestedSessions.has(sessionId) && !childOwners.has(sessionId) && !isOwnedChild)
        return;
      ingestor.ingest(event);
    });
  }

  function subscribe(sessionId: string, listener: CacheObserverListener): () => void {
    if (disposed || !sessionId.trim()) return () => undefined;

    interestedSessions.set(sessionId, (interestedSessions.get(sessionId) ?? 0) + 1);
    const releaseIngestor = ingestor.subscribe(sessionId, listener);
    attachEventListener();
    let released = false;

    return () => {
      if (released) return;
      released = true;
      releaseIngestor();
      const count = interestedSessions.get(sessionId) ?? 0;
      if (count <= 1) interestedSessions.delete(sessionId);
      else interestedSessions.set(sessionId, count - 1);
      const historyCount = historyInterestCounts.get(sessionId) ?? 0;
      if (childOwners.has(sessionId)) {
        pendingObservationGaps.delete(sessionId);
      } else if (historyCount > 0 && (interestedSessions.get(sessionId) ?? 0) <= historyCount) {
        pendingObservationGaps.add(sessionId);
      } else {
        markObservationGapIfUnobserved(sessionId);
      }
      if (interestedSessions.size === 0 && childWatchers.size === 0) {
        releaseEventListener?.();
        releaseEventListener = undefined;
      }
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    activeHistoryController?.abort();
    activeHistoryController = undefined;
    activeHistorySessionIds.clear();
    releaseEventListener?.();
    releaseEventListener = undefined;
    interestedSessions.clear();
    historyInterestCounts.clear();
    pendingObservationGaps.clear();
    childWatchers.clear();
    childOwners.clear();
    historyLoadedSessions.clear();
    historyEpochs.clear();
    transportListeners.clear();
    gapListeners.clear();
    releaseRpcConnection?.();
    releaseReconnect?.();
    releaseEventStreamRetire?.();
    ingestor.dispose();
  }

  function subscribeTransport(
    listener: (transport: NativeCacheObserverTransport) => void,
  ): () => void {
    if (disposed) return () => undefined;
    transportListeners.add(listener);
    try {
      listener(transport());
    } catch {
      // A transport observer cannot break cache-event delivery.
    }
    return () => transportListeners.delete(listener);
  }

  return {
    query,
    subscribe,
    subscribeGaps(listener) {
      if (disposed) return () => {};
      gapListeners.add(listener);
      return () => gapListeners.delete(listener);
    },
    children,
    bootstrapHistory,
    subscribeChildren,
    transport,
    subscribeTransport,
    dispose,
  };
}

function abortError(): Error {
  const error = new Error("Historical cache observer request was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const MAX_SESSION_LABEL_CODEPOINTS = 80;
const MAX_CHILD_DELETION_TOMBSTONES = 128;

function isSafeSessionId(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function isSessionLabelFormatCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

function safeChildLabel(title: string | undefined): string {
  const normalized = Array.from((title ?? "").normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return " ";
    if (isSessionLabelFormatCharacter(codePoint)) return "";
    return character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "Untitled child session";
  const codepoints = Array.from(normalized);
  return codepoints.length > MAX_SESSION_LABEL_CODEPOINTS
    ? `${codepoints.slice(0, MAX_SESSION_LABEL_CODEPOINTS - 1).join("")}…`
    : normalized;
}
