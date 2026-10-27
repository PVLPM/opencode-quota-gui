import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsBucketBoundary, AnalyticsSeries } from "../src/contracts/dashboard";
import { createChartLayout } from "../src/ui/chart-layout";
import { formatTokenCount } from "../src/ui/format";
import {
  API_EQUIVALENT_TOOLTIP,
  combineEstimates,
  disambiguatedIdentityLabel,
  estimateNote,
  identityLabel,
  identityTitle,
  rankSeries,
  rowSeriesKey,
  seriesColorForKey,
  seriesColorVar,
  seriesKey,
  sortBreakdownRows,
} from "../src/ui/model-analytics";
import { buildModelChartGeometry, DEFAULT_MODEL_USAGE_SIZE } from "../src/ui/model-chart-geometry";
import { createSeriesInspection } from "../src/ui/series-inspection";
import { costed, DAY_MS, NOW } from "./fixtures/gui-ui-fixtures";
import {
  known,
  makeRow,
  modelSnapshot,
  providerSnapshot,
  unknownIdentity,
} from "./fixtures/model-analytics-fixtures";

/**
 * Focused pure contracts for the Models surfaces: token rank is the chart's
 * only order, list sorting is independent, null is not zero, and unknown /
 * known-empty identities stay distinguishable in labels and route keys.
 */

function labels(rows: ReturnType<typeof sortBreakdownRows>): string[] {
  return rows.map((row) => identityLabel(row.identity, "model"));
}

/** Five real model segments whose bucket total is exactly `total`. */
function modelPeak(total: number): {
  series: AnalyticsSeries[];
  boundaries: AnalyticsBucketBoundary[];
} {
  const parts = [35, 25, 20, 12, 8].map((weight) => Math.floor((total * weight) / 100));
  const remainder = total - parts.reduce((sum, value) => sum + value, 0);
  const values = parts.map((value, index) => (index === 0 ? value + remainder : value));
  return {
    series: values.map((value, index) => ({
      kind: "entity",
      identity: known(`peak-model-${index}`),
      tokens: costed({ input: value }),
      buckets: [costed({ input: value }), costed({})],
    })),
    boundaries: [
      { startMs: NOW - 2 * DAY_MS, endMs: NOW - DAY_MS },
      { startMs: NOW - DAY_MS, endMs: NOW },
    ],
  };
}

