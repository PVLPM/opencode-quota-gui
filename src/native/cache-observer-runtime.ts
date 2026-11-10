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

export interface NativeCacheObserverChildModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface NativeCacheObserverChild {
  sessionId: string;
  label: string;
}

/**
 * Public session-identity metadata for any watched session (the selected
 * session and its children), from `session.get`/`session.list` records and
 * narrow `session.renamed`/`session.agent.selected`/`session.model.selected`
 * update events. Display data only; no message or credential content.
 */
export interface NativeCacheObserverSessionMeta {
  title?: string;
  agent?: string;
  model?: NativeCacheObserverChildModel;
  /** Public `time.created`; a recency fallback only, never a cache claim. */
  createdAtMs?: number;
  /** Maximum host timestamp observed for identity updates or session activity. */
  updatedAtMs?: number;
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

export type NativeCacheObserverSessionStatus = "busy" | "idle" | "unknown";

export interface NativeCacheObserver {
  query(sessionId: string): CacheObserverClassification | undefined;
  subscribe(sessionId: string, listener: CacheObserverListener): () => void;
  /**
   * The session's execution state from confirmed host evidence only: relayed
   * status/idle/execution events and `session.active` reconciliation.
   * `"unknown"` means no confirmed evidence has arrived yet.
   */
  status(sessionId: string): NativeCacheObserverSessionStatus;
  /**
   * The session's public identity metadata (title, agent, model, activity
   * timestamps), kept current from records and update events. Undefined when
   * nothing authoritative has arrived for this session yet.
   */
  metadata(sessionId: string): NativeCacheObserverSessionMeta | undefined;
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
  listChildren: (parentSessionId: string) => Promise<
    ReadonlyArray<{
      id: string;
      parentID?: string;
      title?: string;
      agent?: string;
      model?: NativeCacheObserverChildModel;
      timeCreatedMs?: number;
      timeUpdatedMs?: number;
    }>
  >;
  /**
   * One-shot authoritative busy snapshot from the public `session.active` RPC,
   * used to reconcile status on (re)connect. Never polled.
   */
  listActiveSessions?: () => Promise<ReadonlyArray<string>>;
  /**
   * One-shot public `session.get` projection used to seed (on first interest)
   * and refresh (after reconnect) a watched session's identity metadata.
   */
  getSessionMetadata?: (
    sessionId: string,
    requestOptions: { signal: AbortSignal },
  ) => Promise<{
    title?: string;
    agent?: string;
    model?: NativeCacheObserverChildModel;
    timeCreatedMs?: number;
    timeUpdatedMs?: number;
  }>;
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
  /** The cache listeners this runtime installed, so confirmed status changes reach them. */
  const ingestorListeners = new Map<string, Set<CacheObserverListener>>();
  /** Confirmed execution state, tracked only for sessions a consumer observes. */
  const sessionStatuses = new Map<string, Exclude<NativeCacheObserverSessionStatus, "unknown">>();
  /**
   * Per-session clock of received status-affecting events. A reconciliation
   * snapshot captured at revision N may not overwrite a session whose clock
   * has moved past N: the live event is the newer evidence.
   */
  const statusEventRevisions = new Map<string, number>();
  /** Public identity metadata, tracked only for sessions a consumer observes. */
  const sessionMetas = new Map<string, NativeCacheObserverSessionMeta>();
  type SessionMetaField = "title" | "agent" | "model";
  type SessionMetaFieldTimes = Partial<Record<SessionMetaField, number>>;
  type SessionMetaFieldRevisions = Record<SessionMetaField, number>;
  /** Identity-event ordering is tracked per field, independently of activity. */
  const sessionMetaFieldUpdatedAtMs = new Map<string, SessionMetaFieldTimes>();
  const sessionMetaFieldRevisions = new Map<string, SessionMetaFieldRevisions>();
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

  function status(sessionId: string): NativeCacheObserverSessionStatus {
    return sessionStatuses.get(sessionId) ?? "unknown";
  }

  function metadata(sessionId: string): NativeCacheObserverSessionMeta | undefined {
    return sessionMetas.get(sessionId);
  }

