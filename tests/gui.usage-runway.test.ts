import { describe, expect, it } from "vitest";
import type { UsagePoint } from "../src/contracts/usage.js";
import { usageRunwayIndex, usageRunwayKey, usageRunwayProjection } from "../src/ui/usage-runway.js";
import { HOUR_MS, NOW, percentRow, providerCard } from "./fixtures/gui-ui-fixtures.js";

/**
 * The Usage runway is presentation-only: it reuses the already-loaded quota
 * row's projection, stays suppressed exactly when the card suppresses it, and
 * never invents an endpoint. The chart's latest measured point is the origin.
 */

const CARD_ID = "usage-card";
const ROW_ID = "usage-row";

function lastPoint(endMs: number, remainingPercent = 40): UsagePoint {
  return {
    startMs: endMs - 60_000,
    endMs,
    remainingPercent,
    sampleCount: 1,
    source: "opencode-poll",
  };
}

function cardWith(
  runway: { kind: "before_reset"; projectedAtIso: string } | { kind: "lasts_past_reset" },
  resetAtMs = NOW + 3 * HOUR_MS,
) {
  return providerCard({
    cardId: CARD_ID as never,
    rows: [
      percentRow({
        rowId: ROW_ID as never,
        runway,
        resetAtIso: new Date(resetAtMs).toISOString(),
      }),
    ],
  });
}

describe("usage runway hints", () => {
  it("indexes the loaded card row by account and row, and follows card staleness", () => {
    const card = cardWith({
      kind: "before_reset",
      projectedAtIso: new Date(NOW + 2 * HOUR_MS).toISOString(),
    });
    const index = usageRunwayIndex([card]);
    expect(index.get(usageRunwayKey(CARD_ID, ROW_ID))).toEqual({
      kind: "before_reset",
      projectedAtMs: NOW + 2 * HOUR_MS,
      resetAtMs: NOW + 3 * HOUR_MS,
    });
    expect(usageRunwayIndex([{ ...card, stale: true }]).size).toBe(0);
    expect(usageRunwayIndex([card], { stale: true }).size).toBe(0);
    expect(usageRunwayIndex(undefined).size).toBe(0);
  });

  it("projects an exhaustion before the reset from the latest measured point", () => {
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint: {
          kind: "before_reset",
          projectedAtMs: NOW + 2 * HOUR_MS,
          resetAtMs: NOW + 3 * HOUR_MS,
        },
        axis: { startMs: NOW - HOUR_MS, endMs: NOW },
        range: "current",
        nowMs: NOW,
      }),
    ).toEqual({ endMs: NOW + 2 * HOUR_MS, toRemainingPercent: 0 });
  });

  it("draws only a projection that already fits a non-current range", () => {
    const hint = {
      kind: "before_reset" as const,
      projectedAtMs: NOW + 2 * HOUR_MS,
      resetAtMs: NOW + 3 * HOUR_MS,
    };
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint,
        axis: { startMs: NOW - 7 * 24 * HOUR_MS, endMs: NOW },
        range: "7d",
        nowMs: NOW,
      }),
    ).toBeUndefined();
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint,
        axis: { startMs: NOW - 7 * 24 * HOUR_MS, endMs: NOW + 3 * HOUR_MS },
        range: "7d",
        nowMs: NOW,
      }),
    ).toEqual({ endMs: NOW + 2 * HOUR_MS, toRemainingPercent: 0 });
  });

  it("continues the last reading to the reset for lasts-past-reset rows", () => {
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint: { kind: "lasts_past_reset", resetAtMs: NOW + 3 * HOUR_MS },
        axis: { startMs: NOW - HOUR_MS, endMs: NOW + 3 * HOUR_MS },
        range: "current",
        nowMs: NOW,
      }),
    ).toEqual({ endMs: NOW + 3 * HOUR_MS });
  });

  it("hides a past projection, a passed reset and an absent point", () => {
    const axis = { startMs: NOW - HOUR_MS, endMs: NOW + 4 * HOUR_MS };
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint: { kind: "before_reset", projectedAtMs: NOW - 60_000 },
        axis,
        range: "current",
        nowMs: NOW,
      }),
    ).toBeUndefined();
    expect(
      usageRunwayProjection({
        last: lastPoint(NOW),
        hint: { kind: "lasts_past_reset", resetAtMs: NOW - 60_000 },
        axis,
        range: "current",
        nowMs: NOW,
      }),
    ).toBeUndefined();
    expect(
      usageRunwayProjection({
        last: undefined,
        hint: { kind: "lasts_past_reset", resetAtMs: NOW + HOUR_MS },
        axis,
        range: "current",
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });
});
