import { createSignal, onCleanup, onMount } from "solid-js";
import type { ChartSize } from "./chart-geometry";

/** Match the SVG coordinate space to its container so narrow-screen labels stay legible. */
export function createChartLayout(defaults: ChartSize): {
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
        return width() < 600 ? 220 : defaults.height;
      },
      padding: defaults.padding,
    },
    ref: (element) => {
      if (element !== container) observe(element);
    },
  };
}
