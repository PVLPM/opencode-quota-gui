import type { TokenStack } from "../contracts/dashboard";

/**
 * Number and time formatting for the dashboard (design spec §10).
 *
 * Five raw additive categories with a derived total; cost is API-equivalent,
 * rendered as `≈ USD x.xx` with an ISO code and no currency symbols, so a
 * figure can never be mistaken for provider spend (R31, R32, R48).
 */

export interface CategoryDescriptor {
  key: keyof TokenStack;
  label: string;
  /** CSS custom property carrying the category colour. */
  colorVar: string;
}

/**
 * Fixed bottom-to-top stack order and matching legend order. The frozen v1
 * palette is carried by the CSS variables; the legend never reorders by totals.
 */
export const TOKEN_CATEGORIES: readonly CategoryDescriptor[] = [
  { key: "cacheRead", label: "Cache Read", colorVar: "--qg-token-cache-read" },
  { key: "input", label: "Input", colorVar: "--qg-token-input" },
  { key: "reasoning", label: "Reasoning", colorVar: "--qg-token-reasoning" },
  { key: "output", label: "Output", colorVar: "--qg-token-output" },
  { key: "cacheWrite", label: "Cache Write", colorVar: "--qg-token-cache-write" },
];

const COMPACT_UNITS = [
  { limit: 1e12, suffix: "T" },
  { limit: 1e9, suffix: "B" },
  { limit: 1e6, suffix: "M" },
  { limit: 1e3, suffix: "k" },
] as const;

/** Compact token counts for rows and axes; exact counts stay in tooltips. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)}`;
  for (const unit of COMPACT_UNITS) {
    if (value >= unit.limit) {
      const scaled = value / unit.limit;
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}${unit.suffix}`;
    }
  }
  return `${Math.round(value)}`;
}

export function formatExactCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

/** `≈ USD 12.34`; an absent price is reported, never rendered as `0`. */
export function formatApiEquivalentCost(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "≈ USD —";
  return `≈ USD ${value.toFixed(2)}`;
}

/**
 * The Models cost display. A total with usage but no priced tokens is
 * `Unpriced`, not a zero estimate; an empty total carries no currency claim at
 * all. Partial numeric estimates still use the same `≈ USD x.xx` form and are
 * qualified separately.
 */
export function formatApiEquivalentCostText(value: number | null, total: number): string {
  if (!(total > 0)) return "—";
  if (value === null || !Number.isFinite(value)) return "Unpriced";
  return formatApiEquivalentCost(value);
}

/**
 * Inspection-level cost text keeps a sub-cent estimate from reading as zero.
 * True zero stays `≈ USD 0.00`; a tiny nonzero value grows to four decimals.
 */
export function formatApiEquivalentCostFine(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "≈ USD —";
  if (value === 0) return "≈ USD 0.00";
  return value < 0.01 ? `≈ USD ${value.toFixed(4)}` : `≈ USD ${value.toFixed(2)}`;
}

/**
 * Compact right-axis tick for the cost overlay. The axis title carries `USD`,
 * so ticks stay bare numerals; the tick step fixes the precision so a tiny
 * scale never mixes `0.005` with `0.01`.
 */
export function formatApiEquivalentCostTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const decimals =
    step >= 1
      ? 0
      : step >= 0.1
        ? 1
        : step >= 0.01
          ? 2
          : step >= 0.001
            ? 3
            : step >= 0.0001
              ? 4
              : step >= 0.00001
                ? 5
                : 6;
  return value.toFixed(decimals);
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

/** Chart inspection always reports two decimals, including exact zeros. */
export function formatPercentExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

/** Right-axis rate ticks stay whole integers. */
export function formatPercentTick(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

/** Formats in the explicit host zone supplied by the payload; never the browser default. */
export function formatTimestamp(ms: number | undefined, timeZone: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", { timeZone });
}

/**
 * Quota's Polled footer is intentionally minute-precise. Keep the same explicit
 * host zone and date as formatTimestamp; only the seconds are omitted.
 */
export function formatTimestampMinutes(ms: number | undefined, timeZone: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatClock(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone,
    month: "short",
    day: "numeric",
  });
}

/** Bucket ticks follow the bucket unit the server reported (R28–R30). */
export function formatBucketTick(ms: number, unit: "hour" | "day", timeZone: string): string {
  return unit === "hour" ? formatClock(ms, timeZone) : formatDay(ms, timeZone);
}

/** The last instant actually included by a non-empty half-open boundary. */
function lastIncludedMs(startMs: number, endMs: number): number {
  return endMs > startMs ? endMs - 1 : endMs;
}

/** The inclusive end label for a half-open bucket, including a 23/25-hour DST day. */
export function formatBucketEnd(
  startMs: number,
  endMs: number,
  unit: "hour" | "day",
  timeZone: string,
): string {
  return formatBucketTick(lastIncludedMs(startMs, endMs), unit, timeZone);
}

/**
 * A bucket is half-open, but its printed label is not a duration claim.
 *
 * Day labels compare the exclusive end at `endMs - 1ms`, so a completed local
 * day prints one date; subtracting one millisecond is DST-aware and still
 * collapses a 23/25-hour day. Hour labels keep their existing range semantics.
 * The supplied boundaries are never changed.
 */
export function formatBucketRange(
  startMs: number,
  endMs: number,
  unit: "hour" | "day",
  timeZone: string,
  separator = " – ",
): string {
  const start = formatBucketTick(startMs, unit, timeZone);
  const endMsForLabel = unit === "day" ? lastIncludedMs(startMs, endMs) : endMs;
  const end = formatBucketTick(endMsForLabel, unit, timeZone);
  return start === end ? start : `${start}${separator}${end}`;
}

/**
 * A clear caption for an axis whose last bucket is not labelled. It keeps the
 * range end visible at narrow widths without inventing an irregular tick.
 */
export function axisRangeCaption(
  endText: string,
  count: number,
  labelIndexes: readonly number[],
): string | undefined {
  if (count <= 0 || labelIndexes.at(-1) === count - 1) return undefined;
  return `Through ${endText}`;
}

export function formatRunway(
  runway:
    | { kind: "before_reset"; projectedAtIso: string }
    | { kind: "lasts_past_reset" }
    | undefined,
  timeZone: string,
): string | undefined {
  if (!runway) return undefined;
  if (runway.kind === "lasts_past_reset") return "Lasts past reset";
  const projected = Date.parse(runway.projectedAtIso);
  if (!Number.isFinite(projected)) return "Runs out before reset";
  return `Runs out ${formatTimestamp(projected, timeZone)}`;
}

/** Concise, truthful title: Lifetime is day-bucketed too. */
export function usageChartTitle(unit: "hour" | "day"): string {
  return unit === "hour" ? "Hourly token usage" : "Daily token usage";
}

export const RANGE_LABELS: Record<string, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  lifetime: "Lifetime",
};

/** Counts read as prose in the dashboard, so a count of one never says "1 nodes". */
export function pluralize(count: number, singular: string, plural?: string): string {
  const formatted = count.toLocaleString("en-US");
  return count === 1 ? `${formatted} ${singular}` : `${formatted} ${plural ?? `${singular}s`}`;
}
