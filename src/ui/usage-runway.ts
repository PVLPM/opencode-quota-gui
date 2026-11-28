import type { ProviderCard } from "../contracts/dashboard";
import type { UsagePoint, UsageRangeKey } from "../contracts/usage";

/**
 * Browser-safe runway hints for the Usage chart.
 *
 * A runways projection is already computed on the quota card row and is
 * presentation-only: nothing here is persisted or recomputed. Usage and the
 * Quota cards share the same `rowId`, so the chart can draw the same estimate
 * without a second provider read. A missing, stale or malformed hint only hides
 * the dashed line; it never invents a projection.
 */

export interface UsageRunwayHint {
  kind: "before_reset" | "lasts_past_reset";
  /** Exhaustion time for `before_reset`; absent for `lasts_past_reset`. */
  projectedAtMs?: number;
  /** Provider reset time, when the row carries a parseable one. */
  resetAtMs?: number;
}

export interface UsageRunwayProjection {
  /** Time the dashed line ends. */
  endMs: number;
  /**
   * Remaining percent at the end. Zero for a projected exhaustion; absent for
   * `lasts_past_reset`, where the line continues at the last reading because no
   * exhaustion is projected before the reset.
   */
  toRemainingPercent?: number;
}

/** The stable account/row key shared by a Usage window and its quota card row. */
export function usageRunwayKey(cardId: string, rowId: string): string {
  return `${cardId}\u0000${rowId}`;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Indexes the already-loaded quota cards by account and row. Runway on a stale
 * snapshot or card is suppressed exactly as the quota card suppresses it.
 */
export function usageRunwayIndex(
  cards: readonly ProviderCard[] | undefined,
  options: { stale?: boolean } = {},
): ReadonlyMap<string, UsageRunwayHint> {
  const index = new Map<string, UsageRunwayHint>();
  if (options.stale === true) return index;
  for (const card of cards ?? []) {
    if (card.stale === true) continue;
    for (const row of card.rows) {
      if (row.kind !== "percent" || row.runway === undefined) continue;
      const resetAtMs = parseTimestamp(row.resetAtIso);
      if (row.runway.kind === "lasts_past_reset") {
        if (resetAtMs === undefined) continue;
        index.set(usageRunwayKey(card.cardId, row.rowId), {
          kind: "lasts_past_reset",
          resetAtMs,
        });
        continue;
      }
      const projectedAtMs = parseTimestamp(row.runway.projectedAtIso);
      if (projectedAtMs === undefined) continue;
      index.set(usageRunwayKey(card.cardId, row.rowId), {
        kind: "before_reset",
        projectedAtMs,
        ...(resetAtMs === undefined ? {} : { resetAtMs }),
      });
    }
  }
  return index;
}

function earliest(positive: number[]): number | undefined {
  return positive.length === 0 ? undefined : Math.min(...positive);
}

/**
 * Resolves the projection endpoint from the shared runway numbers.
 *
 * `last` is the latest measured point; the dashed line always starts there.
 * Only the Current range extends beyond the requested axis (the chart grows to
 * include the projection); every other range draws only when the endpoint
 * already falls inside its axis. A projection that has already passed is not
 * drawn.
 */
export function usageRunwayProjection(input: {
  last: UsagePoint | undefined;
  hint: UsageRunwayHint | undefined;
  axis: { startMs: number; endMs: number };
  range: UsageRangeKey;
  nowMs: number;
}): UsageRunwayProjection | undefined {
  const { last, hint, axis, range, nowMs } = input;
  if (last === undefined || hint === undefined) return undefined;
  if (!Number.isFinite(nowMs)) return undefined;

  const resetAtMs =
    hint.resetAtMs !== undefined && Number.isFinite(hint.resetAtMs) && hint.resetAtMs > last.endMs
      ? hint.resetAtMs
      : undefined;

  if (hint.kind === "lasts_past_reset") {
    if (resetAtMs === undefined || resetAtMs <= nowMs) return undefined;
    if (range !== "current" && resetAtMs > axis.endMs) return undefined;
    return { endMs: resetAtMs };
  }

  const projectedAtMs =
    hint.projectedAtMs !== undefined &&
    Number.isFinite(hint.projectedAtMs) &&
    hint.projectedAtMs > last.endMs
      ? hint.projectedAtMs
      : undefined;
  if (projectedAtMs === undefined || projectedAtMs <= nowMs) return undefined;
  const endMs = earliest([projectedAtMs, ...(resetAtMs === undefined ? [] : [resetAtMs])]);
  if (endMs === undefined) return undefined;
  if (range !== "current" && endMs > axis.endMs) return undefined;
  return { endMs, toRemainingPercent: 0 };
}
