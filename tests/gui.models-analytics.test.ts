import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAnalyticsEntityToken } from "../src/contracts/analytics-entity";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupSnapshot,
  DashboardEvent,
} from "../src/contracts/dashboard";
import type { RangeKey } from "../src/contracts/ranges";
import {
  API_EQUIVALENT_TOOLTIP,
  identityLabel,
  OTHER_COLOR_VAR,
  rankSeries,
  seriesColorVar,
} from "../src/ui/model-analytics";
import { formatPath, parseLocation } from "../src/ui/routing";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestEvent, TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import {
  costed,
  DAY_MS,
  homeSnapshot,
  NOW,
  projectSnapshot,
  sessionSnapshot,
  settingsSnapshot,
  usage,
} from "./fixtures/gui-ui-fixtures.js";
import {
  known,
  modelAlphaSnapshot,
  modelNoRateSnapshot,
  modelSnapshot,
  providerAliasSnapshot,
  providerFallbackSnapshot,
  providerOpenAISnapshot,
  providerSnapshot,
  sameDayModelSnapshot,
  unknownIdentity,
  withChildBuckets,
  withParentBuckets,
  withRange,
  zeroSnapshot,
} from "./fixtures/model-analytics-fixtures";

/**
 * Focused rendered contract for the Models surfaces.
 *
 * Real Solid components run on the in-memory renderer, so keyboard focus,
 * list sorting and the relationship between the chart and the breakdown are
 * exercised as shipped rather than inferred from string snapshots.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const solidWebShimPath = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface RenderGraph {
  createComponent: (component: unknown, props: unknown) => unknown;
  createSignal: <T>(value: T) => [() => T, (next: T | ((previous: T) => T)) => T];
  mount: (code: () => unknown, root: TestNode) => () => void;
  createTestRoot: () => TestNode;
  textOf: (node: TestNode) => string;
  elementsNamed: (node: TestNode, tag: string) => TestNode[];
  listenerOf: (node: TestNode, name: string) => TestListener | undefined;
}

let server: ViteDevServer | undefined;
let graph: RenderGraph;
let modelsViewModule: Record<string, unknown>;
let modelDetailModule: Record<string, unknown>;
let providerDetailModule: Record<string, unknown>;
let appModule: Record<string, unknown>;

beforeAll(async () => {
  const rendering = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [
      {
        name: "tooltip-render-boundary",
        enforce: "pre",
        transform(_code, id) {
          if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx"))
            return "export function Tooltip(props) { return props.children }";
        },
      },
      solid({
        include: [...SOLID_JSX_SOURCES],
        solid: { generate: "universal", moduleName: "@gui-test-renderer" },
      }),
    ],
    resolve: {
      alias: [
        { find: "@gui-test-renderer", replacement: rendererPath },
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "dist", "solid.js"),
        },
        { find: /^solid-js\/web$/, replacement: solidWebShimPath },
        {
          find: /^solid-js\/store$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "store", "dist", "store.js"),
        },
      ],
    },
    ssr: {
      noExternal: [
        "solid-js",
        "solid-js/universal",
        "@opencode/ui",
        "@kobalte/core",
        "@kobalte/utils",
        "@kitlangton/solid-motion",
        "@solid-primitives/props",
        "@solid-primitives/resize-observer",
      ],
    },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = rendering;
  const renderCore = await rendering.ssrLoadModule("solid-js");
  const renderer = await rendering.ssrLoadModule(rendererPath);
  modelsViewModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/views/models.tsx"));
  modelDetailModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/views/model.tsx"));
  providerDetailModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/views/provider.tsx"),
  );
  appModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/app.tsx"));
  graph = {
    createComponent: renderCore.createComponent,
    createSignal: renderCore.createSignal,
    mount: renderer.mountTestTree,
    createTestRoot: renderer.createTestRoot,
    textOf: renderer.textOf,
    elementsNamed: renderer.elementsNamed,
    listenerOf: renderer.listenerOf,
  } satisfies RenderGraph;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function hasClass(node: TestNode, name: string): boolean {
  return String(node.props.class ?? "")
    .split(" ")
    .includes(name);
}

function byClass(root: TestNode, tag: string, name: string): TestNode[] {
  return graph.elementsNamed(root, tag).filter((node) => hasClass(node, name));
}

function listener(node: TestNode, name: string): TestListener | undefined {
  return graph.listenerOf(node, name);
}

function click(node: TestNode): void {
  listener(node, "onClick")?.({ defaultPrevented: false } as TestEvent);
}

function findSegmented(root: TestNode, label: string): TestNode | undefined {
  return graph
    .elementsNamed(root, "div")
    .find(
      (node) =>
        node.props["data-slot"] === "segmented-control-v2" && node.props["aria-label"] === label,
    );
}

function segmentedItems(root: TestNode, label: string): TestNode[] {
  const control = findSegmented(root, label);
  if (!control) return [];
  return graph
    .elementsNamed(control, "button")
    .filter((node) => node.props["data-slot"] === "segmented-control-v2-item");
}

function clickSegmented(root: TestNode, label: string, item: string): void {
  const button = segmentedItems(root, label).find((node) => graph.textOf(node) === item);
  if (!button) throw new Error(`segmented control ${label} has no ${item} item`);
  click(button);
}

function breakdownRows(root: TestNode, parentOnly = false): TestNode[] {
  return byClass(root, "a", "qg-breakdown__row").filter(
    (row) => !parentOnly || !hasClass(row, "qg-breakdown__row--child"),
  );
}

function labelOf(row: TestNode): string {
  const label = graph
    .elementsNamed(row, "span")
    .find((node) => hasClass(node, "qg-breakdown__label"));
  return label ? graph.textOf(label) : "";
}

function rowLabels(root: TestNode): string[] {
  return breakdownRows(root, true).map(labelOf);
}

function rowByLabel(root: TestNode, label: string): TestNode | undefined {
  return breakdownRows(root, true).find((row) => labelOf(row) === label);
}

function rowSwatch(row: TestNode): TestNode | undefined {
  return graph.elementsNamed(row, "span").find((node) => hasClass(node, "qg-breakdown__swatch"));
}

function swatchVar(row: TestNode): string | undefined {
  return (rowSwatch(row)?.props.style as Record<string, string> | undefined)?.["--qg-swatch"];
}

function providerMark(node: TestNode): TestNode | undefined {
  return graph
    .elementsNamed(node, "span")
    .find((entry) => entry.props["data-provider-logo"] !== undefined);
}

function rowLogo(row: TestNode): TestNode | undefined {
  return providerMark(row);
}

function providerMarkVar(node: TestNode): string | undefined {
  return (providerMark(node)?.props.style as Record<string, string> | undefined)?.[
    "--qg-provider-logo"
  ];
}

function logoVar(row: TestNode): string | undefined {
  return providerMarkVar(row);
}

function childRows(root: TestNode, parentLabel: string): TestNode[] {
  const parent = rowByLabel(root, parentLabel);
  if (!parent) return [];
  return graph
    .elementsNamed(parent.parent as TestNode, "a")
    .filter((row) => hasClass(row, "qg-breakdown__row--child"));
}

function childRow(root: TestNode, parentLabel: string, childLabel: string): TestNode | undefined {
  return childRows(root, parentLabel).find((row) => labelOf(row) === childLabel);
}

/** Phase rows are nested inside the provider group, not sibling table rows. */
function phaseRows(root: TestNode, providerLabel: string): TestNode[] {
  const provider = rowByLabel(root, providerLabel);
  const group = provider?.parent as TestNode | undefined;
  if (!group) return [];
  return byClass(group, "div", "qg-breakdown__row--phase");
}

function phaseLabelOf(row: TestNode): string {
  const label = graph
    .elementsNamed(row, "span")
    .find((node) => hasClass(node, "qg-breakdown__phase"));
  return label ? graph.textOf(label) : "";
}

function phaseTokens(row: TestNode): { text: string; title: string } | undefined {
  const node = graph
    .elementsNamed(row, "span")
    .find((entry) => hasClass(entry, "qg-breakdown__tokens"));
  return node ? { text: graph.textOf(node), title: String(node.props.title ?? "") } : undefined;
}

function summaryText(root: TestNode, label: string): string | undefined {
  const stat = graph
    .elementsNamed(root, "div")
    .find((node) => hasClass(node, "qg-chart-shell__stat") && graph.textOf(node).startsWith(label));
  return stat ? graph.textOf(stat) : undefined;
}

function chartShell(root: TestNode):
  | {
      shell: TestNode;
      head: TestNode;
      title: TestNode;
      summary: TestNode;
      body: TestNode;
    }
  | undefined {
  const shell = byClass(root, "section", "qg-chart-shell")[0];
  if (!shell) return undefined;
  const head = byClass(shell, "header", "qg-chart-shell__head")[0];
  const title = byClass(shell, "span", "qg-chart__title")[0];
  const summary = byClass(shell, "div", "qg-summary")[0];
  const body = byClass(shell, "div", "qg-usage")[0];
  if (!head || !title || !summary || !body) return undefined;
  return { shell, head, title, summary, body };
}

function chartTitle(root: TestNode): TestNode | undefined {
  return byClass(root, "span", "qg-chart__title")[0];
}

function chartSegments(root: TestNode): TestNode[] {
  return byClass(root, "rect", "qg-chart__segment");
}

function childSlices(root: TestNode): TestNode[] {
  return byClass(root, "rect", "qg-chart__child-slice");
}

function legendItems(root: TestNode): TestNode[] {
  return byClass(root, "button", "qg-legend__item");
}

function legendItem(root: TestNode, label: string): TestNode | undefined {
  return legendItems(root).find((item) => graph.textOf(item).includes(label));
}

function bucketHits(root: TestNode): TestNode[] {
  return byClass(root, "li", "qg-chart__hit");
}

function focus(node: TestNode): void {
  listener(node, "onFocus")?.({} as TestEvent);
}

function blur(node: TestNode): void {
  listener(node, "onBlur")?.({} as TestEvent);
}

function pointerEnter(node: TestNode): void {
  listener(node, "onPointerEnter")?.({} as TestEvent);
}

function pointerLeave(node: TestNode): void {
  listener(node, "onPointerLeave")?.({} as TestEvent);
}

function tableHeaders(root: TestNode): string[] {
  return graph
    .elementsNamed(root, "th")
    .filter((node) => node.props.scope === "col")
    .map((node) => graph.textOf(node));
}

function mountModels(reactiveDimension = false): {
  root: TestNode;
  dispose: () => void;
  setDimension: (dimension: AnalyticsDimension) => void;
} {
  const model = modelSnapshot();
  const provider = providerSnapshot();
  if (!reactiveDimension) {
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(modelsViewModule.ModelsView, {
          snapshot: model,
          dimension: "model",
          onDimensionChange: () => {},
        }),
      root,
    );
    return { root, dispose, setDimension: () => {} };
  }
  const [dimension, setDimension] = graph.createSignal<AnalyticsDimension>("model");
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () =>
      graph.createComponent(modelsViewModule.ModelsView, {
        get snapshot() {
          return dimension() === "model" ? model : provider;
        },
        get dimension() {
          return dimension();
        },
        onDimensionChange: setDimension,
      }),
    root,
  );
  return { root, dispose, setDimension };
}

function mountReactiveSnapshot(initial: AnalyticsGroupSnapshot): {
  root: TestNode;
  dispose: () => void;
  setSnapshot: (snapshot: AnalyticsGroupSnapshot) => void;
} {
  const [snapshot, setSnapshot] = graph.createSignal(initial);
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () =>
      graph.createComponent(modelsViewModule.ModelsView, {
        get snapshot() {
          return snapshot();
        },
        dimension: "model",
        onDimensionChange: () => {},
      }),
    root,
  );
  return { root, dispose, setSnapshot };
}

function mountSnapshot(snapshot: AnalyticsGroupSnapshot): {
  root: TestNode;
  dispose: () => void;
} {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () =>
      graph.createComponent(modelsViewModule.ModelsView, {
        snapshot,
        dimension: snapshot.dimension,
        onDimensionChange: () => {},
      }),
    root,
  );
  return { root, dispose };
}

/** A real five-series Models snapshot whose first bucket peaks at `total`. */
function peakSnapshot(total: number): AnalyticsGroupSnapshot {
  const base = modelSnapshot();
  const parts = [35, 25, 20, 12, 8].map((weight) => Math.floor((total * weight) / 100));
  const remainder = total - parts.reduce((sum, value) => sum + value, 0);
  const values = parts.map((value, index) => (index === 0 ? value + remainder : value));
  return {
    ...base,
    totals: costed({ input: total }),
    buckets: [
      { startMs: NOW - 2 * DAY_MS, endMs: NOW - DAY_MS },
      { startMs: NOW - DAY_MS, endMs: NOW },
    ],
    rows: values.map((value, index) => ({
      identity: known(`peak-model-${index}`),
      tokens: costed({ input: value }),
      sessionCount: 1,
      stepCount: 1,
      children: [],
    })),
    series: values.map((value, index) => ({
      kind: "entity" as const,
      identity: known(`peak-model-${index}`),
      tokens: costed({ input: value }),
      buckets: [costed({ input: value }), costed({})],
    })),
  };
}

/** One bucket per hidden parent, so the sole entry cannot be subdivided. */
function withSoleParentBuckets(snapshot: AnalyticsGroupSnapshot): AnalyticsGroupSnapshot {
  return {
    ...snapshot,
    series: snapshot.series.map((entry) =>
      entry.kind === "other"
        ? {
            ...entry,
            parentBuckets: [
              [
                {
                  identity: known("model-zeta"),
                  tokens: costed({ input: 60 }, { apiEquivalentCostUsd: 0.6 }),
                },
              ],
              [
                {
                  identity: unknownIdentity,
                  tokens: costed({ input: 40 }, { apiEquivalentCostUsd: 0.4 }),
                },
              ],
            ],
          }
        : entry,
    ),
  };
}

function mountDetail(
  module: Record<string, unknown>,
  name: string,
  snapshot: ReturnType<typeof modelAlphaSnapshot>,
  identity: AnalyticsEntityIdentity,
): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(module[name], { snapshot, identity, range: "7d" }),
    root,
  );
  return { root, dispose };
}

