import { describe, expect, it } from "vitest";
import { placeChartTooltip } from "../src/ui/tooltip-layout";

describe("chart tooltip collision bounds", () => {
  it.each([
    {
      name: "desktop before scroll",
      left: 209,
      top: 263,
      bounds: { left: 9, top: 85, width: 1407, height: 906 },
    },
    {
      name: "desktop regression at scrollTop160",
      left: 209,
      top: 103,
      bounds: { left: 9, top: 85, width: 1407, height: 906 },
    },
    {
      name: "narrow before scroll",
      left: 42,
      top: 324,
      bounds: { left: 9, top: 122, width: 357, height: 713 },
    },
    {
      name: "narrow regression at scrollTop160",
      left: 42,
      top: 164,
      bounds: { left: 9, top: 122, width: 357, height: 713 },
    },
  ])("keeps the entire tooltip inside $name", ({ left, top, bounds }) => {
    const chart = { left, top, width: Math.min(1008, bounds.width - 32), height: 260 };
    for (const anchor of [0, 0.125, 0.5, 1]) {
      const result = placeChartTooltip({
        chart,
        bounds,
        tooltip: { width: 240, height: 153 },
        anchor,
      });
      expect(result.visible).toBe(true);
      expect(chart.top + result.top).toBeGreaterThanOrEqual(bounds.top + 8);
      expect(chart.top + result.top + 153).toBeLessThanOrEqual(bounds.top + bounds.height - 8);
      expect(chart.left + result.left).toBeGreaterThanOrEqual(bounds.left + 8);
      expect(chart.left + result.left + 240).toBeLessThanOrEqual(bounds.left + bounds.width - 8);
    }
  });

  it("does not leave a floating tooltip when its chart scrolls out of view", () => {
    const result = placeChartTooltip({
      chart: { left: 40, top: -300, width: 300, height: 220 },
      bounds: { left: 9, top: 100, width: 350, height: 600 },
      tooltip: { width: 240, height: 153 },
      anchor: 0.5,
    });
    expect(result.visible).toBe(false);
  });

  it("caps overlay dimensions within a small resized inner viewport", () => {
    const chart = { left: 15, top: 100, width: 200, height: 220 };
    const bounds = { left: 9, top: 95, width: 180, height: 120 };
    const result = placeChartTooltip({
      chart,
      bounds,
      tooltip: { width: 240, height: 153 },
      anchor: 1,
    });
    // The visible chart/card intersection is 174x115; the 8px inset leaves
    // 158x99 for the overlay.
    expect(result.maxWidth).toBe(158);
    expect(result.maxHeight).toBe(99);
    expect(chart.left + result.left).toBeGreaterThanOrEqual(bounds.left + 8);
    expect(chart.left + result.left + 158).toBeLessThanOrEqual(bounds.left + bounds.width - 8);
    expect(chart.top + result.top).toBeGreaterThanOrEqual(bounds.top + 8);
    expect(chart.top + result.top + 99).toBeLessThanOrEqual(bounds.top + bounds.height - 8);
  });

  it("places the tooltip on the opposite half of the plot", () => {
    const chart = { left: 100, top: 100, width: 600, height: 260 };
    const bounds = { left: 0, top: 0, width: 800, height: 800 };
    const leftHalf = placeChartTooltip({
      chart,
      bounds,
      tooltip: { width: 240, height: 150 },
      anchor: 0.25,
    });
    const rightHalf = placeChartTooltip({
      chart,
      bounds,
      tooltip: { width: 240, height: 150 },
      anchor: 0.75,
    });
    const anchorLeft = chart.left + chart.width * 0.25;
    const anchorRight = chart.left + chart.width * 0.75;
    expect(chart.left + leftHalf.left).toBeGreaterThanOrEqual(anchorLeft);
    expect(chart.left + rightHalf.left + 240).toBeLessThanOrEqual(anchorRight);
  });

  it("honours a wider clearance for a wide stacked bar", () => {
    const chart = { left: 100, top: 100, width: 600, height: 260 };
    const bounds = { left: 0, top: 0, width: 800, height: 800 };
    const result = placeChartTooltip({
      chart,
      bounds,
      tooltip: { width: 240, height: 150 },
      anchor: 0.75,
      gap: 34,
    });
    const anchorRight = chart.left + chart.width * 0.75;
    expect(chart.left + result.left + 240).toBeLessThanOrEqual(anchorRight - 34 + 0.01);
  });

  it("clamps a narrow card overlay inside the card, not only the scroller", () => {
    const chart = { left: 40, top: 80, width: 160, height: 220 };
    const bounds = { left: 9, top: 60, width: 360, height: 700 };
    const result = placeChartTooltip({
      chart,
      bounds,
      tooltip: { width: 240, height: 153 },
      anchor: 0.9,
    });
    expect(result.maxWidth).toBe(144);
    expect(chart.left + result.left).toBeGreaterThanOrEqual(chart.left + 8);
    expect(chart.left + result.left + 144).toBeLessThanOrEqual(chart.left + chart.width - 8);
  });
});
