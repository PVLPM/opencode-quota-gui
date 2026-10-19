import type { Bucket, SessionSnapshot, TokenStack } from "../contracts/dashboard";
import { TOKEN_CATEGORIES } from "./format";

/**
 * Chart geometry (design spec §6, §10; R31, R32, R48).
 *
 * Pure number crunching, no DOM: the five stacked areas and the two session
 * series all come from here, so the
 * chart's honesty rules are unit-testable.
 */

export const CATEGORY_KEYS: readonly (keyof TokenStack)[] = TOKEN_CATEGORIES.map(
  (category) => category.key,
);

export interface ChartSize {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_USAGE_SIZE: ChartSize = {
  width: 900,
  height: 260,
  padding: { top: 12, right: 12, bottom: 24, left: 48 },
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

/**
 * Stacked bands as pixel polylines. Every band covers the full plot width: the
 * pixel x axis carries the two slot edges around the bucket centres so the area
 * never floats away from the frame.
 */
export interface StackBand {
  key: keyof TokenStack;
  colorVar: string;
  xs: number[];
  upper: number[];
  lower: number[];
}

export interface UsageGeometry {
  plot: PlotRect;
  bucketCount: number;
  slot: number;
  totalLine: { x: number; y: number }[];
  bands: StackBand[];
  yMax: number;
  ticks: AxisTick[];
  pointIndexes: number[];
  labelIndexes: number[];
  /** Y pixel of the stacked total at a bucket index. */
  totalY: number[];
  /** `totalY` padded with the two slot edges, so a fill can reach the frame. */
  totalEdgeY: number[];
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

  const xs = [plot.left, ...buckets.map((_, index) => slotX(index) + slot / 2), plot.right];
  const bands: StackBand[] = CATEGORY_KEYS.map((key) => {
    const descriptor = TOKEN_CATEGORIES.find((category) => category.key === key);
    return {
      key,
      colorVar: descriptor?.colorVar ?? "--qg-token-input",
      xs,
      upper: [],
      lower: [],
    };
  });

  const totalY: number[] = [];
  buckets.forEach((bucket, bucketIndex) => {
    let cumulative = 0;
    for (const band of bands) {
      const value = bucket.tokens[band.key];
      const lower = yFor(cumulative);
      cumulative += value;
      const upper = yFor(cumulative);
      band.lower.push(lower);
      band.upper.push(upper);
      // The slot edges repeat the first/last bucket so the area reaches the frame.
      if (bucketIndex === 0) {
        band.lower.unshift(lower);
        band.upper.unshift(upper);
      }
      if (bucketIndex === buckets.length - 1) {
        band.lower.push(lower);
        band.upper.push(upper);
      }
    }
    totalY.push(yFor(bucket.tokens.total));
  });

  const firstTotal = totalY[0] ?? plot.bottom;
  const lastTotal = totalY[totalY.length - 1] ?? plot.bottom;
  const totalEdgeY = totalY.length > 0 ? [firstTotal, ...totalY, lastTotal] : [];
  const totalLine = xs.map((x, index) => ({ x, y: totalEdgeY[index] ?? plot.bottom }));

