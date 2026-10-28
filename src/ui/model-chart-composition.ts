import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsSeriesChildBucket,
  AnalyticsSeriesParentBucket,
  CostedTokens,
} from "../contracts/dashboard";
import { entityKey, oppositeDimension } from "./model-analytics";
import type { ModelChartSegment } from "./model-chart-geometry";

/**
 * On-demand in-bar composition for one parent segment.
 *
 * A parent segment keeps its exact stacked-bar envelope; entries only divide
 * that envelope while the parent is active. Token proportions use the same
 * bucket's parent total, so a sparse or incomplete entry list leaves the
 * remainder in the parent colour instead of stretching entries to fill it.
 * Known-cost proportions use only numeric entry costs and the parent's numeric
 * cost; an unpriced entry contributes no invented share.
 *
 * `entries` is sparse and already ordered by the server. One entry never
 * subdivides: a single full-height slice would be a fake distinction.
 */

export type CompositionMode = "tokens" | "cost";

export interface CompositionSlice {
  /** Entity key for the subdivided dimension, shared with its breakdown row. */
  key: string;
  identity: AnalyticsEntityIdentity;
  tokens: CostedTokens;
  /** Share of the parent segment covered by this slice, in [0, 1]. */
  share: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Neutral shade ladder over the parent series colour. It depends only on
   * slice order, never on the entity's own palette.
   */
  fillOpacity: number;
}

type CompositionSegment = Pick<ModelChartSegment, "x" | "y" | "width" | "height" | "value">;

type CompositionEntry = {
  identity: AnalyticsEntityIdentity;
  tokens: CostedTokens;
};

function buildCompositionSlices(
  input: {
    segment: CompositionSegment;
    /** The parent series bucket; its numeric cost is the cost-view denominator. */
    parentTokens?: Pick<CostedTokens, "apiEquivalentCostUsd">;
    dimension: AnalyticsDimension;
    mode?: CompositionMode;
  },
  entries: readonly CompositionEntry[],
  entryDimension: AnalyticsDimension,
): CompositionSlice[] {
  const { segment } = input;
  if (entries.length < 2) return [];

  const mode = input.mode ?? "tokens";
  const parentTokens = input.parentTokens;
  const parentCost = parentTokens?.apiEquivalentCostUsd ?? null;
  const denominator =
    mode === "tokens"
      ? Math.max(0, segment.value)
      : typeof parentCost === "number" && Number.isFinite(parentCost) && parentCost > 0
        ? parentCost
        : 0;
  if (!(denominator > 0)) return [];

  const weighted = entries
    .map((entry) => {
      const cost = entry.tokens.apiEquivalentCostUsd;
      const weight =
        mode === "tokens"
          ? Math.max(0, entry.tokens.total)
          : typeof cost === "number" && Number.isFinite(cost) && cost > 0
            ? cost
            : 0;
      return { entry, weight };
    })
    .filter((candidate) => candidate.weight > 0);
  if (weighted.length < 2) return [];

  const slices: Omit<CompositionSlice, "fillOpacity">[] = [];
  let cumulative = 0;
  for (const { entry, weight } of weighted) {
    const remaining = 1 - cumulative;
    if (!(remaining > 0)) break;
    const share = Math.min(weight / denominator, remaining);
    if (!(share > 0)) continue;
    const lower = segment.y + segment.height - cumulative * segment.height;
    const height = share * segment.height;
    slices.push({
      key: entityKey(entryDimension, entry.identity),
      identity: entry.identity,
      tokens: entry.tokens,
      share,
      x: segment.x,
      y: lower - height,
      width: segment.width,
      height,
    });
    cumulative += share;
  }
  if (slices.length < 2) return [];

  const topOpacity = 0.95;
  const bottomOpacity = 0.55;
  return slices.map((slice, index) => ({
    ...slice,
    fillOpacity:
      topOpacity - (index / Math.max(slices.length - 1, 1)) * (topOpacity - bottomOpacity),
  }));
}

/** Subdivides a top-five parent by the opposite-dimension children in one bucket. */
export function buildChildCompositionSlices(input: {
  segment: CompositionSegment;
  parentTokens?: Pick<CostedTokens, "apiEquivalentCostUsd">;
  children?: readonly AnalyticsSeriesChildBucket[];
  dimension: AnalyticsDimension;
  mode?: CompositionMode;
}): CompositionSlice[] {
  return buildCompositionSlices(input, input.children ?? [], oppositeDimension(input.dimension));
}

/**
 * Subdivides Other by the hidden same-dimension parents in one bucket.
 *
 * `parents` is sparse and emitted only by the backend for Other. The keys are
 * the exact same-dimension identities the breakdown rows already use, so a
 * hovered or focused hidden row can single out one slice without a request.
 */
export function buildParentCompositionSlices(input: {
  segment: CompositionSegment;
  parentTokens?: Pick<CostedTokens, "apiEquivalentCostUsd">;
  parents?: readonly AnalyticsSeriesParentBucket[];
  dimension: AnalyticsDimension;
  mode?: CompositionMode;
}): CompositionSlice[] {
  return buildCompositionSlices(input, input.parents ?? [], input.dimension);
}
