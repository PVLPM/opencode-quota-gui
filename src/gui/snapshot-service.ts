/**
 * One snapshot service over the transport-neutral source (design spec §4.2, R9).
 *
 * Owns computation, caching, single-flight, viewer-scoped polling and
 * invalidation. Cache keys are `(kind, resourceId, range)`; quota is its own
 * key. Failures serve the last good snapshot with `stale: true` when one
 * exists. Pollers run only while at least one transport viewer (SSE or RPC) is
 * attached and ticks never overlap within a kind.
 *
 * Quota and analytics poll on independent timers: quota uses the existing
 * positive `minIntervalMs` configuration (default 60000), analytics defaults
 * to 600000. One analytics tick asks the source for at most one shared
 * underlying refresh, then re-derives only the loaded home/project/session
 * keys; a quota-only viewer therefore starts no analytics work, and a slow
 * provider cycle never delays a home/project/session read. The quota
 * registration is pinned outside the analytics LRU bound, and a viewer-scoped
 * view signal (`quota`) suspends analytics refresh even when analytics pages
 * were visited earlier.
 *
 * Retention is bounded: at most `MAX_TRACKED_PAGES` keys keep a cache entry and
 * a poll registration, ordered by actual page loads (HTTP requests), never by
 * poll ticks. Eviction removes both the cache entry and the registration. A
 * compute or poll that settles after its key was evicted still resolves its
 * caller but never caches or re-registers that key. The last viewer disconnect
 * clears all registrations (and dirties retained entries), so a reconnect only
 * polls pages that are loaded again. A tick in flight when the last viewer
 * disconnects is abandoned: it polls no further keys and discards any result
 * that settles afterwards. The same viewer epoch guards HTTP commits: a load
 * that began before the last disconnect cannot re-freshen a dirtied entry, and
 * a post-reconnect load never joins a pre-disconnect in-flight task (the old
 * caller still resolves, and its late completion cannot delete or overwrite the
 * newer one). A load on a closed service still computes for its caller but
 * never touches tracking, registration, or cache.
 *
 * An owner/source handoff uses a source generation: entries retain the
 * generation that produced them and old entries are last-good only. A
 * pre-handoff result is marked stale when the DTO supports it, or failed when
 * it does not (`SessionSnapshot`), so the previous owner's data is never
 * presented as fresh.
 *
 * No TTL, sequence, watermark, or budget machinery exists (R9).
 */

import { encodeAnalyticsGroupQueryKey } from "../contracts/analytics-entity.js";
import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
  DashboardDataSource,
  DashboardEvent,
  DashboardEventTopic,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

/** Default quota/provider poll interval (spec §4.2; existing config overrides). */
export const DEFAULT_QUOTA_INTERVAL_MS = 60_000;

/** Backwards-compatible alias for the quota interval (existing importers). */
export const DEFAULT_POLL_INTERVAL_MS = DEFAULT_QUOTA_INTERVAL_MS;

/** Default analytics refresh/poll interval (spec: 600000ms). */
export const DEFAULT_ANALYTICS_INTERVAL_MS = 600_000;

/**
 * Hard cap on *analytics* pages with a cache entry and poll registration (R9
 * poller fix). The independent quota registration is pinned and excluded from
 * the bound, so analytics page churn can never evict the quota poller.
 *
 * Recency is refreshed only by an actual page load (`load`, i.e. an HTTP
 * snapshot request), never by a poll tick. When a new load pushes the tracked
 * analytic set past this bound, the least recently loaded key is evicted: its
 * cache entry, poll registration, and recency record are dropped together.
 */
export const MAX_TRACKED_PAGES = 16;

/**
 * The read side of the dashboard source the service consumes. `quota` is
 * optional at this seam so older injected mocks keep compiling; production
 * always provides it and `/api/v1/quota` returns a controlled 500 otherwise.
 * `refreshAnalytics` is an optional shared worker refresh seam, and `close` is
 * closed by the lifecycle when the last lease disposes, not by this service.
 */
export type SnapshotSource = Pick<DashboardDataSource, "home" | "project" | "session"> & {
  quota?: DashboardDataSource["quota"];
  groups?: DashboardDataSource["groups"];
  refreshAnalytics?: () => Promise<void>;
  /** Optional worker generation notifications; never starts analytics eagerly. */
  subscribeAnalytics?: (listener: () => void) => () => void;
  close?: () => void | Promise<void>;
};

