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
  usagePointsFromRuns,
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
    expect(lifetime.intervals.filter((interval) => interval.link === "boundary")).toHaveLength(1);
    expect(lifetime.intervals.map((interval) => interval.burnPercentPoints)).toEqual([0, null, 0]);
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
    expect(
      window.intervals.find((interval) => interval.link === "boundary")?.burnPercentPoints,
    ).toBeNull();
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

describe("usage intervals: estimated reset precision", () => {
  const at = (seconds: number): number => BASE + seconds * SECOND;

  it("proves an estimated rollover without placing an exact marker", () => {
    const window = buildUsageWindowSeries(
      series([
        point({
          firstAtMs: at(0),
          lastAtMs: at(60),
          remainingPercent: 80,
          resetAtMs: at(120),
          resetPrecision: "estimated",
        }),
        point({
          firstAtMs: at(180),
          lastAtMs: at(240),
          remainingPercent: 95,
          resetAtMs: at(300),
          resetPrecision: "estimated",
        }),
      ]),
      { range: "lifetime", nowMs: at(250) },
    );

    expect(window.links[0]).toEqual({ kind: "boundary", boundary: "reset" });
    expect(window.links[0]).not.toHaveProperty("atMs");
    expect(window.totals.observedBurnPercentPoints).toBe(0);
  });

  it("ignores forward jitter that crosses the earlier estimate without a rollover", () => {
    const window = buildUsageWindowSeries(
      series([
        point({
          firstAtMs: at(0),
          lastAtMs: at(60),
          remainingPercent: 80,
          resetAtMs: at(120),
          resetPrecision: "estimated",
        }),
        point({
          firstAtMs: at(180),
          lastAtMs: at(240),
          remainingPercent: 70,
          resetAtMs: at(210),
          resetPrecision: "estimated",
        }),
      ]),
      { range: "lifetime", nowMs: at(250) },
    );

    expect(window.links[0]).toEqual({ kind: "observed" });
    expect(
      window.intervals.find((interval) => interval.fromPoint === 0 && interval.toPoint === 1)
        ?.burnPercentPoints,
    ).toBe(10);
  });

  it("accepts a remaining increase as evidence while the boundary barely moves", () => {
    const window = buildUsageWindowSeries(
      series([
        point({
          firstAtMs: at(0),
          lastAtMs: at(60),
          remainingPercent: 20,
          resetAtMs: at(120),
          resetPrecision: "estimated",
        }),
        point({
          firstAtMs: at(180),
          remainingPercent: 40,
          resetAtMs: at(230),
          resetPrecision: "estimated",
        }),
      ]),
      { range: "lifetime", nowMs: at(180) },
    );

    expect(window.links[0]).toEqual({ kind: "boundary", boundary: "reset" });
  });

  it("passes the optional stored precision column through", () => {
    const points = usagePointsFromRuns([
      {
        runId: 1,
        seriesId: "series",
        firstAtMs: BASE,
        lastAtMs: BASE + SECOND,
        sampleCount: 1,
        remainingPercent: 50,
        resetAtMs: BASE + 10 * SECOND,
        reset_precision: "estimated",
        linked: true,
      },
    ]);
    expect(points[0]?.resetPrecision).toBe("estimated");
  });
});

