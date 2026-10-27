import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsSeriesChildBucket,
  CostedTokens,
} from "../contracts/dashboard";
import { entityKey, oppositeDimension } from "./model-analytics";
import type { ModelChartSegment } from "./model-chart-geometry";

/**
 * On-demand in-bar composition for one parent segment.
 *
 * A parent segment keeps its exact stacked-bar envelope; children only divide
 * that envelope while the parent is active. Token proportions use the same
 * bucket's parent total, so a sparse or incomplete child list leaves the
 * remainder in the parent colour instead of stretching children to fill it.
 * Known-cost proportions use only numeric child costs and the parent's numeric
 * cost; an unpriced child contributes no invented share.
 *
 * `children` is sparse and already ordered by the server. One child never
 * subdivides: a single full-height slice would be a fake distinction.
 */

export type CompositionMode = "tokens" | "cost";

export interface ChildCompositionSlice {
  /** Opposite-dimension identity key, shared with breakdown child rows. */
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
   * slice order, never on the opposite entity's own palette.
   */
  fillOpacity: number;
}

type CompositionSegment = Pick<ModelChartSegment, "x" | "y" | "width" | "height" | "value">;

export function buildChildCompositionSlices(input: {
  segment: CompositionSegment;
  /** The parent series bucket; its numeric cost is the cost-view denominator. */
  parentTokens?: Pick<CostedTokens, "apiEquivalentCostUsd">;
  children?: readonly AnalyticsSeriesChildBucket[];
  dimension: AnalyticsDimension;
  mode?: CompositionMode;
}): ChildCompositionSlice[] {
  const { segment } = input;
  const children = input.children ?? [];
  if (children.length < 2) return [];

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

  const weighted = children
    .map((child) => {
      const cost = child.tokens.apiEquivalentCostUsd;
      const weight =
        mode === "tokens"
          ? Math.max(0, child.tokens.total)
          : typeof cost === "number" && Number.isFinite(cost) && cost > 0
            ? cost
            : 0;
      return { child, weight };
    })
    .filter((entry) => entry.weight > 0);
  if (weighted.length < 2) return [];

  const slices: Omit<ChildCompositionSlice, "fillOpacity">[] = [];
  let cumulative = 0;
  for (const { child, weight } of weighted) {
    const remaining = 1 - cumulative;
    if (!(remaining > 0)) break;
    const share = Math.min(weight / denominator, remaining);
    if (!(share > 0)) continue;
    const lower = segment.y + segment.height - cumulative * segment.height;
    const height = share * segment.height;
    slices.push({
      key: entityKey(oppositeDimension(input.dimension), child.identity),
      identity: child.identity,
      tokens: child.tokens,
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
