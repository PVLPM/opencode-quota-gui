import type { UsageBoundaryKind, UsageInterval, UsageLink, UsagePoint } from "../contracts/usage";
import type { PlotRect } from "./chart-geometry";

/**
 * Step-path geometry for one quota window.
 *
 * Quota percentages are stored as *remaining* percent; `mode` flips them to
 * used at render time without touching the data. The requested axis is always
 * drawn in full: a point never invents a value before its first sample or after
 * its last, and the untouched axis ends are returned as unavailable bands.
 *
 * Solid runs include the horizontal flat run of each `UsagePoint`
 * (`startMs` → `endMs`). An `unobserved` link becomes one dashed neutral
 * connector because the trajectory in between is unknown. A `boundary` link
 * ends the observed run, starts a new one and yields a marker at the precise
 * `atMs` when the provider fixed it, otherwise halfway between observations.
 * No simplification drops a stored change, reset or gap.
 */

export interface UsageStepAxis {
  startMs: number;
  endMs: number;
}

export type UsageDisplayMode = "used" | "remaining";

export interface UsageBoundaryMarker {
  x: number;
  atMs?: number;
  boundary: UsageBoundaryKind;
  /** True when the provider supplied no exact time ("reset between observations"). */
  between: boolean;
}

export interface UsageInspectionUnit {
  /** Index into `UsageWindowSeries.intervals`. */
  intervalIndex: number;
  startMs: number;
  endMs: number;
  kind: UsageLink["kind"];
}

export interface UsageStepGeometry {
  plot: PlotRect;
  solidPaths: string[];
  unobservedPaths: string[];
  /** Zero-width single samples, drawn as small marks so they stay visible. */
  isolated: { x: number; y: number }[];
  markers: UsageBoundaryMarker[];
  unavailable: { startMs: number; endMs: number }[];
  /** Chronological inspection units; server intervals when present. */
  units: UsageInspectionUnit[];
  xForMs: (ms: number) => number;
  /** Display-direction y for a stored remaining percent. */
  yForPercent: (remainingPercent: number) => number;
  /** Nearest inspectable unit for a plot-local x; ties prefer the narrowest span. */
  unitAtX: (x: number) => number | undefined;
}

