import { createSignal, onCleanup, onMount } from "solid-js";
import type { ChartSize } from "./chart-geometry";

/** Match the SVG coordinate space to its container so narrow-screen labels stay legible. */
export function createChartLayout(defaults: ChartSize): {
  size: ChartSize;
  ref: (element: HTMLDivElement) => void;
} {
  const [width, setWidth] = createSignal(defaults.width);
  let container: HTMLDivElement | undefined;
  onMount(() => {
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });
  return {
    size: {
      get width() {
        return width();
      },
      get height() {
        return width() < 600 ? 220 : defaults.height;
      },
      padding: defaults.padding,
    },
    ref: (element) => {
      container = element;
    },
  };
}
