import type { ChartSize, PlotRect } from "./chart-geometry";

/** The padded plot rectangle shared by every cartesian chart. */
export function plotRect(size: ChartSize): PlotRect {
  const width = Math.max(size.width - size.padding.left - size.padding.right, 1);
  const height = Math.max(size.height - size.padding.top - size.padding.bottom, 1);
  return {
    left: size.padding.left,
    top: size.padding.top,
    width,
    height,
    bottom: size.padding.top + height,
    right: size.padding.left + width,
  };
}
