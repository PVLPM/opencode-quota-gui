/**
 * Pure usage interval derivation: epoch/reset proof, replenishment, dashed
 * continuity, coverage and axis selection (USAGE_IMPLEMENTATION.md D4–D6).
 */
import { describe, expect, it } from "vitest";

import type { RowId } from "../src/contracts/identity.js";
import {
  buildUsageWindowSeries,
  type UsageSamplePoint,
  type UsageSeriesInput,
} from "../src/gui/usage-intervals.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const SECOND = 1_000;
const ROW_ID = "card-a#window:five_hour|quota:percent" as RowId;

function point(overrides: Partial<UsageSamplePoint> & { firstAtMs: number }): UsageSamplePoint {
  return {
    lastAtMs: overrides.firstAtMs,
    remainingPercent: 50,
    sampleCount: 1,
    linked: true,
    ...overrides,
  };
}

function series(points: readonly UsageSamplePoint[]): UsageSeriesInput {
  return {
    rowId: ROW_ID,
    label: "5h",
    metric: { kind: "window", window: "five_hour" },
    measurement: "provider-observed",
    points,
  };
}

describe("usage intervals: reset proof", () => {
  it("splits a proven scheduled reset at the earlier reset time", () => {
    const at = (seconds: number): number => BASE + seconds * SECOND;
    const points = [
      point({ firstAtMs: at(0), lastAtMs: at(60), remainingPercent: 80, resetAtMs: at(120) }),
      point({ firstAtMs: at(180), lastAtMs: at(240), remainingPercent: 95, resetAtMs: at(300) }),
    ];

    const lifetime = buildUsageWindowSeries(series(points), { range: "lifetime", nowMs: at(250) });
    expect(lifetime.links).toEqual([{ kind: "boundary", boundary: "reset", atMs: at(120) }]);
    expect(lifetime.intervals).toHaveLength(1);
    expect(lifetime.intervals[0]?.burnPercentPoints).toBeNull();
    expect(lifetime.totals.observedBurnPercentPoints).toBe(0);

    const current = buildUsageWindowSeries(series(points), { range: "current", nowMs: at(250) });
    expect(current.points).toHaveLength(1);
    expect(current.axis).toEqual({ startMs: at(180), endMs: at(300) });
    expect(current.intervals).toHaveLength(1);
    expect(current.intervals[0]?.fromPoint).toBe(0);
    expect(current.intervals[0]?.toPoint).toBe(0);
  });

  it("proves a reset even when remaining stayed low after it", () => {
    const points = [
      point({
        firstAtMs: BASE,
        lastAtMs: BASE + 50 * SECOND,
        remainingPercent: 50,
        resetAtMs: BASE + 100 * SECOND,
      }),
      point({
        firstAtMs: BASE + 150 * SECOND,
        lastAtMs: BASE + 190 * SECOND,
        remainingPercent: 30,
        resetAtMs: BASE + 200 * SECOND,
      }),
    ];
    const window = buildUsageWindowSeries(series(points), {
      range: "lifetime",
      nowMs: BASE + 200 * SECOND,
    });
    expect(window.links[0]).toEqual({
      kind: "boundary",
      boundary: "reset",
      atMs: BASE + 100 * SECOND,
    });
    expect(window.intervals[0]?.burnPercentPoints).toBeNull();
  });

  it("does not prove a reset before the earlier boundary", () => {
    const points = [
      point({ firstAtMs: BASE, remainingPercent: 50, resetAtMs: BASE + 100 * SECOND }),
      point({
        firstAtMs: BASE + 50 * SECOND,
        remainingPercent: 60,
        resetAtMs: BASE + 200 * SECOND,
      }),
    ];
    const window = buildUsageWindowSeries(series(points), { range: "lifetime", nowMs: BASE });
    expect(window.links[0]).toEqual({ kind: "boundary", boundary: "replenished" });
  });

  it("classifies an increase as replenished with reset information and uncertain without it", () => {
    const withReset = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, remainingPercent: 20, resetAtMs: BASE + 1_000 * SECOND }),
        point({
          firstAtMs: BASE + 60 * SECOND,
          remainingPercent: 40,
          resetAtMs: BASE + 1_000 * SECOND,
        }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(withReset.links[0]).toEqual({ kind: "boundary", boundary: "replenished" });

    const withoutReset = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, remainingPercent: 20 }),
        point({ firstAtMs: BASE + 60 * SECOND, remainingPercent: 40 }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(withoutReset.links[0]).toEqual({ kind: "boundary", boundary: "uncertain" });
  });

  it("treats a quantity unit change as an identity boundary", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, remainingPercent: 50, unitKey: "count:credit" }),
        point({
          firstAtMs: BASE + 60 * SECOND,
          remainingPercent: 50,
          unitKey: "currency:USD",
        }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(window.links[0]).toEqual({ kind: "boundary", boundary: "identity-change" });
  });
});

