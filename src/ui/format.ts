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

/** Fixed stack order; the legend always names every category (R31). */
export const TOKEN_CATEGORIES: readonly CategoryDescriptor[] = [
  { key: "input", label: "Input", colorVar: "--qg-token-input" },
  { key: "cacheRead", label: "Cache read", colorVar: "--qg-token-cache-read" },
  { key: "cacheWrite", label: "Cache write", colorVar: "--qg-token-cache-write" },
  { key: "output", label: "Output", colorVar: "--qg-token-output" },
  { key: "reasoning", label: "Reasoning", colorVar: "--qg-token-reasoning" },
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

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

/** Formats in the explicit host zone supplied by the payload; never the browser default. */
export function formatTimestamp(ms: number | undefined, timeZone: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", { timeZone });
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
