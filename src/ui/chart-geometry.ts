import type { Bucket, SessionSnapshot, TokenStack } from "../contracts/dashboard";
import { type CategoryDescriptor, TOKEN_CATEGORIES } from "./format";

/**
 * Chart geometry (design spec §6, §10; R31, R32, R48).
 *
 * Pure number crunching, no DOM: the shared stacked bars, the cache-rate line
 * and the two session series all come from here, so the chart's honesty rules
 * are unit-testable.
 */

export interface ChartSize {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_USAGE_SIZE: ChartSize = {
  width: 900,
  height: 260,
  padding: { top: 12, right: 46, bottom: 24, left: 48 },
};

export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

export interface AxisTick {
  value: number;
  y: number;
}

/** One truthfully scaled segment inside a bucket's vertical stack. */
export interface UsageBarSegment {
  key: keyof TokenStack;
  colorVar: string;
  bucketIndex: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in chart units, constrained so thin segments stay visible. */
  radius: number;
}

export interface UsageBar {
  bucketIndex: number;
  x: number;
  width: number;
  /**
   * Actual top of the rounded stack. External presentation gaps can put this
   * up to four units above `yFor(total)`; the token total itself is unchanged.
   */
  top: number;
  bottom: number;
  total: number;
  /** Bottom-to-top in the fixed category order; zero categories are absent. */
  segments: UsageBarSegment[];
}

export interface CacheRatePoint {
  x: number;
  y: number;
  value: number;
  bucketIndex: number;
}

export interface UsageGeometry {
  plot: PlotRect;
  bucketCount: number;
  slot: number;
  barWidth: number;
  bars: UsageBar[];
  /** Only categories with a nonzero total in this exact range. */
  visibleCategories: CategoryDescriptor[];
  /** Cache-hit-rate overlay points; a bucket with no input-side traffic is absent. */
  cacheRatePoints: CacheRatePoint[];
  /** One smooth path per contiguous non-null cache-rate run. */
  cacheRatePath: string;
  /** Fixed 0..100% right-axis ticks. */
  cacheRateTicks: AxisTick[];
  yMax: number;
  ticks: AxisTick[];
  pointIndexes: number[];
  labelIndexes: number[];
  /** Left edge pixel of a bucket slot; the hit areas use these. */
  slotX: (index: number) => number;
  bucketIndexAt: (x: number) => number;
}

function plotRect(size: ChartSize): PlotRect {
  const width = Math.max(size.width - size.padding.left - size.padding.right, 1);
  const height = Math.max(size.height - size.padding.top - size.padding.bottom, 1);
  return {
    left: size.padding.left,
    top: size.padding.top,
    width,
    height,
    bottom: size.padding.top + height,
    right: size.padding.left + width,
  };
}

/** Round tick steps: 1/2/5 × 10ⁿ, so axis labels stay readable. */
export function niceTickStep(span: number, targetTicks: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / Math.max(targetTicks, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function buildTicks(yMax: number, ticks: number, plot: PlotRect): AxisTick[] {
  if (yMax <= 0) return [{ value: 0, y: plot.bottom }];
  const step = niceTickStep(yMax, ticks);
  const result: AxisTick[] = [];
  for (let value = 0; value <= yMax; value += step) {
    result.push({ value, y: plot.bottom - (value / yMax) * plot.height });
  }
  return result;
}

/** At most `max` evenly spaced label positions, always including both ends. */
export function pickLabelIndexes(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (max - 1);
  const indexes = new Set<number>();
  for (let index = 0; index < max; index += 1) indexes.add(Math.round(index * step));
  indexes.add(0);
  indexes.add(count - 1);
  return [...indexes].sort((a, b) => a - b);
}

/**
 * External presentation gaps sit between rounded segments, never on top of
 * them. One chart unit is the smallest deliberate separation at the 900-unit
 * design width; it scales with the SVG rather than claiming to be a screen px.
 */
const USAGE_SEGMENT_GAP = 1;
const USAGE_SEGMENT_RADIUS = 2;

export function buildUsageGeometry(
  buckets: Bucket[],
  size: ChartSize = DEFAULT_USAGE_SIZE,
): UsageGeometry {
  const plot = plotRect(size);
  const count = buckets.length;
  const slot = count > 0 ? plot.width / count : plot.width;
  const yMaxRaw = buckets.reduce((max, bucket) => Math.max(max, bucket.tokens.total), 0);
  const yMax = yMaxRaw > 0 ? yMaxRaw : 1;
  const yFor = (value: number) => plot.bottom - (value / yMax) * plot.height;
  const slotX = (index: number) => plot.left + index * slot;
  const bucketIndexAt = (x: number) =>
    count === 0 ? 0 : Math.min(count - 1, Math.max(0, Math.floor((x - plot.left) / slot)));

  // Range-local eligibility: a category whose total is zero in this exact
  // range disappears completely, and returns when another range has activity.
  const visibleCategories = TOKEN_CATEGORIES.filter((category) =>
    buckets.some((bucket) => bucket.tokens[category.key] > 0),
  );
  // A fixed fraction of the slot stays truthful at every density: dense
  // lifetime ranges keep subpixel, non-overlapping bars, and sparse ranges do
  // not get an artificial width floor or cap.
  const barWidth = slot * 0.72;

  const bars: UsageBar[] = [];
  buckets.forEach((bucket, bucketIndex) => {
    const x = slotX(bucketIndex) + (slot - barWidth) / 2;
    let cumulative = 0;
    let nextBottom = plot.bottom;
    const segments: UsageBarSegment[] = [];
    for (const category of visibleCategories) {
      const value = Math.max(0, bucket.tokens[category.key]);
      if (!(value > 0)) continue;
      const lower = yFor(cumulative);
      cumulative += value;
      const upper = yFor(cumulative);
      const height = lower - upper;
      const y = nextBottom - height;
      segments.push({
        key: category.key,
        colorVar: category.colorVar,
        bucketIndex,
        value,
        x,
        y,
        width: barWidth,
        height,
        radius: Math.min(USAGE_SEGMENT_RADIUS, barWidth / 2, height / 2),
      });
      nextBottom = y - USAGE_SEGMENT_GAP;
    }
    bars.push({
      bucketIndex,
      x,
      width: barWidth,
      top: segments.at(-1)?.y ?? plot.bottom,
      bottom: plot.bottom,
      total: bucket.tokens.total,
      segments,
    });
  });

  const cacheRatePoints: CacheRatePoint[] = [];
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (!bucket) continue;
    const rate = cacheHitRate(bucket.tokens);
    if (rate === null) continue;
    cacheRatePoints.push({
      x: slotX(index) + slot / 2,
      y: plot.bottom - (rate / 100) * plot.height,
      value: rate,
      bucketIndex: index,
    });
  }
  const rateRuns: CacheRatePoint[][] = [];
  for (const point of cacheRatePoints) {
    const run = rateRuns.at(-1);
    if (run && point.bucketIndex === (run.at(-1)?.bucketIndex ?? -2) + 1) run.push(point);
    else rateRuns.push([point]);
  }
  const cacheRatePath = rateRuns
    .map((run) => {
      const path = toMonotoneLinePath(run);
      const point = run[0];
      return run.length === 1 && point
        ? `${path} L ${coordinate(point.x)} ${coordinate(point.y)}`
        : path;
    })
    .filter((path) => path.length > 0)
    .join(" ");
  const cacheRateTicks: AxisTick[] = [0, 25, 50, 75, 100].map((value) => ({
    value,
    y: plot.bottom - (value / 100) * plot.height,
  }));

  return {
    plot,
    bucketCount: count,
    slot,
    barWidth,
    bars,
    visibleCategories,
    cacheRatePoints,
    cacheRatePath,
    cacheRateTicks,
    yMax: yMaxRaw,
    ticks: buildTicks(yMaxRaw, 4, plot),
    pointIndexes: buckets.map((_, index) => index),
    labelIndexes: pickLabelIndexes(count, Math.max(2, Math.min(6, Math.floor(plot.width / 64)))),
    slotX,
    bucketIndexAt,
  };
}

/**
 * `cacheRead / (input + cacheRead + cacheWrite)`. Cache writes are input-side
 * traffic but never cache hits, so they belong in the denominator. No traffic
 * has no meaningful rate: `null`, not a manufactured 0%.
 */
export function cacheHitRate(tokens: TokenStack): number | null {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (!(denominator > 0)) return null;
  return (tokens.cacheRead / denominator) * 100;
}

export const DEFAULT_SESSION_SIZE: ChartSize = {
  width: 900,
  height: 240,
  padding: { top: 34, right: 56, bottom: 34, left: 52 },
};

export interface SessionSeriesPoint {
  x: number;
  y: number;
  value: number;
  stepIndex: number;
}

/**
 * One session series against its own or a supplied shared y domain. `linePath`
 * and `areaPath` are pre-computed monotone curves so both the renderer and
 * tests see the exact geometry that ships.
 */
export interface SessionSeries {
  points: SessionSeriesPoint[];
  linePath: string;
  areaPath: string;
  domainMax: number;
  ticks: AxisTick[];
}

export interface SessionCompactionTick {
  x: number;
  atMs: number;
  sessionId: string;
  stepIndex: number;
}

export interface SessionChartGeometry {
  plot: PlotRect;
  stepCount: number;
  /** Real focus-session steps; carried context on descendants does not add here. */
  focusStepCount: number;
  /** True when the scoped tree has any node or step outside the focus session. */
  hasDescendants: boolean;
  /** Focus-session context on the left axis, carried through descendants. */
  context: SessionSeries;
  /** Prefix sum for the focused session only, on the shared right axis. */
  own: SessionSeries;
  /** Prefix sum for every scoped step, on the shared right axis. */
  tree: SessionSeries;
  /**
   * Context per step index. Carried focus values are defined on descendant
   * steps; values before the first focus sample remain undefined.
   */
  contextValues: (number | undefined)[];
  /** Own-session cumulative value at every step index; flat on descendants. */
  ownCumulativeValues: number[];
  /** Tree cumulative value at every step index; never decreases. */
  treeCumulativeValues: number[];
  /** One shared right-axis scale for both cumulative series. */
  cumulativeTicks: AxisTick[];
  compaction: SessionCompactionTick[];
  stepX: (index: number) => number;
  labelIndexes: number[];
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function coordinate(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

/**
 * Fritsch–Carlson monotone cubic: smooth where the data allows it and flat at
 * local extrema, so a curve never overshoots or invents a negative value.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const count = xs.length;
  const dx: number[] = [];
  const slope: number[] = [];
  const tangent = new Array<number>(count).fill(0);
  for (let index = 0; index < count - 1; index += 1) {
    const width = (xs[index + 1] as number) - (xs[index] as number);
    dx.push(width);
    slope.push(width > 0 ? ((ys[index + 1] as number) - (ys[index] as number)) / width : 0);
  }
  if (count === 2) {
    tangent[0] = slope[0] as number;
    tangent[1] = slope[0] as number;
    return tangent;
  }
  tangent[0] = slope[0] as number;
  tangent[count - 1] = slope[count - 2] as number;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slope[index - 1] as number;
    const current = slope[index] as number;
    if (previous === 0 || current === 0 || previous * current < 0) {
      tangent[index] = 0;
      continue;
    }
    const w1 = 2 * (dx[index] as number) + (dx[index - 1] as number);
    const w2 = (dx[index] as number) + 2 * (dx[index - 1] as number);
    tangent[index] = (w1 + w2) / (w1 / previous + w2 / current);
  }
  // Clamp tangents to the Fritsch–Carlson circle of monotonicity.
  for (let index = 0; index < count - 1; index += 1) {
    const current = slope[index] as number;
    if (current === 0) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }
    const alpha = (tangent[index] as number) / current;
    const beta = (tangent[index + 1] as number) / current;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangent[index] = scale * alpha * current;
      tangent[index + 1] = scale * beta * current;
    }
  }
  return tangent;
}

function toMonotoneLinePath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return toLinePath([...points]);
  for (let index = 1; index < points.length; index += 1) {
    if (!((points[index] as { x: number }).x > (points[index - 1] as { x: number }).x)) {
      return toLinePath([...points]);
    }
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const tangents = monotoneTangents(xs, ys);
  let path = `M ${coordinate(xs[0] as number)} ${coordinate(ys[0] as number)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const x0 = xs[index] as number;
    const x1 = xs[index + 1] as number;
    const y0 = ys[index] as number;
    const y1 = ys[index + 1] as number;
    const third = (x1 - x0) / 3;
    path += ` C ${coordinate(x0 + third)} ${coordinate(y0 + (tangents[index] as number) * third)} ${coordinate(x1 - third)} ${coordinate(y1 - (tangents[index + 1] as number) * third)} ${coordinate(x1)} ${coordinate(y1)}`;
  }
  return path;
}

function toAreaPath(
  points: readonly { x: number; y: number }[],
  linePath: string,
  baseline: number,
): string {
  if (points.length < 2) return "";
  const first = points[0] as { x: number };
  const last = points[points.length - 1] as { x: number };
  return `${linePath} L ${coordinate(last.x)} ${coordinate(baseline)} L ${coordinate(first.x)} ${coordinate(baseline)} Z`;
}

function buildSessionSeries(
  values: { stepIndex: number; x: number; value: number }[],
  plot: PlotRect,
  domainMaxOverride?: number,
): SessionSeries {
  const measuredMax = values.reduce((max, point) => Math.max(max, point.value), 0);
  const domainMax = domainMaxOverride ?? measuredMax;
  const scaleMax = domainMax > 0 ? domainMax : 1;
  const points: SessionSeriesPoint[] = values.map((point) => ({
    ...point,
    y: plot.bottom - (point.value / scaleMax) * plot.height,
  }));
  const linePath = toMonotoneLinePath(points);
  return {
    points,
    linePath,
    areaPath: toAreaPath(points, linePath, plot.bottom),
    domainMax,
    ticks: buildTicks(domainMax, 4, plot),
  };
}

/**
 * Context and cumulative consumption answer different questions:
 *
 * - Context is the focus session's own `input + cache read + cache write` on
 *   its completed steps. On descendant steps the most recent focus value is
 *   carried forward, never borrowed from the child context. Values before the
 *   first focus sample stay unknown, and compaction drops remain visible at
 *   the next real focus measurement.
 * - Own cumulative consumption is a prefix sum over focus-session steps only.
 *   It holds flat through descendant steps and never resets at compaction.
 * - Tree cumulative consumption is a prefix sum over every scoped step (the
 *   focus session plus its descendants, in chronological order). Compaction
 *   and branch changes never reset or subtract it.
 *
 * Own and tree share one right-axis domain so the gap between them is honest.
 * Context keeps its independent left-axis domain.
 */
export function buildSessionChartGeometry(
  snapshot: SessionSnapshot,
  size: ChartSize = DEFAULT_SESSION_SIZE,
): SessionChartGeometry {
  const plot = plotRect(size);
  const source = snapshot.steps;
  const count = source.length;
  const stepX = (index: number) => {
    if (count <= 1) return plot.left + plot.width / 2;
    const clamped = Math.min(Math.max(index, 0), count - 1);
    return plot.left + (clamped / (count - 1)) * plot.width;
  };

  const contextValues = new Array<number | undefined>(count);
  const ownCumulativeValues: number[] = [];
  const treeCumulativeValues: number[] = [];
  const contextRaw: { stepIndex: number; x: number; value: number }[] = [];
  const ownRaw: { stepIndex: number; x: number; value: number }[] = [];
  const treeRaw: { stepIndex: number; x: number; value: number }[] = [];
  let lastFocusContext: number | undefined;
  let focusStepCount = 0;
  let ownCumulative = 0;
  let treeCumulative = 0;

  source.forEach((step, index) => {
    const x = stepX(index);
    const isFocus = step.sessionId === snapshot.focusSessionId;
    if (isFocus) {
      lastFocusContext = nonNegative(step.contextTokens);
      contextValues[index] = lastFocusContext;
      contextRaw.push({ stepIndex: index, x, value: lastFocusContext });
      focusStepCount += 1;
    } else if (lastFocusContext !== undefined) {
      // Carry the last real focus measurement; never borrow child context.
      contextValues[index] = lastFocusContext;
      contextRaw.push({ stepIndex: index, x, value: lastFocusContext });
    }

    const total = nonNegative(step.totalTokens);
    treeCumulative += total;
    if (isFocus) ownCumulative += total;
    ownCumulativeValues.push(ownCumulative);
    treeCumulativeValues.push(treeCumulative);
    ownRaw.push({ stepIndex: index, x, value: ownCumulative });
    treeRaw.push({ stepIndex: index, x, value: treeCumulative });
  });

  const hasDescendants =
    snapshot.nodes.some((node) => node.sessionId !== snapshot.focusSessionId) ||
    source.some((step) => step.sessionId !== snapshot.focusSessionId);
  const cumulativeMax = Math.max(ownCumulative, treeCumulative);
  const own = buildSessionSeries(ownRaw, plot, cumulativeMax);
  const tree = buildSessionSeries(treeRaw, plot, cumulativeMax);

  const compaction: SessionCompactionTick[] = [];
  if (count > 0) {
    for (const marker of snapshot.compactionMarkers) {
      // Markers explain drops in the focus-context series only. A marker with
      // no scoped focus step cannot be placed truthfully and is skipped rather
      // than snapped onto an unrelated descendant step.
      if (marker.sessionId !== snapshot.focusSessionId) continue;
      const index = source.findIndex(
        (step) => step.sessionId === marker.sessionId && step.atMs >= marker.atMs,
      );
      // A marker after the final focus step has no truthful step-index position:
      // the axis is step based, so snapping it backward would draw the drop at
      // the beginning of the graph. Leave it out instead.
      if (index < 0) continue;
      compaction.push({
        x: stepX(index),
        atMs: marker.atMs,
        sessionId: marker.sessionId,
        stepIndex: index,
      });
    }
  }

  return {
    plot,
    stepCount: count,
    focusStepCount,
    hasDescendants,
    context: buildSessionSeries(contextRaw, plot),
    own,
    tree,
    contextValues,
    ownCumulativeValues,
    treeCumulativeValues,
    cumulativeTicks: tree.ticks,
    compaction,
    stepX,
    labelIndexes: pickLabelIndexes(count, Math.max(2, Math.min(6, Math.floor(plot.width / 64)))),
  };
}

/** SVG path for a polyline run. */
function toLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0] as { x: number; y: number };
    return `M ${only.x.toFixed(2)} ${only.y.toFixed(2)}`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}
