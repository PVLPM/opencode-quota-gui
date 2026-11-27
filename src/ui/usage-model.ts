import type {
  UsageInterval,
  UsageLink,
  UsageMeasurementKind,
  UsageUnattributedReason,
  UsageWindowSeries,
} from "../contracts/usage";
import { formatTimestamp } from "./format";

/**
 * Browser-safe Usage semantics shared by the account card, the chart and the
 * breakdown. Percentages arrive as *remaining* percent; the existing
 * `percentDisplayMode` preference flips them only at render time.
 */

export type QuotaPercentMode = "used" | "remaining";

/** The visible value for a stored remaining percent, in the chosen direction. */
export function displayPercent(remainingPercent: number, mode: QuotaPercentMode): number {
  return mode === "used" ? 100 - remainingPercent : remainingPercent;
}

export function percentModeLabel(mode: QuotaPercentMode): string {
  return mode === "used" ? "Used" : "Remaining";
}

export function formatPp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)} pp`;
}

/** A measured endpoint change, never an estimate. */
export function observedChangeText(
  burnPercentPoints: number | null,
  mode: QuotaPercentMode,
): string {
  if (burnPercentPoints === null || !Number.isFinite(burnPercentPoints)) return "—";
  if (burnPercentPoints === 0) return "0.00 pp";
  return mode === "used"
    ? `+${formatPp(burnPercentPoints)} used`
    : `−${formatPp(burnPercentPoints)} remaining`;
}

/** The compact inline form: direction only, with the unit and mode alongside it. */
export function observedChangeCompact(
  burnPercentPoints: number | null,
  mode: QuotaPercentMode,
): string {
  if (burnPercentPoints === null || !Number.isFinite(burnPercentPoints)) return "—";
  if (burnPercentPoints === 0) return "0.00 pp";
  return mode === "used" ? `+${formatPp(burnPercentPoints)}` : `−${formatPp(burnPercentPoints)}`;
}

export function effortLabel(effort: string | undefined): string {
  if (effort === undefined) return "Unknown effort";
  if (effort === "default") return "Default effort (recorded)";
  return effort;
}

export function harnessLabel(harness: "claude-code" | "codex"): string {
  return harness === "claude-code" ? "Claude Code" : "Codex";
}

export const UNATTRIBUTED_REASON_LABELS: Record<UsageUnattributedReason, string> = {
  "no-activity": "No recorded OpenCode activity in this interval",
  "ambiguous-account": "Activity could not be assigned to one account",
  unpriced: "Eligible activity has no pricing",
  "zero-weight": "Eligible activity has zero API-equivalent weight",
  "unobserved-interval": "Monitoring gap: the trajectory is unknown",
  "unidentified-activity": "Some activity has no recorded model, so the split is incomplete",
};

/** `undefined` for an observed or unobserved link; the boundary sentence otherwise. */
export function boundaryText(link: UsageLink | undefined, timeZone: string): string | undefined {
  if (link?.kind !== "boundary") return undefined;
  switch (link.boundary) {
    case "reset":
      return link.atMs === undefined
        ? "Reset between observations"
        : `Reset at ${formatTimestamp(link.atMs, timeZone)}`;
    case "replenished":
      return "Quota was replenished without a proven reset";
    case "identity-change":
      return "Window identity or capacity changed";
    default:
      return "Reset or replenishment could not be determined";
  }
}

export function intervalStateLabel(
  interval: UsageInterval,
  link: UsageLink | undefined,
  timeZone: string,
): string {
  if (interval.link === "boundary") return boundaryText(link, timeZone) ?? "Boundary";
  if (interval.link === "unobserved") return "Monitoring gap";
  return interval.fromPoint === interval.toPoint ? "Observed" : "Observed change";
}

export function measurementLabel(kind: UsageMeasurementKind): string {
  return kind === "provider-observed"
    ? "Provider observed"
    : "Locally estimated — not a provider measurement";
}

/** Share of the requested axis covered by continuously observed time. */
export function coveragePercent(series: Pick<UsageWindowSeries, "axis" | "coverage">): number {
  const span = series.axis.endMs - series.axis.startMs;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(100, (series.coverage.observedMs / span) * 100));
}

/** Estimate disclosure required wherever an attributed percentage point appears. */
export const ATTRIBUTION_DISCLOSURE =
  "Attribution is an estimated split of the observed quota change using recorded OpenCode activity. Usage outside OpenCode cannot be excluded.";

export function attributedText(value: number): string {
  return `${formatPp(value)} estimated`;
}
