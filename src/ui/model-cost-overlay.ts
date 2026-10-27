import type {
  AnalyticsBucketBoundary,
  AnalyticsSeries,
  CostedTokens,
} from "../contracts/dashboard";
import { type AxisTick, buildTicks, niceScale, toMonotoneLinePath } from "./chart-geometry";
import { combineEstimates } from "./model-analytics";
import type { ModelChartGeometry } from "./model-chart-geometry";

/**
 * Geometry for the API-equivalent cost line over the model/provider token
 * chart. Numeric buckets (including a true zero) share one scale and one line;
 * unpriced/empty buckets are gaps, never zero points. Single numeric buckets
 * become short isolated marks, never dots.
 */

export type BucketCostStatus = "empty" | "unpriced" | "priced" | "partial" | "zero";

export interface ModelCostOverlayPoint {
  bucketIndex: number;
  /** Bucket centre, shared with the token bar's slot. */
  x: number;
  /** Plotted y in the token chart's plot; null for unpriced/empty buckets. */
  y: number | null;
  total: number;
  cost: number | null;
  status: BucketCostStatus;
}

export interface ModelCostOverlayRun {
  /** One smooth path for a contiguous numeric run. */
  path: string;
  pointCount: number;
  /** True when any point in this run has incomplete pricing. */
  partial: boolean;
  firstBucketIndex: number;
  lastBucketIndex: number;
}

export interface ModelCostOverlayGeometry {
  points: ModelCostOverlayPoint[];
  runs: ModelCostOverlayRun[];
  /** A numeric bucket with no numeric neighbour on either side. */
  isolated: ModelCostOverlayPoint[];
  /** Right-axis ticks on the same plot as the token bars. */
  ticks: AxisTick[];
  tickStep: number;
  scaleMax: number;
  maxCost: number;
  hasNumeric: boolean;
  hasPartial: boolean;
  hasUnpriced: boolean;
}

function statusOf(
  estimate: Pick<
    CostedTokens,
    "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens"
  >,
): BucketCostStatus {
  if (!(estimate.total > 0)) return "empty";
  if (estimate.apiEquivalentCostUsd === null) return "unpriced";
  // Incomplete pricing wins over a zero subtotal: a priced portion of zero must
  // not read as a complete free bucket.
  if (estimate.unpricedTokens > 0 || estimate.unknownTokens > 0) return "partial";
  if (estimate.apiEquivalentCostUsd === 0) return "zero";
  return "priced";
}

export function buildModelCostOverlayGeometry(
  series: readonly AnalyticsSeries[],
  boundaries: readonly AnalyticsBucketBoundary[],
  chart: Pick<ModelChartGeometry, "slot" | "slotX" | "plot">,
): ModelCostOverlayGeometry {
  const estimates = boundaries.map((_, bucketIndex) => {
    const tokens = series
      .map((entry) => entry.buckets[bucketIndex])
      .filter((entry): entry is CostedTokens => entry !== undefined);
    return combineEstimates(tokens);
  });
  const maxCost = estimates.reduce(
    (max, estimate) =>
      estimate.apiEquivalentCostUsd === null ? max : Math.max(max, estimate.apiEquivalentCostUsd),
    0,
  );
  const scale =
    maxCost > 0 ? niceScale(maxCost, { targetTicks: 4, allowExact: true }) : { max: 0, step: 0 };
  const scaleMax = scale.max > 0 ? scale.max : 1;
  const points: ModelCostOverlayPoint[] = estimates.map((estimate, bucketIndex) => {
    const status = statusOf(estimate);
    const cost = estimate.apiEquivalentCostUsd;
    const numeric = status === "priced" || status === "partial" || status === "zero";
    const y =
      numeric && cost !== null ? chart.plot.bottom - (cost / scaleMax) * chart.plot.height : null;
    return {
      bucketIndex,
      x: chart.slotX(bucketIndex) + chart.slot / 2,
      y,
      total: estimate.total,
      cost,
      status,
    };
  });

  const runs: ModelCostOverlayRun[] = [];
  const isolated: ModelCostOverlayPoint[] = [];
  let run: ModelCostOverlayPoint[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      isolated.push(run[0] as ModelCostOverlayPoint);
    } else {
      runs.push({
        path: toMonotoneLinePath(run.map((point) => ({ x: point.x, y: point.y as number }))),
        pointCount: run.length,
        partial: run.some((point) => point.status === "partial"),
        firstBucketIndex: run[0]?.bucketIndex as number,
        lastBucketIndex: run.at(-1)?.bucketIndex as number,
      });
    }
    run = [];
  };
  for (const point of points) {
    if (point.y !== null) run.push(point);
    else flush();
  }
  flush();

  return {
    points,
    runs,
    isolated,
    ticks: buildTicks(scale.max, 4, chart.plot, scale.step),
    tickStep: scale.step,
    scaleMax: scale.max,
    maxCost,
    hasNumeric: points.some((point) => point.y !== null),
    hasPartial: points.some((point) => point.status === "partial"),
    hasUnpriced: points.some((point) => point.status === "unpriced"),
  };
}