  function sessionMetaRevisionSnapshot(sessionId: string): SessionMetaFieldRevisions {
    const current = sessionMetaFieldRevisions.get(sessionId);
    return {
      title: current?.title ?? 0,
      agent: current?.agent ?? 0,
      model: current?.model ?? 0,
    };
  }

  function noteSessionMetaFieldUpdate(
    sessionId: string,
    field: SessionMetaField,
    atMs: number | undefined,
  ): void {
    const revisions = sessionMetaFieldRevisions.get(sessionId) ?? {
      title: 0,
      agent: 0,
      model: 0,
    };
    revisions[field] += 1;
    sessionMetaFieldRevisions.set(sessionId, revisions);
    if (atMs === undefined) return;
    const times = sessionMetaFieldUpdatedAtMs.get(sessionId) ?? {};
    times[field] = Math.max(times[field] ?? atMs, atMs);
    sessionMetaFieldUpdatedAtMs.set(sessionId, times);
  }

  function clearSessionMetaFreshness(sessionId: string): void {
    sessionMetaFieldUpdatedAtMs.delete(sessionId);
    sessionMetaFieldRevisions.delete(sessionId);
  }

  /** The sessions this runtime currently observes at all. */
  function watchedSessions(): Set<string> {
    return new Set([...ingestorListeners.keys(), ...childWatchers.keys(), ...childOwners.keys()]);
  }

  function isWatched(sessionId: string): boolean {
    return (
      ingestorListeners.has(sessionId) || childWatchers.has(sessionId) || childOwners.has(sessionId)
    );
  }

  /**
   * Bumps the session's status-event clock: live evidence newer than any
   * reconciliation snapshot captured before this point.
   */
  function bumpStatusEventRevision(sessionId: string): void {
    statusEventRevisions.set(sessionId, (statusEventRevisions.get(sessionId) ?? 0) + 1);
  }

  /**
   * Notifies the exact session's consumers after a confirmed status or
   * metadata change. Consumers re-read `status()`/`metadata()`; the
   * notification only marks the change.
   */
  function notifyConsumers(sessionId: string): void {
    const sessionListeners = ingestorListeners.get(sessionId);
    if (sessionListeners === undefined || sessionListeners.size === 0) return;
    const snapshot = ingestor.query(sessionId);
    for (const listener of Array.from(sessionListeners)) {
      try {
        listener(snapshot);
      } catch {
        // A consumer failure cannot interrupt status tracking.
      }
    }
  }

  function setSessionStatus(
    sessionId: string,
    value: Exclude<NativeCacheObserverSessionStatus, "unknown">,
  ): void {
    if (sessionStatuses.get(sessionId) === value) return;
    sessionStatuses.set(sessionId, value);
    notifyConsumers(sessionId);
  }

  /** A bounded, printable host identity string: control characters become spaces. */
  function safeMetaText(value: string | undefined): string | undefined {
    if (value === undefined || value.length === 0 || value.length > MAX_HOST_TEXT_CODEPOINTS) {
      return undefined;
    }
    const clean = Array.from(value.normalize("NFC"), (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return " ";
      if (isSessionLabelFormatCharacter(codePoint)) return "";
      return character;
    })
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    return clean || undefined;
  }

  function safeMetaModel(
    model: NativeCacheObserverChildModel | undefined,
  ): NativeCacheObserverChildModel | undefined {
    if (model === undefined) return undefined;
    const providerID = safeMetaText(model.providerID);
    const id = safeMetaText(model.id);
    if (providerID === undefined || id === undefined) return undefined;
    const variant = safeMetaText(model.variant);
    return { providerID, id, ...(variant === undefined ? {} : { variant }) };
  }

