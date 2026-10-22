import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionSnapshot, TokenStack } from "../src/contracts/dashboard";
import { buildSessionChartGeometry, buildUsageGeometry } from "../src/ui/chart-geometry";
import { chartIndexAt, createChartInspection } from "../src/ui/chart-inspection";
import { formatDay, formatTimestamp } from "../src/ui/format";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestEvent, TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import {
  costed,
  DAY_MS,
  NOW,
  projectSnapshot,
  sessionSnapshot,
  usage,
} from "./fixtures/gui-ui-fixtures.js";

/**
 * Focused chart/session presentation contract.
 *
 * The shared stacked bars, the derived cache-rate line and the live Session
 * inspection are rendered through the real Solid pipeline; geometry assertions
 * read the exact shipped numbers. Synthetic fixtures only.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const solidWebShimPath = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));

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
let usageChartModule: Record<string, unknown>;
let sessionChartModule: Record<string, unknown>;
let sessionViewModule: Record<string, unknown>;
let projectViewModule: Record<string, unknown>;

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
  usageChartModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/components/usage-chart.tsx"),
  );
  sessionChartModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/components/session-chart.tsx"),
  );
  sessionViewModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/views/session.tsx"),
  );
  projectViewModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/views/project.tsx"),
  );
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

function mountUsage(
  buckets: ReturnType<typeof usage>["buckets"],
  range: "24h" | "7d" | "30d" | "lifetime" = "7d",
): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () =>
      graph.createComponent(usageChartModule.UsageChart, {
        usage: usage(range, buckets),
      }),
    root,
  );
  return { root, dispose };
}

function mountSession(snapshot: SessionSnapshot): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(sessionChartModule.SessionChart, { snapshot }),
    root,
  );
  return { root, dispose };
}

function renderSessionView(snapshot: SessionSnapshot): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(sessionViewModule.SessionView, { snapshot, range: "7d" }),
    root,
  );
  return { root, dispose };
}

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

function bucketOf(startMs: number, tokens: Partial<TokenStack>) {
  return { startMs, endMs: startMs + DAY_MS, tokens: costed(tokens) };
}

function pointerEvent(clientX: number, rect: { left: number; width: number }): TestEvent {
  return {
    clientX,
    currentTarget: {
      getBoundingClientRect: () => rect,
    },
  } as unknown as TestEvent;
}

function sampleCubicPath(
  pathData: string,
  plot: { top: number; bottom: number },
): { min: number; max: number } {
  const commands = pathData.match(/[MC][^MC]*/g) ?? [];
  let current: { x: number; y: number } | undefined;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  const sample = (value: number) => {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  };
  for (const command of commands) {
    const values = command.slice(1).trim().split(/\s+/).map(Number);
    if (command.startsWith("M")) {
      const [x, y] = values;
      current = { x: x as number, y: y as number };
      sample(current.y);
      continue;
    }
    const [_x1, y1, _x2, y2, x, y] = values;
    if (!current) continue;
    const from = current;
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20;
      const inverse = 1 - t;
      const cubicY =
        inverse ** 3 * from.y +
        3 * inverse ** 2 * t * (y1 as number) +
        3 * inverse * t ** 2 * (y2 as number) +
        t ** 3 * (y as number);
      sample(cubicY);
      expect(cubicY).toBeGreaterThanOrEqual(Math.min(from.y, y as number) - 0.01);
      expect(cubicY).toBeLessThanOrEqual(Math.max(from.y, y as number) + 0.01);
    }
    current = { x: x as number, y: y as number };
  }
  expect(minimum).toBeGreaterThanOrEqual(plot.top - 0.01);
  expect(maximum).toBeLessThanOrEqual(plot.bottom + 0.01);
  return { min: minimum, max: maximum };
}

