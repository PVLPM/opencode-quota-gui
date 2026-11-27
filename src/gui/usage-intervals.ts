/**
 * Pure quota-usage interval derivation (v1.4.0 D4/D5/D6).
 *
 * Input is one series' stored runs (and, for `current`, enough history to
 * contain the latest epoch). Output is a `UsageWindowSeries`-shaped window with
 * points, links, intervals and coverage. Attribution is intentionally empty:
 * workstreams C/F fill activity, estimates and breakdown rows.
 *
 * Axis choice: `current` starts at the first point of the latest epoch and ends
 * at `now`, extended to the latest known reset time when that is still in the
 * future (so the chart shows the whole window). Finite ranges are
 * `[now - duration, now]`; `lifetime` is `[first observed, max(now, last
 * observed)]` so stored points are never dropped.
 */
import type { AccountingMetric } from "../contracts/dashboard.js";
import type { RowId } from "../contracts/identity.js";
import type {
  UsageBoundaryKind,
  UsageInterval,
  UsageLink,
  UsageMeasurementKind,
  UsagePoint,
  UsageRangeKey,
  UsageWindowSeries,
} from "../contracts/usage.js";
import type { UsageStoredRun } from "../lib/usage-store.js";

/** One stored run, in the shape the store query returns. */
export interface UsageSamplePoint {
  firstAtMs: number;
  lastAtMs: number;
  remainingPercent: number;
  sampleCount: number;
  resetAtMs?: number;
  /** Evidence that this run continues the previous run under observation. */
  linked: boolean;
  /** Normalized quantity unit identity, when the row carries one. */
  unitKey?: string;
}

export interface UsageSeriesInput {
  rowId: RowId;
  label: string;
  metric?: AccountingMetric;
  measurement: UsageMeasurementKind;
  points: readonly UsageSamplePoint[];
}

export interface UsageAxisInput {
  range: UsageRangeKey;
  nowMs: number;
  /** Resolved finite span; defaults to the range length ending at `nowMs`. */
  span?: { startMs: number; endMs: number };
}

/** Store runs to the pure input shape; quantity units become identity keys. */
export function usagePointsFromRuns(runs: readonly UsageStoredRun[]): UsageSamplePoint[] {
  return runs.map((run) => ({
    firstAtMs: run.firstAtMs,
    lastAtMs: run.lastAtMs,
    remainingPercent: run.remainingPercent,
    sampleCount: run.sampleCount,
    ...(run.resetAtMs !== undefined ? { resetAtMs: run.resetAtMs } : {}),
    linked: run.linked,
    ...(run.quantity !== undefined ? { unitKey: JSON.stringify(run.quantity.unit) } : {}),
  }));
}

const RANGE_DURATION_MS: Partial<Record<UsageRangeKey, number>> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function finiteDuration(range: UsageRangeKey): number {
  const duration = RANGE_DURATION_MS[range];
  if (duration === undefined) throw new RangeError(`range ${range} has no fixed duration`);
  return duration;
}

function sortPoints(points: readonly UsageSamplePoint[]): UsageSamplePoint[] {
  return points
    .map((point, index) => ({ point, index }))
    .sort(
      (left, right) =>
        left.point.firstAtMs - right.point.firstAtMs ||
        left.point.lastAtMs - right.point.lastAtMs ||
        left.index - right.index,
    )
    .map((entry) => entry.point);
}

/**
 * Proven scheduled reset, reusing the rule of
 * `src/lib/quota-reset-notifications.ts` (`updateObservation`): the previous
 * observation was taken before its reset boundary, the later observation is
 * at/after that boundary, and the new boundary is later. The marker time is the
 * earlier reset boundary.
 */
function provenResetAtMs(
  previous: UsageSamplePoint,
  current: UsageSamplePoint,
): number | undefined {
  if (previous.resetAtMs === undefined || current.resetAtMs === undefined) return undefined;
  if (previous.lastAtMs > previous.resetAtMs) return undefined;
  if (current.firstAtMs < previous.resetAtMs) return undefined;
  if (!(current.resetAtMs > previous.resetAtMs)) return undefined;
  return previous.resetAtMs;
}

function boundaryBetween(
  previous: UsageSamplePoint,
  current: UsageSamplePoint,
): { kind: UsageBoundaryKind; atMs?: number } | undefined {
  const resetAtMs = provenResetAtMs(previous, current);
  if (resetAtMs !== undefined) return { kind: "reset", atMs: resetAtMs };
  if (previous.unitKey !== current.unitKey) return { kind: "identity-change" };
  if (current.remainingPercent > previous.remainingPercent) {
    return previous.resetAtMs === undefined && current.resetAtMs === undefined
      ? { kind: "uncertain" }
      : { kind: "replenished" };
  }
  return undefined;
}

function linkBetween(previous: UsageSamplePoint, current: UsageSamplePoint): UsageLink {
  const boundary = boundaryBetween(previous, current);
  if (boundary !== undefined) {
    return {
      kind: "boundary",
      boundary: boundary.kind,
      ...(boundary.atMs !== undefined ? { atMs: boundary.atMs } : {}),
    };
  }
  return { kind: current.linked ? "observed" : "unobserved" };
}

function overlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function epochStarts(points: readonly UsageSamplePoint[]): number[] {
  const starts: number[] = [];
  points.forEach((point, index) => {
    if (index === 0) {
      starts.push(0);
      return;
    }
    const previous = points[index - 1] as UsageSamplePoint;
    if (boundaryBetween(previous, point) !== undefined) starts.push(index);
  });
  return starts;
}

