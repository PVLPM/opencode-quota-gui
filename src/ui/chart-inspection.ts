import { type Accessor, createSignal } from "solid-js";

/**
 * Shared chart inspection state.
 *
 * Pointer inspection wins while the pointer is over the plot; keyboard focus
 * survives pointer exit until the element really blurs. There are no timers, so
 * a pointer move or an arrow key updates the tooltip and crosshair on the same
 * tick.
 */
export interface ChartInspection {
  active: Accessor<number | undefined>;
  inspectPointer: (index: number | undefined) => void;
  inspectFocus: (index: number | undefined) => void;
  clearPointer: () => void;
  clearFocus: () => void;
}

export function createChartInspection(): ChartInspection {
  const [pointerIndex, setPointerIndex] = createSignal<number | undefined>();
  const [focusIndex, setFocusIndex] = createSignal<number | undefined>();
  return {
    active: () => pointerIndex() ?? focusIndex(),
    inspectPointer: setPointerIndex,
    inspectFocus: setFocusIndex,
    clearPointer: () => setPointerIndex(undefined),
    clearFocus: () => setFocusIndex(undefined),
  };
}

export interface ChartIndexInput {
  /** Pixel position in the chart's coordinate space. */
  x: number;
  left: number;
  width: number;
  count: number;
}

/**
 * The plot-local x for a pointer event over the inspection surface, or
 * `undefined` before layout. Shared so every chart maps the pointer the same
 * way.
 */
export function pointerPlotX(
  event: PointerEvent,
  plot: { left: number; width: number },
): number | undefined {
  const surface = event.currentTarget as HTMLElement | null;
  if (!surface) return undefined;
  const rect = surface.getBoundingClientRect();
  if (!(rect.width > 0)) return undefined;
  return plot.left + ((event.clientX - rect.left) / rect.width) * plot.width;
}

/** Arrow/Home/End step navigation shared by the keyboard-inspectable charts. */
export function nextInspectionIndex(
  event: KeyboardEvent,
  count: number,
  current: number,
): number | undefined {
  if (count <= 0) return undefined;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    return Math.min(count - 1, current + 1);
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    return Math.max(0, current - 1);
  }
  if (event.key === "Home") return 0;
  if (event.key === "End") return count - 1;
  return undefined;
}

/**
 * Maps a chart-local x coordinate to the nearest rendered step. Session is the
 * only chart with point marks; Usage selects a bucket directly from its button.
 */
export function chartIndexAt(input: ChartIndexInput): number | undefined {
  const { x, left, width, count } = input;
  if (count <= 0) return undefined;
  if (count === 1) return 0;
  const usableWidth = Math.max(0, width);
  const clampedX = Math.max(left, Math.min(left + usableWidth, x));
  const fraction = usableWidth > 0 ? (clampedX - left) / usableWidth : 0;
  return Math.round(fraction * (count - 1));
}