describe("usage intervals: flat runs", () => {
  it("keeps a flat run as its own zero-burn interval beside the following change", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, lastAtMs: BASE + 600 * SECOND, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 660 * SECOND, remainingPercent: 70 }),
      ]),
      { range: "lifetime", nowMs: BASE + 660 * SECOND },
    );

    expect(
      window.intervals.map((interval) => ({
        startMs: interval.startMs,
        endMs: interval.endMs,
        burn: interval.burnPercentPoints,
        fromPoint: interval.fromPoint,
        toPoint: interval.toPoint,
      })),
    ).toEqual([
      {
        startMs: BASE,
        endMs: BASE + 600 * SECOND,
        burn: 0,
        fromPoint: 0,
        toPoint: 0,
      },
      {
        startMs: BASE + 600 * SECOND,
        endMs: BASE + 660 * SECOND,
        burn: 10,
        fromPoint: 0,
        toPoint: 1,
      },
    ]);
  });

  it("never emits a zero-duration interval", () => {
    const single = buildUsageWindowSeries(
      series([point({ firstAtMs: BASE, remainingPercent: 50 })]),
      { range: "lifetime", nowMs: BASE },
    );
    expect(single.intervals).toEqual([]);

    const touching = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, lastAtMs: BASE + 60 * SECOND, remainingPercent: 80 }),
        point({ firstAtMs: BASE + 60 * SECOND, remainingPercent: 70 }),
      ]),
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );
    expect(touching.intervals).toHaveLength(1);
    expect(touching.intervals[0]?.fromPoint).toBe(0);
    expect(touching.intervals[0]?.toPoint).toBe(0);
    for (const interval of [...single.intervals, ...touching.intervals]) {
      expect(interval.endMs).toBeGreaterThan(interval.startMs);
    }
  });

  it("clips a run that straddles a finite span start", () => {
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

    expect(window.intervals[0]).toMatchObject({
      startMs: BASE + 30 * SECOND,
      endMs: BASE + 60 * SECOND,
      burnPercentPoints: 0,
      fromPoint: 0,
      toPoint: 0,
    });
    expect(window.intervals[1]).toMatchObject({
      startMs: BASE + 60 * SECOND,
      endMs: BASE + 90 * SECOND,
      burnPercentPoints: 10,
    });
  });
});

describe("usage intervals: finite-range coverage", () => {
  it("counts in-span samples without pro-rating partially overlapping runs", () => {
    const window = buildUsageWindowSeries(
      series([
        point({
          firstAtMs: BASE,
          lastAtMs: BASE + 20 * SECOND,
          remainingPercent: 80,
          sampleCount: 5,
        }),
        point({
          firstAtMs: BASE + 10 * SECOND,
          lastAtMs: BASE + 110 * SECOND,
          remainingPercent: 70,
          sampleCount: 9,
        }),
        point({
          firstAtMs: BASE + 20 * SECOND,
          lastAtMs: BASE + 40 * SECOND,
          remainingPercent: 65,
          sampleCount: 7,
        }),
        point({
          firstAtMs: BASE + 40 * SECOND,
          lastAtMs: BASE + 60 * SECOND,
          remainingPercent: 60,
          sampleCount: 3,
        }),
        point({
          firstAtMs: BASE + 70 * SECOND,
          lastAtMs: BASE + 80 * SECOND,
          remainingPercent: 55,
          sampleCount: 2,
        }),
        point({
          firstAtMs: BASE + 85 * SECOND,
          lastAtMs: BASE + 120 * SECOND,
          remainingPercent: 50,
          sampleCount: 4,
        }),
      ]),
      {
        range: "24h",
        nowMs: BASE + 120 * SECOND,
        span: { startMs: BASE + 30 * SECOND, endMs: BASE + 90 * SECOND },
      },
    );

    // 0-20 is outside; 10-110 covers the whole span with no endpoint inside;
    // 20-40 and 85-120 contribute one endpoint each; 40-60 and 70-80 are whole.
    expect(window.coverage.sampleCount).toBe(1 + 3 + 2 + 1);
  });
});

