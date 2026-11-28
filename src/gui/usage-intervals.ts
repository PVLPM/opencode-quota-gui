/**
 * Pure quota-usage interval derivation (v1.4.0 D4/D5/D6).
 *
 * Input is one series' stored runs (and, for `current`, enough history to
 * contain the latest epoch). Output is a `UsageWindowSeries`-shaped window with
 * points, links, intervals and coverage. Attribution is intentionally empty:
 * workstreams C/F fill activity, estimates and breakdown rows.
 *
 * Axis choice: `current` starts at the latest epoch's known start — a proven
 * exact provider reset, otherwise the first point of that epoch — and ends at
 * `now`, extended to the latest known reset time when that is still in the
 * future (so the chart shows the whole window). The part of the window before
 * the first observation stays axis space: no point and no interval is invented
 * for it. Finite ranges are `[now - duration, now]`; `lifetime` is
 * `[first observed, max(now, last observed)]` so stored points are never
 * dropped. A caller deriving `current` passes enough history to contain the
 * latest epoch *and* the run that opened it.
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
  UsageResetPrecision,
  UsageSource,
  UsageWindowSeries,
} from "../contracts/usage.js";
import type { UsageStoredRun } from "../lib/usage-store.js";

/** Store rows may already carry the recorder's precision column. */
type UsageStoredRunWithPrecision = UsageStoredRun & { reset_precision?: UsageResetPrecision };

/** One stored run, in the shape the store query returns. */
export interface UsageSamplePoint {
  firstAtMs: number;
  lastAtMs: number;
  remainingPercent: number;
  sampleCount: number;
  resetAtMs?: number;
  /** Absent means exact, keeping existing series backward compatible. */
  resetPrecision?: UsageResetPrecision;
  /** Evidence that this run continues the previous run under observation. */
  linked: boolean;
  /** Normalized identity: quantity unit and/or percent capacity + plan. */
  unitKey?: string;
}

/** Conflicting-sample evidence: the stored run cannot be trusted at `atMs`. */
export interface UsageConflictPoint {
  atMs: number;
  remainingPercent: number;
}

export interface UsageSeriesInput {
  rowId: RowId;
  label: string;
  metric?: AccountingMetric;
  measurement: UsageMeasurementKind;
  points: readonly UsageSamplePoint[];
  /** Provenance of the stored series (`opencode-poll`, `codex-import`, ...). */
  source?: UsageSource;
  /** Conflicts render as `uncertain` boundaries, never as stored steps. */
  conflicts?: readonly UsageConflictPoint[];
  /**
   * `unconfirmed`: the source names no account, so a decrease between two
   * runs may be an account switch. Such a drop becomes an `uncertain`
   * boundary instead of measured consumption; the points stay.
   */
  accountContinuity?: "unconfirmed";
}

export interface UsageAxisInput {
  range: UsageRangeKey;
  nowMs: number;
  /** Resolved finite span; defaults to the range length ending at `nowMs`. */
  span?: { startMs: number; endMs: number };
}