export interface SnapshotServiceOptions {
  source: SnapshotSource;
  /**
   * Quota poll interval (legacy name retained for the production lifecycle):
   * a fixed value or a getter re-read on settings changes. This is the existing
   * `minIntervalMs` setting, with no invented minimum.
   */
  minIntervalMs?: number | (() => number);
  /** Explicit quota interval; wins over `minIntervalMs`. */
  quotaIntervalMs?: number | (() => number);
  /** Analytics poll interval; defaults to `DEFAULT_ANALYTICS_INTERVAL_MS`. */
  analyticsIntervalMs?: number | (() => number);
  /** Test seam for deterministic event timestamps. */
  now?: () => number;
  logger?: GuiLogger;
}

/**
 * Which surface the attached viewers are currently looking at. `quota` stops
 * automatic analytics refresh even when analytics pages were loaded before
 * (visited once is not an active interest); `analytics` restores it. Defaults
 * to `analytics` so clients that never signal keep the previous behaviour.
 */
export type SnapshotViewScope = "analytics" | "quota";

/** One viewer that carries its own active-surface scope. */
export interface SnapshotViewer {
  release(): void;
}

export interface SnapshotService {
  home(input: { range: RangeKey }): Promise<HomeSnapshot>;
  quota(): Promise<QuotaSnapshot>;
  project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot>;
  session(input: { sessionId: string }): Promise<SessionSnapshot>;
  groups(query: AnalyticsGroupQuery): Promise<AnalyticsGroupSnapshot>;
  /** Invalidations broadcast over SSE (three topics, never raw snapshots). */
  subscribe(listener: (event: DashboardEvent) => void): () => void;
  /**
   * Registers a legacy unscoped viewer (HTTP/SSE); the returned disposer
   * detaches it. Its active surface comes from `setViewScope`.
   */
  addViewer(): () => void;
  /**
   * Registers a viewer that carries its own active-surface scope (RPC/native).
   * Concurrent viewers aggregate: analytics refresh runs while any viewer needs
   * analytics, regardless of other viewers' quota signals.
   */
  addScopedViewer(scope: SnapshotViewScope): SnapshotViewer;
  /**
   * A settings write: clears quota/home/project caches and broadcasts
   * `settings.changed`. `scope: "visibility"` only broadcasts (no invalidation,
   * no provider poll, no analytics change); the next quota cycle still uses the
   * current selected-provider set.
   */
  notifySettingsChanged(options?: { scope?: "visibility" }): void;
  /**
   * Viewer-scoped interest signal. An explicit `signal` (UI route change) wins
   * over an inferred `request` (a read of that kind) until the last disconnect;
   * while the scope is `quota`, analytics refresh/derivation is skipped.
   */
  setViewScope(scope: SnapshotViewScope, origin?: "signal" | "request"): void;
  /**
   * The host's active source identity changed (owner handoff in the lifecycle).
   * Cached pages belong to the previous owner, so they are marked stale; any
   * pre-handoff in-flight result is never presented as fresh (stale-marked when
   * the DTO supports it, otherwise failed), and both data topics are emitted so
   * connected clients refetch through the new source.
   */
  sourceChanged(): void;
  close(): void;
}

interface CacheEntry {
  snapshot: unknown;
  substantive: string;
  stale: boolean;
  /** Source identity that produced this entry; old entries are only last-good. */
  sourceGeneration: number;
}

interface InflightTask {
  promise: Promise<unknown>;
  /** Viewer epoch at creation; ending that session disowns this task. */
  epoch: number;
  /** Source generation at creation; a handoff disowns this task's result. */
  sourceGeneration: number;
  /** Recency generation captured when this compute should be allowed to cache. */
  version: number;
}

function quotaKey(): string {
  return "quota\u0000\u0000";
}

function homeKey(range: RangeKey): string {
  return `home\u0000\u0000${range}`;
}

function projectKey(projectId: string, range: RangeKey): string {
  return `project\u0000${projectId}\u0000${range}`;
}

function sessionKey(sessionId: string): string {
  return `session\u0000${sessionId}\u0000`;
}

function groupsKey(query: AnalyticsGroupQuery): string {
  return `groups\u0000${encodeAnalyticsGroupQueryKey(query)}`;
}