describe("model analytics presentation", () => {
  it("reconciles stale pointer and focus keys while keeping valid ones", () => {
    createRoot((stop) => {
      const inspection = createSeriesInspection();
      inspection.inspectFocus("alpha");
      inspection.inspectPointer("beta");
      expect(inspection.active()).toBe("beta");

      inspection.reconcile(new Set(["alpha", "gamma"]));
      expect(inspection.active()).toBe("alpha");

      inspection.reconcile(new Set(["gamma"]));
      expect(inspection.active()).toBeUndefined();
      stop();
    });
  });

  it("keeps the approved API-equivalent copy exact", () => {
    expect(API_EQUIVALENT_TOOLTIP).toBe(
      "API-equivalent estimate based on model pricing. Not actual billed spend.",
    );
  });

  it("labels unknown, known-empty and provider identities without inferring one from another", () => {
    expect(identityLabel(unknownIdentity, "model")).toBe("Unknown model");
    expect(identityLabel(unknownIdentity, "provider")).toBe("Unknown provider");
    expect(identityLabel(known(""), "model")).toBe("Empty model ID");
    expect(identityLabel(known("  "), "provider")).toBe("Empty provider ID");
    expect(identityLabel(known("openai"), "provider")).toBe("OpenAI");
    expect(identityLabel(known("model-alpha"), "provider")).toBe("model-alpha");
    expect(identityTitle(known("a/b"), "model")).toBe("a/b");
    expect(identityTitle(unknownIdentity, "model")).toMatch(/no .* id/i);
  });

  it("ranks chart series by tokens, ties by raw identity, and leaves Other last", () => {
    const snapshot = modelSnapshot();
    const shuffled = [...snapshot.series].reverse();
    const ranked = rankSeries(shuffled);
    expect(
      ranked.map((entry) =>
        entry.kind === "other" ? "Other" : identityLabel(entry.identity, "model"),
      ),
    ).toEqual([
      "model-alpha",
      "model-beta",
      "model-gamma",
      "model-delta",
      "model-epsilon",
      "Other",
    ]);
    expect(ranked.map((_, index) => seriesColorVar(index, ranked[index]?.kind ?? "other"))).toEqual(
      [
        "--qg-rank-1",
        "--qg-rank-2",
        "--qg-rank-3",
        "--qg-rank-4",
        "--qg-rank-5",
        "--qg-rank-other",
      ],
    );
    expect(seriesKey(ranked[0] as AnalyticsSeries, "model")).toBe("model:known:model-alpha");
    expect(seriesKey(ranked.at(-1) as AnalyticsSeries, "model")).toBe("other");
  });

  it("maps rows outside the chart's top five to the Other series", () => {
    const snapshot = modelSnapshot();
    const keys = snapshot.series.map((entry) => seriesKey(entry, "model"));
    expect(rowSeriesKey("model", known("model-alpha"), keys)).toBe("model:known:model-alpha");
    expect(rowSeriesKey("model", known("model-zeta"), keys)).toBe("other");
    expect(rowSeriesKey("model", unknownIdentity, keys)).toBe("other");
    expect(rowSeriesKey("model", known("model-zeta"), undefined)).toBe("model:known:model-zeta");
    expect(rowSeriesKey("provider", known("openai"), [])).toBe("provider:known:openai");
  });

  it("maps a row series key to its chart rank colour and falls back to Other", () => {
    const keys = modelSnapshot().series.map((entry) => seriesKey(entry, "model"));
    expect(seriesColorForKey("model:known:model-alpha", keys)).toBe("--qg-rank-1");
    expect(seriesColorForKey("model:known:model-epsilon", keys)).toBe("--qg-rank-5");
    expect(seriesColorForKey("other", keys)).toBe("--qg-rank-other");
    expect(seriesColorForKey("model:known:model-zeta", keys)).toBe("--qg-rank-other");
    expect(seriesColorForKey("model:known:model-alpha", undefined)).toBe("--qg-rank-other");
  });

  it("sorts breakdown rows without changing the chart ranking", () => {
    const snapshot = modelSnapshot();
    const byCost = sortBreakdownRows(snapshot.rows, "cost");
    const byTokens = sortBreakdownRows(snapshot.rows, "tokens");
    expect(labels(byCost)).toEqual([
      "model-alpha",
      "model-delta",
      "model-epsilon",
      "model-zeta",
      "model-gamma",
      "Empty model ID",
      "model-beta",
      "Unknown model",
    ]);
    expect(labels(byTokens)).toEqual([
      "model-alpha",
      "model-beta",
      "model-gamma",
      "model-delta",
      "model-epsilon",
      "model-zeta",
      "Unknown model",
      "Empty model ID",
    ]);
    // The same snapshots still produce one token rank for the graph.
    expect(rankSeries(snapshot.series).map((entry) => entry.tokens.total)).toEqual([
      600, 500, 400, 300, 200, 190,
    ]);
  });

  it("sorts children inside their parent only, with null costs last and deterministic ties", () => {
    const parent = makeRow({
      identity: known("parent"),
      total: 0,
      cost: 0,
      children: [
        { identity: known("zero"), total: 10, cost: 0 },
        { identity: known("null-b"), total: 90, cost: null },
        { identity: known("tie-b"), total: 20, cost: 2 },
        { identity: known("tie-a"), total: 20, cost: 2 },
        { identity: known("null-a"), total: 80, cost: null },
      ],
    });
    const rows = sortBreakdownRows(parent.children, "cost");
    expect(rows.map((child) => identityLabel(child.identity, "model"))).toEqual([
      "tie-a",
      "tie-b",
      "zero",
      "null-a",
      "null-b",
    ]);
  });

  it("distinguishes a partial estimate from an unpriced total and a valid zero cost", () => {
    const partial = costed({ input: 100 }, { apiEquivalentCostUsd: 0.5, unpricedTokens: 25 });
    const zero = costed({ input: 100 }, { apiEquivalentCostUsd: 0 });
    const unpriced = costed({ input: 100 }, { apiEquivalentCostUsd: null, unpricedTokens: 100 });
    const empty = costed({}, { apiEquivalentCostUsd: null });
    expect(estimateNote(partial)).toBe("Partial estimate");
    expect(estimateNote(zero)).toBeUndefined();
    expect(estimateNote(unpriced)).toBe("Unpriced");
    expect(estimateNote(empty)).toBeUndefined();
    expect(combineEstimates([partial, zero, unpriced])).toEqual({
      total: 300,
      apiEquivalentCostUsd: 0.5,
      unpricedTokens: 125,
      unknownTokens: 0,
    });
    expect(combineEstimates([unpriced, unpriced]).apiEquivalentCostUsd).toBeNull();
  });

  it("disambiguates provider aliases by raw id without merging identities", () => {
    const peers = [known("zai"), known("glm"), known("zhipu")];
    expect(disambiguatedIdentityLabel(known("zai"), "provider", peers)).toBe("Z.ai (zai)");
    expect(disambiguatedIdentityLabel(known("glm"), "provider", peers)).toBe("Z.ai (glm)");
    expect(disambiguatedIdentityLabel(known("zhipu"), "provider", peers)).toBe("Zhipu");
    expect(disambiguatedIdentityLabel(known("glm"), "provider", [known("glm")])).toBe("Z.ai");
    expect(disambiguatedIdentityLabel(known("glm"), "model", peers)).toBe("glm");
  });

  it("uses provider catalog labels for rows but keeps the raw identity as the link", () => {
    const rows = sortBreakdownRows(providerSnapshot().rows, "tokens");
    expect(rows.slice(0, 5).map((row) => identityLabel(row.identity, "provider"))).toEqual([
      "OpenAI",
      "Google",
      "Anthropic",
      "Unknown provider",
      "Mistral",
    ]);
    expect(rows.find((row) => row.identity.kind === "unknown")?.identity).toEqual(unknownIdentity);
  });

  it("applies responsive width and height when the plot mounts after the chart", async () => {
    let fire: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
    class FakeResizeObserver {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        fire = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      let layout: ReturnType<typeof createChartLayout> | undefined;
      let dispose: (() => void) | undefined;
      createRoot((stop) => {
        dispose = stop;
        layout = createChartLayout(DEFAULT_MODEL_USAGE_SIZE);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A skeleton first mounts without a plot; the ref arrives with the payload.
      expect(fire).toBeUndefined();
      layout?.ref({} as HTMLDivElement);
      expect(fire).toBeDefined();
      fire?.([{ contentRect: { width: 375 } }]);
      expect(layout?.size.width).toBe(375);
      expect(layout?.size.height).toBe(220);

      fire?.([{ contentRect: { width: 1200 } }]);
      expect(layout?.size.width).toBe(1200);
      expect(layout?.size.height).toBe(260);
      dispose?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds truthful stacked bars from ranked series and aligned buckets", () => {
    const snapshot = modelSnapshot();
    const geometry = buildModelChartGeometry(rankSeries(snapshot.series), snapshot.buckets);
    expect(geometry.bars).toHaveLength(2);
    expect(geometry.bars[0]?.segments.map((segment) => segment.seriesIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(geometry.bars[0]?.segments.every((segment) => segment.height > 0)).toBe(true);
    expect(geometry.bars[0]?.total).toBe(snapshot.buckets.length > 0 ? 1314 : 0);
    expect(geometry.bars[1]?.total).toBe(876);
    expect(geometry.yMax).toBe(1314);
    expect(geometry.scaleMax).toBe(1_400);
    expect(geometry.ticks.at(-1)?.value).toBe(1_400);
    expect(geometry.labelIndexes).toEqual([0, 1]);
  });

  it("keeps model y-axis labels unique for one- to three-token totals", () => {
    for (const total of [1, 2, 3]) {
      const geometry = buildModelChartGeometry(
        [
          {
            kind: "entity",
            identity: known("tiny-model"),
            tokens: costed({ input: total }),
            buckets: [costed({ input: total })],
          },
        ],
        [{ startMs: NOW - DAY_MS, endMs: NOW }],
      );
      const labels = geometry.ticks.map((tick) => formatTokenCount(tick.value));
      expect(geometry.ticks.every((tick) => Number.isInteger(tick.value))).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("keeps a constant model-chart stride and omits an unaligned final bucket", () => {
    const boundaries = Array.from({ length: 8 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
    }));
    const desktop = buildModelChartGeometry([], boundaries);
    expect(desktop.labelIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const narrow = buildModelChartGeometry([], boundaries, {
      width: 375,
      height: 220,
      padding: { top: 12, right: 12, bottom: 24, left: 48 },
    });
    expect(narrow.labelIndexes).toEqual([0, 2, 4, 6]);
    expect(narrow.labelIndexes.at(-1)).toBe(6);
    const gaps = narrow.labelIndexes
      .slice(1)
      .map((value, index) => value - (narrow.labelIndexes[index] as number));
    expect(gaps).toEqual([2, 2, 2]);
    expect(Math.min(...gaps) * narrow.slot).toBeGreaterThanOrEqual(40);
  });

  it("uses the same regular two-day stride for the 20–27 Oct model boundaries", () => {
    const boundaries = Array.from({ length: 8 }, (_, index) => ({
      startMs: Date.UTC(2026, 9, 20 + index),
      endMs: Date.UTC(2026, 9, 21 + index),
    }));
    for (const width of [375, 357, 342]) {
      const geometry = buildModelChartGeometry([], boundaries, {
        width,
        height: 220,
        padding: { top: 12, right: 12, bottom: 24, left: 48 },
      });
      expect(geometry.labelIndexes).toEqual([0, 2, 4, 6]);
    }
  });

  it("uses the shared multisegment ceiling for representative model peaks", () => {
    for (const total of [5_890, 6_255]) {
      const chart = modelPeak(total);
      const geometry = buildModelChartGeometry(chart.series, chart.boundaries);
      expect(geometry.yMax).toBe(total);
      expect(geometry.scaleMax).toBe(7_000);
      expect(geometry.ticks.at(-1)?.value).toBe(7_000);
      expect(geometry.bars[0]?.segments).toHaveLength(5);
      expect(geometry.bars[0]?.top).toBeGreaterThan(geometry.plot.top + 8);

      const narrow = buildModelChartGeometry(chart.series, chart.boundaries, {
        width: 375,
        height: 220,
        padding: { top: 12, right: 12, bottom: 24, left: 48 },
      });
      expect(narrow.scaleMax).toBe(7_000);
      expect(narrow.ticks.at(-1)?.value).toBe(7_000);
      expect(narrow.bars[0]?.top).toBeGreaterThan(narrow.plot.top + 8);
    }
  });

  it("moves an exact-multiple model peak to the next tick", () => {
    for (const [total, expected] of [
      [6_000, 7_000],
      [7_000, 8_000],
    ] as const) {
      const chart = modelPeak(total);
      const geometry = buildModelChartGeometry(chart.series, chart.boundaries);
      expect(geometry.yMax).toBe(total);
      expect(geometry.scaleMax).toBe(expected);
      expect(geometry.ticks.at(-1)?.value).toBe(expected);
      expect(geometry.scaleMax).toBeGreaterThan(total);
      expect(geometry.bars[0]?.top).toBeGreaterThan(geometry.plot.top + 8);
    }
  });

  it("returns an empty plot when a range has no series", () => {
    const geometry = buildModelChartGeometry([], providerSnapshot().buckets);
    expect(geometry.bars.every((bar) => bar.segments.length === 0)).toBe(true);
    expect(geometry.yMax).toBe(0);
  });
});
