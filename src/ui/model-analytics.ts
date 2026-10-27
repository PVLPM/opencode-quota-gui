import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupRow,
  AnalyticsSeries,
  CostedTokens,
} from "../contracts/dashboard";
import { resolveProviderPresentation } from "./provider-catalog";

/**
 * Presentation rules for grouped model/provider analytics.
 *
 * Nothing here changes identity: a known raw id travels unchanged into route
 * tokens and list keys, and only its visible label may come from the provider
 * catalog. Chart ranking is token-only; the breakdown's Cost | Tokens control
 * is a separate list concern and never feeds back into series order.
 */

export const API_EQUIVALENT_TOOLTIP =
  "API-equivalent estimate based on model pricing. Not actual billed spend.";

export const RANK_COLOR_VARS = [
  "--qg-rank-1",
  "--qg-rank-2",
  "--qg-rank-3",
  "--qg-rank-4",
  "--qg-rank-5",
] as const;

export const OTHER_COLOR_VAR = "--qg-rank-other";

export type BreakdownSort = "cost" | "tokens";

export function identityKey(identity: AnalyticsEntityIdentity): string {
  return identity.kind === "unknown" ? "unknown" : `known:${identity.id}`;
}

export function sameIdentity(
  left: AnalyticsEntityIdentity,
  right: AnalyticsEntityIdentity,
): boolean {
  if (left.kind === "unknown") return right.kind === "unknown";
  return right.kind === "known" && left.id === right.id;
}

/** Keys are internal only; the route token remains the exact reversible encoding. */
export function entityKey(
  dimension: AnalyticsDimension,
  identity: AnalyticsEntityIdentity,
): string {
  return `${dimension}:${identityKey(identity)}`;
}

export function seriesKey(series: AnalyticsSeries, dimension: AnalyticsDimension): string {
  return series.kind === "other" ? "other" : entityKey(dimension, series.identity);
}

/**
 * The chart series a breakdown row belongs to. Rows outside the chart's five
 * ranked entities are already aggregated into Other, so their row emphasis and
 * hover must target that series rather than dim every bar with no match.
 */
export function rowSeriesKey(
  dimension: AnalyticsDimension,
  identity: AnalyticsEntityIdentity,
  seriesKeys?: readonly string[],
): string {
  const key = entityKey(dimension, identity);
  if (seriesKeys === undefined || seriesKeys.length === 0) return key;
  return seriesKeys.includes(key) ? key : "other";
}

export function dimensionNoun(dimension: AnalyticsDimension): string {
  return dimension === "model" ? "model" : "provider";
}

export function usageTitle(dimension: AnalyticsDimension): string {
  return `Usage by ${dimensionNoun(dimension)}`;
}

/**
 * Visible identity text. `unknown` is an explicit missing value; a known empty
 * or whitespace id is still known and gets a distinct label. Provider labels
 * may come from the catalog, but the raw id remains the identity and the link.
 */
export function identityLabel(
  identity: AnalyticsEntityIdentity,
  dimension: AnalyticsDimension,
): string {
  const noun = dimensionNoun(dimension);
  if (identity.kind === "unknown") return `Unknown ${noun}`;
  if (identity.id.trim().length === 0) return `Empty ${noun} ID`;
  return dimension === "provider" ? resolveProviderPresentation(identity.id).label : identity.id;
}

function rawIdText(id: string): string {
  return id.trim().length === 0 ? JSON.stringify(id) : id;
}

/**
 * Adds the raw provider id only when another provider in the same set resolves
 * to the same visible label. Model labels are raw ids already, and the single
 * missing/empty identity groups remain unique.
 */
export function disambiguatedIdentityLabel(
  identity: AnalyticsEntityIdentity,
  dimension: AnalyticsDimension,
  peers: readonly AnalyticsEntityIdentity[],
): string {
  const label = identityLabel(identity, dimension);
  if (dimension !== "provider" || identity.kind !== "known") return label;
  const collides = peers.some(
    (peer) =>
      peer.kind === "known" &&
      !sameIdentity(peer, identity) &&
      identityLabel(peer, dimension) === label,
  );
  return collides ? `${label} (${rawIdText(identity.id)})` : label;
}

/** Exact raw identity or an explicit explanation, suitable for a `title`. */
export function identityTitle(
  identity: AnalyticsEntityIdentity,
  dimension: AnalyticsDimension,
): string {
  const noun = dimensionNoun(dimension);
  if (identity.kind === "unknown") return `No ${noun} id was recorded.`;
  if (identity.id.length === 0) return `The recorded ${noun} id is empty.`;
  return identity.id;
}

export function seriesLabel(series: AnalyticsSeries, dimension: AnalyticsDimension): string {
  return series.kind === "other" ? "Other" : identityLabel(series.identity, dimension);
}