/** Store runs to the pure input shape; capacity/unit become identity keys. */
export function usagePointsFromRuns(
  runs: readonly UsageStoredRunWithPrecision[],
): UsageSamplePoint[] {
  return runs.map((run) => {
    const identity = [
      ...(run.quantity !== undefined ? [JSON.stringify(run.quantity.unit)] : []),
      ...(run.capacityKey !== undefined ? [run.capacityKey] : []),
    ];
    return {
      firstAtMs: run.firstAtMs,
      lastAtMs: run.lastAtMs,
      remainingPercent: run.remainingPercent,
      sampleCount: run.sampleCount,
      ...(run.resetAtMs !== undefined ? { resetAtMs: run.resetAtMs } : {}),
      ...(run.reset_precision === "exact" || run.reset_precision === "estimated"
        ? { resetPrecision: run.reset_precision }
        : {}),
      linked: run.linked,
      ...(identity.length > 0 ? { unitKey: identity.join("|") } : {}),
    };
  });
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
 * at/after that boundary, and the new boundary is later.
 *
 * Exact timestamps keep the original rule and fix the marker at the earlier
 * boundary. Estimated boundaries (`now + offset`, e.g. MiniMax or OpenAI
 * `reset_after_seconds`) jitter forward by about a poll interval, so time
 * alone cannot prove a rollover. For those, a reset additionally needs either
 * an observed remaining increase or a boundary that jumped past the whole gap
 * between the observations. If either side is estimated, the estimated rule is
 * used (conservative); the marker has no exact time.
 */
function provenReset(
  previous: UsageSamplePoint,
  current: UsageSamplePoint,
): { atMs?: number } | undefined {
  if (previous.resetAtMs === undefined || current.resetAtMs === undefined) return undefined;
  if (previous.lastAtMs > previous.resetAtMs) return undefined;
  if (current.firstAtMs < previous.resetAtMs) return undefined;
  if (!(current.resetAtMs > previous.resetAtMs)) return undefined;
  if (previous.resetPrecision === "estimated" || current.resetPrecision === "estimated") {
    const gapMs = Math.max(0, current.firstAtMs - previous.lastAtMs);
    const remainingIncreased = current.remainingPercent > previous.remainingPercent;
    const boundaryRolledForward = current.resetAtMs > previous.resetAtMs + gapMs;
    if (!remainingIncreased && !boundaryRolledForward) return undefined;
    return {};
  }
  return { atMs: previous.resetAtMs };
}

function boundaryBetween(
  previous: UsageSamplePoint,
  current: UsageSamplePoint,
): { kind: UsageBoundaryKind; atMs?: number } | undefined {
  const reset = provenReset(previous, current);
  if (reset !== undefined) {
    return { kind: "reset", ...(reset.atMs !== undefined ? { atMs: reset.atMs } : {}) };
  }
  if (previous.unitKey !== current.unitKey) return { kind: "identity-change" };
  // The earlier epoch's known boundary is already in the past, but the later
  // observation carries no reset evidence at all: whether it still belongs to
  // that window cannot be established, so the change between them is never a
  // measured consumption. Estimated boundaries follow the same rule, because
  // the rollover may have happened anywhere inside the gap.
  if (
    current.resetAtMs === undefined &&
    previous.resetAtMs !== undefined &&
    previous.lastAtMs <= previous.resetAtMs &&
    current.firstAtMs >= previous.resetAtMs
  ) {
    return { kind: "uncertain" };
  }
  if (current.remainingPercent > previous.remainingPercent) {
    return previous.resetAtMs === undefined && current.resetAtMs === undefined
      ? { kind: "uncertain" }
      : { kind: "replenished" };
  }
  return undefined;
}

function linkBetween(
  previous: UsageSamplePoint,
  current: UsageSamplePoint,
  conflicts: readonly UsageConflictPoint[],
  accountContinuity: UsageSeriesInput["accountContinuity"],
): UsageLink {
  const conflict = conflicts.find(
    (item) => item.atMs >= previous.firstAtMs && item.atMs <= current.firstAtMs,
  );
  if (conflict !== undefined) {
    return { kind: "boundary", boundary: "uncertain", atMs: conflict.atMs };
  }
  const boundary = boundaryBetween(previous, current);
  if (boundary !== undefined) {
    return {
      kind: "boundary",
      boundary: boundary.kind,
      ...(boundary.atMs !== undefined ? { atMs: boundary.atMs } : {}),
    };
  }
  // Without a confirmed account, equal readings claim nothing, but a drop
  // could belong to a different subscription, so it is never a burn.
  if (accountContinuity === "unconfirmed" && current.remainingPercent < previous.remainingPercent) {
    return { kind: "boundary", boundary: "uncertain" };
  }
  return { kind: current.linked ? "observed" : "unobserved" };
}

function overlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

interface UsageEpochStart {
  index: number;
  /**
   * Exact provider reset that opened this epoch. Present only when the reset is
   * proven and its instant is a provider timestamp, never an estimate.
   */
  resetAtMs?: number;
}

function epochStarts(
  points: readonly UsageSamplePoint[],
  conflicts: readonly UsageConflictPoint[],
): UsageEpochStart[] {
  const starts: UsageEpochStart[] = [{ index: 0 }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as UsageSamplePoint;
    const point = points[index] as UsageSamplePoint;
    if (conflicts.some((item) => item.atMs >= previous.firstAtMs && item.atMs <= point.firstAtMs)) {
      starts.push({ index });
      continue;
    }
    const boundary = boundaryBetween(previous, point);
    if (boundary === undefined) continue;
    starts.push(
      boundary.kind === "reset" && boundary.atMs !== undefined
        ? { index, resetAtMs: boundary.atMs }
        : { index },
    );
  }
  return starts;
}

function includedIndexes(
  points: readonly UsageSamplePoint[],
  input: UsageAxisInput,
  conflicts: readonly UsageConflictPoint[],
): { indexes: number[]; axis: { startMs: number; endMs: number } } {
  if (points.length === 0) {
    const startMs = input.span?.startMs ?? input.nowMs;
    const endMs = input.span?.endMs ?? input.nowMs;
    return { indexes: [], axis: { startMs, endMs } };
  }

  if (input.range === "current") {
    const starts = epochStarts(points, conflicts);
    const latestEpoch = starts[starts.length - 1] ?? { index: 0 };
    const latestStart = latestEpoch.index;
    const first = points[latestStart] as UsageSamplePoint;
    const last = points[points.length - 1] as UsageSamplePoint;
    const resetAtMs = last.resetAtMs;
    if (
      resetAtMs !== undefined &&
      // An estimated reset (`now + offset`) is not enough to expire the epoch:
      // the boundary may only have jittered past the clock. Expire only on an
      // absolute provider reset with no observation after it.
      last.resetPrecision !== "estimated" &&
      resetAtMs <= input.nowMs &&
      !points.slice(latestStart).some((point) => point.firstAtMs >= resetAtMs)
    ) {
      // The scheduled reset passed and nothing was observed after it, so the
      // last epoch is expired. Do not label it "current"; show its empty
      // successor axis instead.
      return { indexes: [], axis: { startMs: resetAtMs, endMs: input.nowMs } };
    }
    const indexes = points.map((_, index) => index).slice(latestStart);
    // A proven exact reset fixes where the window began, so the axis covers the
    // unobserved prefix instead of starting at the first observation. Without
    // one (estimated reset, replenishment, identity change, conflict) the start
    // stays unknown and the first observation remains the start.
    const startMs =
      latestEpoch.resetAtMs !== undefined && latestEpoch.resetAtMs < first.firstAtMs
        ? latestEpoch.resetAtMs
        : first.firstAtMs;
    return {
      indexes,
      axis: {
        startMs,
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

/**
 * Inspectable intervals in chronological order: each positive-length flat run
 * followed by the gap up to the next point. A run that straddles the axis start
 * is clipped to the axis and keeps its flat (zero) burn; an out-of-range
 * predecessor is never turned into an interval, so no out-of-range burn enters
 * the range. Zero-duration intervals are never emitted because the activity
 * query requires `endMs > startMs`.
 */
function buildIntervals(
  points: readonly UsagePoint[],
  links: readonly UsageLink[],
  axis: { startMs: number; endMs: number },
  conflictAtByPoint: readonly (number | undefined)[] = [],
): UsageInterval[] {
  const intervals: UsageInterval[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] as UsagePoint;
    const flatStartMs = Math.max(point.startMs, axis.startMs);
    const flatEndMs = Math.min(point.endMs, axis.endMs);
    const conflictAtMs = conflictAtByPoint[index];
    if (flatEndMs > flatStartMs || (flatEndMs === flatStartMs && conflictAtMs !== undefined)) {
      intervals.push({
        fromPoint: index,
        toPoint: index,
        startMs: flatStartMs,
        endMs: flatEndMs,
        previousRemainingPercent: point.remainingPercent,
        currentRemainingPercent: point.remainingPercent,
        // Conflicting evidence inside the flat run makes that span uncertain.
        // The measured endpoints remain in `points`; the burn is unknown.
        link: conflictAtMs === undefined ? "observed" : "boundary",
        burnPercentPoints: conflictAtMs === undefined ? 0 : null,
        attributedBurnPercentPoints: 0,
        unattributedBurnPercentPoints: 0,
        ...(conflictAtMs !== undefined ? { conflictAtMs } : {}),
        activity: [],
      });
    }

    if (index >= points.length - 1) continue;
    const current = points[index + 1] as UsagePoint;
    const link = links[index] as UsageLink;
    const startMs = Math.max(point.endMs, axis.startMs);
    const endMs = Math.min(current.startMs, axis.endMs);
    if (endMs <= startMs) continue;
    const burn =
      link.kind === "boundary"
        ? null
        : Math.max(0, point.remainingPercent - current.remainingPercent);
    intervals.push({
      fromPoint: index,
      toPoint: index + 1,
      startMs,
      endMs,
      previousRemainingPercent: point.remainingPercent,
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

/**
 * Finite-range sample count without pro-rating. A run wholly inside the span
 * contributes its recorded sample count; a partially overlapping run contributes
 * only its endpoints that fall inside (so a run covering the whole span with no
 * endpoint inside contributes none). Current/lifetime axes contain their points,
 * so those keep every run's count.
 */
function sampleCountInside(
  points: readonly UsageSamplePoint[],
  axis: { startMs: number; endMs: number },
  finite: boolean,
): number {
  let count = 0;
  for (const point of points) {
    if (!finite) {
      count += point.sampleCount;
      continue;
    }
    if (point.firstAtMs >= axis.startMs && point.lastAtMs <= axis.endMs) {
      count += point.sampleCount;
      continue;
    }
    if (point.firstAtMs >= axis.startMs && point.firstAtMs <= axis.endMs) count += 1;
    if (
      point.lastAtMs !== point.firstAtMs &&
      point.lastAtMs >= axis.startMs &&
      point.lastAtMs <= axis.endMs
    ) {
      count += 1;
    }
  }
  return count;
}

export function buildUsageWindowSeries(
  input: UsageSeriesInput,
  axisInput: UsageAxisInput,
): UsageWindowSeries {
  const sorted = sortPoints(input.points);
  const conflicts = [...(input.conflicts ?? [])].sort((left, right) => left.atMs - right.atMs);
  const { indexes, axis } = includedIndexes(sorted, axisInput, conflicts);
  const included = indexes.map((index) => sorted[index] as UsageSamplePoint);

  const conflictsAt = included.map(
    (point) =>
      conflicts.find((item) => item.atMs >= point.firstAtMs && item.atMs <= point.lastAtMs)?.atMs,
  );
  const points: UsagePoint[] = included.map((point) => ({
    startMs: point.firstAtMs,
    endMs: point.lastAtMs,
    remainingPercent: point.remainingPercent,
    sampleCount: point.sampleCount,
    ...(point.resetAtMs !== undefined ? { resetAtMs: point.resetAtMs } : {}),
    source: input.source ?? "opencode-poll",
  }));

  const links: UsageLink[] = [];
  for (let position = 1; position < included.length; position += 1) {
    links.push(
      linkBetween(
        included[position - 1] as UsageSamplePoint,
        included[position] as UsageSamplePoint,
        conflicts,
        input.accountContinuity,
      ),
    );
  }

  const intervals = buildIntervals(points, links, axis, conflictsAt);
  const includedConflicts = conflicts
    .filter((conflict) =>
      included.some((point) => conflict.atMs >= point.firstAtMs && conflict.atMs <= point.lastAtMs),
    )
    .map((conflict) => ({ atMs: conflict.atMs }));
  const observedBurn = intervals.reduce(
    (total, interval) => total + (interval.burnPercentPoints ?? 0),
    0,
  );

  let observedMs = 0;
  included.forEach((point, index) => {
    // A run that contains conflicting evidence is not continuously observed;
    // its measured endpoints stay points but the flat span is uncertain.
    if (conflictsAt[index] !== undefined) return;
    observedMs += overlap(point.firstAtMs, point.lastAtMs, axis.startMs, axis.endMs);
  });
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
      sampleCount: sampleCountInside(
        included,
        axis,
        axisInput.range === "24h" || axisInput.range === "7d" || axisInput.range === "30d",
      ),
    },
    points,
    links,
    intervals,
    ...(includedConflicts.length > 0 ? { conflicts: includedConflicts } : {}),
    totals: {
      observedBurnPercentPoints: observedBurn,
      attributedBurnPercentPoints: 0,
      unattributedBurnPercentPoints: observedBurn,
    },
    breakdown: [],
  };
}