describe("Models view", () => {
  it("uses the canonical chart shell, token-ranked colours and a compact legend", () => {
    const { root, dispose } = mountModels();
    try {
      const shell = chartShell(root);
      expect(shell).toBeDefined();
      expect(graph.textOf(shell?.title as TestNode)).toBe("Usage by model");
      expect(summaryText(root, "Processed tokens")).toContain("2,190");
      expect(summaryText(root, "API-equivalent estimate")).toContain("≈ $12.00");
      expect(summaryText(root, "API-equivalent estimate")).toContain("Partial estimate");
      expect(shell?.body.children.length).toBeGreaterThan(0);

      const ranked = rankSeries(modelSnapshot().series);
      const expectedFills = ranked.map(
        (entry, index) => `var(${seriesColorVar(index, entry.kind)})`,
      );
      expect(expectedFills).toEqual([
        "var(--qg-rank-1)",
        "var(--qg-rank-2)",
        "var(--qg-rank-3)",
        "var(--qg-rank-4)",
        "var(--qg-rank-5)",
        `var(${OTHER_COLOR_VAR})`,
      ]);
      const segments = chartSegments(root);
      expect(segments.map((segment) => segment.props.fill)).toEqual([
        ...expectedFills,
        ...expectedFills,
      ]);
      expect(segments.map((segment) => segment.props["data-series-key"])).toEqual([
        "model:known:model-alpha",
        "model:known:model-beta",
        "model:known:model-gamma",
        "model:known:model-delta",
        "model:known:model-epsilon",
        "other",
        "model:known:model-alpha",
        "model:known:model-beta",
        "model:known:model-gamma",
        "model:known:model-delta",
        "model:known:model-epsilon",
        "other",
      ]);

      const legend = legendItems(root);
      expect(legend.map((button) => graph.textOf(button))).toEqual([
        "model-alpha600",
        "model-beta500",
        "model-gamma400",
        "model-delta300",
        "model-epsilon200",
        "Other190",
      ]);
      expect(legend.map((button) => button.props["data-series-key"])).toEqual([
        "model:known:model-alpha",
        "model:known:model-beta",
        "model:known:model-gamma",
        "model:known:model-delta",
        "model:known:model-epsilon",
        "other",
      ]);
      expect((legendItem(root, "Other") as TestNode).props.title).toContain("combined exactly");
      const labelNodes = legend.map((button) =>
        graph.elementsNamed(button, "span").find((node) => hasClass(node, "qg-legend__label")),
      );
      expect(labelNodes.every((node) => node !== undefined && hasClass(node, "qg-breakable"))).toBe(
        true,
      );
      const swatchStyles = legend.map(
        (item) => (item.props.style as Record<string, string>)["--qg-swatch"],
      );
      // The variable lives on the item, exactly as in the daily usage legend;
      // the swatch itself stays unstyled apart from its shared class.
      const swatchNodes = legend.map((item) =>
        graph.elementsNamed(item, "span").find((node) => hasClass(node, "qg-legend__swatch")),
      );
      expect(swatchNodes.every((node) => node?.props.style === undefined)).toBe(true);
      expect(swatchStyles).toEqual(expectedFills);
      // No cost graph toggle: the chart header control offers only Provider | Model.
      const actions = byClass(shell?.head as TestNode, "div", "qg-chart-shell__actions")[0];
      expect(actions).toBeDefined();
      const dimensionItems = segmentedItems(actions as TestNode, "Group usage by");
      expect(dimensionItems.map((button) => graph.textOf(button))).toEqual(["Provider", "Model"]);
      expect(dimensionItems.map((button) => button.props["aria-pressed"])).toEqual([false, true]);
    } finally {
      dispose();
    }
  });

  it("prints Free in the summary only for a wholly zero-priced total", () => {
    const free: AnalyticsGroupSnapshot = {
      ...modelSnapshot(),
      totals: costed({ input: 100 }, { apiEquivalentCostUsd: 0 }),
    };
    const { root, dispose } = mountSnapshot(free);
    try {
      expect(summaryText(root, "API-equivalent estimate")).toContain("Free");
      expect(summaryText(root, "API-equivalent estimate")).not.toContain("≈ $0.00");
    } finally {
      dispose();
    }

    const partial: AnalyticsGroupSnapshot = {
      ...modelSnapshot(),
      totals: costed({ input: 100 }, { apiEquivalentCostUsd: 0, unpricedTokens: 5 }),
    };
    const partialCase = mountSnapshot(partial);
    try {
      expect(summaryText(partialCase.root, "API-equivalent estimate")).not.toContain("Free");
      expect(summaryText(partialCase.root, "API-equivalent estimate")).toContain(
        "Partial estimate",
      );
    } finally {
      partialCase.dispose();
    }
  });

  it("changes only the heading control when the grouping dimension changes", async () => {
    const { root, dispose } = mountModels(true);
    try {
      expect(graph.textOf(chartShell(root)?.title as TestNode)).toBe("Usage by model");
      expect(
        legendItems(root)
          .map((button) => graph.textOf(button))
          .join(" "),
      ).not.toContain("OpenAI");
      clickSegmented(root, "Group usage by", "Provider");
      await settle();
      expect(graph.textOf(chartShell(root)?.title as TestNode)).toBe("Usage by provider");
      const legend = legendItems(root);
      expect(legend.map((button) => graph.textOf(button))).toEqual([
        "OpenAI1.5k",
        "Google380",
        "Anthropic150",
        "Unknown provider50",
        "Mistral45",
        "Other65",
      ]);
      const providerLogos = legend.flatMap((button) =>
        graph
          .elementsNamed(button, "span")
          .filter((node) => node.props["data-provider-logo"] !== undefined),
      );
      expect(providerLogos.length).toBeGreaterThan(0);
      expect(providerLogos.every((node) => node.props["aria-hidden"] === "true")).toBe(true);
      const other = legendItem(root, "Other") as TestNode;
      expect(providerMark(other)).toBeUndefined();
      expect(
        graph.elementsNamed(other, "span").some((node) => hasClass(node, "qg-legend__logo--empty")),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it("puts a real five-series 5,890 Models peak under the shared 7.0k ceiling", () => {
    const { root, dispose } = mountSnapshot(peakSnapshot(5_890));
    try {
      const labels = byClass(root, "text", "qg-chart__axis-label")
        .map((node) => graph.textOf(node))
        .filter((label) => /^\d+(?:\.\d+)?k?$/u.test(label));
      expect(labels.at(-1)).toBe("7.0k");
      expect(summaryText(root, "Processed tokens")).toContain("5,890");
      expect(chartSegments(root)).toHaveLength(5);
    } finally {
      dispose();
    }
  });

  it("shows one date in the same-day model tooltip and bucket label", async () => {
    const { root, dispose } = mountSnapshot(sameDayModelSnapshot());
    try {
      const hit = bucketHits(root)[0] as TestNode;
      expect(hit).toBeDefined();
      focus(hit);
      await settle();
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("27 Oct");
      expect(graph.textOf(tooltip)).not.toContain("27 Oct – 27 Oct");
      expect(hit.props["aria-label"]).toContain("Inspect 27 Oct");
      expect(hit.props["aria-label"]).not.toContain("27 Oct to 27 Oct");
    } finally {
      dispose();
    }
  });

  it("shows Free in a bucket tooltip only for a wholly zero-priced series", async () => {
    const { root, dispose } = mountSnapshot(sameDayModelSnapshot());
    try {
      const hit = bucketHits(root)[0] as TestNode;
      focus(hit);
      await settle();
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      const rows = byClass(tooltip, "div", "qg-model-tooltip__row");
      const gamma = rows.find((row) => graph.textOf(row).includes("model-gamma")) as TestNode;
      expect(graph.textOf(gamma)).toContain("Free");
      expect(graph.textOf(gamma)).not.toContain("≈ $0.00");
      expect(hit.props["aria-label"]).toContain("model-gamma 240 tokens, Free");
      expect(hit.props["aria-label"]).not.toContain("≈ $0.00");
    } finally {
      dispose();
    }
  });

  it("keeps the full API-equivalent footer in a narrow model tooltip", async () => {
    const tokens = costed({ input: 100 }, { apiEquivalentCostUsd: 0.02, unpricedTokens: 25 });
    const snapshot: AnalyticsGroupSnapshot = {
      ...sameDayModelSnapshot(),
      totals: tokens,
      series: [
        {
          kind: "entity",
          identity: known("model-alpha"),
          tokens,
          buckets: [tokens],
        },
      ],
    };
    const { root, dispose } = mountSnapshot(snapshot);
    try {
      const hit = bucketHits(root)[0] as TestNode;
      expect(hit).toBeDefined();
      focus(hit);
      await settle();
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      const row = byClass(tooltip, "div", "qg-model-tooltip__row")[0] as TestNode;
      expect(graph.textOf(row)).toContain("model-alpha");
      expect(graph.textOf(row)).toContain("100");
      expect(graph.textOf(row)).toContain("≈ $0.02");
      expect(graph.textOf(row)).toContain("partial");
      const footer = byClass(tooltip, "div", "qg-model-tooltip__footer")[0] as TestNode;
      expect(footer).toBeDefined();
      expect(graph.textOf(footer)).toContain("API-equivalent total");
      expect(graph.textOf(footer)).toContain("≈ $0.02");
      expect(graph.textOf(footer)).toContain("Partial estimate");
      const fullLabel = graph
        .elementsNamed(footer, "span")
        .find((node) => hasClass(node, "qg-model-tooltip__total-long")) as TestNode;
      const shortLabel = graph
        .elementsNamed(footer, "span")
        .find((node) => hasClass(node, "qg-model-tooltip__total-short")) as TestNode;
      expect(graph.textOf(fullLabel)).toBe("API-equivalent total");
      expect(graph.textOf(shortLabel)).toBe("Total");
      expect(fullLabel.props["aria-hidden"]).toBeUndefined();
      expect(shortLabel.props["aria-hidden"]).toBe("true");
    } finally {
      dispose();
    }
  });

  it("marks unknown and empty provider legend series with the shared generic logo, not Other", () => {
    const { root, dispose } = mountSnapshot(providerFallbackSnapshot());
    try {
      for (const label of ["Unknown provider", "Empty provider ID"]) {
        const item = legendItem(root, label) as TestNode;
        expect(providerMark(item)?.props["data-provider-logo"]).toBe("generic");
        expect(providerMarkVar(item)).toContain("/assets/providers/generic.svg");
      }
      expect(
        providerMark(legendItem(root, "OpenAI") as TestNode)?.props["data-provider-logo"],
      ).toBe("openai");
      expect(providerMark(legendItem(root, "Other") as TestNode)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("sorts only the three breakdown columns and never re-ranks the chart", async () => {
    const { root, dispose } = mountModels();
    try {
      const head = byClass(root, "div", "qg-breakdown__head")[0] as TestNode;
      const columns = head.children.filter((child) => child.kind === "element");
      expect(columns.map((child) => graph.textOf(child))).toEqual([
        "Name",
        "CostAbout the API-equivalent estimate",
        "Tokens",
      ]);
      expect(API_EQUIVALENT_TOOLTIP).toBe(
        "API-equivalent estimate based on model pricing. Not actual billed spend.",
      );
      expect(graph.textOf(root)).toContain("About the API-equivalent estimate");

      expect(rowLabels(root)).toEqual([
        "model-alpha",
        "model-delta",
        "model-epsilon",
        "model-zeta",
        "model-gamma",
        "Empty model ID",
        "model-beta",
        "Unknown model",
      ]);
      const before = chartSegments(root).map((segment) => segment.props["data-series-key"]);
      clickSegmented(root, "Sort breakdown", "Tokens");
      await settle();
      expect(rowLabels(root)).toEqual([
        "model-alpha",
        "model-beta",
        "model-gamma",
        "model-delta",
        "model-epsilon",
        "model-zeta",
        "Unknown model",
        "Empty model ID",
      ]);
      expect(chartSegments(root).map((segment) => segment.props["data-series-key"])).toEqual(
        before,
      );
    } finally {
      dispose();
    }
  });

  it("keeps singleton children, raw identity links and null / zero / partial costs distinct", () => {
    const { root, dispose } = mountModels();
    try {
      const childRows = byClass(root, "a", "qg-breakdown__row--child");
      expect(childRows.length).toBe(13);
      const gamma = rowByLabel(root, "model-gamma") as TestNode;
      const gammaGroup = gamma.parent as TestNode;
      const gammaChildren = graph
        .elementsNamed(gammaGroup, "a")
        .filter((row) => hasClass(row, "qg-breakdown__row--child"));
      expect(gammaChildren.map(labelOf)).toEqual(["OpenAI"]);

      const delta = rowByLabel(root, "model-delta") as TestNode;
      expect(graph.textOf(delta)).toContain("Partial estimate");
      const beta = rowByLabel(root, "model-beta") as TestNode;
      expect(graph.textOf(beta)).toContain("Unpriced");
      expect(graph.textOf(beta)).not.toContain("≈ $—");
      const gammaRow = rowByLabel(root, "model-gamma") as TestNode;
      expect(graph.textOf(gammaRow)).toContain("Free");
      expect(graph.textOf(gammaRow)).not.toContain("≈ $0.00");
      expect(graph.textOf(gammaRow)).not.toContain("Partial estimate");

      const unknown = rowByLabel(root, "Unknown model") as TestNode;
      const empty = rowByLabel(root, "Empty model ID") as TestNode;
      expect(unknown.props.href).toBe("/model/u?range=7d&group=model");
      expect(empty.props.href).toBe(
        `/model/${encodeAnalyticsEntityToken({ kind: "known", id: "" })}?range=7d&group=model`,
      );
      expect(unknown.props.href).not.toBe(empty.props.href);
      expect(gammaChildren[0]?.props.href).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("openai"))}?range=7d&group=model`,
      );
    } finally {
      dispose();
    }
  });

  it("shows selected-dimension colour on every parent and no colour on any child", async () => {
    const { root, dispose } = mountModels(true);
    try {
      const check = (parents: readonly TestNode[], children: readonly TestNode[]) => {
        expect(parents.length).toBeGreaterThan(0);
        expect(parents.every((row) => rowSwatch(row) !== undefined)).toBe(true);
        expect(children.length).toBeGreaterThan(0);
        expect(children.every((row) => rowSwatch(row) === undefined)).toBe(true);
      };

      // Model grouping: the parent rows are the chart's model series.
      check(breakdownRows(root, true), byClass(root, "a", "qg-breakdown__row--child"));
      expect(swatchVar(rowByLabel(root, "model-alpha") as TestNode)).toBe("var(--qg-rank-1)");

      clickSegmented(root, "Group usage by", "Provider");
      await settle();

      // Provider grouping applies the same rule; model children never inherit
      // the provider's colour, so opposite-dimension colours cannot leak in.
      check(breakdownRows(root, true), byClass(root, "a", "qg-breakdown__row--child"));
      expect(swatchVar(rowByLabel(root, "OpenAI") as TestNode)).toBe("var(--qg-rank-1)");
      expect(swatchVar(rowByLabel(root, "Mistral") as TestNode)).toBe("var(--qg-rank-5)");
    } finally {
      dispose();
    }
  });

  it("recolours a series with its token rank across the chart, legend and row", async () => {
    const base = modelSnapshot();
    // Boost gamma from rank 3 to rank 1; every other entity shifts down one.
    const boosted: AnalyticsGroupSnapshot = {
      ...base,
      series: base.series.map((entry) =>
        entry.kind === "entity" &&
        entry.identity.kind === "known" &&
        entry.identity.id === "model-gamma"
          ? { ...entry, tokens: { ...entry.tokens, total: 700 } }
          : entry,
      ),
    };
    const mounted = mountReactiveSnapshot(base);
    try {
      const assertGamma = (expected: string) => {
        const segments = chartSegments(mounted.root).filter(
          (segment) => segment.props["data-series-key"] === "model:known:model-gamma",
        );
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.every((segment) => segment.props.fill === expected)).toBe(true);
        expect(
          (legendItem(mounted.root, "model-gamma") as TestNode).props.style["--qg-swatch"],
        ).toBe(expected);
        expect(swatchVar(rowByLabel(mounted.root, "model-gamma") as TestNode)).toBe(expected);
      };

      assertGamma("var(--qg-rank-3)");
      mounted.setSnapshot(boosted);
      await settle();
      assertGamma("var(--qg-rank-1)");
      expect(swatchVar(rowByLabel(mounted.root, "model-alpha") as TestNode)).toBe(
        "var(--qg-rank-2)",
      );
      expect(swatchVar(rowByLabel(mounted.root, "model-beta") as TestNode)).toBe(
        "var(--qg-rank-3)",
      );

      mounted.setSnapshot(base);
      await settle();
      assertGamma("var(--qg-rank-3)");
    } finally {
      mounted.dispose();
    }
  });

  it("keeps provider colour on the parent row and leaves provider-grouped model children unmarked", async () => {
    const { root, dispose } = mountModels(true);
    try {
      clickSegmented(root, "Group usage by", "Provider");
      await settle();

      const openai = rowByLabel(root, "OpenAI") as TestNode;
      expect(swatchVar(openai)).toBe("var(--qg-rank-1)");
      expect(rowLogo(openai)?.props["data-provider-logo"]).toBe("openai");
      expect(swatchVar(rowByLabel(root, "Google") as TestNode)).toBe("var(--qg-rank-2)");
      expect(swatchVar(rowByLabel(root, "Empty provider ID") as TestNode)).toBe(
        "var(--qg-rank-other)",
      );
      expect(
        rowLogo(rowByLabel(root, "Empty provider ID") as TestNode)?.props["data-provider-logo"],
      ).toBe("generic");
      expect(rowSwatch(openai)?.props["aria-hidden"]).toBe("true");

      const nameChildren = (byClass(openai, "span", "qg-breakdown__name")[0] as TestNode).children
        .filter((node) => node.kind === "element")
        .map((node) => node.props.class);
      expect(nameChildren).toEqual([
        "qg-breakdown__swatch",
        "qg-provider-logo qg-breakdown__logo",
        "qg-breakdown__label",
      ]);

      // Models are parts of the provider bar, not chart series of their own.
      // Their children keep the indent but no model swatch or provider mark.
      for (const label of ["model-alpha", "model-gamma", "model-zeta"]) {
        const child = childRow(root, "OpenAI", label) as TestNode;
        expect(rowSwatch(child)).toBeUndefined();
        expect(rowLogo(child)).toBeUndefined();
        expect(hasClass(child, "qg-breakdown__row--plain")).toBe(true);
        const childNameClasses = (
          byClass(child, "span", "qg-breakdown__name")[0] as TestNode
        ).children
          .filter((node) => node.kind === "element")
          .map((node) => node.props.class);
        expect(childNameClasses).toEqual(["qg-breakdown__label"]);
      }
    } finally {
      dispose();
    }
  });

  it("shows chart colour on model parents and no colour swatch on provider leaves", async () => {
    const { root, dispose } = mountModels(true);
    try {
      const alpha = rowByLabel(root, "model-alpha") as TestNode;
      expect(swatchVar(alpha)).toBe("var(--qg-rank-1)");
      expect(rowLogo(alpha)).toBeUndefined();
      expect(swatchVar(rowByLabel(root, "model-epsilon") as TestNode)).toBe("var(--qg-rank-5)");
      expect(swatchVar(rowByLabel(root, "model-zeta") as TestNode)).toBe("var(--qg-rank-other)");

      // Provider leaves under a model are identity marks only: no series
      // swatch, even when the same provider appears under several parents.
      for (const [parent, child] of [
        ["model-alpha", "OpenAI"],
        ["model-gamma", "OpenAI"],
        ["model-zeta", "OpenAI"],
      ] as const) {
        const leaf = childRow(root, parent, child) as TestNode;
        expect(leaf).toBeDefined();
        expect(rowSwatch(leaf)).toBeUndefined();
        expect(rowLogo(leaf)?.props["data-provider-logo"]).toBe("openai");
      }
    } finally {
      dispose();
    }
  });

  it("keeps a generic local mark for unknown and empty provider identities", async () => {
    const { root, dispose } = mountModels(true);
    try {
      clickSegmented(root, "Group usage by", "Provider");
      await settle();

      const unknownParent = rowByLabel(root, "Unknown provider") as TestNode;
      const emptyParent = rowByLabel(root, "Empty provider ID") as TestNode;
      expect(swatchVar(unknownParent)).toBe("var(--qg-rank-4)");
      expect(swatchVar(emptyParent)).toBe("var(--qg-rank-other)");
      for (const row of [unknownParent, emptyParent]) {
        expect(rowLogo(row)?.props["data-provider-logo"]).toBe("generic");
        expect(logoVar(row)).toContain("/assets/providers/generic.svg");
      }
      expect(unknownParent.props.href).toBe("/provider/u?range=7d&group=provider");
      expect(emptyParent.props.href).not.toBe(unknownParent.props.href);
      expect(labelOf(unknownParent)).not.toBe(labelOf(emptyParent));

      clickSegmented(root, "Group usage by", "Model");
      await settle();

      const unknownChild = childRow(root, "Unknown model", "Unknown provider") as TestNode;
      const emptyChild = childRow(root, "Empty model ID", "Empty provider ID") as TestNode;
      expect(unknownChild).toBeDefined();
      expect(emptyChild).toBeDefined();
      for (const row of [unknownChild, emptyChild]) {
        expect(rowLogo(row)?.props["data-provider-logo"]).toBe("generic");
        expect(logoVar(row)).toContain("/assets/providers/generic.svg");
      }
      expect(unknownChild.props.href).not.toBe(emptyChild.props.href);
      const openaiChild = childRow(root, "model-alpha", "OpenAI") as TestNode;
      expect(rowLogo(openaiChild)?.props["data-provider-logo"]).toBe("openai");
    } finally {
      dispose();
    }
  });

  it("cross-highlights bars, legend and parent rows from the keyboard without relying on colour", async () => {
    const { root, dispose } = mountModels();
    try {
      const legend = legendItem(root, "model-gamma") as TestNode;
      expect(legend.props["aria-label"]).toBe("Highlight model-gamma, 400 tokens");
      focus(legend);
      await settle();
      expect(legend.props["data-active"]).toBe("true");
      const gammaSegments = chartSegments(root).filter(
        (segment) => segment.props["data-series-key"] === "model:known:model-gamma",
      );
      expect(gammaSegments.every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );
      const otherSegments = chartSegments(root).filter(
        (segment) => segment.props["data-series-key"] !== "model:known:model-gamma",
      );
      expect(otherSegments.every((segment) => segment.props["data-highlighted"] === "false")).toBe(
        true,
      );
      const gammaRow = rowByLabel(root, "model-gamma") as TestNode;
      expect(gammaRow.props["data-highlighted"]).toBe("true");
      expect((rowByLabel(root, "model-alpha") as TestNode).props["data-dimmed"]).toBe("true");

      blur(legend);
      await settle();
      expect(legend.props["data-active"]).toBeUndefined();
      expect(
        chartSegments(root).every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);

      const row = rowByLabel(root, "model-alpha") as TestNode;
      focus(row);
      await settle();
      expect((legendItem(root, "model-alpha") as TestNode).props["data-active"]).toBe("true");
      expect(row.props["data-highlighted"]).toBe("true");
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "model:known:model-alpha")
          .every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
      blur(row);
    } finally {
      dispose();
    }
  });

  it("pins a clicked legend series until the same badge or an outside click clears it", async () => {
    const { root, dispose } = mountModels();
    try {
      const gamma = legendItem(root, "model-gamma") as TestNode;
      const alpha = legendItem(root, "model-alpha") as TestNode;
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      const gammaSegments = () =>
        chartSegments(root).filter(
          (segment) => segment.props["data-series-key"] === "model:known:model-gamma",
        );
      const alphaSegments = () =>
        chartSegments(root).filter(
          (segment) => segment.props["data-series-key"] === "model:known:model-alpha",
        );
      const gammaRow = rowByLabel(root, "model-gamma") as TestNode;
      const alphaRow = rowByLabel(root, "model-alpha") as TestNode;
      expect(plot).toBeDefined();

      click(gamma);
      await settle();
      expect(gamma.props["data-pinned"]).toBe("true");
      expect(gamma.props["aria-pressed"]).toBe("true");
      expect(gamma.props["data-active"]).toBe("true");
      expect(gammaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );
      expect(
        alphaSegments().every((segment) => segment.props["data-highlighted"] === "false"),
      ).toBe(true);
      expect(gammaRow.props["data-highlighted"]).toBe("true");
      expect(alphaRow.props["data-dimmed"]).toBe("true");

      // Pointer emphasis wins; leaving restores the pinned fallback.
      pointerEnter(alpha);
      await settle();
      expect(alphaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );
      expect(
        gammaSegments().every((segment) => segment.props["data-highlighted"] === "false"),
      ).toBe(true);
      pointerLeave(alpha);
      await settle();
      expect(gammaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );

      // Keyboard focus wins; blur restores the pinned fallback.
      focus(alpha);
      await settle();
      expect(alphaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );
      blur(alpha);
      await settle();
      expect(gammaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );

      // Clicking another badge switches the pin.
      click(alpha);
      await settle();
      expect(alpha.props["data-pinned"]).toBe("true");
      expect(alpha.props["aria-pressed"]).toBe("true");
      expect(gamma.props["data-pinned"]).toBeUndefined();
      expect(gamma.props["aria-pressed"]).toBe("false");
      expect(alphaSegments().every((segment) => segment.props["data-highlighted"] === "true")).toBe(
        true,
      );
      expect(
        gammaSegments().every((segment) => segment.props["data-highlighted"] === "false"),
      ).toBe(true);

      // Clicking the pinned badge again clears the pin and its transient
      // emphasis, so the reset is immediate even while hovered/focused.
      pointerEnter(alpha);
      focus(alpha);
      click(alpha);
      await settle();
      expect(alpha.props["data-pinned"]).toBeUndefined();
      expect(alpha.props["aria-pressed"]).toBe("false");
      expect(
        chartSegments(root).every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);
      expect(alphaRow.props["data-highlighted"]).toBeUndefined();
      expect(gammaRow.props["data-dimmed"]).toBeUndefined();

      // Any click outside the legend clears a re-pinned badge.
      click(gamma);
      await settle();
      expect(gamma.props["data-pinned"]).toBe("true");
      click(plot);
      await settle();
      expect(gamma.props["data-pinned"]).toBeUndefined();
      expect(gamma.props["aria-pressed"]).toBe("false");
      expect(
        chartSegments(root).every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it("keeps leaf emphasis local while its parent chart stays active", async () => {
    const { root, dispose } = mountSnapshot(providerSnapshot());
    try {
      const parent = rowByLabel(root, "OpenAI") as TestNode;
      const leaf = childRow(root, "OpenAI", "model-alpha") as TestNode;
      const sibling = childRow(root, "OpenAI", "model-beta") as TestNode;
      const otherParent = rowByLabel(root, "Google") as TestNode;
      const openaiSegments = () =>
        chartSegments(root).filter(
          (segment) => segment.props["data-series-key"] === "provider:known:openai",
        );

      // A leaf is never its own chart series: focusing or hovering it activates
      // the parent series for the chart, but highlights only that leaf row.
      focus(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(parent.props["data-highlighted"]).toBeUndefined();
      expect(sibling.props["data-highlighted"]).toBeUndefined();
      expect((legendItem(root, "OpenAI") as TestNode).props["data-active"]).toBe("true");
      expect(
        openaiSegments().every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] !== "provider:known:openai")
          .every((segment) => segment.props["data-highlighted"] === "false"),
      ).toBe(true);
      blur(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBeUndefined();

      pointerEnter(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(parent.props["data-highlighted"]).toBeUndefined();
      pointerLeave(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBeUndefined();

      // The parent activates its whole section, including every child row.
      focus(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBe("true");
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(sibling.props["data-highlighted"]).toBe("true");
      expect(otherParent.props["data-dimmed"]).toBe("true");
      expect((legendItem(root, "OpenAI") as TestNode).props["data-active"]).toBe("true");
      expect(
        openaiSegments().every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
      blur(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBeUndefined();
      expect(leaf.props["data-highlighted"]).toBeUndefined();
      expect(sibling.props["data-highlighted"]).toBeUndefined();

      // The same whole-section emphasis applies on pointer hover.
      pointerEnter(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBe("true");
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(sibling.props["data-highlighted"]).toBe("true");
      pointerLeave(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBeUndefined();
      expect(leaf.props["data-highlighted"]).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("highlights a model parent's whole section while a leaf keeps chart emphasis on its parent", async () => {
    const { root, dispose } = mountModels(true);
    try {
      const parent = rowByLabel(root, "model-alpha") as TestNode;
      const children = childRows(root, "model-alpha");
      const leaf = childRow(root, "model-alpha", "OpenAI") as TestNode;

      focus(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBe("true");
      expect(children.length).toBeGreaterThan(0);
      expect(children.every((row) => row.props["data-highlighted"] === "true")).toBe(true);
      expect((rowByLabel(root, "model-beta") as TestNode).props["data-dimmed"]).toBe("true");
      blur(parent);
      await settle();

      focus(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(parent.props["data-highlighted"]).toBeUndefined();
      expect((legendItem(root, "model-alpha") as TestNode).props["data-active"]).toBe("true");
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "model:known:model-alpha")
          .every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] !== "model:known:model-alpha")
          .every((segment) => segment.props["data-highlighted"] === "false"),
      ).toBe(true);
      blur(leaf);
    } finally {
      dispose();
    }
  });

  it("subdivides only the active parent, in that parent's own colour", async () => {
    const { root, dispose } = mountSnapshot(withChildBuckets(modelSnapshot()));
    try {
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      expect(childSlices(root)).toHaveLength(0);

      const alpha = legendItem(root, "model-alpha") as TestNode;
      pointerEnter(alpha);
      await settle();
      const alphaParent = chartSegments(root).find(
        (segment) => segment.props["data-series-key"] === "model:known:model-alpha",
      ) as TestNode;
      const alphaSlices = childSlices(root).filter(
        (slice) => slice.props["data-series-key"] === "model:known:model-alpha",
      );
      expect(alphaSlices.length).toBeGreaterThan(0);
      expect(alphaSlices.every((slice) => slice.props.fill === alphaParent.props.fill)).toBe(true);
      expect(
        alphaSlices.every((slice) => {
          const opacity = Number(slice.props["fill-opacity"]);
          return opacity > 0 && opacity < 1;
        }),
      ).toBe(true);
      expect(new Set(alphaSlices.map((slice) => slice.props["data-child-key"]))).toEqual(
        new Set([
          "provider:known:openai",
          "provider:known:anthropic",
          "provider:known:google",
          "provider:known:mistral",
          "provider:known:deepseek",
          "provider:known:openrouter",
        ]),
      );
      expect(alphaSlices.every((slice) => slice.props["data-highlighted"] === undefined)).toBe(
        true,
      );

      // A sibling parent with one child stays solid even while active.
      const beta = legendItem(root, "model-beta") as TestNode;
      pointerEnter(beta);
      await settle();
      expect(
        childSlices(root).filter(
          (slice) => slice.props["data-series-key"] === "model:known:model-beta",
        ),
      ).toHaveLength(0);

      pointerLeave(beta);
      await settle();
      expect(childSlices(root)).toHaveLength(0);
      expect(plot.props["data-child-highlight"]).toBeUndefined();

      // Keyboard focus on the parent legend behaves like hover.
      focus(alpha);
      await settle();
      expect(childSlices(root).length).toBeGreaterThan(0);
      blur(alpha);
      await settle();
      expect(childSlices(root)).toHaveLength(0);

      // Pinning keeps the subdivision after the pointer leaves.
      click(alpha);
      await settle();
      expect(childSlices(root).length).toBeGreaterThan(0);
      expect(alpha.props["data-pinned"]).toBe("true");
      click(plot);
      await settle();
      expect(childSlices(root)).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("keeps child-row emphasis on one scope and the matching slice only", async () => {
    const { root, dispose } = mountSnapshot(withChildBuckets(modelSnapshot()));
    try {
      const parent = rowByLabel(root, "model-alpha") as TestNode;
      const leaf = childRow(root, "model-alpha", "OpenAI") as TestNode;
      const sibling = childRow(root, "model-alpha", "Anthropic") as TestNode;
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;

      focus(leaf);
      await settle();
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(parent.props["data-highlighted"]).toBeUndefined();
      expect(sibling.props["data-dimmed"]).toBe("true");
      expect(plot.props["data-child-highlight"]).toBe("true");
      const openaiSlices = childSlices(root).filter(
        (slice) => slice.props["data-child-key"] === "provider:known:openai",
      );
      expect(openaiSlices.length).toBeGreaterThan(0);
      expect(openaiSlices.every((slice) => slice.props["data-highlighted"] === "true")).toBe(true);
      expect(
        childSlices(root)
          .filter((slice) => slice.props["data-child-key"] !== "provider:known:openai")
          .every((slice) => slice.props["data-highlighted"] === "false"),
      ).toBe(true);

      blur(leaf);
      await settle();
      expect(childSlices(root)).toHaveLength(0);

      // The parent row still highlights the whole section, without a child
      // selection narrowing it to one slice.
      pointerEnter(parent);
      await settle();
      expect(parent.props["data-highlighted"]).toBe("true");
      expect(leaf.props["data-highlighted"]).toBe("true");
      expect(sibling.props["data-highlighted"]).toBe("true");
      expect(sibling.props["data-dimmed"]).toBeUndefined();
      expect(plot.props["data-child-highlight"]).toBeUndefined();
      expect(
        childSlices(root).every((slice) => slice.props["data-highlighted"] === undefined),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it("uses the provider parent palette and keeps Other composition truthful", async () => {
    const providers = mountSnapshot(withChildBuckets(providerSnapshot()));
    try {
      const openai = legendItem(providers.root, "OpenAI") as TestNode;
      pointerEnter(openai);
      await settle();
      const parent = chartSegments(providers.root).find(
        (segment) => segment.props["data-series-key"] === "provider:known:openai",
      ) as TestNode;
      const slices = childSlices(providers.root);
      expect(slices.length).toBeGreaterThan(0);
      expect(slices.every((slice) => slice.props.fill === parent.props.fill)).toBe(true);
      expect(new Set(slices.map((slice) => slice.props["data-child-key"]))).toEqual(
        new Set([
          "model:known:model-alpha",
          "model:known:model-beta",
          "model:known:model-gamma",
          "model:known:model-epsilon",
          "model:known:model-zeta",
        ]),
      );
    } finally {
      providers.dispose();
    }

    const models = mountSnapshot(withChildBuckets(modelSnapshot()));
    try {
      const other = legendItem(models.root, "Other") as TestNode;
      pointerEnter(other);
      await settle();
      const otherSlices = childSlices(models.root).filter(
        (slice) => slice.props["data-series-key"] === "other",
      );
      expect(new Set(otherSlices.map((slice) => slice.props["data-child-key"]))).toEqual(
        new Set(["provider:known:openai", "provider:unknown", "provider:known:"]),
      );
      expect(otherSlices.every((slice) => slice.props.fill === "var(--qg-rank-other)")).toBe(true);
      pointerLeave(other);
      await settle();

      // A child under an Other-mapped parent is a subset of the aggregate, so
      // its emphasis stays local instead of pointing at an aggregate slice.
      const zeta = rowByLabel(models.root, "model-zeta") as TestNode;
      const zetaChild = childRow(models.root, "model-zeta", "OpenAI") as TestNode;
      focus(zetaChild);
      await settle();
      expect(zetaChild.props["data-highlighted"]).toBe("true");
      expect(zeta.props["data-highlighted"]).toBeUndefined();
      expect(childSlices(models.root)).toHaveLength(0);
    } finally {
      models.dispose();
    }
  });

  it("singles out one hidden model inside Other on pointer and focus", async () => {
    const { root, dispose } = mountSnapshot(withParentBuckets(withChildBuckets(modelSnapshot())));
    try {
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      const zeta = rowByLabel(root, "model-zeta") as TestNode;
      const unknown = rowByLabel(root, "Unknown model") as TestNode;
      const empty = rowByLabel(root, "Empty model ID") as TestNode;
      const alpha = rowByLabel(root, "model-alpha") as TestNode;
      const zetaChild = childRow(root, "model-zeta", "OpenAI") as TestNode;
      const unknownChild = childRow(root, "Unknown model", "Unknown provider") as TestNode;
      const emptyChild = childRow(root, "Empty model ID", "Empty provider ID") as TestNode;
      const otherLegend = legendItem(root, "Other") as TestNode;

      pointerEnter(zeta);
      await settle();
      expect(otherLegend.props["data-active"]).toBe("true");
      expect(zeta.props["data-highlighted"]).toBe("true");
      expect(unknown.props["data-dimmed"]).toBe("true");
      expect(empty.props["data-dimmed"]).toBe("true");
      expect(alpha.props["data-dimmed"]).toBe("true");
      expect(zetaChild.props["data-highlighted"]).toBe("true");
      expect(zetaChild.props["data-dimmed"]).toBeUndefined();
      expect(unknownChild.props["data-highlighted"]).toBeUndefined();
      expect(unknownChild.props["data-dimmed"]).toBe("true");
      expect(emptyChild.props["data-highlighted"]).toBeUndefined();
      expect(emptyChild.props["data-dimmed"]).toBe("true");
      expect(plot.props["data-parent-highlight"]).toBe("true");
      expect(plot.props["data-child-highlight"]).toBeUndefined();
      // Every multi-parent bucket is sliced, so none is left as a full Other bar.
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "other")
          .every((segment) => segment.props["fill-opacity"] === "0.32"),
      ).toBe(true);

      const parentSlices = childSlices(root).filter(
        (slice) => slice.props["data-slice-kind"] === "parent",
      );
      expect(new Set(parentSlices.map((slice) => slice.props["data-parent-key"]))).toEqual(
        new Set(["model:known:model-zeta", "model:unknown", "model:known:"]),
      );
      expect(parentSlices.every((slice) => slice.props.fill === "var(--qg-rank-other)")).toBe(true);
      const zetaSlices = parentSlices.filter(
        (slice) => slice.props["data-parent-key"] === "model:known:model-zeta",
      );
      expect(zetaSlices.length).toBeGreaterThan(0);
      expect(zetaSlices.every((slice) => slice.props["data-highlighted"] === "true")).toBe(true);
      expect(
        parentSlices
          .filter((slice) => slice.props["data-parent-key"] !== "model:known:model-zeta")
          .every((slice) => slice.props["data-highlighted"] === "false"),
      ).toBe(true);
      expect(swatchVar(zeta)).toBe("var(--qg-rank-other)");
      expect(swatchVar(zeta)).toBe(
        (otherLegend.props.style as Record<string, string>)["--qg-swatch"],
      );

      pointerLeave(zeta);
      await settle();
      expect(plot.props["data-parent-highlight"]).toBeUndefined();
      expect(childSlices(root)).toHaveLength(0);

      // Keyboard focus on the same row is equally exact.
      focus(unknown);
      await settle();
      expect(unknown.props["data-highlighted"]).toBe("true");
      expect(zeta.props["data-dimmed"]).toBe("true");
      expect(unknownChild.props["data-highlighted"]).toBe("true");
      expect(unknownChild.props["data-dimmed"]).toBeUndefined();
      expect(zetaChild.props["data-highlighted"]).toBeUndefined();
      expect(zetaChild.props["data-dimmed"]).toBe("true");
      expect(emptyChild.props["data-highlighted"]).toBeUndefined();
      expect(emptyChild.props["data-dimmed"]).toBe("true");
      expect(
        childSlices(root)
          .filter((slice) => slice.props["data-parent-key"] === "model:unknown")
          .every((slice) => slice.props["data-highlighted"] === "true"),
      ).toBe(true);
      blur(unknown);
      await settle();

      // The Other legend still represents the whole aggregate: every hidden
      // parent row stays lit and no single parent slice is singled out.
      focus(otherLegend);
      await settle();
      expect(zeta.props["data-highlighted"]).toBe("true");
      expect(unknown.props["data-highlighted"]).toBe("true");
      expect(empty.props["data-highlighted"]).toBe("true");
      expect(plot.props["data-parent-highlight"]).toBeUndefined();
      expect(
        childSlices(root).every((slice) => slice.props["data-highlighted"] === undefined),
      ).toBe(true);
      blur(otherLegend);
      await settle();
    } finally {
      dispose();
    }
  });

  it("emphasizes a matching sole-parent Other bucket and dims the unrelated one", async () => {
    const { root, dispose } = mountSnapshot(withSoleParentBuckets(modelSnapshot()));
    try {
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      const zeta = rowByLabel(root, "model-zeta") as TestNode;
      const unknown = rowByLabel(root, "Unknown model") as TestNode;
      const otherBuckets = () =>
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "other")
          .sort(
            (left, right) =>
              Number(left.props["data-bucket-index"]) - Number(right.props["data-bucket-index"]),
          );
      const geometry = () =>
        otherBuckets().map(
          (segment) =>
            [segment.props.x, segment.props.y, segment.props.width, segment.props.height] as const,
        );

      expect(otherBuckets()).toHaveLength(2);
      expect(
        otherBuckets().every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);
      const before = geometry();

      pointerEnter(zeta);
      await settle();
      expect(plot.props["data-parent-highlight"]).toBe("true");
      expect(childSlices(root)).toHaveLength(0);
      expect(otherBuckets()[0]?.props["data-highlighted"]).toBe("true");
      expect(otherBuckets()[1]?.props["data-highlighted"]).toBe("false");
      expect(geometry()).toEqual(before);

      pointerLeave(zeta);
      await settle();
      expect(plot.props["data-parent-highlight"]).toBeUndefined();
      expect(
        otherBuckets().every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);

      focus(unknown);
      await settle();
      expect(plot.props["data-parent-highlight"]).toBe("true");
      expect(childSlices(root)).toHaveLength(0);
      expect(otherBuckets()[0]?.props["data-highlighted"]).toBe("false");
      expect(otherBuckets()[1]?.props["data-highlighted"]).toBe("true");
      expect(geometry()).toEqual(before);

      blur(unknown);
      await settle();
      expect(plot.props["data-parent-highlight"]).toBeUndefined();
      expect(
        otherBuckets().every((segment) => segment.props["data-highlighted"] === undefined),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it("singles out one hidden provider inside Other in the provider grouping", async () => {
    const { root, dispose } = mountSnapshot(
      withParentBuckets(withChildBuckets(providerSnapshot())),
    );
    try {
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      const deepseek = rowByLabel(root, "DeepSeek") as TestNode;
      const empty = rowByLabel(root, "Empty provider ID") as TestNode;
      const openai = rowByLabel(root, "OpenAI") as TestNode;
      const deepseekChild = childRow(root, "DeepSeek", "model-alpha") as TestNode;
      const emptyChild = childRow(root, "Empty provider ID", "Empty model ID") as TestNode;
      const openrouterChild = childRow(root, "OpenRouter", "model-alpha") as TestNode;

      focus(deepseek);
      await settle();
      expect((legendItem(root, "Other") as TestNode).props["data-active"]).toBe("true");
      expect(deepseek.props["data-highlighted"]).toBe("true");
      expect(deepseek.props["data-dimmed"]).toBeUndefined();
      expect(empty.props["data-dimmed"]).toBe("true");
      expect(openai.props["data-dimmed"]).toBe("true");
      expect(deepseekChild.props["data-highlighted"]).toBe("true");
      expect(deepseekChild.props["data-dimmed"]).toBeUndefined();
      expect(emptyChild.props["data-highlighted"]).toBeUndefined();
      expect(emptyChild.props["data-dimmed"]).toBe("true");
      expect(openrouterChild.props["data-highlighted"]).toBeUndefined();
      expect(openrouterChild.props["data-dimmed"]).toBe("true");
      expect(plot.props["data-parent-highlight"]).toBe("true");

      const parentSlices = childSlices(root).filter(
        (slice) => slice.props["data-slice-kind"] === "parent",
      );
      expect(new Set(parentSlices.map((slice) => slice.props["data-parent-key"]))).toEqual(
        new Set(["provider:known:", "provider:known:deepseek", "provider:known:openrouter"]),
      );
      expect(
        parentSlices
          .filter((slice) => slice.props["data-parent-key"] === "provider:known:deepseek")
          .every((slice) => slice.props["data-highlighted"] === "true"),
      ).toBe(true);
      expect(
        parentSlices
          .filter((slice) => slice.props["data-parent-key"] !== "provider:known:deepseek")
          .every((slice) => slice.props["data-highlighted"] === "false"),
      ).toBe(true);
      expect(swatchVar(deepseek)).toBe("var(--qg-rank-other)");
      blur(deepseek);
      await settle();
    } finally {
      dispose();
    }
  });

  it("routes rows outside the chart's ranked five through the Other series", async () => {
    const { root, dispose } = mountModels(true);
    try {
      const zeta = rowByLabel(root, "model-zeta") as TestNode;
      focus(zeta);
      await settle();
      expect((legendItem(root, "Other") as TestNode).props["data-active"]).toBe("true");
      expect(zeta.props["data-highlighted"]).toBe("true");
      expect((rowByLabel(root, "Unknown model") as TestNode).props["data-highlighted"]).toBe(
        "true",
      );
      expect((rowByLabel(root, "Empty model ID") as TestNode).props["data-highlighted"]).toBe(
        "true",
      );
      expect((rowByLabel(root, "model-alpha") as TestNode).props["data-dimmed"]).toBe("true");
      // Aggregate Other still emphasizes every hidden parent's children.
      for (const [parent, child] of [
        ["model-zeta", "OpenAI"],
        ["Unknown model", "Unknown provider"],
        ["Empty model ID", "Empty provider ID"],
      ] as const) {
        const node = childRow(root, parent, child) as TestNode;
        expect(node.props["data-highlighted"]).toBe("true");
        expect(node.props["data-dimmed"]).toBeUndefined();
      }
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "other")
          .every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
      blur(zeta);

      const otherLegend = legendItem(root, "Other") as TestNode;
      focus(otherLegend);
      await settle();
      expect(zeta.props["data-highlighted"]).toBe("true");
      expect((rowByLabel(root, "model-alpha") as TestNode).props["data-dimmed"]).toBe("true");
      blur(otherLegend);

      clickSegmented(root, "Group usage by", "Provider");
      await settle();
      const deepseek = rowByLabel(root, "DeepSeek") as TestNode;
      focus(deepseek);
      await settle();
      expect((legendItem(root, "Other") as TestNode).props["data-active"]).toBe("true");
      expect(deepseek.props["data-highlighted"]).toBe("true");
      expect((rowByLabel(root, "OpenAI") as TestNode).props["data-dimmed"]).toBe("true");
      blur(deepseek);
    } finally {
      dispose();
    }
  });

  it("keeps keyboard emphasis when the pointer leaves a legend or row", async () => {
    const { root, dispose } = mountModels();
    try {
      const gamma = legendItem(root, "model-gamma") as TestNode;
      const alpha = legendItem(root, "model-alpha") as TestNode;
      focus(gamma);
      await settle();
      pointerEnter(alpha);
      await settle();
      expect(alpha.props["data-active"]).toBe("true");
      pointerLeave(alpha);
      await settle();
      expect(gamma.props["data-active"]).toBe("true");
      expect(alpha.props["data-active"]).toBeUndefined();
      blur(gamma);

      const alphaRow = rowByLabel(root, "model-alpha") as TestNode;
      const zetaRow = rowByLabel(root, "model-zeta") as TestNode;
      focus(alphaRow);
      await settle();
      pointerEnter(zetaRow);
      await settle();
      expect(zetaRow.props["data-highlighted"]).toBe("true");
      pointerLeave(zetaRow);
      await settle();
      expect(alphaRow.props["data-highlighted"]).toBe("true");
      expect(alphaRow.props["data-dimmed"]).toBeUndefined();
      blur(alphaRow);
    } finally {
      dispose();
    }
  });

  it("reconciles stale series emphasis after a snapshot change without clearing a valid series", async () => {
    const base = modelSnapshot();
    const mounted = mountReactiveSnapshot(base);
    try {
      const gamma = legendItem(mounted.root, "model-gamma") as TestNode;
      focus(gamma);
      await settle();
      expect(gamma.props["data-active"]).toBe("true");

      const withoutGamma: AnalyticsGroupSnapshot = {
        ...base,
        rows: base.rows.filter(
          (row) => row.identity.kind !== "known" || row.identity.id !== "model-gamma",
        ),
        series: base.series.filter(
          (entry) =>
            entry.kind !== "entity" ||
            entry.identity.kind !== "known" ||
            entry.identity.id !== "model-gamma",
        ),
      };
      mounted.setSnapshot(withoutGamma);
      await settle();
      expect(legendItem(mounted.root, "model-gamma")).toBeUndefined();
      expect(
        byClass(mounted.root, "div", "qg-model-chart__plot")[0]?.props["data-highlight"],
      ).toBeUndefined();
      expect(
        chartSegments(mounted.root).every(
          (segment) => segment.props["data-highlighted"] === undefined,
        ),
      ).toBe(true);
      expect(
        breakdownRows(mounted.root).every((row) => row.props["data-dimmed"] === undefined),
      ).toBe(true);

      const alpha = legendItem(mounted.root, "model-alpha") as TestNode;
      focus(alpha);
      await settle();
      const refreshed: AnalyticsGroupSnapshot = {
        ...base,
        range: "30d",
        rows: base.rows.map((row) => ({
          ...row,
          children: row.children.map((child) => ({ ...child })),
        })),
        series: base.series.map((entry) => ({
          ...entry,
          buckets: entry.buckets.map((bucket) => ({ ...bucket })),
        })),
        buckets: base.buckets.map((bucket) => ({ ...bucket })),
      };
      mounted.setSnapshot(refreshed);
      await settle();
      expect((legendItem(mounted.root, "model-alpha") as TestNode).props["data-active"]).toBe(
        "true",
      );
      expect(
        chartSegments(mounted.root)
          .filter((segment) => segment.props["data-series-key"] === "model:known:model-alpha")
          .every((segment) => segment.props["data-highlighted"] === "true"),
      ).toBe(true);
    } finally {
      mounted.dispose();
    }
  });

  it("exposes keyboard-operable legend pinning as native toggle buttons", async () => {
    const { root, dispose } = mountModels();
    try {
      const legend = legendItems(root);
      expect(legend.length).toBeGreaterThan(0);
      expect(legend.every((item) => item.tag === "button")).toBe(true);
      expect(legend.every((item) => item.props.type === "button")).toBe(true);
      expect(legend.every((item) => item.props.tabIndex === undefined)).toBe(true);
      expect(legend.every((item) => listener(item, "onClick") !== undefined)).toBe(true);
      expect(legend.every((item) => item.props["aria-pressed"] === "false")).toBe(true);
      expect(byClass(root, "button", "qg-chart__hit")).toHaveLength(0);

      const first = legend[0] as TestNode;
      click(first);
      await settle();
      expect(first.props["aria-pressed"]).toBe("true");
      expect(first.props["data-pinned"]).toBe("true");
      click(first);
      await settle();
      expect(first.props["aria-pressed"]).toBe("false");
      expect(first.props["data-pinned"]).toBeUndefined();

      focus(first);
      await settle();
      expect(first.props["data-active"]).toBe("true");
      blur(first);

      const hits = bucketHits(root);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.props.tabIndex === 0)).toBe(true);
      expect(byClass(root, "button", "qg-chart__hit")).toHaveLength(0);
      expect(hits.every((hit) => hit.props["aria-pressed"] === undefined)).toBe(true);
      expect(hits[0]?.props["aria-label"]).toMatch(/^Inspect /);

      focus(hits[0] as TestNode);
      await settle();
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(tooltip).toBeDefined();
      expect(graph.textOf(tooltip)).toContain("API-equivalent");
    } finally {
      dispose();
    }
  });

  it("qualifies partial and unpriced costs in the sr-only bucket table", () => {
    const unpriced = costed({ input: 10 }, { apiEquivalentCostUsd: null, unpricedTokens: 10 });
    const partial = costed({ input: 20 }, { apiEquivalentCostUsd: 2, unpricedTokens: 5 });
    const totals = costed({ input: 30 }, { apiEquivalentCostUsd: 2, unpricedTokens: 15 });
    const snapshot: AnalyticsGroupSnapshot = {
      ...zeroSnapshot("model", undefined),
      totals,
      rows: [
        {
          identity: known("model-alpha"),
          tokens: totals,
          sessionCount: 1,
          stepCount: 1,
          children: [],
        },
      ],
      series: [
        {
          kind: "entity",
          identity: known("model-alpha"),
          tokens: totals,
          buckets: [unpriced, partial],
        },
      ],
    };
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(modelsViewModule.ModelsView, {
          snapshot,
          dimension: "model",
          onDimensionChange: () => {},
        }),
      root,
    );
    try {
      const table = graph.elementsNamed(root, "table")[0] as TestNode;
      const rows = graph
        .elementsNamed(table, "tr")
        .filter((row) => graph.elementsNamed(row, "td").length > 0);
      const apiCell = (row: TestNode) => graph.elementsNamed(row, "td")[1] as TestNode;
      expect(graph.textOf(apiCell(rows[0] as TestNode))).toContain("Unpriced");
      expect(graph.textOf(apiCell(rows[0] as TestNode))).not.toContain("≈ $—");
      expect(graph.textOf(apiCell(rows[1] as TestNode))).toContain("Partial estimate");
    } finally {
      dispose();
    }
  });

  it("keeps Unpriced in the summary and omits the currency dash", () => {
    const tokens = costed({ input: 90 }, { apiEquivalentCostUsd: null, unpricedTokens: 90 });
    const snapshot: AnalyticsGroupSnapshot = {
      ...zeroSnapshot("model", undefined),
      totals: tokens,
      rows: [
        {
          identity: known("model-alpha"),
          tokens,
          sessionCount: 1,
          stepCount: 1,
          children: [],
        },
      ],
      series: [
        {
          kind: "entity",
          identity: known("model-alpha"),
          tokens,
          buckets: [tokens],
        },
      ],
    };
    const { root, dispose } = mountSnapshot(snapshot);
    try {
      const summary = summaryText(root, "API-equivalent estimate");
      expect(summary).toContain("Unpriced");
      expect(summary).not.toContain("≈ $—");
    } finally {
      dispose();
    }
  });

  it("keeps the API-equivalent cost overlay on the visible bucket total", async () => {
    const { root, dispose } = mountModels();
    try {
      const combined = byClass(root, "path", "qg-chart__cost-line")[0] as TestNode;
      expect(combined).toBeDefined();
      const combinedPath = combined.props.d;
      const combinedTicks = byClass(root, "text", "qg-chart__axis-label--cost");
      expect(graph.textOf(combinedTicks.at(-1) as TestNode)).toBe("8");
      expect(combined.props["data-partial"]).toBe("true");

      const legend = legendItem(root, "model-alpha") as TestNode;
      pointerEnter(legend);
      await settle();
      expect((byClass(root, "path", "qg-chart__cost-line")[0] as TestNode).props.d).toBe(
        combinedPath,
      );
      expect(
        graph.textOf(byClass(root, "text", "qg-chart__axis-label--cost").at(-1) as TestNode),
      ).toBe("8");
      pointerLeave(legend);
      await settle();

      focus(legend);
      await settle();
      expect((byClass(root, "path", "qg-chart__cost-line")[0] as TestNode).props.d).toBe(
        combinedPath,
      );
      expect(
        graph.textOf(byClass(root, "text", "qg-chart__axis-label--cost").at(-1) as TestNode),
      ).toBe("8");
      expect(
        (byClass(root, "path", "qg-chart__cost-line")[0] as TestNode).props["data-partial"],
      ).toBe("true");

      blur(legend);
      await settle();
      expect((byClass(root, "path", "qg-chart__cost-line")[0] as TestNode).props.d).toBe(
        combinedPath,
      );
    } finally {
      dispose();
    }
  });

  it("quiets the total cost line during emphasis and never makes Other its owner", async () => {
    const { root, dispose } = mountModels();
    try {
      const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
      const costLine = () => byClass(root, "path", "qg-chart__cost-line")[0] as TestNode;
      const costPath = costLine().props.d;
      expect(costPath).toBeDefined();

      expect(plot.props["data-highlight"]).toBeUndefined();
      expect(costLine().props["data-highlighted"]).toBeUndefined();
      expect(costLine().props["data-series-key"]).toBeUndefined();

      const alpha = legendItem(root, "model-alpha") as TestNode;
      focus(alpha);
      await settle();
      expect(plot.props["data-highlight"]).toBe("true");
      // The grey hook is CSS-only: the line keeps its true path and never
      // receives a highlighted state of its own.
      expect(costLine().props.d).toBe(costPath);
      expect(costLine().props["data-highlighted"]).toBeUndefined();
      blur(alpha);
      await settle();
      expect(plot.props["data-highlight"]).toBeUndefined();

      const other = legendItem(root, "Other") as TestNode;
      focus(other);
      await settle();
      expect(plot.props["data-highlight"]).toBe("true");
      expect(costLine().props.d).toBe(costPath);
      expect(costLine().props["data-highlighted"]).toBeUndefined();
      expect(costLine().props["data-series-key"]).toBeUndefined();
      blur(other);
      await settle();
      expect(plot.props["data-highlight"]).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("omits the old range composition section and keeps the token chart primary", () => {
    const { root, dispose } = mountModels();
    try {
      expect(byClass(root, "section", "qg-composition")).toHaveLength(0);
      expect(graph.textOf(root)).not.toContain("Range composition");
    } finally {
      dispose();
    }
  });

  it("overlays cost with unpriced gaps and a true-zero point", async () => {
    const tokens = costed({ input: 50 }, { apiEquivalentCostUsd: 3, unpricedTokens: 15 });
    const snapshot: AnalyticsGroupSnapshot = {
      ...zeroSnapshot("model", undefined),
      totals: tokens,
      buckets: [
        { startMs: NOW - 5 * DAY_MS, endMs: NOW - 4 * DAY_MS },
        { startMs: NOW - 4 * DAY_MS, endMs: NOW - 3 * DAY_MS },
        { startMs: NOW - 3 * DAY_MS, endMs: NOW - 2 * DAY_MS },
        { startMs: NOW - 2 * DAY_MS, endMs: NOW - DAY_MS },
        { startMs: NOW - DAY_MS, endMs: NOW },
      ],
      rows: [
        {
          identity: known("model-alpha"),
          tokens,
          sessionCount: 1,
          stepCount: 1,
          children: [],
        },
      ],
      series: [
        {
          kind: "entity",
          identity: known("model-alpha"),
          tokens,
          buckets: [
            costed({ input: 10 }, { apiEquivalentCostUsd: 2 }),
            costed({ input: 10 }, { apiEquivalentCostUsd: 1, unpricedTokens: 5 }),
            costed({ input: 10 }, { apiEquivalentCostUsd: null, unpricedTokens: 10 }),
            costed({ input: 10 }, { apiEquivalentCostUsd: 0 }),
            costed({}, { apiEquivalentCostUsd: null }),
          ],
        },
      ],
    };
    const { root, dispose } = mountSnapshot(snapshot);
    try {
      const lines = byClass(root, "path", "qg-chart__cost-line");
      expect(lines).toHaveLength(1);
      expect(lines[0]?.props["data-partial"]).toBe("true");
      expect(String(lines[0]?.props.d)).toContain("M");
      expect(byClass(root, "p", "qg-cost-trend__caption")).toHaveLength(0);

      // The true zero is numeric but isolated, so it keeps a short line mark.
      const points = byClass(root, "line", "qg-chart__cost-isolated");
      expect(points).toHaveLength(1);
      expect(points[0]?.props["data-status"]).toBe("zero");
      expect(points[0]?.props["data-bucket-index"]).toBe(3);
      const baseline = (byClass(root, "line", "qg-chart__grid-line")[0] as TestNode).props.y1;
      expect(points[0]?.props.y1).toBe(baseline);
      expect(points[0]?.props.y2).toBe(baseline);

      const costTicks = byClass(root, "text", "qg-chart__axis-label--cost");
      expect(costTicks.map((tick) => graph.textOf(tick))).toEqual([
        "0",
        "0.5",
        "1.0",
        "1.5",
        "2.0",
      ]);

      focus(bucketHits(root)[1] as TestNode);
      await settle();
      const partialTooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(partialTooltip)).toContain("API-equivalent total");
      expect(graph.textOf(partialTooltip)).toContain("partial");
      blur(bucketHits(root)[1] as TestNode);

      focus(bucketHits(root)[2] as TestNode);
      await settle();
      const unpricedTooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(unpricedTooltip)).toContain("Unpriced");
      expect(graph.textOf(unpricedTooltip)).not.toContain("≈ $—");
      blur(bucketHits(root)[2] as TestNode);
    } finally {
      dispose();
    }
  });

  it("disambiguates provider aliases with raw ids in legend, table and breakdown", () => {
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(modelsViewModule.ModelsView, {
          snapshot: providerAliasSnapshot(),
          dimension: "provider",
          onDimensionChange: () => {},
        }),
      root,
    );
    try {
      expect(
        legendItems(root)
          .map((button) => graph.textOf(button))
          .join(" "),
      ).toContain("Z.ai (zai)");
      expect(
        legendItems(root)
          .map((button) => graph.textOf(button))
          .join(" "),
      ).toContain("Z.ai (glm)");
      expect(rowLabels(root)).toEqual(["Z.ai (zai)", "Z.ai (glm)", "Zhipu"]);
      expect(tableHeaders(root)).toContain("Z.ai (zai)");
      expect(tableHeaders(root)).toContain("Z.ai (glm)");
      expect((rowByLabel(root, "Z.ai (zai)") as TestNode).props.href).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("zai"))}?range=7d&group=provider`,
      );
    } finally {
      dispose();
    }
  });

  it("shows an honest empty state with no fabricated series", () => {
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(modelsViewModule.ModelsView, {
          snapshot: zeroSnapshot("model", undefined),
          dimension: "model",
          onDimensionChange: () => {},
        }),
      root,
    );
    try {
      expect(graph.textOf(root)).toContain("No activity in this range.");
      expect(graph.textOf(root)).toContain("No usage in this range.");
      expect(legendItems(root)).toHaveLength(0);
      expect(chartSegments(root)).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});

describe("model and provider detail", () => {
  it("shows symmetric model metrics, a derivable cache rate and provider breakdown", () => {
    const { root, dispose } = mountDetail(
      modelDetailModule,
      "ModelDetailView",
      modelAlphaSnapshot(),
      known("model-alpha"),
    );
    try {
      const shell = chartShell(root);
      expect(shell).toBeDefined();
      expect(graph.textOf(shell?.title as TestNode)).toBe("Usage by provider");
      expect(summaryText(root, "Total tokens")).toContain("600");
      expect(summaryText(root, "API-equivalent estimate")).toContain("≈ $6.00");
      expect(summaryText(root, "Sessions")).toContain("6");
      expect(summaryText(root, "Cache hit rate")).toContain("33.50%");
      expect(graph.textOf(root)).toContain("Analytics");
      expect(graph.textOf(root)).toContain("Models");
      expect(graph.textOf(root)).toContain("model-alpha");
      expect(byClass(root, "a", "qg-breakdown__row--child")).toHaveLength(0);
      expect(rowLabels(root)).toEqual([
        "OpenAI",
        "Anthropic",
        "Google",
        "Mistral",
        "DeepSeek",
        "OpenRouter",
      ]);
      const openai = rowByLabel(root, "OpenAI") as TestNode;
      expect(openai.props.href).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("openai"))}?range=7d&group=model`,
      );
      // Exactly one identity heading, one chart heading and one Breakdown heading.
      expect(byClass(root, "h2", "qg-page-title")).toHaveLength(1);
      const pageTitle = byClass(root, "h2", "qg-page-title")[0] as TestNode;
      expect(hasClass(pageTitle, "qg-breakable")).toBe(true);
      const crumb = graph
        .elementsNamed(root, "span")
        .find((node) => node.props["aria-current"] === "page");
      expect(crumb && hasClass(crumb, "qg-breakable")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("nests peak and off-peak rows under each provider route on model detail", () => {
    const temporalBreakdown = {
      rows: [
        {
          identity: known("openai"),
          peak: costed({ input: 1_000_000 }, { apiEquivalentCostUsd: 3 }),
          offpeak: costed({ input: 500_000 }, { apiEquivalentCostUsd: 1 }),
        },
        {
          identity: known("anthropic"),
          peak: costed({ input: 2_000_000 }, { apiEquivalentCostUsd: 4 }),
          offpeak: costed({ input: 2_000_000 }, { apiEquivalentCostUsd: 2 }),
        },
      ],
    };
    const { root, dispose } = mountDetail(
      modelDetailModule,
      "ModelDetailView",
      { ...modelAlphaSnapshot(), temporalBreakdown },
      known("model-alpha"),
    );
    try {
      const openaiGroup = (rowByLabel(root, "OpenAI") as TestNode).parent;
      const openai = phaseRows(root, "OpenAI");
      expect(openai.map(phaseLabelOf)).toEqual(["Peak", "Off-peak"]);
      expect(openai.map((row) => row.props["data-level"])).toEqual(["phase", "phase"]);
      expect(openai.map((row) => row.props["data-phase"])).toEqual(["peak", "offpeak"]);
      // Each phase is a child of the provider's group, one level below the route.
      expect(openai.every((row) => row.parent === openaiGroup)).toBe(true);
      expect(graph.textOf(openai[0] as TestNode)).toContain("≈ $3.00");
      expect(phaseTokens(openai[0] as TestNode)).toEqual({
        text: "1.0M",
        title: "1,000,000 tokens",
      });
      expect(graph.textOf(openai[1] as TestNode)).toContain("≈ $1.00");
      expect(phaseTokens(openai[1] as TestNode)).toEqual({
        text: "500k",
        title: "500,000 tokens",
      });

      const anthropic = phaseRows(root, "Anthropic");
      expect(anthropic.map(phaseLabelOf)).toEqual(["Peak", "Off-peak"]);
      expect(graph.textOf(anthropic[0] as TestNode)).toContain("≈ $4.00");
      expect(graph.textOf(anthropic[1] as TestNode)).toContain("≈ $2.00");
      expect(phaseTokens(anthropic[1] as TestNode)).toEqual({
        text: "2.0M",
        title: "2,000,000 tokens",
      });

      // Only admitted provider routes get phase levels; the provider list is
      // otherwise the same hierarchy it was before.
      expect(phaseRows(root, "Google")).toHaveLength(0);
      expect(rowLabels(root)).toEqual([
        "OpenAI",
        "Anthropic",
        "Google",
        "Mistral",
        "DeepSeek",
        "OpenRouter",
      ]);
      expect(breakdownRows(root)).toHaveLength(6);

      // The data is no longer a separate provider/phase table appended below.
      expect(graph.textOf(root)).not.toContain("Peak and off-peak history");

      // The existing model-detail layout stays intact around the nested levels.
      expect(byClass(root, "h2", "qg-page-title")).toHaveLength(1);
      expect(chartShell(root)?.title && graph.textOf(chartShell(root)?.title as TestNode)).toBe(
        "Usage by provider",
      );

      const empty = mountDetail(
        modelDetailModule,
        "ModelDetailView",
        { ...modelAlphaSnapshot(), temporalBreakdown: { rows: [] } },
        known("model-alpha"),
      );
      try {
        expect(byClass(empty.root, "div", "qg-breakdown__row--phase")).toHaveLength(0);
      } finally {
        empty.dispose();
      }
    } finally {
      dispose();
    }
  });

  it("never nests temporal phase rows on provider detail", () => {
    const { root, dispose } = mountDetail(
      providerDetailModule,
      "ProviderDetailView",
      {
        ...providerOpenAISnapshot(),
        temporalBreakdown: {
          rows: [
            {
              identity: known("openai"),
              peak: costed({ input: 1_000_000 }, { apiEquivalentCostUsd: 3 }),
              offpeak: costed({ input: 500_000 }, { apiEquivalentCostUsd: 1 }),
            },
          ],
        },
      },
      known("openai"),
    );
    try {
      expect(byClass(root, "div", "qg-breakdown__row--phase")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("never nests temporal phase rows on the models overview", () => {
    const snapshot = {
      ...modelSnapshot(),
      temporalBreakdown: {
        rows: [
          {
            identity: known("openai"),
            peak: costed({ input: 1_000_000 }, { apiEquivalentCostUsd: 3 }),
            offpeak: costed({ input: 500_000 }, { apiEquivalentCostUsd: 1 }),
          },
        ],
      },
    };
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(modelsViewModule.ModelsView, {
          snapshot,
          dimension: "model",
          onDimensionChange: () => {},
        }),
      root,
    );
    try {
      expect(byClass(root, "div", "qg-breakdown__row--phase")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("omits the cache rate when the existing semantics cannot derive it", () => {
    const { root, dispose } = mountDetail(
      modelDetailModule,
      "ModelDetailView",
      modelNoRateSnapshot(),
      known("model-no-rate"),
    );
    try {
      expect(summaryText(root, "Cache hit rate")).toBeUndefined();
      expect(graph.textOf(root)).not.toContain("Cache hit rate");
      expect(summaryText(root, "Total tokens")).toContain("120");
    } finally {
      dispose();
    }
  });

  it("shows provider metrics with a model count and model breakdown", () => {
    const { root, dispose } = mountDetail(
      providerDetailModule,
      "ProviderDetailView",
      providerOpenAISnapshot(),
      known("openai"),
    );
    try {
      const shell = chartShell(root);
      expect(shell).toBeDefined();
      expect(graph.textOf(shell?.title as TestNode)).toBe("Usage by model");
      expect(summaryText(root, "Total tokens")).toContain("1,500");
      expect(summaryText(root, "API-equivalent estimate")).toContain("≈ $6.00");
      expect(summaryText(root, "API-equivalent estimate")).toContain("Partial estimate");
      expect(summaryText(root, "Sessions")).toContain("5");
      expect(summaryText(root, "Models")).toContain("5");
      expect(graph.textOf(root)).not.toContain("Cache hit rate");
      expect(rowLabels(root)).toEqual([
        "model-alpha",
        "model-epsilon",
        "model-zeta",
        "model-gamma",
        "model-beta",
      ]);
      const beta = rowByLabel(root, "model-beta") as TestNode;
      expect(beta.props.href).toBe(
        `/model/${encodeAnalyticsEntityToken(known("model-beta"))}?range=7d&group=provider`,
      );
      expect(graph.textOf(root)).toContain("openai");
      expect(byClass(root, "h2", "qg-page-title")).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("uses Free in a detail summary and rows only for wholly zero-priced totals", () => {
    const freeTotals = costed({ input: 100 }, { apiEquivalentCostUsd: 0 });
    const { root, dispose } = mountDetail(
      providerDetailModule,
      "ProviderDetailView",
      { ...providerOpenAISnapshot(), totals: freeTotals },
      known("openai"),
    );
    try {
      expect(summaryText(root, "API-equivalent estimate")).toContain("Free");
      expect(summaryText(root, "API-equivalent estimate")).not.toContain("≈ $0.00");
      const gamma = rowByLabel(root, "model-gamma") as TestNode;
      expect(graph.textOf(gamma)).toContain("Free");
      const beta = rowByLabel(root, "model-beta") as TestNode;
      expect(graph.textOf(beta)).toContain("Unpriced");
    } finally {
      dispose();
    }
  });

  it("uses the same rank colour across a detail chart, legend and breakdown", () => {
    const snapshot = providerOpenAISnapshot();
    const ranked = rankSeries(snapshot.series);
    expect(ranked.map((entry) => (entry.kind === "other" ? "Other" : entry.identity))).toEqual([
      known("model-beta"),
      known("model-gamma"),
      known("model-alpha"),
      known("model-epsilon"),
      known("model-zeta"),
    ]);

    const { root, dispose } = mountDetail(
      providerDetailModule,
      "ProviderDetailView",
      snapshot,
      known("openai"),
    );
    try {
      const expected = "var(--qg-rank-2)";
      const segments = chartSegments(root).filter(
        (segment) => segment.props["data-series-key"] === "model:known:model-gamma",
      );
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.every((segment) => segment.props.fill === expected)).toBe(true);
      expect((legendItem(root, "model-gamma") as TestNode).props.style["--qg-swatch"]).toBe(
        expected,
      );
      expect(swatchVar(rowByLabel(root, "model-gamma") as TestNode)).toBe(expected);
      // The next rank is the next palette slot, on every detail surface.
      expect(
        chartSegments(root)
          .filter((segment) => segment.props["data-series-key"] === "model:known:model-alpha")
          .every((segment) => segment.props.fill === "var(--qg-rank-3)"),
      ).toBe(true);
      expect(swatchVar(rowByLabel(root, "model-alpha") as TestNode)).toBe("var(--qg-rank-3)");
    } finally {
      dispose();
    }
  });

  it("wires pinned legend state on both detail pages", async () => {
    const cases = [
      {
        module: modelDetailModule,
        name: "ModelDetailView",
        snapshot: modelAlphaSnapshot(),
        identity: known("model-alpha"),
      },
      {
        module: providerDetailModule,
        name: "ProviderDetailView",
        snapshot: providerOpenAISnapshot(),
        identity: known("openai"),
      },
    ] as const;

    for (const detail of cases) {
      const { root, dispose } = mountDetail(
        detail.module,
        detail.name,
        detail.snapshot,
        detail.identity,
      );
      try {
        const legend = legendItems(root);
        expect(legend.length).toBeGreaterThan(0);
        const first = legend[0] as TestNode;
        expect(first.tag).toBe("button");
        expect(first.props["aria-pressed"]).toBe("false");

        focus(first);
        await settle();
        expect(first.props["data-active"]).toBe("true");

        click(first);
        await settle();
        expect(first.props["data-pinned"]).toBe("true");
        expect(first.props["aria-pressed"]).toBe("true");

        const plot = byClass(root, "div", "qg-model-chart__plot")[0] as TestNode;
        expect(plot).toBeDefined();
        click(plot);
        await settle();
        expect(first.props["data-pinned"]).toBeUndefined();
        expect(first.props["aria-pressed"]).toBe("false");
      } finally {
        dispose();
      }
    }
  });

  it("shows the generic provider mark for unknown and empty detail headers", () => {
    const identities: { identity: AnalyticsEntityIdentity; label: string }[] = [
      { identity: unknownIdentity, label: "Unknown provider" },
      { identity: { kind: "known", id: "" }, label: "Empty provider ID" },
    ];
    for (const { identity, label } of identities) {
      const { root, dispose } = mountDetail(
        providerDetailModule,
        "ProviderDetailView",
        providerOpenAISnapshot(),
        identity,
      );
      try {
        const header = byClass(root, "h2", "qg-page-title")[0] as TestNode;
        const logo = byClass(header, "span", "qg-page-head__logo")[0] as TestNode;
        expect(logo).toBeDefined();
        expect(logo.props["data-provider-logo"]).toBe("generic");
        expect((logo.props.style as Record<string, string>)["--qg-provider-logo"]).toContain(
          "/assets/providers/generic.svg",
        );
        expect(graph.textOf(header)).toContain(label);
      } finally {
        dispose();
      }
    }

    const knownCase = mountDetail(
      providerDetailModule,
      "ProviderDetailView",
      providerOpenAISnapshot(),
      known("openai"),
    );
    try {
      const header = byClass(knownCase.root, "h2", "qg-page-title")[0] as TestNode;
      expect(byClass(header, "span", "qg-page-head__logo")[0]?.props["data-provider-logo"]).toBe(
        "openai",
      );
    } finally {
      knownCase.dispose();
    }
  });

  it("labels unknown and known-empty detail identities without conflating them", () => {
    const unknown = mountDetail(
      modelDetailModule,
      "ModelDetailView",
      zeroSnapshot("provider", {
        dimension: "model",
        identity: unknownIdentity,
      }),
      unknownIdentity,
    );
    try {
      expect(graph.textOf(unknown.root)).toContain("Unknown model");
      expect(graph.textOf(unknown.root)).not.toContain("Empty model ID");
    } finally {
      unknown.dispose();
    }
    const empty = mountDetail(
      modelDetailModule,
      "ModelDetailView",
      zeroSnapshot("provider", {
        dimension: "model",
        identity: { kind: "known", id: "" },
      }),
      { kind: "known", id: "" },
    );
    try {
      expect(graph.textOf(empty.root)).toContain("Empty model ID");
      expect(graph.textOf(empty.root)).not.toContain("Unknown model");
    } finally {
      empty.dispose();
    }
  });
});

interface BrowserStub {
  readonly location: URL;
  readonly localStorage: Pick<Storage, "getItem" | "setItem">;
  readonly history: {
    pushState: (state: unknown, title: string, path: string) => void;
    replaceState: (state: unknown, title: string, path: string) => void;
    back: () => void;
  };
  addEventListener: (name: string, listener: (event: unknown) => void) => void;
  removeEventListener: (name: string) => void;
  follow: (href: string) => void;
  back: () => void;
}

function historyBrowser(initialPath: string): BrowserStub {
  const entries = [initialPath];
  let index = 0;
  const current = () => new URL(entries[index] ?? "/", "http://localhost:4144");
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    get location() {
      return current();
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    history: {
      pushState: (_state, _title, path) => {
        entries.splice(index + 1);
        entries.push(path);
        index = entries.length - 1;
      },
      replaceState: (_state, _title, path) => {
        entries[index] = path;
      },
      back: () => {
        if (index > 0) index -= 1;
        listeners.get("popstate")?.({});
      },
    },
    addEventListener: (name, handler) => {
      listeners.set(name, handler);
    },
    removeEventListener: (name) => {
      listeners.delete(name);
    },
    follow: (href) => {
      const preventDefault = vi.fn();
      listeners.get("click")?.({
        button: 0,
        defaultPrevented: false,
        target: {
          closest: () => ({
            getAttribute: (key: string) => (key === "href" ? href : null),
            hasAttribute: () => false,
          }),
        },
        preventDefault,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(current().pathname + current().search).toBe(href);
    },
    back: () => {
      if (index > 0) index -= 1;
      listeners.get("popstate")?.({});
    },
  };
}

interface AppCall {
  home: RangeKey[];
  groups: GroupCall[];
  session: string[];
}

interface GroupCall {
  range: RangeKey;
  dimension: AnalyticsDimension;
  filter?: { dimension: AnalyticsDimension; identity: AnalyticsEntityIdentity };
}

interface MountAppOptions {
  groups?: (query: GroupCall) => Promise<AnalyticsGroupSnapshot>;
}

function defaultGroups(query: GroupCall): Promise<AnalyticsGroupSnapshot> {
  if (query.filter?.dimension === "model" && query.filter.identity.kind === "known") {
    return Promise.resolve(
      withRange(
        query.filter.identity.id === "model-alpha"
          ? modelAlphaSnapshot()
          : zeroSnapshot(query.dimension, query.filter),
        query.range,
      ),
    );
  }
  if (query.filter?.dimension === "provider" && query.filter.identity.kind === "known") {
    return Promise.resolve(
      withRange(
        query.filter.identity.id === "openai"
          ? providerOpenAISnapshot()
          : zeroSnapshot(query.dimension, query.filter),
        query.range,
      ),
    );
  }
  return Promise.resolve(
    withRange(query.dimension === "model" ? modelSnapshot() : providerSnapshot(), query.range),
  );
}

function mountApp(
  initialPath: string,
  options: MountAppOptions = {},
): {
  root: TestNode;
  browser: BrowserStub;
  calls: AppCall;
  follow: (href: string) => Promise<void>;
  back: () => Promise<void>;
  emit: (topic: DashboardEvent["topic"]) => void;
  dispose: () => void;
} {
  const browser = historyBrowser(initialPath);
  vi.stubGlobal("window", browser);
  const calls: AppCall = { home: [], groups: [], session: [] };
  let subscription: ((event: DashboardEvent) => void) | undefined;
  const client = {
    connection: () => "live",
    onConnectionChange: () => () => {},
    subscribe: (onEvent: (event: DashboardEvent) => void) => {
      subscription = onEvent;
      return () => {
        subscription = undefined;
      };
    },
    health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
    home: async ({ range }: { range: RangeKey }) => {
      calls.home.push(range);
      return { ...homeSnapshot({ range }), usage: usage(range, []) };
    },
    quota: async () => homeSnapshot(),
    project: async () => projectSnapshot(),
    session: async ({ sessionId }: { sessionId: string }) => {
      calls.session.push(sessionId);
      return sessionSnapshot();
    },
    groups: async (query: GroupCall) => {
      calls.groups.push(query);
      return (options.groups ?? defaultGroups)(query);
    },
    settings: async () => settingsSnapshot(),
    saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
    saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
    importPreview: async () => ({
      from: "workspace: synthetic",
      keys: [],
      issues: [],
      expectedRevision: "r",
    }),
    importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
  };
  const root = graph.createTestRoot();
  const stop = graph.mount(() => graph.createComponent(appModule.App, { client }), root);
  return {
    root,
    browser,
    calls,
    follow: async (href) => {
      browser.follow(href);
      await settle();
      await settle();
    },
    back: async () => {
      browser.back();
      await settle();
      await settle();
    },
    emit: (topic) => {
      subscription?.({ topic, at: Date.now() });
    },
    dispose: () => {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

function tabsOf(root: TestNode): TestNode | undefined {
  return graph.elementsNamed(root, "nav").find((node) => hasClass(node, "qg-analytics-tabs"));
}

function tabLinks(root: TestNode): TestNode[] {
  const tabs = tabsOf(root);
  return tabs ? graph.elementsNamed(tabs, "a") : [];
}

function rangeControl(root: TestNode): TestNode | undefined {
  return graph
    .elementsNamed(root, "div")
    .find(
      (node) =>
        node.props["data-slot"] === "segmented-control-v2" &&
        node.props["aria-label"] === "Time range",
    );
}

describe("peer Analytics / Models navigation", () => {
  it("renders Provider before Model while Provider remains the default grouping", async () => {
    const app = mountApp("/models?range=24h");
    try {
      await settle();
      await settle();
      const links = tabLinks(app.root);
      expect(links.map((link) => link.props.href)).toEqual([
        "/analytics?range=24h",
        "/models?range=24h",
      ]);
      expect(links.map((link) => link.props["aria-current"])).toEqual([undefined, "page"]);
      expect(graph.textOf(chartTitle(app.root) as TestNode)).toBe("Usage by provider");
      const dimensionItems = segmentedItems(app.root, "Group usage by");
      expect(dimensionItems.map((item) => graph.textOf(item))).toEqual(["Provider", "Model"]);
      expect(dimensionItems.map((item) => item.props["aria-pressed"])).toEqual([true, false]);
      expect(rangeControl(app.root)).toBeDefined();
      expect(app.calls.groups).toEqual([{ range: "24h", dimension: "provider" }]);
    } finally {
      app.dispose();
    }
  });

  it("links the Models tab to the canonical provider default from Analytics", async () => {
    const app = mountApp("/analytics?range=24h");
    try {
      await settle();
      await settle();
      expect((tabLinks(app.root)[1] as TestNode).props.href).toBe("/models?range=24h");
    } finally {
      app.dispose();
    }
  });

  it("keeps the range across Analytics, Models, model detail and provider detail", async () => {
    const app = mountApp("/analytics?range=24h");
    try {
      await settle();
      await settle();
      expect(app.calls.home).toEqual(["24h"]);
      await app.follow("/models?range=24h&group=model");
      expect(app.calls.groups).toEqual([{ range: "24h", dimension: "model" }]);
      const modelItems = segmentedItems(app.root, "Group usage by");
      expect(modelItems.map((item) => graph.textOf(item))).toEqual(["Provider", "Model"]);
      expect(modelItems.map((item) => item.props["aria-pressed"])).toEqual([false, true]);
      expect(tabLinks(app.root).map((link) => link.props["aria-current"])).toEqual([
        undefined,
        "page",
      ]);

      await app.follow(formatPath({ name: "model", identity: known("model-alpha") }, "24h"));
      expect(app.calls.groups.at(-1)).toEqual({
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: known("model-alpha") },
      });
      expect(graph.textOf(app.root)).toContain("model-alpha");
      expect(tabLinks(app.root).map((link) => link.props["aria-current"])).toEqual([
        undefined,
        "page",
      ]);

      await app.follow(formatPath({ name: "provider", identity: known("openai") }, "24h"));
      expect(app.calls.groups.at(-1)).toEqual({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: known("openai") },
      });
      expect(graph.textOf(app.root)).toContain("OpenAI");
      expect(rangeControl(app.root)).toBeDefined();
      await app.follow("/models?range=7d");
      expect(app.calls.groups.at(-1)).toEqual({ range: "7d", dimension: "provider" });
    } finally {
      app.dispose();
    }
  });

  it("shows a failed same-kind model detail transition, then recovers on refresh", async () => {
    let failBeta = true;
    const alphaPath = formatPath({ name: "model", identity: known("model-alpha") }, "7d");
    const betaPath = formatPath({ name: "model", identity: known("model-beta") }, "7d");
    const app = mountApp(alphaPath, {
      groups: (query) => {
        const identity = query.filter?.identity;
        if (identity?.kind === "known" && identity.id === "model-beta" && failBeta) {
          return Promise.reject(new Error("model beta unavailable"));
        }
        return defaultGroups(query);
      },
    });
    try {
      await settle();
      await settle();
      expect(graph.textOf(app.root)).toContain("model-alpha");
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(0);

      await app.follow(betaPath);
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(1);
      expect(byClass(app.root, "output", "qg-skeleton")).toHaveLength(0);
      expect(graph.textOf(app.root)).not.toContain("model-alpha");

      failBeta = false;
      app.emit("sessions.changed");
      await settle();
      await settle();
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(0);
      expect(graph.textOf(app.root)).toContain("model-beta");
      expect(graph.textOf(app.root)).not.toContain("model-alpha");
    } finally {
      app.dispose();
    }
  });

  it("shows a failed same-kind provider detail transition, then recovers on refresh", async () => {
    let failAnthropic = true;
    const openaiPath = formatPath({ name: "provider", identity: known("openai") }, "7d");
    const anthropicPath = formatPath({ name: "provider", identity: known("anthropic") }, "7d");
    const app = mountApp(openaiPath, {
      groups: (query) => {
        const identity = query.filter?.identity;
        if (identity?.kind === "known" && identity.id === "anthropic" && failAnthropic) {
          return Promise.reject(new Error("anthropic unavailable"));
        }
        return defaultGroups(query);
      },
    });
    try {
      await settle();
      await settle();
      expect(graph.textOf(app.root)).toContain("OpenAI");
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(0);

      await app.follow(anthropicPath);
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(1);
      expect(byClass(app.root, "output", "qg-skeleton")).toHaveLength(0);
      expect(graph.textOf(app.root)).not.toContain("OpenAI");

      failAnthropic = false;
      app.emit("sessions.changed");
      await settle();
      await settle();
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(0);
      expect(graph.textOf(app.root)).toContain("Anthropic");
      expect(graph.textOf(app.root)).not.toContain("OpenAI");
    } finally {
      app.dispose();
    }
  });

  it("keeps data links on the visible stale range after a range failure", async () => {
    const app = mountApp("/models?range=7d&group=model", {
      groups: (query) =>
        query.range === "30d"
          ? Promise.reject(new Error("range unavailable"))
          : defaultGroups(query),
    });
    try {
      await settle();
      await settle();
      expect(rowByLabel(app.root, "model-alpha")).toBeDefined();

      clickSegmented(app.root, "Time range", "30 days");
      await settle();
      await settle();

      expect(app.browser.location.search).toBe("?range=30d&group=model");
      expect(byClass(app.root, "div", "qg-range-failure")).toHaveLength(1);
      expect(graph.textOf(app.root)).toContain("Showing 7 days. Updating to 30 days failed.");
      const row = rowByLabel(app.root, "model-alpha") as TestNode;
      expect(row.props.href).toBe(
        `/model/${encodeAnalyticsEntityToken(known("model-alpha"))}?range=7d&group=model`,
      );
      expect(row.props.href).not.toContain("30d");
    } finally {
      app.dispose();
    }
  });

  it("keeps Session range-free while the remembered range survives the tabs", async () => {
    const app = mountApp("/models?range=30d");
    try {
      await settle();
      await settle();
      await app.follow("/session/session-root-1");
      expect(app.browser.location.search).toBe("");
      expect(rangeControl(app.root)).toBeUndefined();
      expect(app.calls.session).toEqual(["session-root-1"]);
      const links = tabLinks(app.root);
      expect(links.map((link) => link.props.href)).toEqual([
        "/analytics?range=30d",
        "/models?range=30d",
      ]);
      expect(links.map((link) => link.props["aria-current"])).toEqual(["page", undefined]);
      await app.follow("/analytics?range=30d");
      expect(app.calls.home.at(-1)).toBe("30d");
    } finally {
      app.dispose();
    }
  });

  it("does not expose any route beyond Models and the two symmetric details", () => {
    expect(parseLocation("/models/foo", "7d").route.name).toBe("not-found");
    expect(parseLocation("/model-pair/a/b", "7d").route.name).toBe("not-found");
  });

  it("keeps the dimension control and breakdown sort mounted while a switch is pending", async () => {
    let resolveProvider: ((snapshot: AnalyticsGroupSnapshot) => void) | undefined;
    const app = mountApp("/models?range=24h&group=model", {
      groups: (query) => {
        if (query.dimension === "provider") {
          return new Promise((resolve) => {
            resolveProvider = resolve;
          });
        }
        return defaultGroups(query);
      },
    });
    try {
      await settle();
      await settle();
      const tokensSort = () =>
        segmentedItems(app.root, "Sort breakdown").find((node) => graph.textOf(node) === "Tokens");
      clickSegmented(app.root, "Sort breakdown", "Tokens");
      await settle();
      expect(tokensSort()?.props["aria-pressed"]).toBe(true);
      const control = findSegmented(app.root, "Group usage by") as TestNode;
      const providerControl = segmentedItems(app.root, "Group usage by").find(
        (node) => graph.textOf(node) === "Provider",
      ) as TestNode;
      click(providerControl);
      await settle();

      expect(findSegmented(app.root, "Group usage by")).toBe(control);
      expect(
        segmentedItems(app.root, "Group usage by").find(
          (node) => graph.textOf(node) === "Provider",
        ),
      ).toBe(providerControl);
      expect(graph.textOf(chartTitle(app.root) as TestNode)).toBe("Usage by provider");

      (resolveProvider as (snapshot: AnalyticsGroupSnapshot) => void)(
        withRange(providerSnapshot(), "24h"),
      );
      await settle();
      await settle();
      expect(rowLabels(app.root)).toEqual([
        "OpenAI",
        "Google",
        "Anthropic",
        "Unknown provider",
        "Mistral",
        "Empty provider ID",
        "DeepSeek",
        "OpenRouter",
      ]);
      expect(tokensSort()?.props["aria-pressed"]).toBe(true);

      await app.follow("/models?range=7d");
      expect(app.browser.location.pathname + app.browser.location.search).toBe("/models?range=7d");
      expect(tokensSort()?.props["aria-pressed"]).toBe(true);
      expect(rowLabels(app.root).slice(0, 5)).toEqual([
        "OpenAI",
        "Google",
        "Anthropic",
        "Unknown provider",
        "Mistral",
      ]);
    } finally {
      app.dispose();
    }
  });

  it("keeps the dimension control usable after a failed switch", async () => {
    const app = mountApp("/models?range=24h&group=model", {
      groups: (query) => {
        if (query.dimension === "provider")
          return Promise.reject(new Error("provider unavailable"));
        return defaultGroups(query);
      },
    });
    try {
      await settle();
      await settle();
      clickSegmented(app.root, "Group usage by", "Provider");
      await settle();
      await settle();

      expect(findSegmented(app.root, "Group usage by")).toBeDefined();
      expect(byClass(app.root, "div", "qg-error-card")).toHaveLength(1);

      clickSegmented(app.root, "Group usage by", "Model");
      await settle();
      await settle();
      expect(graph.textOf(chartTitle(app.root) as TestNode)).toBe("Usage by model");
      expect(rowLabels(app.root)).toContain("model-alpha");
    } finally {
      app.dispose();
    }
  });

  it("preserves the Models grouping through a detail, tab link and browser back", async () => {
    const app = mountApp("/models?range=24h&group=model");
    try {
      await settle();
      await settle();
      clickSegmented(app.root, "Group usage by", "Provider");
      await settle();
      await settle();
      expect(app.browser.location.pathname + app.browser.location.search).toBe("/models?range=24h");

      const openai = rowByLabel(app.root, "OpenAI") as TestNode;
      expect(openai.props.href).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("openai"))}?range=24h&group=provider`,
      );
      await app.follow(openai.props.href as string);
      const modelsTab = tabLinks(app.root)[1] as TestNode;
      expect(modelsTab.props.href).toBe("/models?range=24h");
      const breadcrumbs = graph
        .elementsNamed(app.root, "nav")
        .find((node) => hasClass(node, "qg-breadcrumbs")) as TestNode;
      const crumbLinks = graph.elementsNamed(breadcrumbs, "a");
      expect(crumbLinks[1]?.props.href).toBe("/models?range=24h");

      await app.back();
      expect(app.browser.location.pathname + app.browser.location.search).toBe("/models?range=24h");
      expect(app.calls.groups.at(-1)).toEqual({ range: "24h", dimension: "provider" });

      await app.follow("/analytics?range=24h");
      expect((tabLinks(app.root)[1] as TestNode).props.href).toBe("/models?range=24h");
    } finally {
      app.dispose();
    }
  });

  it("defaults a direct provider detail to the provider grouping without losing range", async () => {
    const app = mountApp(formatPath({ name: "provider", identity: known("openai") }, "24h"));
    try {
      await settle();
      await settle();
      expect(app.calls.groups).toEqual([
        {
          range: "24h",
          dimension: "model",
          filter: { dimension: "provider", identity: known("openai") },
        },
      ]);
      expect((tabLinks(app.root)[1] as TestNode).props.href).toBe("/models?range=24h");
      const breadcrumbs = graph
        .elementsNamed(app.root, "nav")
        .find((node) => hasClass(node, "qg-breadcrumbs")) as TestNode;
      expect(graph.elementsNamed(breadcrumbs, "a")[1]?.props.href).toBe("/models?range=24h");
      expect(rangeControl(app.root)).toBeDefined();
      expect(app.browser.location.search).toBe("?range=24h");
    } finally {
      app.dispose();
    }
  });

  it("keeps a model-origin provider detail on the model grouping through back and range", async () => {
    const app = mountApp("/models?range=24h&group=model");
    try {
      await settle();
      await settle();
      const providerChild = childRow(app.root, "model-alpha", "OpenAI") as TestNode;
      expect(providerChild.props.href).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("openai"))}?range=24h&group=model`,
      );
      await app.follow(providerChild.props.href as string);
      expect(app.browser.location.pathname + app.browser.location.search).toBe(
        `/provider/${encodeAnalyticsEntityToken(known("openai"))}?range=24h&group=model`,
      );
      expect((tabLinks(app.root)[1] as TestNode).props.href).toBe("/models?range=24h&group=model");
      const breadcrumbs = graph
        .elementsNamed(app.root, "nav")
        .find((node) => hasClass(node, "qg-breadcrumbs")) as TestNode;
      expect(graph.elementsNamed(breadcrumbs, "a")[1]?.props.href).toBe(
        "/models?range=24h&group=model",
      );

      await app.back();
      expect(app.browser.location.pathname + app.browser.location.search).toBe(
        "/models?range=24h&group=model",
      );
      expect(app.calls.groups.at(-1)).toEqual({ range: "24h", dimension: "model" });
    } finally {
      app.dispose();
    }
  });

  it("defaults a provider detail with no group to the provider grouping and preserves back and range", async () => {
    const app = mountApp("/models?range=24h");
    try {
      await settle();
      await settle();
      expect(app.browser.location.pathname + app.browser.location.search).toBe("/models?range=24h");

      // A detail URL without an explicit origin group uses the provider
      // default rather than inheriting the model grouping.
      await app.follow(formatPath({ name: "provider", identity: known("openai") }, "7d"));
      expect(app.calls.groups.at(-1)).toEqual({
        range: "7d",
        dimension: "model",
        filter: { dimension: "provider", identity: known("openai") },
      });
      expect((tabLinks(app.root)[1] as TestNode).props.href).toBe("/models?range=7d");
      const breadcrumbs = graph
        .elementsNamed(app.root, "nav")
        .find((node) => hasClass(node, "qg-breadcrumbs")) as TestNode;
      expect(graph.elementsNamed(breadcrumbs, "a")[1]?.props.href).toBe("/models?range=7d");
      expect(rangeControl(app.root)).toBeDefined();
      expect(graph.textOf(app.root)).toContain("OpenAI");

      await app.back();
      expect(app.browser.location.pathname + app.browser.location.search).toBe("/models?range=24h");
      expect(app.calls.groups.at(-1)).toEqual({ range: "24h", dimension: "provider" });
    } finally {
      app.dispose();
    }
  });

  it("marks only the visible tab current and indicates the Analytics section separately", async () => {
    const app = mountApp("/models?range=24h");
    try {
      await settle();
      await settle();
      const sectionLink = () =>
        graph
          .elementsNamed(app.root, "a")
          .find((node) => node.props["aria-label"] === "Analytics") as TestNode;
      expect(sectionLink().props["aria-current"]).toBeUndefined();
      expect(sectionLink().props["data-section-active"]).toBe("true");
      expect(tabLinks(app.root).map((link) => link.props["aria-current"])).toEqual([
        undefined,
        "page",
      ]);
      expect(
        graph.elementsNamed(app.root, "a").filter((link) => link.props["aria-current"] === "page"),
      ).toHaveLength(1);

      await app.follow("/analytics?range=24h");
      expect(sectionLink().props["aria-current"]).toBeUndefined();
      expect(tabLinks(app.root).map((link) => link.props["aria-current"])).toEqual([
        "page",
        undefined,
      ]);
    } finally {
      app.dispose();
    }
  });
});

describe("Models styles", () => {
  it("declares the exact rank palette and the accessible emphasis hooks", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-rank-1: var(--qg-token-cache-read);");
    expect(styles).toContain("--qg-rank-2: var(--qg-token-input);");
    expect(styles).toContain("--qg-rank-3: var(--qg-token-reasoning);");
    expect(styles).toContain("--qg-rank-4: var(--qg-token-output);");
    expect(styles).toContain("--qg-rank-5: #00bc7d;");
    expect(styles).toContain("--qg-rank-other: var(--qg-text-muted);");
    expect(styles).toContain(".qg-analytics-tabs");
    expect(styles).toContain(".qg-breakdown");
    expect(styles).toContain(".qg-partial");
    expect(styles).toContain(".qg-model-chart");
    expect(styles).toContain(".qg-chart__cost-line");
    expect(styles).toContain(".qg-chart__cost-isolated");
    expect(styles).toContain(".qg-chart__axis-title--cost");
    expect(styles).toContain(".qg-chart__child-slice");
    expect(styles).toContain(".qg-model-tooltip__cost");
    expect(styles).not.toContain(".qg-composition");
    expect(styles).not.toContain(".qg-cost-trend");
    expect(styles).not.toContain(".qg-model-legend");
    expect(styles).toMatch(
      /\.qg-legend__item:hover,\s*\.qg-legend__item:focus-visible \{[^}]*border-color: var\(--qg-border\);/u,
    );
    expect(styles).toContain(".qg-legend__swatch {");
    expect(styles).toContain("border-radius: 2px;");
    expect(styles).toMatch(
      /\.qg-breakdown__swatch \{[^}]*width: 10px;[^}]*height: 10px;[^}]*border-radius: 2px;[^}]*background: var\(--qg-swatch\);/u,
    );
    expect(styles).toContain('.qg-breakdown__row[data-dimmed="true"]');
    expect(styles).toContain(".qg-model-chart__plot[data-highlight]");
    expect(styles).toContain(".qg-breakable");
    expect(styles).toContain("overflow-wrap: anywhere;");
    expect(styles).toContain("background: var(--qg-surface);");
  });

  it("paints the cost line amber while the fifth rank stays an independent green", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-chart-rate: #ffb900;");
    expect(styles).toContain("--qg-chart-cost-strong: #ffb900;");
    expect(styles).toContain("--qg-rank-5: #00bc7d;");
    expect(styles).not.toContain("--qg-rank-5: var(--qg-chart-rate);");
    expect(styles).toMatch(/\.qg-chart__cost-line \{[^}]*stroke: var\(--qg-chart-cost-strong\);/u);
    expect(styles).toMatch(
      /\.qg-chart__axis-title--cost,\s*\.qg-chart__axis-label--cost \{[^}]*fill: var\(--qg-chart-cost-strong\);/u,
    );
    // The generic title rule must come first, or equal specificity mutes it.
    expect(styles.indexOf(".qg-chart__axis-title {")).toBeGreaterThan(-1);
    expect(styles.indexOf(".qg-chart__axis-title--cost")).toBeGreaterThan(
      styles.indexOf(".qg-chart__axis-title {"),
    );
  });

  it("greys the cost line and its axis text only while the chart carries series emphasis", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.qg-model-chart__plot\[data-highlight\] \.qg-chart__cost-line \{[^}]*stroke: var\(--qg-chart-cost\);/u,
    );
    expect(styles).toMatch(
      /\.qg-model-chart__plot\[data-highlight\] \.qg-chart__axis-title--cost,\s*\.qg-model-chart__plot\[data-highlight\] \.qg-chart__axis-label--cost \{[^}]*fill: var\(--qg-chart-cost\);/u,
    );
  });

  it("uses the shared inactive opacity and keeps the narrow total compact", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.qg-chart\[data-highlight\] \.qg-chart__segment:not\(\[data-highlighted="true"\]\) \{[^}]*opacity: 0\.42;/u,
    );
    expect(styles).not.toMatch(
      /\.qg-model-chart__plot\[data-highlight\] \.qg-chart__segment\[data-highlighted="false"\]/u,
    );
    expect(styles).toMatch(
      /\.qg-model-chart__plot\[data-child-highlight\] \.qg-chart__child-slice:not\(\[data-highlighted="true"\]\) \{[^}]*opacity: 0\.38;/u,
    );
    expect(styles).toMatch(
      /\.qg-model-chart__plot\[data-parent-highlight\] \.qg-chart__child-slice:not\(\[data-highlighted="true"\]\) \{[^}]*opacity: 0\.38;/u,
    );
    expect(styles).toMatch(
      /\.qg-model-tooltip__footer \.qg-totals__label \{[^}]*white-space: normal;[^}]*\}/u,
    );
    expect(styles).toMatch(/\.qg-model-tooltip__total-short \{[^}]*display: none;/u);
    const compactFooter = styles.slice(
      styles.indexOf("@media (max-width: 700px)"),
      styles.indexOf("@media (max-width: 380px)"),
    );
    expect(compactFooter).toContain(".qg-model-tooltip__total-long");
    expect(compactFooter).toContain("clip-path: inset(50%);");
    expect(compactFooter).toContain(".qg-model-tooltip__total-short");
    expect(compactFooter).toContain("display: inline;");
    expect(styles).toMatch(/\.qg-legend__item \{[^}]*font: inherit;/u);
    expect(styles).toMatch(
      /\.qg-legend__item:focus-visible \{[^}]*outline: 1px solid var\(--qg-accent-border\);/u,
    );
  });
});

/**
 * The module's label helpers are exercised through the rendered rows above;
 * this guard keeps the direct import honest for the identity cases that a
 * fixture row cannot express cheaply.
 */
describe("identity labels used by the rendered surfaces", () => {
  it("keeps model and provider nouns distinct", () => {
    expect(identityLabel(unknownIdentity, "model")).toBe("Unknown model");
    expect(identityLabel(unknownIdentity, "provider")).toBe("Unknown provider");
    expect(identityLabel(known("openai"), "provider")).toBe("OpenAI");
  });
});