function kindOf(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? key : key.slice(0, separator);
}

function topicFor(key: string): DashboardEventTopic {
  // Home used to include provider cards and emit quota.changed. It is now
  // analytics-only (usage/projects), so only the independent quota key emits
  // quota.changed; every analytics key is a session change.
  return kindOf(key) === "quota" ? "quota.changed" : "sessions.changed";
}

/**
 * Derived noise excluded from the substantive-change comparison (spec §4.2).
 *
 * `generatedAtMs`, `polledAtMs`, and `countdown` are derived display noise.
 * `sinceMs`/`untilMs` (Usage.window) and `startMs`/`endMs` (clipped Bucket
 * boundaries) advance with the real clock on every source poll without any
 * token or data change, so they must not trigger broadcasts. These four names
 * are clock boundaries only: step `atMs`, `latestActivityAtMs`, `*Iso`
 * timestamps, and every token value stay substantive.
 */
const DERIVED_NOISE_KEYS: ReadonlySet<string> = new Set([
  "generatedAtMs",
  "polledAtMs",
  "countdown",
  "sinceMs",
  "untilMs",
  "startMs",
  "endMs",
]);

function stripDerivedNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDerivedNoise);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DERIVED_NOISE_KEYS.has(key)) continue;
      out[key] = stripDerivedNoise(child);
    }
    return out;
  }
  return value;
}

function substantiveOf(snapshot: unknown): string {
  return JSON.stringify(stripDerivedNoise(snapshot));
}

function staleFlag(value: unknown): boolean {
  return typeof value === "object" && value !== null && "stale" in value && value.stale === true;
}

/**
 * True when the source payload itself reports stale data. Such a payload must
 * not enter the cache as fresh: the next read revalidates instead of serving it
 * as current until the next poll. Home/project snapshots also flag staleness on
 * `usage`; session snapshots have no `stale` field and stay unchanged.
 */
function payloadIsStale(snapshot: unknown): boolean {
  if (staleFlag(snapshot)) return true;
  if (typeof snapshot !== "object" || snapshot === null || !("usage" in snapshot)) return false;
  return staleFlag(snapshot.usage);
}

/** True when the contract carries the top-level `stale` marker. */
function hasStaleMarker(snapshot: unknown): boolean {
  return typeof snapshot === "object" && snapshot !== null && "stale" in snapshot;
}

/** Session snapshots have no `stale` field; they are served as-is. */
function markStale<T>(snapshot: T): T {
  if (!hasStaleMarker(snapshot)) return snapshot;
  return { ...snapshot, stale: true };
}

/**
 * A source handoff completed while a load that cannot carry the `stale` marker
 * was still in flight. Failing is safer than returning the previous owner's
 * payload as fresh; the transport maps it like any other snapshot failure.
 */
class SnapshotSourceChangedError extends Error {
  constructor() {
    super("Snapshot source changed before the snapshot completed");
    this.name = "SnapshotSourceChangedError";
  }
}

/** Safe log label: an allowlisted-shape code, never a raw message. */
function failureLabel(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(code)) return code;
  }
  return "unavailable";
}

