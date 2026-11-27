import { createSignal, onCleanup, onMount } from "solid-js";
import type { ChartSize, PlotRect } from "./chart-geometry";

/** Plot window as percentages, shared by the usage and per-model charts. */
export function plotInsetStyle(
  plot: PlotRect,
  size: ChartSize,
): { top: string; bottom: string; left: string; right: string } {
  return {
    top: `${(plot.top / size.height) * 100}%`,
    bottom: `${((size.height - plot.bottom) / size.height) * 100}%`,
    left: `${(plot.left / size.width) * 100}%`,
    right: `${((size.width - plot.right) / size.width) * 100}%`,
  };
}

/** One bucket's pointer/focus hit column, positioned in plot percentages. */
export function slotHitStyle(
  plot: PlotRect,
  slotX: number,
  slot: number,
): { left: string; width: string } {
  return {
    left: `${((slotX - plot.left) / plot.width) * 100}%`,
    width: `${(Math.max(slot, 1) / plot.width) * 100}%`,
  };
}

/** Match the SVG coordinate space to its container so narrow-screen labels stay legible. */
export function createChartLayout(
  defaults: ChartSize,
  options: { narrowHeight?: number } = {},
): {
  size: ChartSize;
  ref: (element: HTMLDivElement) => void;
} {
  const [width, setWidth] = createSignal(defaults.width);
  let container: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;

  function observe(element: HTMLDivElement | undefined): void {
    observer?.disconnect();
    observer = undefined;
    container = element;
    if (!element || typeof ResizeObserver === "undefined") return;
    observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
  }

  // A chart that first renders a skeleton attaches its ref after mount, so the
  // ref callback owns observation; onMount only covers eager first renders.
  onMount(() => {
    observe(container);
    onCleanup(() => observer?.disconnect());
  });

  return {
    size: {
      get width() {
        return width();
      },
      get height() {
        return width() < 600 ? (options.narrowHeight ?? 220) : defaults.height;
      },
      padding: defaults.padding,
    },
    ref: (element) => {
      if (element !== container) observe(element);
    },
  };
}
