/**
 * One snapshot service over the transport-neutral source (design spec §4.2, R9).
 *
 * Owns computation, caching, single-flight, the viewer-scoped poller, and
 * invalidation. Cache key is `(kind, resourceId, range)`; failures serve the
 * last good snapshot with `stale: true` when one exists. The poller runs only
 * while at least one SSE viewer is attached and ticks never overlap.
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
 * No TTL, sequence, watermark, or budget machinery exists (R9).
 */

import type {
  DashboardDataSource,
  DashboardEvent,
  DashboardEventTopic,
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

/** Effective poll interval when nothing valid is configured (spec §4.2). */
export const DEFAULT_POLL_INTERVAL_MS = 300_000;

/**
 * Hard cap on pages with a cache entry and poll registration (R9 poller fix).
 *
 * Recency is refreshed only by an actual page load (`load`, i.e. an HTTP
 * snapshot request), never by a poll tick. When a new load pushes the tracked
 * set past this bound, the least recently loaded key is evicted: its cache
 * entry, poll registration, and recency record are dropped together.
 */
export const MAX_TRACKED_PAGES = 16;

/** The read side of the dashboard source the service consumes. */
export type SnapshotSource = Pick<DashboardDataSource, "home" | "project" | "session">;

export interface SnapshotServiceOptions {
  source: SnapshotSource;
  /** Fixed interval, or a getter re-read on settings changes (P2 production seam). */
  minIntervalMs?: number | (() => number);
  /** Test seam for deterministic event timestamps. */
  now?: () => number;
  logger?: GuiLogger;
}

export interface SnapshotService {
  home(input: { range: RangeKey }): Promise<HomeSnapshot>;
  project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot>;
  session(input: { sessionId: string }): Promise<SessionSnapshot>;
  /** Invalidations broadcast over SSE (three topics, never raw snapshots). */
  subscribe(listener: (event: DashboardEvent) => void): () => void;
  /** Registers an SSE viewer; the returned disposer detaches it. */
  addViewer(): () => void;
  /**
   * A settings write: clears home/project caches and broadcasts
   * `settings.changed`. `scope: "visibility"` only broadcasts (no invalidation,
   * no provider poll, no analytics change).
   */
  notifySettingsChanged(options?: { scope?: "visibility" }): void;
  close(): void;
}

interface CacheEntry {
  snapshot: unknown;
  substantive: string;
  stale: boolean;
}

interface InflightTask {
  promise: Promise<unknown>;
  /** Viewer epoch at creation; ending that session disowns this task. */
  epoch: number;
  /** Recency generation captured when this compute should be allowed to cache. */
  version: number;
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

function kindOf(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? key : key.slice(0, separator);
}

function topicFor(key: string): DashboardEventTopic {
  return kindOf(key) === "home" ? "quota.changed" : "sessions.changed";
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

/** Session snapshots have no `stale` field; they are served as-is. */
function markStale<T>(snapshot: T): T {
  if (typeof snapshot !== "object" || snapshot === null || !("stale" in snapshot)) {
    return snapshot;
  }
  return { ...snapshot, stale: true };
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
   * Bumped when the viewer session ends (last disconnect or close). It disowns
   * in-flight poll ticks and any HTTP cache commit started before that point.
   */
  let viewerEpoch = 0;
  let pollTimer: NodeJS.Timeout | undefined;
  let ticking = false;
  let closed = false;

  function effectiveIntervalMs(): number {
    let value: number | undefined;
    try {
      const configured = options.minIntervalMs;
      value = typeof configured === "function" ? configured() : configured;
    } catch {
      value = undefined;
    }
    return value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_POLL_INTERVAL_MS;
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

  /** Marks a page as the most recently loaded and evicts past the bound. */
  function touch(key: string): number {
    const version = ++versionCounter;
    tracked.delete(key);
    tracked.set(key, version);
    while (tracked.size > MAX_TRACKED_PAGES) {
      const oldest = tracked.keys().next().value;
      if (oldest === undefined) break;
      evict(oldest);
    }
    return version;
  }

  function load<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const epoch = viewerEpoch;
    // A closed service does not track, register, or cache: the caller still
    // gets its computation, but a probe (or a late request) cannot repopulate
    // state that close() released.
    const version = closed ? 0 : touch(key);
    if (!closed) computes.set(key, compute);
    const existing = cache.get(key);
    if (existing && !existing.stale) {
      // SAFETY: `load<T>` is only called with a key built from `(kind, resourceId,
      // range)`, and the entry under this key was stored by a compute of that key.
      return Promise.resolve(existing.snapshot as T);
    }

    const pending = inflight.get(key);
    if (pending && pending.epoch === epoch) {
      // The key was requested again in the same viewer session while its compute
      // was still pending: preserve single-flight and let it cache again.
      if (!closed) pending.version = version;
      // SAFETY: same key contract as the cache above; the inflight task was created
      // by a `load<T>` call for this exact key.
      return pending.promise as Promise<T>;
    }
    // A pending task from an ended viewer session is disowned: this caller runs
    // its own compute instead of joining a pre-disconnect task.

    let computation: Promise<T>;
    try {
      computation = compute();
    } catch (error: unknown) {
      computation = Promise.reject(error);
    }

    const task: InflightTask = { epoch, promise: Promise.resolve(), version };
    task.promise = computation
      .then((snapshot) => {
        // A commit belongs to the viewer session that started the load: the
        // last disconnect already dirtied the entries, so a pre-disconnect
        // result never re-freshens them.
        if (!closed && task.epoch === viewerEpoch && tracked.get(key) === task.version) {
          cache.set(key, { snapshot, substantive: substantiveOf(snapshot), stale: false });
        }
        return snapshot;
      })
      .catch((error: unknown) => {
        const fallback = tracked.get(key) === task.version ? cache.get(key) : undefined;
        if (!fallback) throw error;
        if (!closed && task.epoch === viewerEpoch) {
          fallback.stale = true;
          logger.warn("snapshot compute failed; serving last good snapshot", failureLabel(error));
        }
        // SAFETY: the cached entry under this key is a previous successful compute
        // of the same `(kind, resourceId, range)` key, so it is a T snapshot.
        return markStale(fallback.snapshot) as T;
      })
      .finally(() => {
        // Never delete a newer task that replaced this one after reconnect.
        if (inflight.get(key) === task) inflight.delete(key);
      });

    inflight.set(key, task);
    return task.promise as Promise<T>;
  }

  async function tick(): Promise<void> {
    if (ticking || closed || viewers === 0) return;
    ticking = true;
    const epoch = viewerEpoch;
    const changed = new Set<DashboardEventTopic>();
    try {
      // Copy before the async body: `load` can register new computes while a
      // tick awaits, and one tick must not grow while it runs.
      for (const [key, compute] of Array.from(computes)) {
        // The viewer session that started this tick has ended: poll no further
        // keys for it, no matter how many entries the copied list holds.
        if (closed || viewerEpoch !== epoch || viewers === 0) break;
        if (computes.get(key) !== compute) continue;
        if (inflight.has(key)) continue;
        const version = tracked.get(key);
        if (version === undefined) continue;
        let snapshot: unknown;
        try {
          snapshot = await compute();
        } catch (error: unknown) {
          // A key evicted (or re-loaded) while the poll was pending must not be
          // marked current by this late result; an ended viewer session must
          // not be updated or logged for at all.
          if (closed || viewerEpoch !== epoch || viewers === 0) break;
          if (tracked.get(key) === version && computes.get(key) === compute) {
            const entry = cache.get(key);
            if (entry) entry.stale = true;
            logger.warn("snapshot poll failed", failureLabel(error));
          }
          continue;
        }
        // Late poll results never resurrect an evicted key, overwrite a key
        // loaded again mid-poll, or land in a viewer session that has ended.
        if (closed || viewerEpoch !== epoch || viewers === 0) break;
        if (tracked.get(key) !== version || computes.get(key) !== compute) continue;
        const substantive = substantiveOf(snapshot);
        const entry = cache.get(key);
        const changedNow = entry === undefined || entry.stale || entry.substantive !== substantive;
        cache.set(key, { snapshot, substantive, stale: false });
        if (changedNow) changed.add(topicFor(key));
      }
    } finally {
      ticking = false;
    }

    if (closed || viewerEpoch !== epoch) return;
    if (changed.has("quota.changed")) emit({ topic: "quota.changed", at: now() });
    if (changed.has("sessions.changed")) emit({ topic: "sessions.changed", at: now() });
  }

  function startPoller(): void {
    if (closed || pollTimer) return;
    pollTimer = setInterval(() => {
      void tick();
    }, effectiveIntervalMs());
    pollTimer.unref();
  }

  function stopPoller(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function dirty(): void {
    for (const entry of cache.values()) entry.stale = true;
  }

  return {
    home: (input) => load(homeKey(input.range), () => options.source.home({ range: input.range })),
    project: (input) =>
      load(projectKey(input.projectId, input.range), () =>
        options.source.project({ projectId: input.projectId, range: input.range }),
      ),
    session: (input) =>
      load(sessionKey(input.sessionId), () =>
        options.source.session({ sessionId: input.sessionId }),
      ),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    addViewer() {
      if (closed) return () => {};
      viewers += 1;
      if (viewers === 1) startPoller();
      let released = false;
      return () => {
        if (released || closed) return;
        released = true;
        viewers = Math.max(0, viewers - 1);
        if (viewers === 0) {
          stopPoller();
          // End the viewer session: abandoned ticks poll no further keys, a
          // reconnect starts with no stale poll interests, and pages are only
          // polled again after an actual load re-registers them.
          viewerEpoch += 1;
          computes.clear();
          dirty();
        }
      };
    },

    notifySettingsChanged(settingsOptions?: { scope?: "visibility" }): void {
      if (closed) return;
      if (settingsOptions?.scope !== "visibility") {
        for (const [key, entry] of cache) {
          const kind = kindOf(key);
          if (kind === "home" || kind === "project") entry.stale = true;
        }
        if (viewers > 0) {
          // Re-read the poll interval from the getter (spec §7, R16).
          stopPoller();
          startPoller();
        }
      }
      const event: DashboardEvent = { topic: "settings.changed", at: now() };
      if (settingsOptions?.scope) event.scope = settingsOptions.scope;
      emit(event);
    },

    close(): void {
      if (closed) return;
      closed = true;
      viewerEpoch += 1;
      stopPoller();
      listeners.clear();
      computes.clear();
      cache.clear();
      inflight.clear();
      tracked.clear();
    },
  };
}