describe("usage intervals: expired current epoch", () => {
  it("keeps the latest epoch when an estimated reset passed with no newer sample", () => {
    const window = buildUsageWindowSeries(
      series([
        point({
          firstAtMs: BASE,
          lastAtMs: BASE + 20 * SECOND,
          remainingPercent: 70,
          resetAtMs: BASE + 30 * SECOND,
          resetPrecision: "estimated",
        }),
      ]),
      { range: "current", nowMs: BASE + 60 * SECOND },
    );

    expect(window.points).toHaveLength(1);
    expect(window.axis).toEqual({ startMs: BASE, endMs: BASE + 60 * SECOND });
  });

  it("returns an empty axis when the scheduled reset passed without a newer sample", () => {
    const window = buildUsageWindowSeries(
      series([
        point({ firstAtMs: BASE, lastAtMs: BASE + 6 * SECOND, remainingPercent: 80 }),
        point({
          firstAtMs: BASE + 10 * SECOND,
          lastAtMs: BASE + 20 * SECOND,
          remainingPercent: 70,
          resetAtMs: BASE + 30 * SECOND,
        }),
      ]),
      { range: "current", nowMs: BASE + 60 * SECOND },
    );

    expect(window.axis).toEqual({ startMs: BASE + 30 * SECOND, endMs: BASE + 60 * SECOND });
    expect(window.points).toEqual([]);
    expect(window.links).toEqual([]);
    expect(window.intervals).toEqual([]);
    expect(window.coverage.observedMs).toBe(0);
    expect(window.coverage.sampleCount).toBe(0);
    expect(window.coverage.firstObservedAtMs).toBeUndefined();
    expect(window.totals.observedBurnPercentPoints).toBe(0);
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

describe("usage intervals: conflicting samples", () => {
  it("renders conflict evidence as an uncertain boundary, never as a fabricated step", () => {
    const window = buildUsageWindowSeries(
      {
        ...series([
          point({ firstAtMs: BASE, lastAtMs: BASE + 60 * SECOND, remainingPercent: 80 }),
          point({ firstAtMs: BASE + 120 * SECOND, remainingPercent: 70 }),
        ]),
        conflicts: [{ atMs: BASE + 30 * SECOND, remainingPercent: 40 }],
      },
      { range: "lifetime", nowMs: BASE + 120 * SECOND },
    );

    expect(window.points.map((item) => item.remainingPercent)).toEqual([80, 70]);
    expect(window.links).toEqual([
      { kind: "boundary", boundary: "uncertain", atMs: BASE + 30 * SECOND },
    ]);
    expect(window.intervals[0]?.link).toBe("boundary");
    expect(window.intervals[1]?.burnPercentPoints).toBeNull();
    expect(window.totals.observedBurnPercentPoints).toBe(0);
  });

  it("renders a conflict inside the only flat run with a marker and no solid span", () => {
    const window = buildUsageWindowSeries(
      {
        ...series([point({ firstAtMs: BASE, lastAtMs: BASE + 60 * SECOND, remainingPercent: 80 })]),
        conflicts: [{ atMs: BASE + 30 * SECOND, remainingPercent: 40 }],
      },
      { range: "lifetime", nowMs: BASE + 60 * SECOND },
    );

    expect(window.points).toHaveLength(1);
    expect(window.links).toEqual([]);
    expect(window.intervals).toEqual([
      expect.objectContaining({
        fromPoint: 0,
        toPoint: 0,
        link: "boundary",
        burnPercentPoints: null,
        conflictAtMs: BASE + 30 * SECOND,
      }),
    ]);
    expect(window.coverage.observedMs).toBe(0);
    expect(window.totals.observedBurnPercentPoints).toBe(0);
    expect(window.points[0]?.startMs).toBe(BASE);
    expect(window.points[0]?.endMs).toBe(BASE + 60 * SECOND);
  });

  it("treats a conflict inside a gap as an uncertain boundary", () => {
    const window = buildUsageWindowSeries(
      {
        ...series([
          point({ firstAtMs: BASE, remainingPercent: 80 }),
          point({ firstAtMs: BASE + 120 * SECOND, remainingPercent: 70, linked: false }),
        ]),
        conflicts: [{ atMs: BASE + 60 * SECOND, remainingPercent: 50 }],
      },
      { range: "lifetime", nowMs: BASE + 120 * SECOND },
    );
    expect(window.links[0]).toEqual({
      kind: "boundary",
      boundary: "uncertain",
      atMs: BASE + 60 * SECOND,
    });
    expect(
      window.intervals.find((interval) => interval.fromPoint === 0 && interval.toPoint === 1)
        ?.burnPercentPoints,
    ).toBeNull();
  });
});

describe("usage intervals: point provenance", () => {
  it("carries the stored series source onto every point", () => {
    const window = buildUsageWindowSeries(
      {
        ...series([point({ firstAtMs: BASE, remainingPercent: 50 })]),
        source: "codex-import",
      },
      { range: "lifetime", nowMs: BASE },
    );
    expect(window.points[0]?.source).toBe("codex-import");
  });
});

describe("usage intervals: capacity identity", () => {
  it("passes a stored capacity/plan key through the existing identity field", () => {
    const points = usagePointsFromRuns([
      {
        runId: 1,
        seriesId: "series",
        firstAtMs: BASE,
        lastAtMs: BASE,
        sampleCount: 1,
        remainingPercent: 50,
        capacityKey: "limit:100:requests|plan:abc",
        linked: true,
      },
    ]);
    expect(points[0]?.unitKey).toBe("limit:100:requests|plan:abc");
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
