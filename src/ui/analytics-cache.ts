import { createSignal } from "solid-js";
import type { HomeSnapshot } from "../contracts/dashboard";
import { isRecord } from "../contracts/dto-guards";
import type { RangeKey } from "../contracts/ranges";
import { rejoinAnalyticsRead } from "./view-model";

/**
 * Shell-owned Analytics presentation store.
 *
 * It is not a data cache: it keeps the same already-fetched payloads the route
 * containers used to hold locally, so leaving Analytics for Models (or opening
 * a detail route) and coming back paints the previous view immediately instead
 * of disposing it and waiting behind the worker again. The worker/snapshot
 * service remains the source of truth; every retained payload is revalidated in
 * the background on mount.
 *
 * Retention follows source ownership, not freshness: an invalidation token
 * (`sessions.changed`, native panel re-entry) must not throw away a payload the
 * same source produced. Only a real owner handoff does.
 *
 * The pending signal is the union of background prefetches, a foreground read
 * that outlived the first second, and a provisional payload whose exact result
 * is still computing. Range labels consume it unchanged.
 */

export type AnalyticsHomeReader = (input: {
  range: RangeKey;
  background?: boolean;
}) => Promise<HomeSnapshot>;

export interface AnalyticsPresentationStore {
  /** Ranges whose exact payload is still outstanding. */
  pending: () => ReadonlySet<RangeKey>;
  /** A retained payload for this route payload key, from the current source owner. */
  take: <T extends object>(retentionKey: string) => T | undefined;
  /** Retains a fresh, non-provisional payload for an instant later paint. */
  remember: <T extends object>(retentionKey: string, value: T) => void;
  /** Starts the Analytics lifetime/30d background reads. */
  prefetch: (foreground: RangeKey) => void;
  /** Marks a foreground read; the ring appears only if it outlives the delay. */
  beginForeground: (range: RangeKey) => () => void;
  /** Monotonic ordering for provisional markers (issued when a read starts). */
  beginRead: () => number;
  /** Marks provisional data for this read; newer reads keep ownership. */
  noteProvisional: (range: RangeKey, token: number) => void;
  /** Clears only a marker at or older than this read. */
  clearProvisional: (range: RangeKey, token: number) => void;
  dispose: () => void;
}

export interface AnalyticsPresentationStoreOptions {
  /** The data source this store belongs to; a change is a real handoff. */
  owner?: () => object;
}

const PREFETCH_RANGES: readonly RangeKey[] = ["lifetime", "30d"];
const FOREGROUND_RING_DELAY_MS = 1_000;
/** Bounded: four home ranges plus a handful of models/detail payloads. */
const MAX_RETAINED_PAYLOADS = 16;
/** Session trees are the one payload shape that can grow without bound. */
const MAX_RETAINED_SESSION_PAYLOADS = 2;
/** Approximate retained JSON bytes; keeps a renderer session bounded. */
const MAX_RETAINED_BYTES = 12 * 1024 * 1024;

function isFreshPayload<T extends object>(value: T): boolean {
  if (!isRecord(value)) return true;
  if (value.provisional === true || value.stale === true) return false;
  const usage = value.usage;
  if (isRecord(usage) && "stale" in usage) {
    return usage.stale !== true;
  }
  return true;
}

function payloadBytes<T extends object>(value: T): number {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return MAX_RETAINED_BYTES;
  }
}

function isSessionDetail(retentionKey: string): boolean {
  return retentionKey.startsWith("session:");
}

