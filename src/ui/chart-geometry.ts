import type { Bucket, StepPoint, TokenStack } from "../contracts/dashboard";
import { TOKEN_CATEGORIES } from "./format";

/**
 * Chart geometry (design spec §6, §10; R31, R32, R48).
 *
 * Pure number crunching, no DOM: the stacked-area chart, its totals-only
 * fallback decision, and the two session series all come from here, so the
 * chart's honesty rules are unit-testable.
 */

export const CATEGORY_KEYS: readonly (keyof TokenStack)[] = TOKEN_CATEGORIES.map(
  (category) => category.key,
);

/** A slice thinner than this share of its bucket is invisible at any plot height. */
export const THIN_SLICE_SHARE = 0.005;

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
  for (let value = 0; value <= yMax + step / 2; value += step) {
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

/**
 * The totals-only series: one band from the baseline to the stacked total,
 * used when stacking would be unreadable (R32).
 */
export function buildTotalsBand(geometry: UsageGeometry): StackBand {
  return {
    key: "input",
    colorVar: "--qg-token-total",
    xs: geometry.bands[0]?.xs ?? [],
    upper: geometry.totalEdgeY,
    lower: (geometry.bands[0]?.xs ?? []).map(() => geometry.plot.bottom),
  };
}

/**
 * Totals-only fallback (R32, frontend-only).
 *
 * Stacking earns its complexity only when it shows something: if the window
 * uses fewer than two categories, or a used category is a sub-pixel sliver in
 * every bucket it appears in, the chart falls back to one totals series. The
 * numbers, the legend and the tooltip are unchanged either way.
 */
export function shouldUseTotalsFallback(buckets: Bucket[]): boolean {
  const used = new Set<keyof TokenStack>();
  let anyValue = false;
  const invisibleEverywhere = new Map<keyof TokenStack, boolean>();

  for (const bucket of buckets) {
    const total = bucket.tokens.total;
    if (total <= 0) continue;
    anyValue = true;
    for (const key of CATEGORY_KEYS) {
      const value = bucket.tokens[key];
      if (value <= 0) continue;
      used.add(key);
      const visible = value / total >= THIN_SLICE_SHARE;
      invisibleEverywhere.set(key, (invisibleEverywhere.get(key) ?? true) && !visible);
    }
  }

  if (!anyValue) return false;
  if (used.size < 2) return true;
  for (const key of used) {
    if (invisibleEverywhere.get(key) === true) return true;
  }
  return false;
}

export const DEFAULT_SESSION_SIZE: ChartSize = {
  width: 900,
  height: 240,
  padding: { top: 12, right: 12, bottom: 24, left: 48 },
};

/** One unbroken run: a branch line breaks across sessions, never summing context. */
export interface SeriesRun {
  sessionId: string;
  branch: number;
  points: { x: number; y: number }[];
}

export interface StepGeometry {
  plot: PlotRect;
  stepCount: number;
  yMax: number;
  ticks: AxisTick[];
  contextRuns: SeriesRun[];
  totalRuns: SeriesRun[];
  compaction: { x: number; atMs: number; sessionId: string }[];
  stepX: (index: number) => number;
  labelIndexes: number[];
}

/**
 * Arc-length x axis: one step is one x unit, so a dense session never squashes
 * a sparse one. Both series cover the opened session and every descendant step.
 */
export function buildStepGeometry(
  steps: StepPoint[],
  compactions: { sessionId: string; atMs: number }[],
  size: ChartSize = DEFAULT_SESSION_SIZE,
): StepGeometry {
  const plot = plotRect(size);
  const count = steps.length;
  const stepX = (index: number) =>
    plot.left + (count <= 1 ? plot.width / 2 : (index / (count - 1)) * plot.width);
  const yMaxRaw = steps.reduce(
    (max, step) => Math.max(max, step.totalTokens, step.contextTokens),
    0,
  );
  const yMax = yMaxRaw > 0 ? yMaxRaw : 1;
  const yFor = (value: number) => plot.bottom - (value / yMax) * plot.height;

  const contextRuns: SeriesRun[] = [];
  const totalRuns: SeriesRun[] = [];

  const pushRun = (
    runs: SeriesRun[],
    run: SeriesRun | undefined,
    step: StepPoint,
    index: number,
  ) => {
    const point = { x: stepX(index), y: 0 };
    if (!run) {
      const created: SeriesRun = {
        sessionId: step.sessionId,
        branch: step.branch,
        points: [point],
      };
      runs.push(created);
      return created;
    }
    run.points.push(point);
    return run;
  };

  let contextRun: SeriesRun | undefined;
  let totalRun: SeriesRun | undefined;
  steps.forEach((step, index) => {
    if (
      contextRun &&
      (contextRun.sessionId !== step.sessionId || contextRun.branch !== step.branch)
    ) {
      contextRun = undefined;
    }
    if (totalRun && (totalRun.sessionId !== step.sessionId || totalRun.branch !== step.branch)) {
      totalRun = undefined;
    }
    contextRun = pushRun(contextRuns, contextRun, step, index);
    totalRun = pushRun(totalRuns, totalRun, step, index);
    const lastContext = contextRun.points[contextRun.points.length - 1];
    if (lastContext) lastContext.y = yFor(step.contextTokens);
    const lastTotal = totalRun.points[totalRun.points.length - 1];
    if (lastTotal) lastTotal.y = yFor(step.totalTokens);
  });

  const compaction = compactions.map((marker) => {
    const firstAtOrAfter = steps.findIndex(
      (step) => step.sessionId === marker.sessionId && step.atMs >= marker.atMs,
    );
    const fallback = steps.findIndex((step) => step.sessionId === marker.sessionId);
    const index = firstAtOrAfter >= 0 ? firstAtOrAfter : Math.max(fallback, 0);
    return { x: stepX(index), atMs: marker.atMs, sessionId: marker.sessionId };
  });

  return {
    plot,
    stepCount: count,
    yMax: yMaxRaw,
    ticks: buildTicks(yMaxRaw, 4, plot),
    contextRuns,
    totalRuns,
    compaction,
    stepX,
    labelIndexes: pickLabelIndexes(count, Math.max(2, Math.min(6, Math.floor(plot.width / 64)))),
  };
}

/** SVG path for a polyline run. */
export function toLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0] as { x: number; y: number };
    return `M ${only.x.toFixed(2)} ${only.y.toFixed(2)}`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

/** Closed SVG path for one stacked band. */
export function toBandPath(band: StackBand): string {
  const upperPoints = band.xs
    .map((x, index) => ({ x, y: band.upper[index] ?? 0 }))
    .map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
  const lowerPoints = band.xs
    .map((x, index) => ({ x, y: band.lower[index] ?? 0 }))
    .reverse()
    .map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
  if (upperPoints.length === 0) return "";
  return `M ${upperPoints.join(" L ")} L ${lowerPoints.join(" L ")} Z`;
}
