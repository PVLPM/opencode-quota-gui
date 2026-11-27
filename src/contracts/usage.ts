/**
 * Usage view contracts (v1.4.0). Browser-safe: no Node, no DOM, no `src/lib`.
 *
 * Three quantities are kept strictly separate:
 * 1. provider-observed quota change (`UsageInterval.burnPercentPoints`),
 * 2. recorded invocation activity (`UsageActivity.tokens`),
 * 3. the estimated attribution of (1) to (2) (`estimatedBurnPercentPoints`).
 *
 * Percentages are stored and transported as *remaining* percent; the UI flips
 * to *used* at render time from the existing `percentDisplayMode` preference.
 * See USAGE_IMPLEMENTATION.md for the semantics behind every field.
 */
import type { AccountingMetric, CostedTokens } from "./dashboard.js";
import type { CardId, RowId } from "./identity.js";

export const USAGE_RANGE_KEYS = ["current", "24h", "7d", "30d", "lifetime"] as const;
export type UsageRangeKey = (typeof USAGE_RANGE_KEYS)[number];

const USAGE_RANGE_NAMES: ReadonlySet<unknown> = new Set<unknown>(USAGE_RANGE_KEYS);
export function isUsageRangeKey(value: unknown): value is UsageRangeKey {
  return USAGE_RANGE_NAMES.has(value);
}

export interface UsageQuery {
  range: UsageRangeKey;
}

/** Where a measurement came from. */
export type UsageSource = "opencode-poll" | "codex-import";

/**
 * How a measurement was obtained. `provider-observed` is a provider quota
 * reading; `locally-estimated` is computed by this plugin (for example
 * Cursor's local cost estimate) and is never a provider measurement.
 */
export type UsageMeasurementKind = "provider-observed" | "locally-estimated";

/**
 * One stored run: one or more consecutive identical successful measurements of
 * the same series and epoch. `startMs` is the first sample, `endMs` the last
 * (equal for a single sample). A flat run is observed evidence of no change.
 */
export interface UsagePoint {
  startMs: number;
  endMs: number;
  remainingPercent: number;
  sampleCount: number;
  /** Provider reset boundary supplied with this measurement, when any. */
  resetAtMs?: number;
  source: UsageSource;
}

/**
 * Boundary between two points that makes them incomparable.
 * - `reset`: a scheduled reset proven by the observations.
 * - `replenished`: remaining rose without a proven reset (refill, manual or
 *   banked reset, provider correction).
 * - `identity-change`: unit, capacity or plan changed.
 * - `uncertain`: identity cannot be established from the evidence.
 */
export type UsageBoundaryKind = "reset" | "replenished" | "identity-change" | "uncertain";

/**
 * Relation of `points[i]` to `points[i + 1]` (same length as `points - 1`).
 * - `observed`: continuously monitored; draw a solid step.
 * - `unobserved`: comparable endpoints but monitoring was interrupted; draw a
 *   dashed neutral connector. The trajectory in between is unknown.
 * - `boundary`: incomparable endpoints; draw disconnected segments and a
 *   marker. `atMs` is present only when the provider evidence fixes the time.
 */
export type UsageLink =
  | { kind: "observed" }
  | { kind: "unobserved" }
  | { kind: "boundary"; boundary: UsageBoundaryKind; atMs?: number };

/** Why some or all of an interval's observed burn is not attributed. */
export type UsageUnattributedReason =
  | "no-activity"
  | "ambiguous-account"
  | "unpriced"
  | "zero-weight"
  | "unobserved-interval"
  /** Matching-provider activity exists but has no model identity, so its share cannot be priced. */
  | "unidentified-activity";

/** One provider/model/effort identity as recorded. `effort` absent = unknown. */
export interface UsageModelKey {
  providerId: string;
  modelId: string;
  effort?: string;
}

/** Recorded activity of one model/effort identity inside an interval or range. */
export interface UsageActivity {
  /** Index into `UsageSnapshot.models`. */
  model: number;
  tokens: CostedTokens;
  stepCount: number;
  /** Estimated share of observed burn, in percentage points; absent when not attributed. */
  estimatedBurnPercentPoints?: number;
  source: UsageSource | "claude-code-import";
}

/**
 * One inspectable interval between consecutive points `fromPoint` and
 * `fromPoint + 1`, or a flat run itself (`fromPoint === toPoint`).
 */
export interface UsageInterval {
  fromPoint: number;
  toPoint: number;
  startMs: number;
  endMs: number;
  previousRemainingPercent: number;
  currentRemainingPercent: number;
  link: UsageLink["kind"];
  /** Observed decrease in percentage points; `null` across a boundary. */
  burnPercentPoints: number | null;
  attributedBurnPercentPoints: number;
  unattributedBurnPercentPoints: number;
  unattributedReason?: UsageUnattributedReason;
  /**
   * Conflicting stored evidence at this exact time. Present on a flat run's
   * interval (`fromPoint === toPoint`); the run is uncertain there, so clients
   * keep the measured endpoints but draw a conflict marker and not a solid span.
   */
  conflictAtMs?: number;
  activity: UsageActivity[];
}

export interface UsageCoverage {
  firstObservedAtMs?: number;
  lastObservedAtMs?: number;
  /** Total length of continuously observed time inside the axis span. */
  observedMs: number;
  sampleCount: number;
}

/** One quota window of one account. */
export interface UsageWindowSeries {
  rowId: RowId;
  label: string;
  metric?: AccountingMetric;
  measurement: UsageMeasurementKind;
  /** Full requested axis span; for `current` the current epoch of this window. */
  axis: { startMs: number; endMs: number };
  coverage: UsageCoverage;
  points: UsagePoint[];
  links: UsageLink[];
  intervals: UsageInterval[];
  totals: {
    observedBurnPercentPoints: number;
    attributedBurnPercentPoints: number;
    unattributedBurnPercentPoints: number;
  };
  /** Model-first breakdown for this window and range. */
  breakdown: UsageBreakdownRow[];
}

/** Model row with expandable effort children. */
export interface UsageBreakdownRow {
  providerId: string;
  modelId: string;
  tokens: CostedTokens;
  stepCount: number;
  estimatedBurnPercentPoints?: number;
  efforts: {
    effort?: string;
    tokens: CostedTokens;
    stepCount: number;
    estimatedBurnPercentPoints?: number;
  }[];
}

export interface UsageAccount {
  /** Card id for polled accounts, an opaque import scope for imported ones. */
  accountKey: CardId | string;
  providerId: string;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
  source: UsageSource;
  windows: UsageWindowSeries[];
}

export interface UsageSnapshot {
  generatedAtMs: number;
  range: UsageRangeKey;
  timeZone: string;
  /** Requested span for finite ranges; per-window `axis` for `current`. */
  span?: { startMs: number; endMs: number };
  accounts: UsageAccount[];
  models: UsageModelKey[];
  /** Imported harnesses enabled and their last import outcome. */
  imports: {
    harness: "claude-code" | "codex";
    enabled: boolean;
    lastImportedAtMs?: number;
    status: "disabled" | "ok" | "unavailable" | "error";
  }[];
  /** Activity history unavailable (analytics not ready); quota history still valid. */
  activityUnavailable?: true;
  /** An existing usage-history database could not be read (not a fresh install). */
  historyUnavailable?: true;
}