  /**
   * Applies an authoritative record (`session.get`/`session.list`) field by
   * field. A field event that arrived after this read began wins; otherwise
   * each field is ordered against its own host timestamp, not activity.
   */
  function applySessionMetaRecord(
    sessionId: string,
    record: {
      title?: string;
      agent?: string;
      model?: NativeCacheObserverChildModel;
      timeCreatedMs?: number;
      timeUpdatedMs?: number;
    },
    fieldRevisionsAtStart?: SessionMetaFieldRevisions,
  ): boolean {
    const existing = sessionMetas.get(sessionId);
    const atMs = isNonNegativeFinite(record.timeUpdatedMs) ? record.timeUpdatedMs : undefined;
    if (existing !== undefined) {
      // An unorderable record cannot be known to supersede stored evidence.
      if (atMs === undefined) return false;
    }
    const next: NativeCacheObserverSessionMeta = {
      ...existing,
      ...(atMs === undefined ? {} : { updatedAtMs: Math.max(existing?.updatedAtMs ?? atMs, atMs) }),
    };
    if (isNonNegativeFinite(record.timeCreatedMs)) next.createdAtMs = record.timeCreatedMs;
    else delete next.createdAtMs;

    const fieldTimes = sessionMetaFieldUpdatedAtMs.get(sessionId);
    const fieldRevisions = sessionMetaRevisionSnapshot(sessionId);
    const canApplyField = (field: SessionMetaField): boolean => {
      if (
        fieldRevisionsAtStart !== undefined &&
        fieldRevisions[field] !== fieldRevisionsAtStart[field]
      ) {
        return false;
      }
      const fieldUpdatedAtMs = fieldTimes?.[field];
      return atMs === undefined
        ? fieldUpdatedAtMs === undefined
        : fieldUpdatedAtMs === undefined || atMs >= fieldUpdatedAtMs;
    };

    const title = safeMetaText(record.title);
    if (canApplyField("title")) {
      if (title === undefined) delete next.title;
      else next.title = title;
      noteSessionMetaFieldUpdate(sessionId, "title", atMs);
    }
    const agent = safeMetaText(record.agent);
    if (canApplyField("agent")) {
      if (agent === undefined) delete next.agent;
      else next.agent = agent;
      noteSessionMetaFieldUpdate(sessionId, "agent", atMs);
    }
    const model = safeMetaModel(record.model);
    if (canApplyField("model")) {
      if (model === undefined) delete next.model;
      else next.model = model;
      noteSessionMetaFieldUpdate(sessionId, "model", atMs);
    }
    const changed =
      existing === undefined ||
      existing.title !== next.title ||
      existing.agent !== next.agent ||
      existing.model?.providerID !== next.model?.providerID ||
      existing.model?.id !== next.model?.id ||
      existing.model?.variant !== next.model?.variant ||
      existing.createdAtMs !== next.createdAtMs ||
      existing.updatedAtMs !== next.updatedAtMs;
    sessionMetas.set(sessionId, next);
    return changed;
  }

  /**
   * Advances a watched session's activity recency from a host event timestamp.
   * Only existing identity is dated — an activity event never fabricates a
   * metadata entry (that would block the record seed) and never regresses.
   */
  function advanceSessionActivity(sessionId: string, atMs: number | undefined): void {
    if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) return;
    const existing = sessionMetas.get(sessionId);
    if (existing === undefined) return;
    const current = existing.updatedAtMs;
    if (current !== undefined && atMs <= current) return;
    sessionMetas.set(sessionId, { ...existing, updatedAtMs: atMs });
    notifyConsumers(sessionId);
  }

