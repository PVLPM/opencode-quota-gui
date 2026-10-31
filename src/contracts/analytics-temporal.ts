/**
 * Historical peak/off-peak analytics DTO.
 *
 * This is a model-detail-only projection: the selected model is grouped by its
 * exact provider routes, and each route is split by the admitted monetary-API
 * temporal policy evaluated at every owned physical assistant completion
 * instant. It is deliberately separate from `AnalyticsGroupRow.children` so
 * existing breakdown consumers keep their exact shape.
 */

import type { AnalyticsEntityIdentity, CostedTokens } from "./dashboard.js";

/** One exact provider route's selected-range historical phase split. */
export interface AnalyticsTemporalBreakdownRow {
  /** Provider identity; the enclosing snapshot groups by the provider axis. */
  identity: AnalyticsEntityIdentity;
  /**
   * Tokens/cost completed in the policy's peak state: a surcharge period, or
   * the unchanged base period of a discount-only policy.
   */
  peak: CostedTokens;
  /**
   * Tokens/cost completed in the policy's off-peak state: a discounted period,
   * or the unchanged base period of a surcharge-only policy.
   */
  offpeak: CostedTokens;
}

/**
 * Present only on a model->provider detail snapshot with at least one admitted
 * route. Routes without a supported source monetary temporal policy or with an
 * unresolved evaluation are omitted rather than folded into a phase.
 * Non-monetary quota schedules live in a separate data source, so a route whose
 * only temporal effect is quota points has no monetary policy here and no
 * split; an exact source monetary policy is admitted regardless of provider
 * name.
 */
export interface AnalyticsTemporalBreakdown {
  /** Exact provider routes, ordered like the snapshot's provider rows. */
  rows: AnalyticsTemporalBreakdownRow[];
}
