/**
 * Internal usage-activity read (v1.4.0). Browser-safe: no Node, no DOM, no
 * `src/lib`.
 *
 * This is the host-only activity seam behind the Usage view. It is deliberately
 * not part of `DashboardDataSource`: the host builds the browser `UsageSnapshot`
 * from these per-interval groups. Time windows are sorted, non-overlapping and
 * half-open on completion time: `(startMs, endMs]`.
 */
import type { CostedTokens } from "./dashboard.js";

export interface UsageActivityQueryInterval {
  startMs: number;
  endMs: number;
}

export interface UsageActivityQuery {
  /** Sorted, non-overlapping completion windows. */
  intervals: readonly UsageActivityQueryInterval[];
  /** OpenCode runtime provider ids whose activity is requested. */
  providerIds: readonly string[];
}

/** One provider/model/effort group. `effort` absent means unknown. */
export interface UsageActivityEntry {
  providerId: string;
  modelId: string;
  /** Recorded `model.variant`; `"default"` is an explicit recorded value. */
  effort?: string;
  /** Earliest completion timestamp contributing to this group, when known. */
  firstAtMs?: number;
  /** Latest completion timestamp contributing to this group, when known. */
  lastAtMs?: number;
  tokens: CostedTokens;
  stepCount: number;
}

export interface UsageActivityInterval {
  startMs: number;
  endMs: number;
  entries: UsageActivityEntry[];
  /** Some reported step cannot be completely priced or identified. */
  incomplete: boolean;
  unpricedTokens: number;
  unknownTokens: number;
  /**
   * Positive-token steps of a requested provider whose model id is empty or
   * unknown. They cannot be priced or attributed; their burn share stays
   * unattributed as `unidentified-activity`.
   */
  unidentifiedTokens?: number;
  unidentifiedSteps?: number;
  /**
   * Positive-token steps with no provider id. They match no requested provider,
   * so they are reported for transparency but never attributed.
   */
  unmatchedTokens?: number;
  unmatchedSteps?: number;
}

export interface UsageActivityResult {
  /** Aligned 1:1 with `UsageActivityQuery.intervals`. */
  intervals: UsageActivityInterval[];
  /**
   * Coverage/freshness of the span this producer actually read. Attribution is
   * certified only from `complete: true`; an absent value never certifies
   * anything, so a producer that cannot prove its span must leave it out (the
   * burn then stays unattributed instead of being allocated to whichever models
   * the partial read happened to contain).
   */
  coverage?: UsageActivityCoverage;
}

/**
 * What one activity read can prove about the queried intervals. A partially
 * read or stale index cannot prove that a requested interval holds no activity,
 * so quota-burn attribution may only be certified from a complete read.
 */
export interface UsageActivityCoverage {
  /** The index temporally covers every requested interval and its coverage is trusted. */
  complete: boolean;
  /**
   * The index has no successful sync within its refresh interval, so activity
   * after the last sync may still be missing. A bounded background refresh was
   * scheduled; freshness alone never changes an already covered interval.
   */
  stale: boolean;
}

function isQueryInterval(value: unknown): value is UsageActivityQueryInterval {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.startMs === "number" &&
    Number.isFinite(record.startMs) &&
    typeof record.endMs === "number" &&
    Number.isFinite(record.endMs) &&
    record.endMs > record.startMs
  );
}

/** Sorted, non-overlapping, finite windows with non-empty runtime provider ids. */
export function isUsageActivityQuery(value: unknown): value is UsageActivityQuery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.intervals) || !Array.isArray(record.providerIds)) return false;
  let previousEndMs = Number.NEGATIVE_INFINITY;
  for (const interval of record.intervals) {
    if (!isQueryInterval(interval)) return false;
    if (interval.startMs < previousEndMs) return false;
    previousEndMs = interval.endMs;
  }
  return record.providerIds.every(
    (providerId) => typeof providerId === "string" && providerId.length > 0,
  );
}