  /**
   * Applies one narrow update event: only the fields it carries change, and
   * its host timestamp dates identity and activity. Staleness is checked per
   * field so an event for one field cannot block an unrelated field update.
   */
  function applySessionMetaPatch(
    sessionId: string,
    patch: { title?: string; agent?: string; model?: NativeCacheObserverChildModel },
    atMs: number,
  ): boolean {
    if (!Number.isFinite(atMs) || atMs < 0) return false;
    const existing = sessionMetas.get(sessionId);
    const next: NativeCacheObserverSessionMeta = {
      ...existing,
      updatedAtMs: Math.max(existing?.updatedAtMs ?? atMs, atMs),
    };
    const title = safeMetaText(patch.title);
    const fieldTimes = sessionMetaFieldUpdatedAtMs.get(sessionId);
    let changed = false;
    if (title !== undefined && (fieldTimes?.title === undefined || atMs >= fieldTimes.title)) {
      next.title = title;
      noteSessionMetaFieldUpdate(sessionId, "title", atMs);
      changed = true;
    }
    const agent = safeMetaText(patch.agent);
    if (agent !== undefined && (fieldTimes?.agent === undefined || atMs >= fieldTimes.agent)) {
      next.agent = agent;
      noteSessionMetaFieldUpdate(sessionId, "agent", atMs);
      changed = true;
    }
    const model = safeMetaModel(patch.model);
    if (model !== undefined && (fieldTimes?.model === undefined || atMs >= fieldTimes.model)) {
      next.model = model;
      noteSessionMetaFieldUpdate(sessionId, "model", atMs);
      changed = true;
    }
    if (!changed) return false;
    sessionMetas.set(sessionId, next);
    return true;
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
      if (nextChild !== undefined && nextChild.label === oldChild.label) continue;
      changed = true;
      if (nextChild === undefined && childOwners.get(sessionId) === watcher.parentSessionId) {
        childOwners.delete(sessionId);
        markObservationGapIfUnobserved(sessionId);
        if (!isWatched(sessionId)) forgetSessionMetadata(sessionId);
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

  /** A watched child's snapshot label follows a relayed rename. */
  function renameWatchedChild(sessionId: string, title: string): void {
    const ownerSessionId = childOwners.get(sessionId);
    if (ownerSessionId === undefined) return;
    const watcher = childWatchers.get(ownerSessionId);
    const child = watcher?.children.get(sessionId);
    if (watcher === undefined || child === undefined) return;
    updateWatcherChild(watcher, sessionId, { ...child, label: safeChildLabel(title) });
  }

  function projectChildren(
    parentSessionId: string,
    records: ReadonlyArray<{
      id: string;
      parentID?: string;
      title?: string;
      agent?: string;
      model?: NativeCacheObserverChildModel;
      timeCreatedMs?: number;
      timeUpdatedMs?: number;
    }>,
  ): { children: Map<string, NativeCacheObserverChild>; changedMetas: string[] } {
    const result = new Map<string, NativeCacheObserverChild>();
    const changedMetas: string[] = [];
    for (const record of records) {
      if (record.parentID !== parentSessionId || !isSafeSessionId(record.id)) continue;
      // The record is the session's state at its time.updated; it seeds the
      // per-session metadata store, with freshness tracked per identity field.
      if (applySessionMetaRecord(record.id, record)) changedMetas.push(record.id);
      result.set(record.id, {
        sessionId: record.id,
        label: safeChildLabel(record.title),
      });
    }
    return {
      children: new Map(
        [...result.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
      changedMetas,
    };
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

      const projection = projectChildren(watcher.parentSessionId, records);
      const children = projection.children;
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
      // Identity changes discovered by the refresh reach the session's own
      // consumers (labels, recency) after the snapshot is consistent.
      for (const sessionId of projection.changedMetas) notifyConsumers(sessionId);
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
    cancelSessionMetadataRequest(sessionId);
    if (!ingestorListeners.has(sessionId)) {
      // No direct consumer remains: a deleted session keeps no tracked state.
      sessionStatuses.delete(sessionId);
      statusEventRevisions.delete(sessionId);
      sessionMetas.delete(sessionId);
    }
    clearSessionMetaFreshness(sessionId);
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
    cancelSessionMetadataRequest(sessionId);
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
    const sessionIds = watchedSessions();
    // Invalidate in-flight reconciliation and metadata reads first: their
    // results may predate the gap.
    reconcileVersion += 1;
    metadataGapEpoch += 1;
    cancelAllMetadataRequests();
    // Drop confirmed status BEFORE any notification so no listener re-render
    // can observe the stale value.
    const clearedStatuses = [...sessionIds].filter((sessionId) =>
      sessionStatuses.delete(sessionId),
    );
    for (const sessionId of sessionIds) markObservationGap(sessionId);
    // The per-session gap notification only fires where retained ingestor
    // state exists; every session whose status actually cleared re-renders.
    for (const sessionId of clearedStatuses) notifyConsumers(sessionId);
  }

  let reconcileVersion = 0;
  let reconcileQueued = false;
  /**
   * Reconcile confirmed execution state from the public `session.active`
   * snapshot. Coalesced per tick and run on (re)connect — never polled — so a
   * missed idle/busy transition self-corrects from the authoritative source.
   * A failed snapshot leaves every status untouched; unknown stays unknown.
   */
  function queueReconcile(): void {
    if (reconcileQueued || disposed || options.listActiveSessions === undefined) return;
    reconcileQueued = true;
    queueMicrotask(() => {
      reconcileQueued = false;
      void reconcileActive();
    });
  }

  async function reconcileActive(): Promise<void> {
    if (disposed || options.listActiveSessions === undefined) return;
    const version = ++reconcileVersion;
    const observed = [...watchedSessions()];
    // Capture each session's event clock at snapshot start: a status event
    // that arrives while the snapshot is in flight is newer evidence and must
    // not be overwritten by the older snapshot.
    const startRevisions = new Map(
      observed.map((sessionId) => [sessionId, statusEventRevisions.get(sessionId) ?? 0]),
    );
    try {
      const activeIds = await options.listActiveSessions();
      if (disposed || version !== reconcileVersion) return;
      const active = new Set(activeIds);
      for (const sessionId of observed) {
        if ((statusEventRevisions.get(sessionId) ?? 0) !== (startRevisions.get(sessionId) ?? 0)) {
          continue;
        }
        setSessionStatus(sessionId, active.has(sessionId) ? "busy" : "idle");
      }
    } catch {
      // An unavailable snapshot is not evidence; statuses keep their last
      // confirmed value and unknown stays unknown.
    }
  }

  const metadataRequests = new Map<
    string,
    {
      controller: AbortController;
      gapEpoch: number;
      fieldRevisionsAtStart: SessionMetaFieldRevisions;
    }
  >();
  let metadataGapEpoch = 0;
  function cancelSessionMetadataRequest(sessionId: string): void {
    const request = metadataRequests.get(sessionId);
    if (request === undefined) return;
    // Remove ownership before aborting: an abort listener can settle the read
    // synchronously, but its continuation must not affect a later request.
    metadataRequests.delete(sessionId);
    request.controller.abort();
  }

  function cancelAllMetadataRequests(): void {
    for (const sessionId of metadataRequests.keys()) cancelSessionMetadataRequest(sessionId);
  }

  function forgetSessionMetadata(sessionId: string): void {
    cancelSessionMetadataRequest(sessionId);
    sessionMetas.delete(sessionId);
    clearSessionMetaFreshness(sessionId);
  }

  /**
   * One public `session.get` per request, arbitrated per session: a request
   * that adds nothing (identity already known) never issues a read nor
   * disturbs another session's in-flight read. A newer request supersedes an
   * older one; identity events protect their fields while the read completes.
   * Release, gap, and disposal cancel outstanding reads.
   */
  function requestSessionMetadata(sessionId: string, onlyMissing: boolean): void {
    if (disposed || options.getSessionMetadata === undefined) return;
    if (!isSafeSessionId(sessionId) || !isWatched(sessionId)) return;
    if (onlyMissing && sessionMetas.has(sessionId)) return;
    cancelSessionMetadataRequest(sessionId);
    const request = {
      controller: new AbortController(),
      gapEpoch: metadataGapEpoch,
      fieldRevisionsAtStart: sessionMetaRevisionSnapshot(sessionId),
    };
    metadataRequests.set(sessionId, request);
    const getSessionMetadata = options.getSessionMetadata;
    void (async () => {
      try {
        const record = await awaitWithAbort(
          getSessionMetadata(sessionId, { signal: request.controller.signal }),
          request.controller.signal,
        );
        if (disposed || metadataGapEpoch !== request.gapEpoch) return;
        if (metadataRequests.get(sessionId) !== request) return;
        if (!isWatched(sessionId)) return;
        if (applySessionMetaRecord(sessionId, record, request.fieldRevisionsAtStart)) {
          notifyConsumers(sessionId);
        }
      } catch {
        // An unavailable or cancelled read keeps stored identity; a later
        // trigger (reconnect, re-subscribe) retries. No polling.
      } finally {
        if (metadataRequests.get(sessionId) === request) metadataRequests.delete(sessionId);
      }
    })();
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
    queueReconcile();
    for (const sessionId of watchedSessions()) requestSessionMetadata(sessionId, false);
  });
  const releaseReconnect = options.subscribeReconnect?.(() => {
    for (const watcher of childWatchers.values()) {
      void refreshChildren(watcher, { reconcilePendingCreates: true });
    }
    queueReconcile();
    // Events lost while the stream was down are recovered from the records.
    for (const sessionId of watchedSessions()) requestSessionMetadata(sessionId, false);
  });
  const releaseEventStreamRetire = options.subscribeEventStreamRetire?.(markActiveObservationGaps);

  async function children(sessionId: string): Promise<NativeCacheObserverChild[]> {
    if (disposed) throw new Error("Cache observer runtime is closed");
    if (!isSafeSessionId(sessionId)) throw new TypeError("Invalid parent session id");

    const records = await options.listChildren(sessionId);
    return [...projectChildren(sessionId, records).children.values()];
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
          if ((ingestorListeners.get(childSessionId)?.size ?? 0) === 0) {
            sessionStatuses.delete(childSessionId);
            statusEventRevisions.delete(childSessionId);
            sessionMetas.delete(childSessionId);
            clearSessionMetaFreshness(childSessionId);
          }
          if (!isWatched(childSessionId)) cancelSessionMetadataRequest(childSessionId);
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
      if (event.type === "session.status") {
        const sessionId = event.data.sessionID;
        if (isWatched(sessionId)) {
          bumpStatusEventRevision(sessionId);
          setSessionStatus(sessionId, event.data.state);
          // The transition itself dates the session's activity.
          advanceSessionActivity(sessionId, event.created);
        }
        return;
      }
      if (event.type === "session.metadata") {
        const sessionId = event.data.sessionID;
        if (isWatched(sessionId)) {
          const patch = {
            title: event.data.title,
            agent: event.data.agent,
            model: event.data.model,
          };
          if (applySessionMetaPatch(sessionId, patch, event.created)) {
            if (patch.title !== undefined) renameWatchedChild(sessionId, patch.title);
            notifyConsumers(sessionId);
          }
        }
        return;
      }
      const update = cacheObserverUpdateFromOpenCodeEvent(event);
      const startedSessionId =
        event.type === "session.step.started" ? event.data.sessionID : undefined;
      const startedEventAtMs = event.type === "session.step.started" ? event.created : undefined;
      if (startedSessionId !== undefined) {
        bumpHistoryEpoch(startedSessionId);
        // A host-published started step is confirmed execution evidence.
        if (isWatched(startedSessionId)) {
          bumpStatusEventRevision(startedSessionId);
          setSessionStatus(startedSessionId, "busy");
          advanceSessionActivity(startedSessionId, startedEventAtMs);
        }
      }
      if (update?.kind === "invocation") {
        bumpHistoryEpoch(update.observation.sessionId);
      } else if (update?.kind === "compaction" || update?.kind === "deleted") {
        bumpHistoryEpoch(update.sessionId, true);
        if (update.kind === "deleted") sessionStatuses.delete(update.sessionId);
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
    let sessionListeners = ingestorListeners.get(sessionId);
    const isFirstInterest = sessionListeners === undefined;
    if (sessionListeners === undefined) {
      sessionListeners = new Set();
      ingestorListeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    const releaseIngestor = ingestor.subscribe(sessionId, listener);
    attachEventListener();
    queueReconcile();
    if (isFirstInterest) requestSessionMetadata(sessionId, true);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      releaseIngestor();
      sessionListeners?.delete(listener);
      if (sessionListeners?.size === 0) {
        ingestorListeners.delete(sessionId);
        sessionStatuses.delete(sessionId);
        statusEventRevisions.delete(sessionId);
        if (!childOwners.has(sessionId)) {
          sessionMetas.delete(sessionId);
          clearSessionMetaFreshness(sessionId);
        }
      }
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
      if (!isWatched(sessionId)) cancelSessionMetadataRequest(sessionId);
      if (interestedSessions.size === 0 && childWatchers.size === 0) {
        releaseEventListener?.();
        releaseEventListener = undefined;
      }
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAllMetadataRequests();
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
    ingestorListeners.clear();
    sessionStatuses.clear();
    statusEventRevisions.clear();
    sessionMetas.clear();
    sessionMetaFieldUpdatedAtMs.clear();
    sessionMetaFieldRevisions.clear();
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
    status,
    metadata,
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
const MAX_HOST_TEXT_CODEPOINTS = 128;

function isNonNegativeFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

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
