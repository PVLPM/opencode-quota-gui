import type { QuotaSnapshot } from "../contracts/dashboard.js";

/**
 * Live-cycle identity for quota observations.
 *
 * The notification observer must tell a just-finished source cycle from a
 * cached replay of an earlier snapshot. A live cycle can be marked
 * `stale: true` because it retained last-good rows; a cached replay is
 * synthesized separately and is never registered here. WeakSet membership
 * keeps this internal signal out of the DTO and never survives serialization.
 */
const liveQuotaObservations = new WeakSet<object>();

export function markQuotaObservationLive(snapshot: QuotaSnapshot): QuotaSnapshot {
  liveQuotaObservations.add(snapshot);
  return snapshot;
}

export function isLiveQuotaObservation(snapshot: QuotaSnapshot): boolean {
  return liveQuotaObservations.has(snapshot);
}
