/**
 * One snapshot service over the transport-neutral source (design spec §4.2, R9).
 *
 * Owns computation, caching, single-flight, the viewer-scoped poller, and
 * invalidation. Cache key is `(kind, resourceId, range)`; failures serve the
 * last good snapshot with `stale: true` when one exists. The poller runs only
 * while at least one SSE viewer is attached, ticks never overlap, and the cache
 * is dirtied when the last viewer disconnects so a reconnect recomputes.
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
  const inflight = new Map<string, Promise<unknown>>();
  const listeners = new Set<(event: DashboardEvent) => void>();

  let viewers = 0;
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

  function load<T>(key: string, compute: () => Promise<T>): Promise<T> {
    if (!closed) computes.set(key, compute);
    const existing = cache.get(key);
    if (existing && !existing.stale) {
      // SAFETY: `load<T>` is only called with a key built from `(kind, resourceId,
      // range)`, and the entry under this key was stored by a compute of that key.
      return Promise.resolve(existing.snapshot as T);
    }

    const pending = inflight.get(key);
    if (pending) {
      // SAFETY: same key contract as the cache above; the inflight task was created
      // by a `load<T>` call for this exact key.
      return pending as Promise<T>;
    }

    let computation: Promise<T>;
    try {
      computation = compute();
    } catch (error: unknown) {
      computation = Promise.reject(error);
    }

    const task = computation
      .then((snapshot) => {
        cache.set(key, { snapshot, substantive: substantiveOf(snapshot), stale: false });
        return snapshot;
      })
      .catch((error: unknown) => {
        const fallback = cache.get(key);
        if (!fallback) throw error;
        fallback.stale = true;
        logger.warn("snapshot compute failed; serving last good snapshot", failureLabel(error));
        // SAFETY: the cached entry under this key is a previous successful compute
        // of the same `(kind, resourceId, range)` key, so it is a T snapshot.
        return markStale(fallback.snapshot) as T;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, task);
    return task;
  }

  async function tick(): Promise<void> {
    if (ticking || closed) return;
    ticking = true;
    const changed = new Set<DashboardEventTopic>();
    try {
      // Copy before the async body: `load` can register new computes while a
      // tick awaits, and one tick must not grow while it runs.
      for (const [key, compute] of Array.from(computes)) {
        if (closed) break;
        if (inflight.has(key)) continue;
        let snapshot: unknown;
        try {
          snapshot = await compute();
        } catch (error: unknown) {
          const entry = cache.get(key);
          if (entry) entry.stale = true;
          logger.warn("snapshot poll failed", failureLabel(error));
          continue;
        }
        const substantive = substantiveOf(snapshot);
        const entry = cache.get(key);
        const changedNow = entry === undefined || entry.stale || entry.substantive !== substantive;
        cache.set(key, { snapshot, substantive, stale: false });
        if (changedNow) changed.add(topicFor(key));
      }
    } finally {
      ticking = false;
    }

    if (closed) return;
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
      stopPoller();
      listeners.clear();
    },
  };
}
