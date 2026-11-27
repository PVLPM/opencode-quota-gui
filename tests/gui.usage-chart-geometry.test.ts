import { describe, expect, it } from "vitest";
import type { UsageInterval, UsageLink, UsagePoint } from "../src/contracts/usage.js";
import { buildUsageStepGeometry } from "../src/ui/usage-chart-geometry.js";

/**
 * Usage step geometry: the requested axis is always full, stored runs keep
 * their flat width, a monitoring gap is dashed, and a boundary disconnects the
 * line at a marker instead of joining incomparable endpoints.
 */

const PLOT = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
const AXIS = { startMs: 0, endMs: 1_000 };

function point(startMs: number, endMs: number, remainingPercent: number): UsagePoint {
  return { startMs, endMs, remainingPercent, sampleCount: 1, source: "opencode-poll" };
}

function interval(
  fromPoint: number,
  toPoint: number,
  startMs: number,
  endMs: number,
  link: UsageLink["kind"],
  previousRemainingPercent: number,
  currentRemainingPercent: number,
): UsageInterval {
  return {
    fromPoint,
    toPoint,
    startMs,
    endMs,
    previousRemainingPercent,
    currentRemainingPercent,
    link,
    burnPercentPoints:
      link === "boundary" ? null : previousRemainingPercent - currentRemainingPercent,
    attributedBurnPercentPoints: 0,
    unattributedBurnPercentPoints: 0,
    activity: [],
  };
}

const POINTS = [point(100, 200, 80), point(300, 400, 70), point(600, 800, 40)];
const LINKS: UsageLink[] = [
  { kind: "unobserved" },
  { kind: "boundary", boundary: "reset", atMs: 500 },
];

describe("usage chart geometry", () => {
  it("flips the stored remaining percent only in the used display mode", () => {
    const remaining = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points: POINTS,
      links: LINKS,
      intervals: [],
    });
    const used = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "used",
      points: POINTS,
      links: LINKS,
      intervals: [],
    });

    // 80% remaining sits high; the same reading as 20% used sits low.
    expect(remaining.yForPercent(80)).toBeCloseTo(20);
    expect(used.yForPercent(80)).toBeCloseTo(80);
    expect(remaining.yForPercent(40)).toBeCloseTo(60);
    // 40% remaining is 60% used, which sits low on the used-mode axis.
    expect(used.yForPercent(40)).toBeCloseTo(40);
    expect(remaining.yForPercent(100)).toBeCloseTo(0);
    expect(used.yForPercent(100)).toBeCloseTo(100);
  });

  it("keeps the full requested axis and marks history missing at both ends", () => {
    const geometry = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points: POINTS,
      links: LINKS,
      intervals: [],
    });

    expect(geometry.unavailable).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 800, endMs: 1_000 },
    ]);
    // The first solid path starts at the first sample, never at the axis edge.
    expect(geometry.solidPaths[0]).toMatch(/^M 10\.00 /);
  });

  it("draws a dashed connector for an unobserved gap and disconnects a boundary", () => {
    const geometry = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points: POINTS,
      links: LINKS,
      intervals: [],
    });

    expect(geometry.solidPaths).toHaveLength(3);
    expect(geometry.unobservedPaths).toHaveLength(1);
    expect(geometry.unobservedPaths[0]).toBe("M 20.00 20.00 L 30.00 30.00");
    expect(geometry.markers).toEqual([{ x: 50, atMs: 500, boundary: "reset", between: false }]);
    // A boundary ends the run instead of drawing across the incomparable jump.
    expect(geometry.solidPaths[1]).not.toContain("L 60.00");
  });

  it("places an unknown reset marker between the observations", () => {
    const geometry = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points: POINTS,
      links: [{ kind: "boundary", boundary: "replenished" }, { kind: "observed" }],
      intervals: [],
    });

    expect(geometry.markers).toEqual([{ x: 25, boundary: "replenished", between: true }]);
  });

  it("renders every stored change without simplification", () => {
    const points = [point(10, 20, 90), point(30, 40, 80), point(50, 60, 70), point(70, 80, 60)];
    const geometry = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points,
      links: [{ kind: "observed" }, { kind: "observed" }, { kind: "observed" }],
      intervals: [],
    });

    expect(geometry.solidPaths).toHaveLength(1);
    expect(geometry.solidPaths[0]?.match(/L /g)).toHaveLength(points.length * 3 - 2);
  });

  it("inspects the server intervals in chronological order", () => {
    const intervals = [
      interval(0, 1, 200, 300, "unobserved", 80, 70),
      interval(0, 0, 100, 200, "observed", 80, 80),
      interval(1, 2, 400, 600, "boundary", 70, 40),
    ];
    const geometry = buildUsageStepGeometry({
      axis: AXIS,
      plot: PLOT,
      mode: "remaining",
      points: POINTS,
      links: LINKS,
      intervals,
    });

    expect(geometry.units.map((unit) => unit.intervalIndex)).toEqual([1, 0, 2]);
    expect(geometry.unitAtX(15)).toBe(0);
    expect(geometry.unitAtX(65)).toBe(2);
  });
});
