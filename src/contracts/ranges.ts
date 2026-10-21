/**
 * Range vocabulary and bucket planning (design spec §6, R28–R30).
 *
 * Browser-safe: no Node, no DOM, no `src/lib` imports. Finite ranges are exact
 * rolling intervals `[nowMs - duration, nowMs)`; interior bucket boundaries are
 * aligned to the **host machine's** local clock. A partial edge bucket is
 * clipped to the window. `lifetime` uses daily buckets from the earliest
 * activity and has no fixed bucket count.
 *
 * `timeZone` is always supplied by the caller in production (the Node host
 * resolves it once). The `"UTC"` default exists only so pure contract tests are
 * deterministic; it is not a UI convention.
 */

import { nextZonedUnitStart, startOfZonedUnit } from "./time-zone.js";

export const RANGE_KEYS = ["24h", "7d", "30d", "lifetime"] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

export const DEFAULT_RANGE_KEY: RangeKey = "7d";

export type BucketUnit = "hour" | "day";

/** Spec §5.2 `Usage["window"]`: exact half-open `[sinceMs, untilMs)` when finite. */
export interface RangeWindow {
  sinceMs?: number;
  untilMs: number;
}

export interface RangeBucketBoundary {
  startMs: number;
  endMs: number;
}

export interface RangeBucketOptions {
  /** IANA zone of the machine hosting the plugin. Production always passes it. */
  timeZone?: string;
}

const DAY_MS = 24 * 3_600_000;

const RANGE_DURATION_MS: Record<Exclude<RangeKey, "lifetime">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/** Membership set for the range-key vocabulary (identity checks, no coercion). */
const RANGE_KEY_NAMES: ReadonlySet<unknown> = new Set<unknown>(RANGE_KEYS);

export function isRangeKey(value: unknown): value is RangeKey {
  return RANGE_KEY_NAMES.has(value);
}

/** Duration of a finite range, or `null` for the forever range. */
export function rangeDurationMs(range: RangeKey): number | null {
  return range === "lifetime" ? null : RANGE_DURATION_MS[range];
}

export function rangeBucketUnit(range: RangeKey): BucketUnit {
  return range === "24h" ? "hour" : "day";
}

/** The exact rolling window `[nowMs - duration, nowMs)`; `lifetime` has no start. */
export function rangeWindow(range: RangeKey, nowMs: number): RangeWindow {
  const duration = rangeDurationMs(range);
  if (duration === null) return { untilMs: nowMs };
  return { sinceMs: nowMs - duration, untilMs: nowMs };
}

/** Guard against a pathological input producing an unbounded bucket array. */
const MAX_BUCKETS = 200_000;

/**
 * Plans the host-local bucket boundaries a range renders, ready for P3 to
 * zero-fill. Finite ranges cover the exact rolling window, so `24h` renders 24
 * hourly buckets (a local hour label may repeat or be skipped), and the daily
 * ranges render 7/8, 30/31, or a data-dependent number of lifetime buckets —
 * never a fixed cap. Daily buckets across a DST transition are 23/25 hours long.
 *
 * `earliestMs` is the earliest known activity (P3 supplies it for `lifetime`);
 * without it the forever range returns one bucket for the current local day.
 */
export function planRangeBuckets(
  range: RangeKey,
  nowMs: number,
  earliestMs?: number,
  options: RangeBucketOptions = {},
): RangeBucketBoundary[] {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite epoch-millisecond timestamp");
  }

  const timeZone = options.timeZone ?? "UTC";
  const unit = rangeBucketUnit(range);
  const window = rangeWindow(range, nowMs);
  const lifetimeStartMs =
    earliestMs !== undefined && Number.isFinite(earliestMs) && earliestMs < nowMs
      ? earliestMs
      : nowMs;
  const anchor = window.sinceMs ?? lifetimeStartMs;
  const firstStartMs = startOfZonedUnit(anchor, unit, timeZone);

  const buckets: RangeBucketBoundary[] = [];
  let startMs = firstStartMs;
  for (let guard = 0; startMs < nowMs && guard < MAX_BUCKETS; guard += 1) {
    const nextStartMs = nextZonedUnitStart(startMs, unit, timeZone);
    const endMs = Math.min(nextStartMs, nowMs);
    buckets.push({
      startMs: Math.max(startMs, window.sinceMs ?? startMs),
      endMs,
    });
    if (nextStartMs <= startMs) break;
    startMs = nextStartMs;
  }

  if (buckets.length === 0) {
    buckets.push({ startMs: firstStartMs, endMs: nowMs });
  }
  return buckets;
}
