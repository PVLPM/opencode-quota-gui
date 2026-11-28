import type { QuotaSnapshot } from "../contracts/dashboard.js";
import type { UsageResetPrecision } from "../lib/usage-import.js";

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

/**
 * Collection metadata for one live cycle, kept off the DTO. `collectorRunId`
 * is unique per quota cycle (one attempt per card), `collectorSessionId` is
 * stable for one process lifetime, so usage continuity never spans a restart.
 */
export interface QuotaObservationCycle {
  /** Genuine measurement time per card; absent means the card was not measured. */
  readonly measuredAtByCard: ReadonlyMap<string, number>;
  /** Collector attempt time of this cycle; interruption evidence is stamped with it. */
  readonly attemptedAtMs: number;
  /** Per-row reset precision from the provider's internal evidence. */
  readonly resetPrecisionByRow?: ReadonlyMap<string, UsageResetPrecision>;
  /** Per-row normalized capacity/limit and plan identity used for epoch identity. */
  readonly capacityKeyByRow?: ReadonlyMap<string, string>;
  readonly collectorRunId: string;
  readonly collectorSessionId: string;
  /** Configured poll interval of the collector at this cycle. */
  readonly intervalMs: number;
  /** Provider ids selected for this cycle. */
  readonly providerIds: readonly string[];
}

const cycles = new WeakMap<object, QuotaObservationCycle>();
const collectorSessionId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let collectorRunSequence = 0;

export function markQuotaObservationCycle(
  snapshot: QuotaSnapshot,
  input: {
    measuredAtByCard: ReadonlyMap<string, number>;
    intervalMs: number;
    providerIds: readonly string[];
    /** Cycle attempt time; defaults to the current clock for older callers. */
    attemptedAtMs?: number;
    resetPrecisionByRow?: ReadonlyMap<string, UsageResetPrecision>;
    capacityKeyByRow?: ReadonlyMap<string, string>;
  },
): QuotaSnapshot {
  collectorRunSequence += 1;
  const measuredTimes = [...input.measuredAtByCard.values()].filter((value) =>
    Number.isFinite(value),
  );
  const fallbackAttemptAtMs = measuredTimes.length > 0 ? Math.max(...measuredTimes) : Date.now();
  cycles.set(snapshot, {
    measuredAtByCard: input.measuredAtByCard,
    attemptedAtMs:
      input.attemptedAtMs !== undefined && Number.isFinite(input.attemptedAtMs)
        ? input.attemptedAtMs
        : fallbackAttemptAtMs,
    ...(input.resetPrecisionByRow !== undefined
      ? { resetPrecisionByRow: input.resetPrecisionByRow }
      : {}),
    ...(input.capacityKeyByRow !== undefined ? { capacityKeyByRow: input.capacityKeyByRow } : {}),
    collectorRunId: `${collectorSessionId}:${collectorRunSequence}`,
    collectorSessionId,
    intervalMs: input.intervalMs,
    providerIds: input.providerIds,
  });
  return snapshot;
}

export function quotaObservationCycle(snapshot: QuotaSnapshot): QuotaObservationCycle | undefined {
  return cycles.get(snapshot);
}
