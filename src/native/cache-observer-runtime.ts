import type { CacheObserverClassification } from "../lib/cache-observer.js";
import {
  type CacheObserverListener,
  cacheObserverUpdateFromOpenCodeEvent,
  createCacheObserverIngestor,
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
  /** One-shot direct-child discovery; it does not start or retain a transport. */
  children(sessionId: string): Promise<NativeCacheObserverChild[]>;
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

/** Fans observer interest into Native's existing shared RPC event subscription. */
export function createNativeCacheObserverRuntime(options: {
  subscribeEvents: (listener: (event: DashboardRpcCacheObserverEvent) => void) => () => void;
  rpcConnection: () => NativeDashboardConnection;
  subscribeRpcConnection?: (listener: (state: NativeDashboardConnection) => void) => () => void;
  subscribeReconnect?: (listener: () => void) => () => void;
  listChildren: (
    parentSessionId: string,
  ) => Promise<ReadonlyArray<{ id: string; parentID?: string; title?: string }>>;
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
  const childWatchers = new Map<string, ChildWatcher>();
  /** Child ownership exists only while an exact parent has active child listeners. */
  const childOwners = new Map<string, string>();
  const transportListeners = new Set<(transport: NativeCacheObserverTransport) => void>();
  let releaseEventListener: (() => void) | undefined;
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
      for (const childSessionId of watcher.children.keys()) {
        if (childOwners.get(childSessionId) === sessionId) childOwners.delete(childSessionId);
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
        setHostEventState(event.data.state, event.created);
        return;
      }
      const update = cacheObserverUpdateFromOpenCodeEvent(event);
      if (update !== undefined) {
        const timestamp = "created" in event ? event.created : undefined;
        setHostEventState(
          "observed",
          typeof timestamp === "number" && Number.isFinite(timestamp)
            ? timestamp
            : (options.now?.() ?? Date.now()),
        );
      }
      if (update === undefined) return;

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
      if (interestedSessions.size === 0 && childWatchers.size === 0) {
        releaseEventListener?.();
        releaseEventListener = undefined;
      }
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    releaseEventListener?.();
    releaseEventListener = undefined;
    interestedSessions.clear();
    childWatchers.clear();
    childOwners.clear();
    transportListeners.clear();
    releaseRpcConnection?.();
    releaseReconnect?.();
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
    children,
    subscribeChildren,
    transport,
    subscribeTransport,
    dispose,
  };
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