describe("usage intervals: continuity and coverage", () => {
  it("draws a dashed unobserved connector but still reports the comparable burn", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 60 * SECOND, remainingPercent: 75, linked: false }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(window.links[0]).toEqual({ kind: "unobserved" });
    expect(window.intervals[0]?.burnPercentPoints).toBe(5);
    expect(window.intervals[0]?.unattributedReason).toBe("unobserved-interval");
    expect(window.coverage.observedMs).toBe(0);
  });

  it("counts run length and observed gaps inside the axis only", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, lastAtMs: BASE + 60 * SECOND, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 90 * SECOND, remainingPercent: 70 }),
      ]),
      {
        range: "24h",
        nowMs: BASE + 120 * SECOND,
        span: { startMs: BASE + 30 * SECOND, endMs: BASE + 90 * SECOND },
      },
    );
    expect(window.links[0]).toEqual({ kind: "observed" });
    expect(window.coverage.observedMs).toBe(60 * SECOND);
    expect(window.coverage.sampleCount).toBe(2);
    expect(window.axis).toEqual({ startMs: BASE + 30 * SECOND, endMs: BASE + 90 * SECOND });
  });

  it("never invents points outside the finite range", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE - 10 * SECOND, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 10 * SECOND, remainingPercent: 70 }),
        point({ firstAtMs: BASE + 100 * SECOND, remainingPercent: 60 }),
      ]),
      { range: "24h", nowMs: BASE + 60 * SECOND },
    );
    const spanStart = BASE + 60 * SECOND - 24 * 60 * 60 * SECOND;
    expect(window.points.some((item) => item.startMs === BASE + 100 * SECOND)).toBe(false);
    expect(window.points.every((item) => item.startMs >= spanStart)).toBe(true);
    expect(window.points).toHaveLength(2);
  });

  it("keeps every stored point for lifetime even past the wall clock", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 300 * SECOND, remainingPercent: 70 }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(window.points).toHaveLength(2);
    expect(window.axis.endMs).toBe(BASE + 300 * SECOND);
  });
});

describe("usage intervals: multi-reset ranges", () => {
  it("sums per-epoch burn without ever carrying it across a reset", () => {
    const at = (seconds: number): number => BASE + seconds * SECOND;
    const points = [
      point({ firstAtMs: at(0), remainingPercent: 100, resetAtMs: at(1_000) }),
      point({ firstAtMs: at(100), remainingPercent: 10, resetAtMs: at(1_000) }),
      point({ firstAtMs: at(1_100), remainingPercent: 100, resetAtMs: at(2_000) }),
      point({ firstAtMs: at(1_200), remainingPercent: 10, resetAtMs: at(2_000) }),
      point({ firstAtMs: at(2_100), remainingPercent: 100, resetAtMs: at(3_000) }),
      point({ firstAtMs: at(2_200), remainingPercent: 5, resetAtMs: at(3_000) }),
    ];
    const window = buildUsageWindowSeries(series(points), { range: "lifetime", nowMs: at(2_300) });

    expect(window.intervals.filter((interval) => interval.burnPercentPoints === null)).toHaveLength(
      2,
    );
    expect(window.totals.observedBurnPercentPoints).toBe(275);
    expect(window.totals.attributedBurnPercentPoints).toBe(0);
    expect(window.totals.unattributedBurnPercentPoints).toBe(275);
  });

  it("orders out-of-order stored points by observation time", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE + 60 * SECOND, remainingPercent: 40, linked: false }),
        point({ firstAtMs: BASE, remainingPercent: 80 }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(window.points.map((item) => item.remainingPercent)).toEqual([80, 40]);
  });
});