function includedIndexes(
  points: readonly UsageSamplePoint[],
  input: UsageAxisInput,
): { indexes: number[]; axis: { startMs: number; endMs: number } } {
  if (points.length === 0) {
    const startMs = input.span?.startMs ?? input.nowMs;
    const endMs = input.span?.endMs ?? input.nowMs;
    return { indexes: [], axis: { startMs, endMs } };
  }

  if (input.range === "current") {
    const starts = epochStarts(points);
    const latestStart = starts[starts.length - 1] ?? 0;
    const indexes = points.map((_, index) => index).slice(latestStart);
    const first = points[latestStart] as UsageSamplePoint;
    const last = points[points.length - 1] as UsageSamplePoint;
    const resetAtMs = last.resetAtMs;
    return {
      indexes,
      axis: {
        startMs: first.firstAtMs,
        endMs: resetAtMs !== undefined && resetAtMs > input.nowMs ? resetAtMs : input.nowMs,
      },
    };
  }

  if (input.range === "lifetime") {
    const first = points[0] as UsageSamplePoint;
    const last = points[points.length - 1] as UsageSamplePoint;
    return {
      indexes: points.map((_, index) => index),
      axis: { startMs: first.firstAtMs, endMs: Math.max(input.nowMs, last.lastAtMs) },
    };
  }

  const span = input.span ?? {
    startMs: input.nowMs - finiteDuration(input.range),
    endMs: input.nowMs,
  };
  const indexes: number[] = [];
  points.forEach((point, index) => {
    if (point.lastAtMs >= span.startMs && point.firstAtMs <= span.endMs) indexes.push(index);
  });
  return { indexes, axis: { startMs: span.startMs, endMs: span.endMs } };
}

function buildIntervals(
  points: readonly UsagePoint[],
  links: readonly UsageLink[],
): UsageInterval[] {
  if (points.length === 1) {
    const only = points[0] as UsagePoint;
    return [
      {
        fromPoint: 0,
        toPoint: 0,
        startMs: only.startMs,
        endMs: only.endMs,
        previousRemainingPercent: only.remainingPercent,
        currentRemainingPercent: only.remainingPercent,
        link: "observed",
        burnPercentPoints: 0,
        attributedBurnPercentPoints: 0,
        unattributedBurnPercentPoints: 0,
        activity: [],
      },
    ];
  }

  const intervals: UsageInterval[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index] as UsagePoint;
    const current = points[index + 1] as UsagePoint;
    const link = links[index] as UsageLink;
    const burn =
      link.kind === "boundary"
        ? null
        : Math.max(0, previous.remainingPercent - current.remainingPercent);
    intervals.push({
      fromPoint: index,
      toPoint: index + 1,
      startMs: previous.endMs,
      endMs: current.startMs,
      previousRemainingPercent: previous.remainingPercent,
      currentRemainingPercent: current.remainingPercent,
      link: link.kind,
      burnPercentPoints: burn,
      attributedBurnPercentPoints: 0,
      unattributedBurnPercentPoints: burn ?? 0,
      ...(link.kind === "unobserved" ? { unattributedReason: "unobserved-interval" as const } : {}),
      activity: [],
    });
  }
  return intervals;
}

export function buildUsageWindowSeries(
  input: UsageSeriesInput,
  axisInput: UsageAxisInput,
): UsageWindowSeries {
  const sorted = sortPoints(input.points);
  const { indexes, axis } = includedIndexes(sorted, axisInput);
  const included = indexes.map((index) => sorted[index] as UsageSamplePoint);

  const points: UsagePoint[] = included.map((point) => ({
    startMs: point.firstAtMs,
    endMs: point.lastAtMs,
    remainingPercent: point.remainingPercent,
    sampleCount: point.sampleCount,
    ...(point.resetAtMs !== undefined ? { resetAtMs: point.resetAtMs } : {}),
    source: "opencode-poll",
  }));

  const links: UsageLink[] = [];
  for (let position = 1; position < included.length; position += 1) {
    links.push(
      linkBetween(
        included[position - 1] as UsageSamplePoint,
        included[position] as UsageSamplePoint,
      ),
    );
  }

  const intervals = buildIntervals(points, links);
  const observedBurn = intervals.reduce(
    (total, interval) => total + (interval.burnPercentPoints ?? 0),
    0,
  );

  let observedMs = 0;
  for (const point of included) {
    observedMs += overlap(point.firstAtMs, point.lastAtMs, axis.startMs, axis.endMs);
  }
  for (let position = 0; position < links.length; position += 1) {
    if ((links[position] as UsageLink).kind !== "observed") continue;
    const previous = included[position] as UsageSamplePoint;
    const current = included[position + 1] as UsageSamplePoint;
    observedMs += overlap(previous.lastAtMs, current.firstAtMs, axis.startMs, axis.endMs);
  }

  const first = included[0];
  const last = included[included.length - 1];
  return {
    rowId: input.rowId,
    label: input.label,
    ...(input.metric !== undefined ? { metric: input.metric } : {}),
    measurement: input.measurement,
    axis,
    coverage: {
      ...(first !== undefined ? { firstObservedAtMs: first.firstAtMs } : {}),
      ...(last !== undefined ? { lastObservedAtMs: last.lastAtMs } : {}),
      observedMs,
      sampleCount: included.reduce((total, point) => total + point.sampleCount, 0),
    },
    points,
    links,
    intervals,
    totals: {
      observedBurnPercentPoints: observedBurn,
      attributedBurnPercentPoints: 0,
      unattributedBurnPercentPoints: observedBurn,
    },
    breakdown: [],
  };
}