function coordinate(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function buildUsageStepGeometry(input: {
  axis: UsageStepAxis;
  plot: PlotRect;
  mode: UsageDisplayMode;
  points: UsagePoint[];
  links: UsageLink[];
  intervals: UsageInterval[];
  /** Series-level conflict markers that do not depend on an interval. */
  conflicts?: readonly { atMs: number }[];
}): UsageStepGeometry {
  const { axis, plot, mode, points, links, intervals } = input;
  const span = axis.endMs - axis.startMs;
  const xAt = (ms: number): number =>
    span > 0
      ? plot.left + ((clamp(ms, axis.startMs, axis.endMs) - axis.startMs) / span) * plot.width
      : plot.left + plot.width / 2;
  const yForPercent = (remainingPercent: number): number => {
    const shown = mode === "used" ? 100 - remainingPercent : remainingPercent;
    return plot.bottom - (clamp(shown, 0, 100) / 100) * plot.height;
  };

  const solidPaths: string[] = [];
  const unobservedPaths: string[] = [];
  const isolated: { x: number; y: number }[] = [];
  const markers: UsageBoundaryMarker[] = [];

  // A conflict inside a flat run has no link of its own, so it is carried on
  // that run's interval. The affected span is not drawn solid; the measured
  // endpoints stay visible as marks and the conflict time gets a marker.
  const conflictsByPoint = new Map<number, number[]>();
  for (const interval of intervals) {
    if (interval.fromPoint !== interval.toPoint || interval.conflictAtMs === undefined) continue;
    const times = conflictsByPoint.get(interval.fromPoint);
    if (times === undefined) conflictsByPoint.set(interval.fromPoint, [interval.conflictAtMs]);
    else times.push(interval.conflictAtMs);
  }
  // Series-level markers also cover a zero-duration run, where no positive
  // interval exists to carry `conflictAtMs`.
  for (const conflict of input.conflicts ?? []) {
    const index = points.findIndex(
      (point) => conflict.atMs >= point.startMs && conflict.atMs <= point.endMs,
    );
    if (index < 0) continue;
    const times = conflictsByPoint.get(index);
    if (times === undefined) conflictsByPoint.set(index, [conflict.atMs]);
    else if (!times.includes(conflict.atMs)) times.push(conflict.atMs);
  }

  let path = "";
  let open = false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    const y = yForPercent(point.remainingPercent);
    const startX = xAt(point.startMs);
    const endX = xAt(point.endMs);
    if (!open) {
      path = `M ${coordinate(startX)} ${coordinate(y)}`;
      open = true;
    } else {
      // The previous observed link already extended the horizontal run here.
      path += ` L ${coordinate(startX)} ${coordinate(y)}`;
    }
    const conflictTimes = conflictsByPoint.get(index);
    if (conflictTimes === undefined) {
      if (endX > startX + 0.005) path += ` L ${coordinate(endX)} ${coordinate(y)}`;
      if (endX - startX < 0.5) isolated.push({ x: endX, y });
    } else {
      // End the trustworthy path at the measured endpoint; do not draw the
      // uncertain flat span. A path that never left its start is not solid.
      if (open && path.includes(" L ")) solidPaths.push(path);
      open = false;
      path = "";
      isolated.push({ x: startX, y });
      if (endX > startX + 0.005) isolated.push({ x: endX, y });
      for (const atMs of conflictTimes) {
        markers.push({ x: xAt(atMs), atMs, boundary: "uncertain", between: false });
      }
    }

    const link = links[index];
    if (!link) {
      if (open) solidPaths.push(path);
      open = false;
      path = "";
      break;
    }
    if (link.kind === "observed") {
      const next = points[index + 1];
      if (next) {
        const nextX = xAt(next.startMs);
        if (!open) {
          path = `M ${coordinate(endX)} ${coordinate(y)}`;
          open = true;
        }
        if (nextX > endX + 0.005) path += ` L ${coordinate(nextX)} ${coordinate(y)}`;
      }
      continue;
    }

    if (open) solidPaths.push(path);
    open = false;
    path = "";
    const next = points[index + 1];
    if (!next) continue;
    const nextX = xAt(next.startMs);
    if (link.kind === "unobserved") {
      unobservedPaths.push(
        `M ${coordinate(endX)} ${coordinate(y)} L ${coordinate(nextX)} ${coordinate(yForPercent(next.remainingPercent))}`,
      );
      continue;
    }
    markers.push({
      x: link.atMs === undefined ? (endX + nextX) / 2 : xAt(link.atMs),
      ...(link.atMs === undefined ? {} : { atMs: link.atMs }),
      boundary: link.boundary,
      between: link.atMs === undefined,
    });
  }
  if (open && path.length > 0) solidPaths.push(path);

  const first = points[0];
  const last = points[points.length - 1];
  const unavailable: { startMs: number; endMs: number }[] = [];
  if (!first || !last) {
    unavailable.push({ startMs: axis.startMs, endMs: axis.endMs });
  } else {
    if (first.startMs > axis.startMs) {
      unavailable.push({ startMs: axis.startMs, endMs: Math.min(first.startMs, axis.endMs) });
    }
    if (last.endMs < axis.endMs) {
      unavailable.push({ startMs: Math.max(last.endMs, axis.startMs), endMs: axis.endMs });
    }
  }

  const units: UsageInspectionUnit[] =
    intervals.length > 0
      ? intervals
          .map((interval, intervalIndex) => ({
            intervalIndex,
            startMs: interval.startMs,
            endMs: interval.endMs,
            kind: interval.link,
          }))
          .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
      : [
          ...points.map((point, pointIndex) => ({
            intervalIndex: pointIndex,
            startMs: point.startMs,
            endMs: point.endMs,
            kind: "observed" as const,
          })),
          ...links.map((link, linkIndex) => ({
            intervalIndex: points.length + linkIndex,
            startMs: points[linkIndex]?.endMs ?? axis.startMs,
            endMs: points[linkIndex + 1]?.startMs ?? axis.endMs,
            kind: link.kind,
          })),
        ].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  const unitAtX = (x: number): number | undefined => {
    if (units.length === 0) return undefined;
    const minHalfWidth = 3;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let best: number | undefined;
    let bestWidth = Number.POSITIVE_INFINITY;
    units.forEach((unit, unitIndex) => {
      const x0 = xAt(unit.startMs);
      const x1 = xAt(unit.endMs);
      const center = (x0 + x1) / 2;
      const halfWidth = Math.max((x1 - x0) / 2, minHalfWidth);
      const distance = Math.abs(x - center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = unitIndex;
      }
      const width = x1 - x0;
      if (distance <= halfWidth && width < bestWidth) {
        best = unitIndex;
        bestWidth = width;
      }
    });
    return best ?? nearest;
  };

  return {
    plot,
    solidPaths,
    unobservedPaths,
    isolated,
    markers,
    unavailable,
    units,
    xForMs: xAt,
    yForPercent,
    unitAtX,
  };
}
