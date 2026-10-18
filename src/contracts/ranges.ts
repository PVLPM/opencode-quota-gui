/**
 * Range vocabulary and bucket planning (design spec §6, R28–R30).
 *
 * Browser-safe: no Node, no DOM, no `src/lib` imports. Finite ranges are exact
 * rolling intervals `[nowMs - duration, nowMs)`; interior bucket boundaries are
 * UTC-aligned; a partial edge bucket is clipped to the window. `lifetime` uses
 * daily buckets from the earliest activity and has no fixed bucket count; with
 * no activity at all it returns one bucket for the current UTC day.
 */

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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RANGE_DURATION_MS: Record<Exclude<RangeKey, "lifetime">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value);
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

/** Epoch milliseconds rounded down to a UTC-aligned multiple (hours or days). */
function utcFloor(ms: number, unitMs: number): number {
  return Math.floor(ms / unitMs) * unitMs;
}

/**
 * Plans the UTC-aligned bucket boundaries a range renders, ready for P3 to
 * zero-fill. Finite ranges cover the exact rolling window, so `24h` renders
 * 24 or 25 hourly buckets and the daily ranges render 7/8, 30/31, or a
 * data-dependent number of lifetime buckets — never a fixed cap.
 *
 * `earliestMs` is the earliest known activity (P3 supplies it for `lifetime`);
 * without it the forever range returns one bucket for the current UTC day.
 */
export function planRangeBuckets(
  range: RangeKey,
  nowMs: number,
  earliestMs?: number,
): RangeBucketBoundary[] {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite epoch-millisecond timestamp");
  }

  const unitMs = rangeBucketUnit(range) === "hour" ? HOUR_MS : DAY_MS;
  const window = rangeWindow(range, nowMs);
  const lifetimeStartMs =
    earliestMs !== undefined && Number.isFinite(earliestMs) && earliestMs < nowMs
      ? earliestMs
      : nowMs;
  const firstStartMs =
    window.sinceMs === undefined
      ? utcFloor(lifetimeStartMs, unitMs)
      : utcFloor(window.sinceMs, unitMs);

  const buckets: RangeBucketBoundary[] = [];
  for (let startMs = firstStartMs; startMs < nowMs; startMs += unitMs) {
    buckets.push({
      startMs: Math.max(startMs, window.sinceMs ?? startMs),
      endMs: Math.min(startMs + unitMs, nowMs),
    });
  }

  if (buckets.length === 0) {
    buckets.push({ startMs: firstStartMs, endMs: nowMs });
  }
  return buckets;
}