function compareIdentities(left: AnalyticsEntityIdentity, right: AnalyticsEntityIdentity): number {
  if (left.kind === "unknown" && right.kind === "unknown") return 0;
  if (left.kind === "unknown") return 1;
  if (right.kind === "unknown") return -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The chart's only order: selected-range tokens, raw-id ties, Other last.
 * This runs independently of any breakdown sort mode.
 */
export function rankSeries(series: readonly AnalyticsSeries[]): AnalyticsSeries[] {
  return [...series].sort((left, right) => {
    if (left.kind === "other" || right.kind === "other") {
      if (left.kind === right.kind) return 0;
      return left.kind === "other" ? 1 : -1;
    }
    const byTokens = right.tokens.total - left.tokens.total;
    if (byTokens !== 0) return byTokens;
    return compareIdentities(left.identity, right.identity);
  });
}

export function seriesColorVar(index: number, kind: AnalyticsSeries["kind"]): string {
  return kind === "other" ? OTHER_COLOR_VAR : (RANK_COLOR_VARS[index] ?? OTHER_COLOR_VAR);
}

/**
 * Rank colour for an already-mapped row series key. Only keys present in the
 * chart's ranked series get a rank swatch; everything else is neutral Other.
 */
export function seriesColorForKey(key: string, seriesKeys?: readonly string[]): string {
  if (key === "other" || seriesKeys === undefined) return OTHER_COLOR_VAR;
  const index = seriesKeys.indexOf(key);
  return index === -1 ? OTHER_COLOR_VAR : seriesColorVar(index, "entity");
}

function compareBreakdownRows(
  left: AnalyticsGroupRow,
  right: AnalyticsGroupRow,
  sort: BreakdownSort,
): number {
  const byMetric =
    sort === "cost"
      ? compareCosts(left.tokens.apiEquivalentCostUsd, right.tokens.apiEquivalentCostUsd)
      : right.tokens.total - left.tokens.total;
  if (byMetric !== 0) return byMetric;
  return compareIdentities(left.identity, right.identity);
}

/** Null means no priced total; a numeric zero is a real, sortable cost. */
function compareCosts(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/** Sorts one hierarchy level only; children are sorted separately by callers. */
export function sortBreakdownRows(
  rows: readonly AnalyticsGroupRow[],
  sort: BreakdownSort,
): AnalyticsGroupRow[] {
  return [...rows].sort((left, right) => compareBreakdownRows(left, right, sort));
}

export function isPartialEstimate(
  tokens: Pick<CostedTokens, "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">,
): boolean {
  return (
    tokens.apiEquivalentCostUsd !== null &&
    tokens.total > 0 &&
    (tokens.unpricedTokens > 0 || tokens.unknownTokens > 0)
  );
}

/**
 * `Partial estimate` is reserved for a mixed numeric total. A total with no
 * priced tokens is `Unpriced`, not a zero-cost estimate; an empty range
 * carries no note at all.
 */
export function estimateNote(
  tokens: Pick<CostedTokens, "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">,
): "Partial estimate" | "Unpriced" | undefined {
  if (tokens.total <= 0) return undefined;
  if (tokens.apiEquivalentCostUsd === null) return "Unpriced";
  return isPartialEstimate(tokens) ? "Partial estimate" : undefined;
}

export function estimateNoteTitle(
  tokens: Pick<CostedTokens, "unpricedTokens" | "unknownTokens">,
): string {
  const parts = ["API-equivalent estimate based on model pricing. Not actual billed spend."];
  if (tokens.unpricedTokens > 0)
    parts.push(`${Math.round(tokens.unpricedTokens)} unpriced tokens are excluded.`);
  if (tokens.unknownTokens > 0)
    parts.push(`${Math.round(tokens.unknownTokens)} unknown tokens are excluded.`);
  return parts.join(" ");
}

export function exactCostTitle(tokens: Pick<CostedTokens, "apiEquivalentCostUsd">): string {
  return tokens.apiEquivalentCostUsd === null
    ? "No priced tokens in this total."
    : `API-equivalent estimate: USD ${tokens.apiEquivalentCostUsd.toFixed(6)}. Not actual billed spend.`;
}

export interface CombinedEstimate {
  total: number;
  apiEquivalentCostUsd: number | null;
  unpricedTokens: number;
  unknownTokens: number;
}

/**
 * Combines per-series buckets without inventing completeness: a numeric total
 * exists only when at least one part is priced, and the mixed flags stay set.
 */
export function combineEstimates(tokens: readonly CostedTokens[]): CombinedEstimate {
  let total = 0;
  let cost = 0;
  let anyPriced = false;
  let unpricedTokens = 0;
  let unknownTokens = 0;
  for (const entry of tokens) {
    total += entry.total;
    unpricedTokens += entry.unpricedTokens;
    unknownTokens += entry.unknownTokens;
    if (entry.apiEquivalentCostUsd !== null) {
      anyPriced = true;
      cost += entry.apiEquivalentCostUsd;
    }
  }
  return {
    total,
    apiEquivalentCostUsd: anyPriced ? cost : null,
    unpricedTokens,
    unknownTokens,
  };
}