describe("shared stacked usage bars", () => {
  it("renders fixed bottom-to-top category order with the frozen palette", () => {
    const { root, dispose } = mountUsage([
      bucketOf(NOW - DAY_MS, {
        input: 10,
        cacheRead: 20,
        cacheWrite: 30,
        output: 40,
        reasoning: 50,
      }),
    ]);
    try {
      const segments = byClass(root, "rect", "qg-chart__segment");
      expect(segments.map((segment) => segment.props["data-category"])).toEqual([
        "cacheRead",
        "input",
        "reasoning",
        "output",
        "cacheWrite",
      ]);
      expect(segments.map((segment) => segment.props.fill)).toEqual([
        "var(--qg-token-cache-read)",
        "var(--qg-token-input)",
        "var(--qg-token-reasoning)",
        "var(--qg-token-output)",
        "var(--qg-token-cache-write)",
      ]);
      const legend = byClass(root, "li", "qg-legend__item");
      expect(legend.map((item) => graph.textOf(item))).toEqual([
        "Cache Read20",
        "Input10",
        "Reasoning50",
        "Output40",
        "Cache Write30",
      ]);
      // No cumulative boundary/area geometry and no cache-rate legend entry.
      expect(byClass(root, "path", "qg-chart__boundary")).toHaveLength(0);
      expect(root.children.some((child) => graph.textOf(child).includes("right axis"))).toBe(false);
    } finally {
      dispose();
    }
  });

  it("drops and restores a zero series in the same mounted chart, including its active tooltip", async () => {
    const zeroBuckets = [bucketOf(NOW - DAY_MS, { input: 10 })];
    const [buckets, setBuckets] = graph.createSignal(zeroBuckets);
    const [range, setRange] = graph.createSignal<"7d" | "30d">("7d");
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(usageChartModule.UsageChart, {
          get usage() {
            return usage(range(), buckets());
          },
        }),
      root,
    );
    try {
      const categories = () =>
        byClass(root, "rect", "qg-chart__segment").map((segment) => segment.props["data-category"]);
      const legend = () => byClass(root, "li", "qg-legend__item");
      expect(categories()).toEqual(["input"]);
      expect(legend()).toHaveLength(1);
      expect(graph.textOf(root)).not.toContain("Cache Write");

      const hit = byClass(root, "button", "qg-chart__hit")[0];
      expect(hit).toBeDefined();
      listener(hit as TestNode, "onFocus")?.({});
      await Promise.resolve();
      const initialTooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(initialTooltip).toBeDefined();
      expect(graph.textOf(initialTooltip)).not.toContain("Cache Write");

      // Same mounted instance: range and buckets both change. The bars, legend
      // and already-active tooltip must all restore the series.
      setRange("30d");
      setBuckets([bucketOf(NOW - DAY_MS, { input: 10, cacheWrite: 30 })]);
      await Promise.resolve();
      expect(categories()).toEqual(["input", "cacheWrite"]);
      expect(legend()).toHaveLength(2);
      expect(graph.textOf(root)).toContain("Cache Write");
      const restoredTooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(restoredTooltip).toBeDefined();
      expect(graph.textOf(restoredTooltip)).toContain("Cache Write");
      expect(graph.textOf(restoredTooltip)).toContain("30");

      // Same instance again: returning to a zero range removes the series and
      // updates the active tooltip, without remounting the chart.
      setRange("7d");
      setBuckets(zeroBuckets);
      await Promise.resolve();
      expect(categories()).toEqual(["input"]);
      expect(legend()).toHaveLength(1);
      expect(graph.textOf(root)).not.toContain("Cache Write");
      const removedTooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(removedTooltip).toBeDefined();
      expect(graph.textOf(removedTooltip)).not.toContain("Cache Write");
    } finally {
      dispose();
    }
  });

  it("keeps truthful per-bucket stacks and never creates a phantom separator for a zero series", () => {
    const buckets = [
      bucketOf(NOW - 3 * DAY_MS, { input: 10, cacheRead: 10 }),
      bucketOf(NOW - 2 * DAY_MS, { input: 10 }),
      bucketOf(NOW - DAY_MS, { input: 10, cacheRead: 10 }),
    ];
    const geometry = buildUsageGeometry(buckets);
    expect(geometry.bars.map((bar) => bar.segments.length)).toEqual([2, 1, 2]);
    expect(geometry.separators).toHaveLength(2);
    for (const bar of geometry.bars) {
      if (bar.segments.length === 0) continue;
      expect(bar.segments[0]?.y + (bar.segments[0]?.height ?? 0)).toBeCloseTo(
        geometry.plot.bottom,
        10,
      );
      for (let index = 1; index < bar.segments.length; index += 1) {
        const lower = bar.segments[index - 1];
        const upper = bar.segments[index];
        expect(upper?.y + (upper?.height ?? 0)).toBeCloseTo(lower?.y as number, 10);
      }
    }
    const { root, dispose } = mountUsage(buckets);
    try {
      expect(byClass(root, "line", "qg-chart__separator")).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it("keeps dense lifetime bars subpixel and non-overlapping without a width floor or cap", () => {
    const sparse = buildUsageGeometry([bucketOf(NOW - DAY_MS, { input: 10 })]);
    expect(sparse.barWidth).toBeCloseTo(sparse.slot * 0.72, 10);

    const denseBuckets = Array.from({ length: 900 }, (_, index) =>
      bucketOf(NOW + index * DAY_MS, { input: 1 }),
    );
    const dense = buildUsageGeometry(denseBuckets);
    expect(dense.bars).toHaveLength(900);
    expect(dense.slot).toBeLessThan(1);
    expect(dense.barWidth).toBeCloseTo(dense.slot * 0.72, 10);
    expect(dense.barWidth).toBeGreaterThan(0);
    expect(dense.barWidth).toBeLessThan(1);
    for (let index = 0; index < dense.bars.length; index += 1) {
      const bar = dense.bars[index];
      if (!bar) continue;
      expect(bar.width).toBeCloseTo(dense.barWidth, 10);
      expect(bar.x).toBeGreaterThanOrEqual(dense.slotX(index) - 1e-9);
      expect(bar.x + bar.width).toBeLessThanOrEqual(dense.slotX(index) + dense.slot + 1e-9);
      const previous = dense.bars[index - 1];
      if (previous) {
        expect(previous.x + previous.width).toBeLessThanOrEqual(bar.x + 1e-9);
      }
    }
  });

  it("keeps a tiny nonzero segment at its true height without a misleading minimum", () => {
    const geometry = buildUsageGeometry([
      bucketOf(NOW - DAY_MS, { input: 1_000_000, reasoning: 1 }),
    ]);
    const tiny = geometry.bars[0]?.segments.find((segment) => segment.key === "reasoning");
    expect(tiny).toBeDefined();
    expect(tiny?.height).toBeGreaterThan(0);
    expect(tiny?.height).toBeLessThan(0.01);
    expect(geometry.separators).toHaveLength(1);

    const { root, dispose } = mountUsage([
      bucketOf(NOW - DAY_MS, { input: 1_000_000, reasoning: 1 }),
    ]);
    try {
      const rendered = byClass(root, "rect", "qg-chart__segment").find(
        (segment) => segment.props["data-category"] === "reasoning",
      );
      expect(Number(rendered?.props.height)).toBeCloseTo(tiny?.height as number, 10);
      expect(Number(rendered?.props.height)).toBeLessThan(0.01);
      expect(byClass(root, "line", "qg-chart__separator")).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("computes the cache ratio from bucket sums and formats the tooltip to two decimals", () => {
    const ratioBucket = bucketOf(NOW - DAY_MS, { input: 363, cacheRead: 9_637 });
    const { root, dispose } = mountUsage([ratioBucket]);
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0];
      listener(hit as TestNode, "onFocus")?.({});
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      const values = graph
        .elementsNamed(tooltip, "span")
        .filter((node) => node.props.class === "qg-totals__value")
        .map((node) => graph.textOf(node));
      expect(values).toContain("96.37%");
    } finally {
      dispose();
    }

    const nullBucket = bucketOf(NOW - DAY_MS, { output: 10 });
    const nullGeometry = buildUsageGeometry([nullBucket]);
    expect(nullGeometry.cacheRatePoints).toHaveLength(0);
    const nullChart = mountUsage([nullBucket]);
    try {
      const hit = byClass(nullChart.root, "button", "qg-chart__hit")[0];
      listener(hit as TestNode, "onFocus")?.({});
      const tooltip = graph.elementsNamed(nullChart.root, "output")[0] as TestNode;
      const values = graph
        .elementsNamed(tooltip, "span")
        .filter((node) => node.props.class === "qg-totals__value")
        .map((node) => graph.textOf(node));
      expect(values).toContain("—");
    } finally {
      nullChart.dispose();
    }
  });

  it("draws a smooth non-overshooting cache-rate curve with fixed integer ticks", () => {
    const buckets = [
      bucketOf(NOW - 3 * DAY_MS, { input: 90, cacheRead: 10 }),
      bucketOf(NOW - 2 * DAY_MS, { input: 10, cacheRead: 90 }),
      bucketOf(NOW - DAY_MS, { input: 80, cacheRead: 20 }),
    ];
    const geometry = buildUsageGeometry(buckets);
    expect(geometry.cacheRatePath).toContain(" C ");
    expect(geometry.cacheRatePath).not.toMatch(/NaN|Infinity|undefined/);
    sampleCubicPath(geometry.cacheRatePath, geometry.plot);
    expect(geometry.cacheRateTicks.map((tick) => tick.value)).toEqual([0, 25, 50, 75, 100]);

    const { root, dispose } = mountUsage(buckets);
    try {
      expect(graph.textOf(root)).toContain("TOKEN USAGE");
      expect(graph.textOf(root)).toContain("CACHE HIT RATE");
      const rateLabels = byClass(root, "text", "qg-chart__axis-label--rate").map((node) =>
        graph.textOf(node),
      );
      expect(rateLabels).toEqual(["0%", "25%", "50%", "75%", "100%"]);
      // Only input and cache read have activity in this range.
      expect(byClass(root, "li", "qg-legend__item")).toHaveLength(2);
      expect(graph.textOf(root)).not.toContain("right axis");
    } finally {
      dispose();
    }
  });

  it("never adds a Home/Project crosshair or native title", () => {
    const { root, dispose } = mountUsage([bucketOf(NOW - DAY_MS, { input: 10, cacheRead: 5 })]);
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0];
      listener(hit as TestNode, "onFocus")?.({});
      expect(byClass(root, "line", "qg-chart__cursor")).toHaveLength(0);
      expect(graph.elementsNamed(root, "title")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("uses square swatches in the legend and tooltip", () => {
    const { root, dispose } = mountUsage([bucketOf(NOW - DAY_MS, { input: 10, cacheRead: 5 })]);
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0];
      listener(hit as TestNode, "onFocus")?.({});
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      const swatches = byClass(tooltip, "span", "qg-tooltip__swatch").filter(
        (swatch) => !hasClass(swatch, "qg-tooltip__swatch--line"),
      );
      expect(swatches.length).toBeGreaterThanOrEqual(2);
      for (const swatch of swatches) {
        const style = swatch.props.style as Record<string, string>;
        expect(style["--qg-swatch"]).toContain("var(");
      }
      expect(byClass(tooltip, "span", "qg-tooltip__swatch--line")).toHaveLength(1);
      const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
      expect(styles).toMatch(/\.qg-tooltip__swatch\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;/s);
    } finally {
      dispose();
    }
  });
});

describe("session chart and tree presentation", () => {
  it("uses the frozen Session colours, 1-based step ticks and a Steps title", () => {
    const snapshot = sessionSnapshot();
    const { root, dispose } = mountSession(snapshot);
    try {
      expect(graph.textOf(root)).toContain("Steps");
      const stepLabels = byClass(root, "text", "qg-chart__axis-label--step").map((node) =>
        graph.textOf(node),
      );
      expect(stepLabels).toEqual(["1", "2", "3"]);
      expect(stepLabels.every((label) => !label.startsWith("#"))).toBe(true);
      const dayLabel = formatDay(snapshot.steps[0]?.atMs as number, snapshot.timeZone);
      expect(stepLabels).not.toContain(dayLabel);
      expect(byClass(root, "text", "qg-chart__axis-title--steps")).toHaveLength(1);
      expect(byClass(root, "path", "qg-chart__area--context")).toHaveLength(1);
      expect(byClass(root, "path", "qg-chart__area--total")).toHaveLength(1);
      expect(byClass(root, "line", "qg-chart__marker")).toHaveLength(1);
      expect(graph.elementsNamed(root, "title")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("updates the live crosshair and custom tooltip on pointer movement without timers", async () => {
    const snapshot = sessionSnapshot();
    const geometry = buildSessionChartGeometry(snapshot);
    const { root, dispose } = mountSession(snapshot);
    try {
      const surface = byClass(root, "div", "qg-chart__surface")[0];
      expect(surface).toBeDefined();
      const rect = { left: geometry.plot.left, width: geometry.plot.width };
      listener(surface as TestNode, "onPointerMove")?.(pointerEvent(geometry.stepX(1), rect));
      await Promise.resolve();

      let tooltip = graph.elementsNamed(root, "output")[0];
      expect(tooltip).toBeDefined();
      expect(graph.textOf(tooltip as TestNode)).toContain("Step 2");
      expect(graph.textOf(tooltip as TestNode)).toContain(
        formatTimestamp(snapshot.steps[1]?.atMs as number, snapshot.timeZone),
      );
      expect(graph.textOf(tooltip as TestNode)).toContain("Context · focus session");
      expect(graph.textOf(tooltip as TestNode)).toContain("800");
      expect(graph.textOf(tooltip as TestNode)).toContain("Cumulative · session tree");
      expect(graph.textOf(tooltip as TestNode)).toContain("1,500");
      let cursor = byClass(root, "line", "qg-chart__cursor")[0];
      expect(cursor?.props.x1).toBeCloseTo(geometry.stepX(1), 10);

      listener(surface as TestNode, "onPointerMove")?.(pointerEvent(geometry.stepX(2), rect));
      await Promise.resolve();
      tooltip = graph.elementsNamed(root, "output")[0];
      expect(graph.textOf(tooltip as TestNode)).toContain("Step 3");
      expect(graph.textOf(tooltip as TestNode)).toContain("—");
      expect(graph.textOf(tooltip as TestNode)).toContain("2,900");
      cursor = byClass(root, "line", "qg-chart__cursor")[0];
      expect(cursor?.props.x1).toBeCloseTo(geometry.stepX(2), 10);

      listener(surface as TestNode, "onPointerLeave")?.({});
      await Promise.resolve();
      expect(graph.elementsNamed(root, "output")).toHaveLength(0);
      expect(byClass(root, "line", "qg-chart__cursor")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("never renders a cache-rate line, row or line swatch in the Session chart", async () => {
    const snapshot = sessionSnapshot();
    const geometry = buildSessionChartGeometry(snapshot);
    const { root, dispose } = mountSession(snapshot);
    try {
      expect(byClass(root, "path", "qg-chart__rate-line")).toHaveLength(0);
      expect(byClass(root, "text", "qg-chart__axis-label--rate")).toHaveLength(0);
      const surface = byClass(root, "div", "qg-chart__surface")[0];
      expect(surface).toBeDefined();
      listener(
        surface as TestNode,
        "onPointerMove",
      )?.(
        pointerEvent(geometry.stepX(1), {
          left: geometry.plot.left,
          width: geometry.plot.width,
        }),
      );
      await Promise.resolve();
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(tooltip).toBeDefined();
      expect(graph.textOf(tooltip)).not.toContain("Cache rate");
      expect(byClass(tooltip, "span", "qg-tooltip__swatch--line")).toHaveLength(0);
      // The two real series still use ordinary square swatches.
      expect(byClass(tooltip, "span", "qg-tooltip__swatch")).toHaveLength(2);
      expect(graph.textOf(root)).not.toContain("Cache rate");
    } finally {
      dispose();
    }
  });

  it("supports immediate keyboard inspection with Home, End and arrow keys", async () => {
    const snapshot = sessionSnapshot();
    const { root, dispose } = mountSession(snapshot);
    try {
      const surface = byClass(root, "div", "qg-chart__surface")[0];
      expect(surface?.props.role).toBe("slider");
      expect(surface?.props.tabIndex).toBe(0);
      listener(surface as TestNode, "onFocus")?.({});
      await Promise.resolve();
      expect(graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode)).toContain("Step 1");
      expect(byClass(root, "line", "qg-chart__cursor")).toHaveLength(1);

      listener(
        surface as TestNode,
        "onKeyDown",
      )?.({
        key: "ArrowRight",
        preventDefault: () => {},
      });
      await Promise.resolve();
      expect(graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode)).toContain("Step 2");
      expect(surface?.props["aria-valuenow"]).toBe(2);

      listener(surface as TestNode, "onKeyDown")?.({ key: "End", preventDefault: () => {} });
      await Promise.resolve();
      expect(graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode)).toContain("Step 3");

      listener(surface as TestNode, "onKeyDown")?.({ key: "Home", preventDefault: () => {} });
      await Promise.resolve();
      expect(graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode)).toContain("Step 1");

      listener(surface as TestNode, "onBlur")?.({});
      await Promise.resolve();
      expect(graph.elementsNamed(root, "output")).toHaveLength(0);
      expect(byClass(root, "line", "qg-chart__cursor")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("exposes only the live inspection state consumed by both charts", () => {
    const inspection = createChartInspection();
    expect(Object.keys(inspection).sort()).toEqual([
      "active",
      "clearFocus",
      "clearPointer",
      "inspectFocus",
      "inspectPointer",
    ]);
  });

  it("selects the nearest rendered step across the plot", () => {
    expect(chartIndexAt({ x: 0, left: 0, width: 100, count: 3 })).toBe(0);
    expect(chartIndexAt({ x: 24, left: 0, width: 100, count: 3 })).toBe(0);
    expect(chartIndexAt({ x: 26, left: 0, width: 100, count: 3 })).toBe(1);
    expect(chartIndexAt({ x: 74, left: 0, width: 100, count: 3 })).toBe(1);
    expect(chartIndexAt({ x: 76, left: 0, width: 100, count: 3 })).toBe(2);
    expect(chartIndexAt({ x: 120, left: 0, width: 100, count: 3 })).toBe(2);
  });

  it("renders Name | Agent | Steps | Tokens and uses node.agent or a dash", () => {
    const base = sessionSnapshot();
    const rootNode = base.nodes[0] as SessionSnapshot["nodes"][number];
    const childNode = base.nodes[1] as SessionSnapshot["nodes"][number];
    const snapshot = sessionSnapshot({
      nodes: [
        { ...rootNode, agent: "build" },
        { ...childNode, agent: undefined },
      ],
    });
    const { root, dispose } = renderSessionView(snapshot);
    try {
      const html = graph.textOf(root);
      expect(html).toContain("Name");
      expect(html).toContain("Agent");
      expect(html).toContain("Steps");
      expect(html).toContain("Tokens");
      expect(html).not.toContain("Worktree");
      expect(byClass(root, "span", "qg-node__agent")).toHaveLength(2);
      expect(byClass(root, "span", "qg-node__agent").map((node) => graph.textOf(node))).toEqual([
        "build",
        "—",
      ]);
      expect(html).not.toContain("alpha-feature");
    } finally {
      dispose();
    }
  });

  it("hides the tree only for a focused child with no other nodes", () => {
    const base = sessionSnapshot();
    const rootNode = base.nodes[0] as SessionSnapshot["nodes"][number];
    const childNode = base.nodes[1] as SessionSnapshot["nodes"][number];

    const rootOnly = renderSessionView(
      sessionSnapshot({
        nodes: [{ ...rootNode, childIds: [] }],
        steps: base.steps.slice(0, 2),
        compactionMarkers: [],
      }),
    );
    try {
      expect(byClass(rootOnly.root, "div", "qg-nodes")).toHaveLength(1);
      expect(byClass(rootOnly.root, "a", "qg-node")).toHaveLength(1);
    } finally {
      rootOnly.dispose();
    }

    const childOnly = renderSessionView(
      sessionSnapshot({
        focusSessionId: childNode.sessionId,
        nodes: [{ ...childNode }],
        steps: [base.steps[2] as SessionSnapshot["steps"][number]],
        compactionMarkers: [],
        ownSummary: { ...costed({ input: 1200, output: 200 }), stepCount: 1 },
        treeTotals: costed({ input: 1200, output: 200 }),
      }),
    );
    try {
      expect(byClass(childOnly.root, "div", "qg-nodes")).toHaveLength(0);
      expect(graph.textOf(childOnly.root)).not.toContain("Session tree");
    } finally {
      childOnly.dispose();
    }

    const childWithDescendant = renderSessionView(
      sessionSnapshot({
        focusSessionId: childNode.sessionId,
        nodes: [
          { ...childNode, childIds: ["session-grandchild"] },
          {
            ...childNode,
            sessionId: "session-grandchild",
            parentId: childNode.sessionId,
            title: "Grandchild",
            depth: 2,
            childIds: [],
            ownTokens: costed({ input: 10 }),
            subtreeTokens: costed({ input: 10 }),
          },
        ],
        steps: [base.steps[2] as SessionSnapshot["steps"][number]],
        compactionMarkers: [],
        ownSummary: { ...costed({ input: 1200, output: 200 }), stepCount: 1 },
        treeTotals: costed({ input: 1210, output: 200 }),
      }),
    );
    try {
      expect(byClass(childWithDescendant.root, "div", "qg-nodes")).toHaveLength(1);
      expect(byClass(childWithDescendant.root, "a", "qg-node")).toHaveLength(2);
    } finally {
      childWithDescendant.dispose();
    }
  });

  it("keeps the Project one-root list visible", () => {
    const project = projectSnapshot();
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(projectViewModule.ProjectView, {
          snapshot: projectSnapshot({
            roots: [project.roots[0] as (typeof project.roots)[number]],
          }),
          range: "7d",
        }),
      root,
    );
    try {
      expect(byClass(root, "div", "qg-list--roots")).toHaveLength(1);
      expect(byClass(root, "a", "qg-list__row")).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("pins the frozen chart palette and Session colours in the stylesheet", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-token-cache-read: #ec6afe");
    expect(styles).toContain("--qg-token-input: #a583fe");
    expect(styles).toContain("--qg-token-reasoning: #7c85fe");
    expect(styles).toContain("--qg-token-output: #51a1fe");
    expect(styles).toContain("--qg-token-cache-write: #00d2f1");
    expect(styles).toContain("--qg-chart-rate: #ffb900");
    expect(styles).toContain("--qg-chart-context: #51a2ff");
    expect(styles).toContain("--qg-chart-total: #ff8904");
    expect(styles).toContain(".qg-chart__separator");
    expect(styles).toMatch(/\.qg-chart__rate-line\s*\{[^}]*stroke-linecap:\s*round;/s);
    expect(styles).toMatch(/\.qg-chart__rate-line\s*\{[^}]*stroke-linejoin:\s*round;/s);
    // The Session inspection surface must let a phone page scroll vertically.
    expect(styles).toMatch(/\.qg-chart__surface\s*\{[^}]*touch-action:\s*pan-y;/s);
    expect(styles).not.toMatch(/\.qg-chart__surface\s*\{[^}]*touch-action:\s*none;/s);
  });
});
