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
  tokens: CostedTokens;
  stepCount: number;
}

export interface UsageActivityInterval {
  startMs: number;
  endMs: number;
  entries: UsageActivityEntry[];
  /** Some reported step has no complete price (unpriced or unknown route). */
  incomplete: boolean;
  unpricedTokens: number;
  unknownTokens: number;
}

export interface UsageActivityResult {
  /** Aligned 1:1 with `UsageActivityQuery.intervals`. */
  intervals: UsageActivityInterval[];
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
