import type { CostedTokens, ProjectActivityRow, Usage } from "../contracts/dashboard";

/**
 * One project's pre-aggregated contribution across the home chart's buckets.
 * The buckets are aligned index-for-index with `Usage.buckets`; hovering or
 * focusing the project row must never trigger a rollup or a network read.
 */
export interface ProjectChartComposition {
  readonly projectId: string;
  readonly label: string;
  readonly buckets: readonly CostedTokens[];
  readonly totals: CostedTokens;
}

/**
 * Build the chart composition from the existing home payload. Older servers
 * omit `project.buckets`; the row then keeps its aggregate-only behaviour.
 */
export function createProjectChartComposition(
  usage: Usage,
  project: ProjectActivityRow,
): ProjectChartComposition | undefined {
  const buckets = project.buckets;
  if (buckets === undefined || buckets.length !== usage.buckets.length) return undefined;
  return {
    projectId: project.projectId,
    label: project.name,
    buckets,
    totals: project.tokens,
  };
}

/** The selected project's contribution in one aligned chart bucket. */
export function compositionBucket(
  composition: ProjectChartComposition | undefined,
  bucketIndex: number,
): CostedTokens | undefined {
  if (composition === undefined) return undefined;
  if (!Number.isInteger(bucketIndex) || bucketIndex < 0) return undefined;
  return composition.buckets[bucketIndex];
}

/** A truthful share of one bucket; a zero or invalid denominator has none. */
export function compositionTokenShare(part: number, total: number): number | undefined {
  if (!Number.isFinite(part) || !Number.isFinite(total) || part <= 0 || total <= 0) {
    return undefined;
  }
  return Math.min(1, part / total);
}

export interface CostContributionState {
  /** The project's usage itself has a numeric API-equivalent cost. */
  readonly priced: boolean;
  /** Some of the project's usage is unpriced or unknown, so its cost is incomplete. */
  readonly partial: boolean;
  /** The project's whole visible usage has no numeric API-equivalent cost. */
  readonly unpriced: boolean;
  /** Both this project and the chart total are fully priced, even at $0. */
  readonly complete: boolean;
  /**
   * The project's share of the range estimate. Only present when both the
   * project and the chart total are fully priced; a partially priced side has
   * no truthful denominator.
   */
  readonly share?: number;
}

function fullyPriced(tokens: CostedTokens): boolean {
  return (
    tokens.total > 0 &&
    tokens.apiEquivalentCostUsd !== null &&
    Number.isFinite(tokens.apiEquivalentCostUsd) &&
    tokens.unpricedTokens === 0 &&
    tokens.unknownTokens === 0
  );
}

/**
 * Cost composition never invents a share. A partial or unpriced project, or a
 * partial chart total, keeps its known value visible but reports no percentage.
 */
export function costContribution(
  project: CostedTokens,
  total: CostedTokens,
): CostContributionState {
  const priced = project.total > 0 && project.apiEquivalentCostUsd !== null;
  const partial =
    project.total > 0 && priced && (project.unpricedTokens > 0 || project.unknownTokens > 0);
  const unpriced = project.total > 0 && project.apiEquivalentCostUsd === null;
  const totalCost = total.apiEquivalentCostUsd;
  const complete = fullyPriced(project) && fullyPriced(total);
  const share =
    complete && totalCost !== null && totalCost > 0
      ? (project.apiEquivalentCostUsd as number) / totalCost
      : undefined;
  return {
    priced,
    partial,
    unpriced,
    complete,
    ...(share === undefined ? {} : { share }),
  };
}