  return {
    plot,
    bucketCount: count,
    slot,
    totalLine,
    bands,
    yMax: yMaxRaw,
    ticks: buildTicks(yMaxRaw, 4, plot),
    pointIndexes: buckets.map((_, index) => index),
    labelIndexes: pickLabelIndexes(count, Math.max(2, Math.min(6, Math.floor(plot.width / 64)))),
    totalY,
    totalEdgeY,
    slotX,
    bucketIndexAt,
  };
}

export const DEFAULT_SESSION_SIZE: ChartSize = {
  width: 900,
  height: 240,
  padding: { top: 34, right: 56, bottom: 26, left: 52 },
};

export interface SessionSeriesPoint {
  x: number;
  y: number;
  value: number;
  stepIndex: number;
}

/**
 * One measured series against its own y domain. `linePath` and `areaPath` are
 * pre-computed monotone curves so both the renderer and tests see the exact
 * geometry that ships.
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
  focusStepCount: number;
  /** Focus-session context only, on the left axis. May rise and fall. */
  context: SessionSeries;
  /** Running consumption over every scoped step, on the right axis. */
  total: SessionSeries;
  /** Context per step index; `undefined` outside the focus session. */
  contextValues: (number | undefined)[];
  /** Cumulative consumption at every step index; never decreases. */
  cumulativeValues: number[];
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
): SessionSeries {
  const domainMax = values.reduce((max, point) => Math.max(max, point.value), 0);
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
 * The session chart has two independent honesty rules:
 *
 * - Context is the focus session's own `input + cache read + cache write` at
 *   each of its completed steps. Child-session context is never stitched into
 *   this line, so compaction drops stay visible and meaningful.
 * - Total consumption is a running prefix sum over every scoped step (the
 *   focus session plus its descendants, in chronological order). Compaction
 *   and branch changes never reset or subtract it.
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
  const cumulativeValues: number[] = [];
  const contextRaw: { stepIndex: number; x: number; value: number }[] = [];
  const totalRaw: { stepIndex: number; x: number; value: number }[] = [];
  let cumulative = 0;

  source.forEach((step, index) => {
    cumulative += nonNegative(step.totalTokens);
    cumulativeValues.push(cumulative);
    totalRaw.push({ stepIndex: index, x: stepX(index), value: cumulative });
    if (step.sessionId === snapshot.focusSessionId) {
      const context = nonNegative(step.contextTokens);
      contextValues[index] = context;
      contextRaw.push({ stepIndex: index, x: stepX(index), value: context });
    }
  });

  const compaction: SessionCompactionTick[] = [];
  if (count > 0) {
    for (const marker of snapshot.compactionMarkers) {
      const firstAtOrAfter = source.findIndex(
        (step) => step.sessionId === marker.sessionId && step.atMs >= marker.atMs,
      );
      const fallback = source.findIndex((step) => step.sessionId === marker.sessionId);
      const index = firstAtOrAfter >= 0 ? firstAtOrAfter : Math.max(fallback, 0);
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
    focusStepCount: contextRaw.length,
    context: buildSessionSeries(contextRaw, plot),
    total: buildSessionSeries(totalRaw, plot),
    contextValues,
    cumulativeValues,
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

/**
 * Shared zero-tangent cubic interpolation. Every boundary uses the same convex
 * smoothstep weights, so adjacent bands share their exact edge and ordered
 * boundaries cannot cross, even when a category is zero beside a sharp spike.
 * Full-precision coordinates preserve tiny categories rather than rounding them
 * to an artificial minimum height (or erasing them at two decimal places).
 */
function monotoneBoundary(xs: number[], ys: number[], reverse: boolean): string {
  const indexes = xs.map((_, index) => index);
  if (reverse) indexes.reverse();
  let result = "";
  for (let position = 1; position < indexes.length; position += 1) {
    const previous = indexes[position - 1] as number;
    const current = indexes[position] as number;
    const x0 = xs[previous] as number;
    const x1 = xs[current] as number;
    const y0 = ys[previous] ?? 0;
    const y1 = ys[current] ?? 0;
    const dx = (x1 - x0) / 3;
    result += ` C ${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}`;
  }
  return result;
}

/** Closed monotone SVG area; upper/lower edges are shared cumulative boundaries. */
export function toBandPath(band: StackBand): string {
  if (band.upper.length === 0 || band.xs.length === 0) return "";
  const last = band.xs.length - 1;
  return `M ${band.xs[0]} ${band.upper[0]}${monotoneBoundary(band.xs, band.upper, false)} L ${band.xs[last]} ${band.lower[last]}${monotoneBoundary(band.xs, band.lower, true)} Z`;
}
