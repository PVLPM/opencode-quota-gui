import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

export interface TooltipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Places the custom tooltip over the plot, on the half opposite the active
 * bucket. The collision box is the intersection of the chart/card and the
 * visible scroller, so a narrow card never lets the overlay escape its border
 * and a scrolled chart never leaves a floating tooltip behind.
 */
export function placeChartTooltip(input: {
  chart: TooltipRect;
  bounds: TooltipRect;
  tooltip: { width: number; height: number };
  anchor: number;
  /** Optional clearance from the active mark; defaults to a small gap. */
  gap?: number;
}) {
  const { chart, bounds, tooltip } = input;
  const inset = 8;
  const gap = Math.max(0, input.gap ?? 10);
  const clipLeft = Math.max(chart.left, bounds.left);
  const clipTop = Math.max(chart.top, bounds.top);
  const clipRight = Math.min(chart.left + chart.width, bounds.left + bounds.width);
  const clipBottom = Math.min(chart.top + chart.height, bounds.top + bounds.height);
  const maxWidth = Math.max(0, clipRight - clipLeft - inset * 2);
  const maxHeight = Math.max(0, clipBottom - clipTop - inset * 2);
  const width = Math.min(tooltip.width, maxWidth);
  const height = Math.min(tooltip.height, maxHeight);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  const anchorX = chart.left + chart.width * input.anchor;
  const preferredLeft = input.anchor < 0.5 ? anchorX + gap : anchorX - gap - width;
  const left = clamp(
    preferredLeft,
    clipLeft + inset,
    Math.max(clipLeft + inset, clipRight - inset - width),
  );
  const preferredTop = clipTop + (clipBottom - clipTop - height) / 2;
  const top = clamp(
    preferredTop,
    clipTop + inset,
    Math.max(clipTop + inset, clipBottom - inset - height),
  );
  return {
    left: left - chart.left,
    top: top - chart.top,
    maxWidth,
    maxHeight,
    visible: clipRight > clipLeft && clipBottom > clipTop && width > 0 && height > 0,
  };
}

export function createChartTooltipLayout(anchor: () => number, gap?: () => number) {
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
        gap: gap?.(),
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
