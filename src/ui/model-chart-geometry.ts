import type { AnalyticsBucketBoundary, AnalyticsSeries } from "../contracts/dashboard";
import {
  type AxisTick,
  axisLabelIndexes,
  buildTicks,
  type ChartSize,
  type PlotRect,
  stackedScale,
} from "./chart-geometry";

/**
 * Pure geometry for the grouped model/provider token chart.
 *
 * The chart is a stacked token-volume bar chart: one bar per range bucket and
 * one segment per ranked series. Series order comes from `rankSeries`, so the
 * caller's list-sort state cannot move a segment or change a rank colour.
 */

export const DEFAULT_MODEL_USAGE_SIZE: ChartSize = {
  width: 900,
  height: 260,
  padding: { top: 12, right: 58, bottom: 24, left: 48 },
};

const SEGMENT_GAP = 1;
const SEGMENT_RADIUS = 1;

export interface ModelChartSegment {
  seriesIndex: number;
  bucketIndex: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface ModelChartBar {
  bucketIndex: number;
  x: number;
  width: number;
  top: number;
  bottom: number;
  total: number;
  /** Bottom-to-top in rank order; zero series are absent. */
  segments: ModelChartSegment[];
}

export interface ModelChartGeometry {
  plot: PlotRect;
  slot: number;
  barWidth: number;
  /** Highest measured bucket total; never changed by presentation headroom. */
  yMax: number;
  /** Nice axis ceiling used to place bars and ticks. */
  scaleMax: number;
  bars: ModelChartBar[];
  ticks: AxisTick[];
  labelIndexes: number[];
  slotX: (index: number) => number;
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

export function buildModelChartGeometry(
  series: readonly AnalyticsSeries[],
  boundaries: readonly AnalyticsBucketBoundary[],
  size: ChartSize = DEFAULT_MODEL_USAGE_SIZE,
): ModelChartGeometry {
  const plot = plotRect(size);
  const count = boundaries.length;
  const slot = count > 0 ? plot.width / count : plot.width;
  const slotX = (index: number) => plot.left + index * slot;
  const barWidth = slot * 0.72;

  let maxBarSegments = 0;
  const bucketTotals = boundaries.map((_, bucketIndex) => {
    let total = 0;
    let segmentCount = 0;
    for (const entry of series) {
      const value = Math.max(0, entry.buckets[bucketIndex]?.total ?? 0);
      total += value;
      if (value > 0) segmentCount += 1;
    }
    maxBarSegments = Math.max(maxBarSegments, segmentCount);
    return total;
  });
  const yMax = bucketTotals.reduce((max, total) => Math.max(max, total), 0);
  const scale = yMax > 0 ? stackedScale(yMax, plot.height, maxBarSegments) : { max: 0, step: 0 };
  const scaleMax = scale.max > 0 ? scale.max : 1;
  const yFor = (value: number) => plot.bottom - (value / scaleMax) * plot.height;

  const bars: ModelChartBar[] = boundaries.map((_, bucketIndex) => {
    const x = slotX(bucketIndex) + (slot - barWidth) / 2;
    const segments: ModelChartSegment[] = [];
    let cumulative = 0;
    let nextBottom = plot.bottom;
    series.forEach((entry, seriesIndex) => {
      const value = Math.max(0, entry.buckets[bucketIndex]?.total ?? 0);
      if (!(value > 0)) return;
      const lower = yFor(cumulative);
      cumulative += value;
      const upper = yFor(cumulative);
      const height = lower - upper;
      const y = nextBottom - height;
      segments.push({
        seriesIndex,
        bucketIndex,
        value,
        x,
        y,
        width: barWidth,
        height,
        radius: Math.min(SEGMENT_RADIUS, barWidth / 2, height / 2),
      });
      nextBottom = y - SEGMENT_GAP;
    });
    return {
      bucketIndex,
      x,
      width: barWidth,
      top: segments.at(-1)?.y ?? plot.bottom,
      bottom: plot.bottom,
      total: bucketTotals[bucketIndex] ?? 0,
      segments,
    };
  });

  return {
    plot,
    slot,
    barWidth,
    yMax,
    scaleMax,
    bars,
    ticks: buildTicks(scale.max, 8, plot, scale.step),
    labelIndexes: axisLabelIndexes(count, slot, 40),
    slotX,
  };
}
