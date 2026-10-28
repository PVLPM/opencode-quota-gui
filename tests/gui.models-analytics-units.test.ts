import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsBucketBoundary, AnalyticsSeries } from "../src/contracts/dashboard";
import { createChartLayout } from "../src/ui/chart-layout";
import {
  formatApiEquivalentCostFine,
  formatApiEquivalentCostText,
  formatApiEquivalentCostTick,
  formatTokenCount,
} from "../src/ui/format";
import {
  API_EQUIVALENT_TOOLTIP,
  buildEntityColorMap,
  combineEstimates,
  costValueTitle,
  disambiguatedIdentityLabel,
  entityKey,
  estimateNote,
  formatCostText,
  identityLabel,
  identityTitle,
  isAuthoritativelyFree,
  oppositeDimension,
  rankSeries,
  rowSeriesKey,
  seriesColorForKey,
  seriesColorVar,
  seriesKey,
  sortBreakdownRows,
} from "../src/ui/model-analytics";
import {
  buildChildCompositionSlices,
  buildParentCompositionSlices,
} from "../src/ui/model-chart-composition";
import { buildModelChartGeometry, DEFAULT_MODEL_USAGE_SIZE } from "../src/ui/model-chart-geometry";
import { buildModelCostOverlayGeometry } from "../src/ui/model-cost-overlay";
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

  it("falls back to a pinned key and clears it with its transient emphasis", () => {
    createRoot((stop) => {
      const inspection = createSeriesInspection();
      inspection.inspectFocus("alpha");
      inspection.togglePinned("gamma");
      expect(inspection.active()).toBe("alpha");
      inspection.clearFocus();
      expect(inspection.active()).toBe("gamma");
      expect(inspection.pinned()).toBe("gamma");

      inspection.inspectPointer("gamma");
      inspection.togglePinned("gamma");
      expect(inspection.pinned()).toBeUndefined();
      expect(inspection.active()).toBeUndefined();

      inspection.inspectFocus("beta");
      inspection.togglePinned("beta");
      inspection.reconcile(new Set(["alpha"]));
      expect(inspection.pinned()).toBeUndefined();
      stop();
    });
  });

  it("keeps a child selection scoped to its parent series", () => {
    createRoot((stop) => {
      const inspection = createSeriesInspection();
      inspection.inspectPointerChild({
        seriesKey: "model:known:model-alpha",
        childKey: "provider:known:openai",
      });
      expect(inspection.active()).toBe("model:known:model-alpha");
      expect(inspection.activeChild()).toEqual({
        seriesKey: "model:known:model-alpha",
        childKey: "provider:known:openai",
      });

      // Moving to the parent row clears the child but keeps the parent active.
      inspection.inspectPointer("model:known:model-alpha");
      expect(inspection.active()).toBe("model:known:model-alpha");
      expect(inspection.activeChild()).toBeUndefined();

      inspection.clearPointer();
      inspection.inspectFocusChild({
        seriesKey: "model:known:model-alpha",
        childKey: "provider:known:anthropic",
      });
      expect(inspection.activeChild()?.childKey).toBe("provider:known:anthropic");
      inspection.inspectPointer("model:known:model-beta");
      expect(inspection.active()).toBe("model:known:model-beta");
      expect(inspection.activeChild()).toBeUndefined();
      inspection.clearPointer();
      expect(inspection.active()).toBe("model:known:model-alpha");
      expect(inspection.activeChild()?.childKey).toBe("provider:known:anthropic");

      inspection.reconcile(new Set(["model:known:model-beta"]));
      expect(inspection.active()).toBeUndefined();
      expect(inspection.activeChild()).toBeUndefined();
      stop();
    });
  });

  it("keeps a hidden-parent selection scoped to Other and reconciles exact keys", () => {
    createRoot((stop) => {
      const inspection = createSeriesInspection();
      inspection.inspectFocusParent({
        seriesKey: "other",
        parentKey: "model:known:model-zeta",
      });
      expect(inspection.active()).toBe("other");
      expect(inspection.activeParent()).toEqual({
        seriesKey: "other",
        parentKey: "model:known:model-zeta",
      });
      expect(inspection.activeChild()).toBeUndefined();

      // A parent-row selection and a child-row selection never coexist.
      inspection.inspectPointerChild({
        seriesKey: "model:known:model-alpha",
        childKey: "provider:known:openai",
      });
      expect(inspection.activeParent()).toBeUndefined();
      expect(inspection.activeChild()?.childKey).toBe("provider:known:openai");
      inspection.inspectPointerParent({ seriesKey: "other", parentKey: "model:unknown" });
      expect(inspection.activeChild()).toBeUndefined();
      expect(inspection.activeParent()?.parentKey).toBe("model:unknown");
      expect(inspection.active()).toBe("other");

      // A snapshot change can retire the exact parent while Other remains.
      inspection.reconcile(new Set(["other"]), new Set(["model:known:model-zeta"]));
      expect(inspection.activeParent()).toBeUndefined();
      expect(inspection.active()).toBe("other");
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

  it("assigns rank colours in token order and follows a rank change", () => {
    const snapshot = modelSnapshot();
    const keys = rankSeries(snapshot.series).map((entry) => seriesKey(entry, "model"));
    expect(keys).toEqual([
      "model:known:model-alpha",
      "model:known:model-beta",
      "model:known:model-gamma",
      "model:known:model-delta",
      "model:known:model-epsilon",
      "other",
    ]);
    expect(seriesColorForKey("model:known:model-alpha", keys)).toBe("--qg-rank-1");
    expect(seriesColorForKey("model:known:model-beta", keys)).toBe("--qg-rank-2");
    expect(seriesColorForKey("model:known:model-gamma", keys)).toBe("--qg-rank-3");
    expect(seriesColorForKey("model:known:model-delta", keys)).toBe("--qg-rank-4");
    expect(seriesColorForKey("model:known:model-epsilon", keys)).toBe("--qg-rank-5");
    expect(seriesColorForKey("other", keys)).toBe("--qg-rank-other");

    // A range can move an entity's token rank; its swatch follows that rank.
    const shifted = {
      ...snapshot,
      series: snapshot.series.map((entry) =>
        entry.kind === "entity" &&
        entry.identity.kind === "known" &&
        entry.identity.id === "model-epsilon"
          ? { ...entry, tokens: { ...entry.tokens, total: 700 } }
          : entry,
      ),
    };
    const shiftedKeys = rankSeries(shifted.series).map((entry) => seriesKey(entry, "model"));
    expect(seriesColorForKey("model:known:model-epsilon", keys)).toBe("--qg-rank-5");
    expect(seriesColorForKey("model:known:model-epsilon", shiftedKeys)).toBe("--qg-rank-1");
    expect(seriesColorForKey("model:known:model-alpha", shiftedKeys)).toBe("--qg-rank-2");
    expect(seriesColorForKey("model:known:model-beta", shiftedKeys)).toBe("--qg-rank-3");
    expect(seriesColorForKey("model:known:model-gamma", shiftedKeys)).toBe("--qg-rank-4");
    expect(seriesColorForKey("model:known:model-delta", shiftedKeys)).toBe("--qg-rank-5");
    expect(seriesColorVar(5, "entity")).toBe("--qg-rank-other");
    expect(seriesColorVar(0, "other")).toBe("--qg-rank-other");
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
    const keys = rankSeries(modelSnapshot().series).map((entry) => seriesKey(entry, "model"));
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

  it("renders an absent priced total as Unpriced, never as a zero-cost estimate", () => {
    expect(formatApiEquivalentCostText(1.2, 100)).toBe("≈ USD 1.20");
    expect(formatApiEquivalentCostText(0, 100)).toBe("≈ USD 0.00");
    expect(formatApiEquivalentCostText(null, 100)).toBe("Unpriced");
    expect(formatApiEquivalentCostText(null, 0)).toBe("—");
    expect(formatApiEquivalentCostFine(0.0042)).toBe("≈ USD 0.0042");
    expect(formatApiEquivalentCostFine(0.42)).toBe("≈ USD 0.42");
    expect(formatApiEquivalentCostFine(0)).toBe("≈ USD 0.00");
    expect(formatApiEquivalentCostFine(null)).toBe("≈ USD —");
  });

  it("shows Free only when every token is authoritatively priced at exactly zero", () => {
    const free = costed({ input: 100 }, { apiEquivalentCostUsd: 0 });
    const rounded = costed({ input: 100 }, { apiEquivalentCostUsd: 0.0000004 });
    const partialZero = costed({ input: 100 }, { apiEquivalentCostUsd: 0, unpricedTokens: 25 });
    const unknownZero = costed({ input: 100 }, { apiEquivalentCostUsd: 0, unknownTokens: 1 });
    const unpriced = costed({ input: 100 }, { apiEquivalentCostUsd: null, unpricedTokens: 100 });
    const empty = costed({}, { apiEquivalentCostUsd: 0 });

    expect(isAuthoritativelyFree(free)).toBe(true);
    expect(isAuthoritativelyFree(rounded)).toBe(false);
    expect(isAuthoritativelyFree(partialZero)).toBe(false);
    expect(isAuthoritativelyFree(unknownZero)).toBe(false);
    expect(isAuthoritativelyFree(unpriced)).toBe(false);
    expect(isAuthoritativelyFree(empty)).toBe(false);

    expect(formatCostText(free)).toBe("Free");
    expect(costValueTitle(free)).toContain("Free");
    expect(formatCostText(rounded)).toBe("≈ USD 0.00");
    expect(formatCostText(partialZero)).toBe("≈ USD 0.00");
    expect(costValueTitle(partialZero)).not.toContain("Free");
    expect(formatCostText(unknownZero)).toBe("≈ USD 0.00");
    expect(formatCostText(unpriced)).toBe("Unpriced");
    expect(formatCostText(empty)).toBe("—");
  });

  it("gives an opposite-dimension leaf the same rank colour in either grouping", () => {
    const modelColors = buildEntityColorMap(modelSnapshot().rows, "model");
    const providerColors = buildEntityColorMap(providerSnapshot().rows, "provider");
    expect(oppositeDimension("model")).toBe("provider");
    expect(oppositeDimension("provider")).toBe("model");
    expect(modelColors.get("provider:known:openai")).toBe("--qg-rank-1");
    expect(modelColors.get("provider:known:google")).toBe("--qg-rank-2");
    expect(modelColors.get("provider:unknown")).toBe("--qg-rank-4");
    expect(modelColors.get("provider:known:deepseek")).toBe("--qg-rank-other");
    expect(providerColors.get("model:known:model-alpha")).toBe("--qg-rank-1");
    expect(providerColors.get("model:known:model-gamma")).toBe("--qg-rank-3");
    expect(providerColors.get("model:known:model-zeta")).toBe("--qg-rank-other");
    // Reordering rows never re-colours an entity: colours come from the snapshot, not display sort.
    const shuffled = [...providerSnapshot().rows].reverse();
    expect([...buildEntityColorMap(shuffled, "provider")]).toEqual([...providerColors]);
  });

  it("overlays priced, partial, unpriced, true-zero and empty cost buckets", () => {
    const series: AnalyticsSeries[] = [
      {
        kind: "entity",
        identity: known("cost-series"),
        tokens: costed({ input: 60 }, { apiEquivalentCostUsd: 3, unpricedTokens: 5 }),
        buckets: [
          costed({ input: 10 }, { apiEquivalentCostUsd: 2 }),
          costed({ input: 10 }, { apiEquivalentCostUsd: 1, unpricedTokens: 5 }),
          costed({ input: 10 }, { apiEquivalentCostUsd: null, unpricedTokens: 10 }),
          costed({ input: 10 }, { apiEquivalentCostUsd: 0 }),
          costed({}, { apiEquivalentCostUsd: null }),
        ],
      },
    ];
    const boundaries = Array.from({ length: 5 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
    }));
    const chart = buildModelChartGeometry(series, boundaries);
    const overlay = buildModelCostOverlayGeometry(series, boundaries, chart);
    expect(overlay.points.map((point) => point.status)).toEqual([
      "priced",
      "partial",
      "unpriced",
      "zero",
      "empty",
    ]);
    expect(overlay.points.map((point) => point.total)).toEqual([10, 10, 10, 10, 0]);
    expect(overlay.points.map((point) => point.cost)).toEqual([2, 1, null, 0, null]);
    // The line only connects numeric buckets; unpriced and empty are gaps.
    expect(overlay.points[2]?.y).toBeNull();
    expect(overlay.points[4]?.y).toBeNull();
    expect(overlay.points[0]?.y).toBeLessThan(overlay.points[1]?.y ?? 0);
    expect(overlay.points[1]?.y).toBeLessThan(chart.plot.bottom);
    // A true zero is a real point on the baseline, never a missing value.
    expect(overlay.points[3]?.y).toBe(chart.plot.bottom);
    expect(overlay.runs).toHaveLength(1);
    expect(overlay.runs[0]?.pointCount).toBe(2);
    expect(overlay.runs[0]?.partial).toBe(true);
    expect(overlay.runs[0]?.path).toContain((overlay.points[0]?.x ?? 0).toFixed(2));
    expect(overlay.runs[0]?.path).not.toContain((overlay.points[3]?.x ?? 0).toFixed(2));
    expect(overlay.isolated.map((point) => point.bucketIndex)).toEqual([3]);
    // The right axis uses a nice 1/2/5 scale above the measured cost.
    expect(overlay.maxCost).toBe(2);
    expect(overlay.scaleMax).toBe(2);
    expect(overlay.tickStep).toBe(0.5);
    expect(overlay.ticks.map((tick) => tick.value)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(overlay.ticks.at(-1)?.y).toBeCloseTo(chart.plot.top, 10);
    expect(overlay.hasNumeric).toBe(true);
    expect(overlay.hasPartial).toBe(true);
    expect(overlay.hasUnpriced).toBe(true);
    // Points share the token bar's slot centre, so the line reads vertically.
    overlay.points.forEach((point, index) => {
      const bar = chart.bars[index];
      expect(point.x).toBeCloseTo((bar?.x ?? 0) + (bar?.width ?? 0) / 2, 10);
    });
  });

  it("totals every visible series into each cost bucket", () => {
    const alpha = costed({ input: 20 }, { apiEquivalentCostUsd: 3, unpricedTokens: 10 });
    const beta = costed({ input: 20 }, { apiEquivalentCostUsd: 4 });
    const series: AnalyticsSeries[] = [
      {
        kind: "entity",
        identity: known("alpha"),
        tokens: alpha,
        buckets: [
          costed({ input: 10 }, { apiEquivalentCostUsd: 2 }),
          costed({ input: 10 }, { apiEquivalentCostUsd: null, unpricedTokens: 10 }),
        ],
      },
      {
        kind: "entity",
        identity: known("beta"),
        tokens: beta,
        buckets: [
          costed({ input: 10 }, { apiEquivalentCostUsd: 1 }),
          costed({ input: 10 }, { apiEquivalentCostUsd: 3 }),
        ],
      },
    ];
    const boundaries = [
      { startMs: 0, endMs: 1_000 },
      { startMs: 1_000, endMs: 2_000 },
    ];
    const chart = buildModelChartGeometry(series, boundaries);
    const overlay = buildModelCostOverlayGeometry(series, boundaries, chart);
    // The rule consumes every visible series: 2 + 1, then a priced 3 with
    // 10 excluded tokens, not just the first series or a focused one.
    expect(overlay.points.map((point) => point.cost)).toEqual([3, 3]);
    expect(overlay.points.map((point) => point.status)).toEqual(["priced", "partial"]);
    expect(overlay.runs).toHaveLength(1);
    expect(overlay.runs[0]?.partial).toBe(true);
    expect(overlay.maxCost).toBe(3);
  });

  it("keeps a zero priced subtotal partial when some tokens are unpriced", () => {
    const bucket = costed({ input: 10 }, { apiEquivalentCostUsd: 0, unpricedTokens: 5 });
    const series: AnalyticsSeries[] = [
      {
        kind: "entity",
        identity: known("free-partial"),
        tokens: bucket,
        buckets: [bucket],
      },
    ];
    const boundaries = [{ startMs: 0, endMs: 1_000 }];
    const chart = buildModelChartGeometry(series, boundaries);
    const overlay = buildModelCostOverlayGeometry(series, boundaries, chart);
    expect(overlay.points[0]?.status).toBe("partial");
    expect(overlay.points[0]?.y).toBe(chart.plot.bottom);
    expect(overlay.runs).toHaveLength(0);
    expect(overlay.isolated).toHaveLength(1);
    expect(overlay.isolated[0]?.bucketIndex).toBe(0);
    expect(overlay.ticks.map((tick) => tick.value)).toEqual([0]);
  });

  it("formats cost-axis ticks at the scale's precision", () => {
    expect(formatApiEquivalentCostTick(0, 0.005)).toBe("0");
    expect(formatApiEquivalentCostTick(0.005, 0.005)).toBe("0.005");
    expect(formatApiEquivalentCostTick(0.01, 0.005)).toBe("0.010");
    expect(formatApiEquivalentCostTick(1.5, 0.5)).toBe("1.5");
    expect(formatApiEquivalentCostTick(12, 2)).toBe("12");
    expect(formatApiEquivalentCostTick(0.000005, 0.000001)).toBe("0.000005");
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

  it("subdivides a parent segment by same-bucket tokens and preserves its envelope", () => {
    const segment = { value: 100, x: 10, y: 20, width: 24, height: 50 };
    const parent = costed({ input: 100 }, { apiEquivalentCostUsd: 3 });
    const children = [
      { identity: known("openai"), tokens: costed({ input: 60 }, { apiEquivalentCostUsd: 1.5 }) },
      {
        identity: known("anthropic"),
        tokens: costed({ input: 40 }, { apiEquivalentCostUsd: null, unpricedTokens: 40 }),
      },
    ];
    const slices = buildChildCompositionSlices({
      segment,
      parentTokens: parent,
      children,
      dimension: "model",
    });
    expect(slices.map((slice) => slice.key)).toEqual([
      "provider:known:openai",
      "provider:known:anthropic",
    ]);
    expect(slices.map((slice) => slice.share)).toEqual([0.6, 0.4]);
    expect(slices.map((slice) => slice.height)).toEqual([30, 20]);
    expect(slices.every((slice) => slice.x === segment.x && slice.width === segment.width)).toBe(
      true,
    );
    expect((slices[0]?.y ?? 0) + (slices[0]?.height ?? 0)).toBeCloseTo(segment.y + segment.height);
    expect(slices[1]?.y).toBe(segment.y);
    expect(slices[0]?.fillOpacity).toBeGreaterThan(slices[1]?.fillOpacity ?? 0);
  });

  it("leaves unconserved child tokens in the parent colour and never subdivides one child", () => {
    const segment = { value: 100, x: 0, y: 0, width: 20, height: 40 };
    const parent = costed({ input: 100 }, { apiEquivalentCostUsd: 2 });
    const sparse = buildChildCompositionSlices({
      segment,
      parentTokens: parent,
      children: [
        { identity: known("openai"), tokens: costed({ input: 30 }, { apiEquivalentCostUsd: 1 }) },
        { identity: known("google"), tokens: costed({ input: 20 }, { apiEquivalentCostUsd: 1 }) },
      ],
      dimension: "model",
    });
    expect(sparse.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(0.5);
    expect(sparse.reduce((sum, slice) => sum + slice.height, 0)).toBeCloseTo(20);

    const single = buildChildCompositionSlices({
      segment,
      parentTokens: parent,
      children: [
        { identity: known("openai"), tokens: costed({ input: 100 }, { apiEquivalentCostUsd: 2 }) },
      ],
      dimension: "model",
    });
    expect(single).toEqual([]);
  });

  it("uses only known numeric costs for cost composition and never invents an unpriced share", () => {
    const segment = { value: 100, x: 0, y: 0, width: 20, height: 60 };
    const parent = costed({ input: 100 }, { apiEquivalentCostUsd: 3 });
    const slices = buildChildCompositionSlices({
      segment,
      parentTokens: parent,
      children: [
        {
          identity: known("openai"),
          tokens: costed({ input: 60 }, { apiEquivalentCostUsd: null, unpricedTokens: 60 }),
        },
        { identity: known("google"), tokens: costed({ input: 20 }, { apiEquivalentCostUsd: 1 }) },
        {
          identity: known("anthropic"),
          tokens: costed({ input: 20 }, { apiEquivalentCostUsd: 2 }),
        },
      ],
      dimension: "model",
      mode: "cost",
    });
    expect(slices.map((slice) => slice.key)).toEqual([
      "provider:known:google",
      "provider:known:anthropic",
    ]);
    expect(slices.map((slice) => slice.share)).toEqual([1 / 3, 2 / 3]);
    expect(slices.map((slice) => slice.tokens.apiEquivalentCostUsd)).toEqual([1, 2]);

    const unpricedParent = buildChildCompositionSlices({
      segment,
      parentTokens: costed({ input: 100 }, { apiEquivalentCostUsd: null, unpricedTokens: 100 }),
      children: [
        { identity: known("google"), tokens: costed({ input: 50 }, { apiEquivalentCostUsd: 1 }) },
        { identity: known("openai"), tokens: costed({ input: 50 }, { apiEquivalentCostUsd: 1 }) },
      ],
      dimension: "model",
      mode: "cost",
    });
    expect(unpricedParent).toEqual([]);
  });

  it("subdivides Other by exact hidden same-dimension parents in either grouping", () => {
    const segment = { value: 100, x: 4, y: 10, width: 20, height: 50 };
    const cases = [
      {
        dimension: "model" as const,
        identities: [known("model-zeta"), unknownIdentity, known("")],
      },
      {
        dimension: "provider" as const,
        identities: [known("deepseek"), known("openrouter"), known("")],
      },
    ];
    for (const testCase of cases) {
      const parent = costed({ input: 100 }, { apiEquivalentCostUsd: 3 });
      const parents = [
        { identity: testCase.identities[0], tokens: costed({ input: 50 }) },
        { identity: testCase.identities[1], tokens: costed({ input: 30 }) },
        { identity: testCase.identities[2], tokens: costed({ input: 20 }) },
      ];
      const slices = buildParentCompositionSlices({
        segment,
        parentTokens: parent,
        parents,
        dimension: testCase.dimension,
      });
      expect(slices.map((slice) => slice.key)).toEqual(
        testCase.identities.map((identity) => entityKey(testCase.dimension, identity)),
      );
      expect(slices).toHaveLength(3);
      for (const [index, expectedShare] of [0.5, 0.3, 0.2].entries()) {
        expect(slices[index]?.share).toBeCloseTo(expectedShare);
      }
      expect(slices.every((slice) => slice.x === segment.x && slice.width === segment.width)).toBe(
        true,
      );
      expect((slices[0]?.y ?? 0) + (slices[0]?.height ?? 0)).toBeCloseTo(
        segment.y + segment.height,
      );
      expect(slices[2]?.y).toBeCloseTo(segment.y);
    }

    // Sparse real parents leave the missing remainder in the Other colour,
    // and one hidden parent is never a fake full-height distinction.
    const sparse = buildParentCompositionSlices({
      segment,
      parentTokens: costed({ input: 100 }, { apiEquivalentCostUsd: 3 }),
      parents: [
        { identity: known("model-zeta"), tokens: costed({ input: 50 }) },
        { identity: known("model-eta"), tokens: costed({ input: 20 }) },
      ],
      dimension: "model",
    });
    expect(sparse.map((slice) => slice.share)).toHaveLength(2);
    expect(sparse[0]?.share).toBeCloseTo(0.5);
    expect(sparse[1]?.share).toBeCloseTo(0.2);
    const single = buildParentCompositionSlices({
      segment,
      parentTokens: costed({ input: 100 }, { apiEquivalentCostUsd: 3 }),
      parents: [{ identity: known("model-zeta"), tokens: costed({ input: 100 }) }],
      dimension: "model",
    });
    expect(single).toEqual([]);

    const byCost = buildParentCompositionSlices({
      segment,
      parentTokens: costed({ input: 100 }, { apiEquivalentCostUsd: 3 }),
      parents: [
        {
          identity: known("model-zeta"),
          tokens: costed({ input: 50 }, { apiEquivalentCostUsd: 1 }),
        },
        {
          identity: known("model-eta"),
          tokens: costed({ input: 50 }, { apiEquivalentCostUsd: 2 }),
        },
      ],
      dimension: "model",
      mode: "cost",
    });
    expect(byCost.map((slice) => slice.share)).toHaveLength(2);
    expect(byCost[0]?.share).toBeCloseTo(1 / 3);
    expect(byCost[1]?.share).toBeCloseTo(2 / 3);
  });

  it("returns an empty plot when a range has no series", () => {
    const geometry = buildModelChartGeometry([], providerSnapshot().buckets);
    expect(geometry.bars.every((bar) => bar.segments.length === 0)).toBe(true);
    expect(geometry.yMax).toBe(0);
  });
});