export function createAnalyticsPresentationStore(
  readHome: AnalyticsHomeReader,
  options: AnalyticsPresentationStoreOptions = {},
): AnalyticsPresentationStore {
  const [pending, setPending] = createSignal<ReadonlySet<RangeKey>>(new Set());
  const prefetching = new Set<RangeKey>();
  const provisional = new Map<RangeKey, number>();
  const foreground = new Map<
    RangeKey,
    { count: number; visible: boolean; timer?: ReturnType<typeof setTimeout> }
  >();
  const retained = new Map<
    string,
    { value: object; bytes: number; owner: object | undefined; sessionDetail: boolean }
  >();
  let retainedBytes = 0;
  let readToken = 0;
  let disposed = false;

  const owner = () => options.owner?.();

  const publish = () => {
    const ranges = new Set<RangeKey>(prefetching);
    for (const range of provisional.keys()) ranges.add(range);
    for (const [range, entry] of foreground) {
      if (entry.visible) ranges.add(range);
    }
    setPending(ranges);
  };

  function drop(retentionKey: string): void {
    const entry = retained.get(retentionKey);
    if (entry === undefined) return;
    retained.delete(retentionKey);
    retainedBytes -= entry.bytes;
  }

  function trim(): void {
    // Session trees go first; rollups stay available for instant navigation.
    for (const [retentionKey, entry] of retained) {
      if (!entry.sessionDetail) continue;
      const sessionCount = [...retained.values()].filter(
        (candidate) => candidate.sessionDetail,
      ).length;
      if (sessionCount <= MAX_RETAINED_SESSION_PAYLOADS) break;
      drop(retentionKey);
    }
    while (retained.size > MAX_RETAINED_PAYLOADS || retainedBytes > MAX_RETAINED_BYTES) {
      const oldest = retained.keys().next().value;
      if (oldest === undefined) return;
      drop(oldest);
    }
  }

  function remember<T extends object>(retentionKey: string, value: T): void {
    if (disposed || !isFreshPayload(value)) return;
    drop(retentionKey);
    retained.set(retentionKey, {
      value,
      bytes: payloadBytes(value),
      owner: owner(),
      sessionDetail: isSessionDetail(retentionKey),
    });
    retainedBytes += retained.get(retentionKey)?.bytes ?? 0;
    trim();
  }

  function take<T extends object>(retentionKey: string): T | undefined {
    const entry = retained.get(retentionKey);
    if (entry === undefined) return undefined;
    if (entry.owner !== owner()) {
      drop(retentionKey);
      return undefined;
    }
    // SAFETY: remember stores the caller's value under the caller's key, and
    // every take(T) caller asks for the payload type it stored for that key.
    return entry.value as T;
  }

  function prefetch(foregroundRange: RangeKey): void {
    if (disposed) return;
    for (const range of PREFETCH_RANGES) {
      if (range === foregroundRange || prefetching.has(range)) continue;
      const retainedEntry = retained.get(`home:${range}`);
      if (retainedEntry !== undefined && retainedEntry.owner === owner()) continue;
      prefetching.add(range);
      const token = ++readToken;
      void rejoinAnalyticsRead(
        () => readHome({ range, background: true }),
        () => disposed,
      )
        .then((data) => {
          if (disposed) return;
          if (data.provisional === true) {
            provisional.set(range, token);
            publish();
            return;
          }
          clearProvisional(range, token);
          remember(`home:${range}`, data);
        })
        .catch(() => undefined)
        .finally(() => {
          prefetching.delete(range);
          if (!disposed) publish();
        });
    }
    publish();
  }

  function beginForeground(range: RangeKey): () => void {
    const entry = foreground.get(range) ?? { count: 0, visible: false };
    foreground.set(range, entry);
    entry.count += 1;
    if (!entry.visible && entry.timer === undefined && !provisional.has(range)) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        entry.visible = true;
        publish();
      }, FOREGROUND_RING_DELAY_MS);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.count -= 1;
      if (entry.count > 0) return;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      foreground.delete(range);
      publish();
    };
  }

  function clearProvisional(range: RangeKey, token: number): void {
    const current = provisional.get(range);
    if (current === undefined || current > token) return;
    provisional.delete(range);
    publish();
  }

  return {
    pending,
    take,
    remember,
    prefetch,
    beginForeground,
    beginRead: () => ++readToken,
    noteProvisional(range: RangeKey, token: number): void {
      if (disposed) return;
      const current = provisional.get(range);
      if (current !== undefined && current > token) return;
      provisional.set(range, token);
      publish();
    },
    clearProvisional,
    dispose(): void {
      disposed = true;
      for (const entry of foreground.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      foreground.clear();
      prefetching.clear();
      provisional.clear();
      retained.clear();
      retainedBytes = 0;
      setPending(new Set<RangeKey>());
    },
  };
}
