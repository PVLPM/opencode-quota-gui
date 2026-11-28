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
  /**
   * The measured instant this unit describes: the current reading for an
   * interval, or the last sample of a flat run. The crosshair and pointer
   * inspection snap here so the last interval is reachable on its dot.
   */
  anchorMs: number;
  kind: UsageLink["kind"];
}

/** A runway projection supplied by the already-loaded quota row. */
export interface UsageProjectionGeometry {
  fromMs: number;
  fromRemainingPercent: number;
  toMs: number;
  /** Absent for a `lasts_past_reset` projection, which continues at the last reading. */
  toRemainingPercent?: number;
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
  /** The latest measured sample, drawn as the dot the inspection snaps to. */
  latest?: { x: number; y: number };
  /** Dashed runway projection path, when one is available and inside this axis. */
  projectionPath?: string;
  projectionEnd?: { x: number; y: number };
  xForMs: (ms: number) => number;
  /** Display-direction y for a stored remaining percent. */
  yForPercent: (remainingPercent: number) => number;
  /** Nearest inspectable unit for a plot-local x, measured at each unit's anchor. */
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
  /**
   * End of the requested history axis when a Current-range chart is extended to
   * include a future projection. The trailing "no history" band stops here so
   * future time is not shaded as missing data.
   */
  historyEndMs?: number;
  /** Runway projection from the latest measured point. */
  projection?: UsageProjectionGeometry;
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
  const historyEndMs = Math.min(input.historyEndMs ?? axis.endMs, axis.endMs);
  const unavailable: { startMs: number; endMs: number }[] = [];
  if (!first || !last) {
    unavailable.push({ startMs: axis.startMs, endMs: historyEndMs });
  } else {
    if (first.startMs > axis.startMs) {
      unavailable.push({ startMs: axis.startMs, endMs: Math.min(first.startMs, axis.endMs) });
    }
    if (last.endMs < historyEndMs) {
      unavailable.push({ startMs: Math.max(last.endMs, axis.startMs), endMs: historyEndMs });
    }
  }

  const units: UsageInspectionUnit[] =
    intervals.length > 0
      ? intervals
          .map((interval, intervalIndex) => ({
            intervalIndex,
            startMs: interval.startMs,
            endMs: interval.endMs,
            anchorMs: interval.endMs,
            kind: interval.link,
          }))
          .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
      : [
          ...points.map((point, pointIndex) => ({
            intervalIndex: pointIndex,
            startMs: point.startMs,
            endMs: point.endMs,
            anchorMs: point.endMs,
            kind: "observed" as const,
          })),
          ...links.map((link, linkIndex) => ({
            intervalIndex: points.length + linkIndex,
            startMs: points[linkIndex]?.endMs ?? axis.startMs,
            endMs: points[linkIndex + 1]?.startMs ?? axis.endMs,
            anchorMs: points[linkIndex + 1]?.startMs ?? axis.endMs,
            kind: link.kind,
          })),
        ].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  /**
   * Pointer inspection follows the measured instant, not the unit's geometric
   * centre: hovering the latest dot selects the interval that ends there, and
   * the crosshair can therefore sit exactly on the dot.
   */
  const unitAtX = (x: number): number | undefined => {
    if (units.length === 0) return undefined;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    units.forEach((unit, unitIndex) => {
      const distance = Math.abs(x - xAt(unit.anchorMs));
      if (distance < bestDistance) {
        best = unitIndex;
        bestDistance = distance;
      }
    });
    return best;
  };

  const latest =
    last === undefined ? undefined : { x: xAt(last.endMs), y: yForPercent(last.remainingPercent) };

  let projectionPath: string | undefined;
  let projectionEnd: { x: number; y: number } | undefined;
  const projection = input.projection;
  if (
    projection !== undefined &&
    projection.toMs > projection.fromMs &&
    projection.fromMs >= axis.startMs &&
    projection.fromMs <= axis.endMs &&
    projection.toMs <= axis.endMs
  ) {
    const start = {
      x: xAt(projection.fromMs),
      y: yForPercent(projection.fromRemainingPercent),
    };
    const endRemaining = projection.toRemainingPercent ?? projection.fromRemainingPercent;
    projectionEnd = { x: xAt(projection.toMs), y: yForPercent(endRemaining) };
    projectionPath = `M ${coordinate(start.x)} ${coordinate(start.y)} L ${coordinate(projectionEnd.x)} ${coordinate(projectionEnd.y)}`;
  }

  return {
    plot,
    solidPaths,
    unobservedPaths,
    isolated,
    markers,
    unavailable,
    units,
    ...(latest === undefined ? {} : { latest }),
    ...(projectionPath === undefined ? {} : { projectionPath }),
    ...(projectionEnd === undefined ? {} : { projectionEnd }),
    xForMs: xAt,
    yForPercent,
    unitAtX,
  };
}