export function createSnapshotService(options: SnapshotServiceOptions): SnapshotService {
  const logger = options.logger ?? createGuiLogger();
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const computes = new Map<string, () => Promise<unknown>>();
  const inflight = new Map<string, InflightTask>();
  const listeners = new Set<(event: DashboardEvent) => void>();
  /** Key -> recency generation; Map insertion order is LRU order. */
  const tracked = new Map<string, number>();
  let versionCounter = 0;

  let viewers = 0;
  /**
   * Scoped viewers are real consumers with their own active surface. Legacy
   * (HTTP/SSE) viewers stay unscoped and vote through `viewScope`; the effective
   * scope below aggregates both instead of letting the last signal win.
   */
  const scopedViewers = new Map<number, SnapshotViewScope>();
  let nextScopedViewerId = 1;
  /**
   * Bumped when the viewer session ends (last disconnect or close). It disowns
   * in-flight poll ticks and any HTTP cache commit started before that point.
   */
  let viewerEpoch = 0;
  /**
   * Bumped when the active source identity changes (owner handoff). The cache
   * remains as last-good fallback, but pre-handoff commits and poll results must
   * not freshen it, and a new request must not join a pre-handoff task.
   */
  let sourceGeneration = 0;
  let viewScope: SnapshotViewScope = "analytics";
  /** Explicit UI signal outranks read-request inference for this viewer session. */
  let viewScopeExplicit = false;
  let quotaTimer: NodeJS.Timeout | undefined;
  let analyticsTimer: NodeJS.Timeout | undefined;
  let quotaTicking = false;
  let analyticsTicking = false;
  let analyticsRetryPending = false;
  let closed = false;
  let unsubscribeAnalytics: (() => void) | undefined;
  let analyticsNotifyChain: Promise<void> | undefined;

  function handleGenerationNotification(): void {
    if (closed || viewers === 0) return;
    const epoch = viewerEpoch;
    const run = async (): Promise<void> => {
      // Let reads already in flight finish first; otherwise an old result could
      // re-cache itself after invalidation and delay the fresh SSE event.
      const pending = Array.from(inflight.entries())
        .filter(([key]) => kindOf(key) !== "quota")
        .map(([, task]) => task.promise.catch(() => undefined));
      if (pending.length > 0) await Promise.all(pending);
      if (closed || viewerEpoch !== epoch || viewers === 0) return;
      for (const [key, entry] of cache) {
        if (kindOf(key) !== "quota") entry.stale = true;
      }
      // Derivation only: the worker already produced this generation.
      await tickAnalytics(false, true);
    };
    analyticsNotifyChain = (analyticsNotifyChain ?? Promise.resolve())
      .then(run, run)
      .catch(() => undefined);
  }

  if (options.source.subscribeAnalytics) {
    try {
      unsubscribeAnalytics = options.source.subscribeAnalytics(handleGenerationNotification);
    } catch {
      unsubscribeAnalytics = undefined;
    }
  }

  function readInterval(configured: number | (() => number) | undefined, fallback: number): number {
    let value: number | undefined;
    try {
      value = typeof configured === "function" ? configured() : configured;
    } catch {
      value = undefined;
    }
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function quotaIntervalMs(): number {
    return readInterval(
      options.quotaIntervalMs ?? options.minIntervalMs,
      DEFAULT_QUOTA_INTERVAL_MS,
    );
  }

  function analyticsIntervalMs(): number {
    return readInterval(options.analyticsIntervalMs, DEFAULT_ANALYTICS_INTERVAL_MS);
  }

  /**
   * True when any real consumer still needs analytics. A scoped analytics
   * viewer always wins, so a quota signal from a concurrent window cannot stop
   * another window's refresh. Legacy viewers vote through `viewScope`; with no
   * legacy viewer only scoped interests count.
   */
  function analyticsViewActive(): boolean {
    for (const scope of scopedViewers.values()) {
      if (scope === "analytics") return true;
    }
    const legacyViewers = viewers - scopedViewers.size;
    return legacyViewers > 0 && viewScope === "analytics";
  }

  function retainViewer(): void {
    if (closed) return;
    viewers += 1;
    if (viewers === 1) startPollers();
  }

  function releaseViewer(): void {
    if (closed) return;
    viewers = Math.max(0, viewers - 1);
    if (viewers === 0) {
      stopPollers();
      // End the viewer session: abandoned ticks poll no further keys, a
      // reconnect starts with no stale poll interests, and pages are only
      // polled again after an actual load re-registers them. Scope signals are
      // viewer-scoped and reset with it.
      viewerEpoch += 1;
      viewScope = "analytics";
      viewScopeExplicit = false;
      scopedViewers.clear();
      computes.clear();
      dirty();
    }
  }

  function emit(event: DashboardEvent): void {
    // Copy before calling out: a listener may unsubscribe while it runs.
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // A subscriber failure never breaks invalidation.
      }
    }
  }

  function evict(key: string): void {
    tracked.delete(key);
    cache.delete(key);
    computes.delete(key);
    // Any in-flight task stays in `inflight` so already-waiting callers still
    // share the result, but its guarded completion cannot cache this key.
  }

  function isQuotaKey(key: string): boolean {
    return kindOf(key) === "quota";
  }

  function analyticsTrackedCount(): number {
    let count = 0;
    for (const key of tracked.keys()) {
      if (!isQuotaKey(key)) count += 1;
    }
    return count;
  }

  /**
   * Marks a page as the most recently loaded and evicts analytics pages past
   * the bound. The quota registration is never a victim (checkpoint limitation
   * 115: analytics churn must not stop the independent quota poller).
   */
  function touch(key: string): number {
    const version = ++versionCounter;
    tracked.delete(key);
    tracked.set(key, version);
    while (analyticsTrackedCount() > MAX_TRACKED_PAGES) {
      let oldestAnalytics: string | undefined;
      for (const candidate of tracked.keys()) {
        if (!isQuotaKey(candidate)) {
          oldestAnalytics = candidate;
          break;
        }
      }
      if (oldestAnalytics === undefined) break;
      evict(oldestAnalytics);
    }
    return version;
  }

  function load<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const epoch = viewerEpoch;
    const generation = sourceGeneration;
    // A closed service does not track, register, or cache: the caller still
    // gets its computation, but a probe (or a late request) cannot repopulate
    // state that close() released.
    const version = closed ? 0 : touch(key);
    if (!closed) computes.set(key, compute);
    const existing = cache.get(key);
    if (existing && !existing.stale && existing.sourceGeneration === sourceGeneration) {
      // SAFETY: `load<T>` is only called with a key built from `(kind, resourceId,
      // range)`, and the entry under this key was stored by a compute of that key.
      return Promise.resolve(existing.snapshot as T);
    }

    const pending = inflight.get(key);
    if (pending && pending.epoch === epoch && pending.sourceGeneration === generation) {
      // The key was requested again in the same viewer session and source
      // generation while its compute was still pending: preserve single-flight
      // and let it cache again.
      if (!closed) pending.version = version;
      // SAFETY: same key contract as the cache above; the inflight task was created
      // by a `load<T>` call for this exact key.
      return pending.promise as Promise<T>;
    }
    // A pending task from an ended viewer session or a previous source identity
    // is disowned: this caller runs its own compute instead.

    let computation: Promise<T>;
    try {
      computation = compute();
    } catch (error: unknown) {
      computation = Promise.reject(error);
    }

    const task: InflightTask = {
      epoch,
      sourceGeneration: generation,
      promise: Promise.resolve(),
      version,
    };
    const attempt = (async (): Promise<T> => {
      let snapshot: T;
      try {
        snapshot = await computation;
      } catch (error: unknown) {
        const fallback = tracked.get(key) === task.version ? cache.get(key) : undefined;
        if (!fallback) throw error;
        // A previous owner's last-good entry may be served only when the DTO
        // can carry the stale marker. Session snapshots cannot, so their
        // failure is surfaced rather than presented as fresh old-owner data.
        if (fallback.sourceGeneration !== sourceGeneration && !hasStaleMarker(fallback.snapshot)) {
          throw error;
        }
        if (!closed && task.epoch === viewerEpoch && task.sourceGeneration === sourceGeneration) {
          fallback.stale = true;
          logger.warn("snapshot compute failed; serving last good snapshot", failureLabel(error));
        }
        // SAFETY: the cached entry under this key is a previous successful compute
        // of the same `(kind, resourceId, range)` key, so it is a T snapshot.
        return markStale(fallback.snapshot) as T;
      }

      // A commit belongs to the viewer session and source identity that started
      // the load: a disconnect or owner handoff already dirtied the entries, so
      // an old result never re-freshens them.
      if (
        !closed &&
        task.epoch === viewerEpoch &&
        task.sourceGeneration === sourceGeneration &&
        tracked.get(key) === task.version
      ) {
        cache.set(key, {
          snapshot,
          substantive: substantiveOf(snapshot),
          // A payload the source already reports stale stays a cache hit only
          // for this caller; the next read must recompute rather than serve
          // stale data as fresh until the next poll.
          stale: payloadIsStale(snapshot),
          sourceGeneration: task.sourceGeneration,
        });
        return snapshot;
      }

      if (task.sourceGeneration !== sourceGeneration) {
        // A handoff happened while this load was in flight. Never present the
        // previous owner's payload as fresh: mark it when the contract supports
        // it, otherwise fail like a post-handoff read would.
        if (!hasStaleMarker(snapshot)) throw new SnapshotSourceChangedError();
        return markStale(snapshot);
      }
      return snapshot;
    })();
    task.promise = attempt.finally(() => {
      // Never delete a newer task that replaced this one after reconnect.
      if (inflight.get(key) === task) inflight.delete(key);
    });

    inflight.set(key, task);
    return task.promise as Promise<T>;
  }

  /**
   * Polls one registered key. Returns false when the viewer session ended or
   * the service closed and the tick must stop.
   */
  async function pollOne(
    key: string,
    compute: () => Promise<unknown>,
    epoch: number,
    changed: Set<DashboardEventTopic>,
  ): Promise<boolean> {
    const generation = sourceGeneration;
    if (closed || viewerEpoch !== epoch || viewers === 0) return false;
    if (computes.get(key) !== compute) return true;
    if (inflight.has(key)) return true;
    const version = tracked.get(key);
    if (version === undefined) return true;
    let snapshot: unknown;
    try {
      snapshot = await compute();
    } catch (error: unknown) {
      // A key evicted (or re-loaded) while the poll was pending must not be
      // marked current by this late result; an ended viewer session or a
      // previous source identity must not be updated or logged for at all.
      if (closed || viewerEpoch !== epoch || viewers === 0) return false;
      if (sourceGeneration !== generation) return false;
      if (tracked.get(key) === version && computes.get(key) === compute) {
        const entry = cache.get(key);
        if (entry) entry.stale = true;
        logger.warn("snapshot poll failed", failureLabel(error));
      }
      return true;
    }
    // Late poll results never resurrect an evicted key, overwrite a key loaded
    // again mid-poll, land in a viewer session that has ended, or cross a
    // source-identity handoff.
    if (closed || viewerEpoch !== epoch || viewers === 0) return false;
    if (sourceGeneration !== generation) return false;
    if (tracked.get(key) !== version || computes.get(key) !== compute) return true;
    const substantive = substantiveOf(snapshot);
    const entry = cache.get(key);
    const changedNow = entry === undefined || entry.stale || entry.substantive !== substantive;
    cache.set(key, { snapshot, substantive, stale: false, sourceGeneration: generation });
    if (changedNow) changed.add(topicFor(key));
    return true;
  }

  async function tickQuota(): Promise<void> {
    if (quotaTicking || closed || viewers === 0) return;
    quotaTicking = true;
    const epoch = viewerEpoch;
    const changed = new Set<DashboardEventTopic>();
    try {
      // Copy before the async body: `load` can register new computes while a
      // tick awaits, and one tick must not grow while it runs.
      for (const [key, compute] of Array.from(computes)) {
        if (kindOf(key) !== "quota") continue;
        if (!(await pollOne(key, compute, epoch, changed))) break;
      }
    } finally {
      quotaTicking = false;
    }

    if (closed || viewerEpoch !== epoch) return;
    if (changed.has("quota.changed")) emit({ topic: "quota.changed", at: now() });
  }

  async function tickAnalytics(refresh = true, retryIfBusy = false): Promise<void> {
    if (analyticsTicking) {
      // A periodic tick or another notification tick is still running. Only a
      // generation notification retries after it; periodic ticks still skip
      // (the running tick already covers their interval).
      if (retryIfBusy && !closed && viewers > 0) analyticsRetryPending = true;
      return;
    }
    if (closed || viewers === 0) return;
    // Visited once is not an active interest: while every live viewer is on
    // the quota surface, no analytics refresh or range derivation runs even
    // though keys are loaded.
    if (!analyticsViewActive()) return;
    const epoch = viewerEpoch;
    // Analytics interests are exactly the loaded home/project/session keys.
    // With only quota viewers this list is empty, so no analytics refresh and
    // no worker start happens.
    const analyticsComputes = Array.from(computes).filter(([key]) => kindOf(key) !== "quota");
    if (analyticsComputes.length === 0) return;

    analyticsTicking = true;
    const changed = new Set<DashboardEventTopic>();
    try {
      // A generation notification means fresh data already exists: derive the
      // loaded views without forcing another refresh (no feedback loop).
      // A periodic tick still performs one shared underlying refresh first.
      if (refresh && options.source.refreshAnalytics) {
        try {
          await options.source.refreshAnalytics();
        } catch (error: unknown) {
          if (!closed && viewerEpoch === epoch && viewers > 0) {
            logger.warn("analytics refresh failed", failureLabel(error));
          }
        }
      }
      for (const [key, compute] of analyticsComputes) {
        if (!(await pollOne(key, compute, epoch, changed))) break;
      }
    } finally {
      analyticsTicking = false;
      if (analyticsRetryPending) {
        analyticsRetryPending = false;
        if (!closed && viewers > 0 && viewerEpoch === epoch) {
          queueMicrotask(() => {
            void tickAnalytics(false, true);
          });
        }
      }
    }

    if (closed || viewerEpoch !== epoch) return;
    if (changed.has("sessions.changed")) emit({ topic: "sessions.changed", at: now() });
  }

  function startPollers(): void {
    if (closed || quotaTimer || analyticsTimer) return;
    quotaTimer = setInterval(() => {
      void tickQuota();
    }, quotaIntervalMs());
    quotaTimer.unref();
    analyticsTimer = setInterval(() => {
      void tickAnalytics();
    }, analyticsIntervalMs());
    analyticsTimer.unref();
  }

  function stopPollers(): void {
    if (quotaTimer) {
      clearInterval(quotaTimer);
      quotaTimer = undefined;
    }
    if (analyticsTimer) {
      clearInterval(analyticsTimer);
      analyticsTimer = undefined;
    }
  }

  /** Restarts both timers so getter-based settings are read again immediately. */
  function restartPollers(): void {
    if (closed || viewers === 0) return;
    stopPollers();
    startPollers();
  }

  function dirty(): void {
    for (const entry of cache.values()) entry.stale = true;
  }

  return {
    home: (input) => load(homeKey(input.range), () => options.source.home({ range: input.range })),
    quota: () =>
      load(quotaKey(), () => {
        if (!options.source.quota) {
          return Promise.reject(new Error("Quota source unavailable"));
        }
        return options.source.quota();
      }),
    project: (input) =>
      load(projectKey(input.projectId, input.range), () =>
        options.source.project({ projectId: input.projectId, range: input.range }),
      ),
    session: (input) =>
      load(sessionKey(input.sessionId), () =>
        options.source.session({ sessionId: input.sessionId }),
      ),
    groups: (query) =>
      load(groupsKey(query), () => {
        if (!options.source.groups) {
          return Promise.reject(new Error("Analytics groups source unavailable"));
        }
        return options.source.groups(query);
      }),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    addViewer() {
      if (closed) return () => {};
      retainViewer();
      let released = false;
      return () => {
        if (released || closed) return;
        released = true;
        releaseViewer();
      };
    },

    addScopedViewer(scope) {
      if (closed) return { release: () => {} };
      const id = nextScopedViewerId;
      nextScopedViewerId += 1;
      scopedViewers.set(id, scope);
      retainViewer();
      let released = false;
      return {
        release: () => {
          if (released || closed) return;
          released = true;
          scopedViewers.delete(id);
          releaseViewer();
        },
      };
    },

    notifySettingsChanged(settingsOptions?: { scope?: "visibility" }): void {
      if (closed) return;
      if (settingsOptions?.scope !== "visibility") {
        for (const [key, entry] of cache) {
          const kind = kindOf(key);
          if (kind === "quota" || kind === "home" || kind === "project") entry.stale = true;
        }
        // Re-read both interval getters from live settings (R16).
        restartPollers();
      }
      const event: DashboardEvent = { topic: "settings.changed", at: now() };
      if (settingsOptions?.scope) event.scope = settingsOptions.scope;
      emit(event);
    },

    setViewScope(scope, origin = "signal") {
      if (closed) return;
      // A later read-request must not undo the UI's explicit route signal.
      if (origin === "request" && viewScopeExplicit) return;
      viewScope = scope;
      if (origin === "signal") viewScopeExplicit = true;
    },

    sourceChanged(): void {
      if (closed) return;
      // The cached payloads remain useful as last-good fallback, but they must
      // never be served as fresh data from the previous owner.
      sourceGeneration += 1;
      dirty();
      emit({ topic: "quota.changed", at: now() });
      emit({ topic: "sessions.changed", at: now() });
    },

    close(): void {
      if (closed) return;
      closed = true;
      viewerEpoch += 1;
      stopPollers();
      if (unsubscribeAnalytics) {
        unsubscribeAnalytics();
        unsubscribeAnalytics = undefined;
      }
      listeners.clear();
      computes.clear();
      cache.clear();
      inflight.clear();
      tracked.clear();
      scopedViewers.clear();
    },
  };
}
