import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

export interface TooltipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Coordinates stay chart-local, but collision bounds are the visible scroller. */
export function placeChartTooltip(input: {
  chart: TooltipRect;
  bounds: TooltipRect;
  tooltip: { width: number; height: number };
  anchor: number;
}) {
  const { chart, bounds, tooltip } = input;
  const inset = 8;
  const maxWidth = Math.max(0, bounds.width - inset * 2);
  const maxHeight = Math.max(0, bounds.height - inset * 2);
  const width = Math.min(tooltip.width, maxWidth);
  const height = Math.min(tooltip.height, maxHeight);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  const left = clamp(
    chart.left + chart.width * input.anchor - width / 2,
    bounds.left + inset,
    bounds.left + bounds.width - inset - width,
  );
  const above = chart.top - height - inset;
  const preferredTop = above >= bounds.top + inset ? above : chart.top + inset;
  const top = clamp(preferredTop, bounds.top + inset, bounds.top + bounds.height - inset - height);
  return {
    left: left - chart.left,
    top: top - chart.top,
    maxWidth,
    maxHeight,
    visible:
      chart.top + chart.height > bounds.top &&
      chart.top < bounds.top + bounds.height &&
      width > 0 &&
      height > 0,
  };
}

export function createChartTooltipLayout(anchor: () => number) {
  const [position, setPosition] = createSignal({
    left: 0,
    top: 0,
    maxWidth: 240,
    maxHeight: 240,
    visible: false,
  });
  let chart: HTMLDivElement | undefined;
  let tooltip: HTMLOutputElement | undefined;
  let observer: ResizeObserver | undefined;
  let disposed = false;

  function update(): void {
    if (disposed || typeof document === "undefined" || !chart || !tooltip) return;
    const scroller = chart.closest<HTMLElement>(".qg-main");
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const left = Math.max(0, rect.left + scroller.clientLeft);
    const top = Math.max(0, rect.top + scroller.clientTop);
    const right = Math.min(
      window.innerWidth,
      rect.left + scroller.clientLeft + scroller.clientWidth,
    );
    const bottom = Math.min(
      window.innerHeight,
      rect.top + scroller.clientTop + scroller.clientHeight,
    );
    setPosition(
      placeChartTooltip({
        chart: chart.getBoundingClientRect(),
        bounds: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
        tooltip: { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
        anchor: anchor(),
      }),
    );
  }

  createEffect(() => {
    anchor();
    update();
  });
  onMount(() => {
    if (typeof document === "undefined") return;
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      if (chart) observer.observe(chart);
      if (tooltip) observer.observe(tooltip);
      const scroller = chart?.closest(".qg-main");
      if (scroller) observer.observe(scroller);
    }
    update();
    onCleanup(() => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    });
  });

  return {
    position,
    chartRef: (element: HTMLDivElement) => {
      chart = element;
    },
    tooltipRef: (element: HTMLOutputElement) => {
      if (tooltip) observer?.unobserve(tooltip);
      tooltip = element;
      observer?.observe(element);
      queueMicrotask(update);
    },
  };
}
