import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot, SessionSnapshot, TokenStack } from "../src/contracts/dashboard";
import { planRangeBuckets } from "../src/contracts/ranges";
import {
  axisLabelIndexes,
  buildSessionChartGeometry,
  buildUsageGeometry,
} from "../src/ui/chart-geometry";
import { chartIndexAt, createChartInspection } from "../src/ui/chart-inspection";
import { parseSessionSnapshot } from "../src/ui/dashboard-client";
import { formatDay, formatTimestamp, formatTokenCount } from "../src/ui/format";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestEvent, TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import {
  costed,
  DAY_MS,
  homeSnapshot,
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
let homeViewModule: Record<string, unknown>;

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
  homeViewModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/views/home.tsx"));
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

function mountProject(snapshot: ProjectSnapshot): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(projectViewModule.ProjectView, { snapshot, range: "7d" }),
    root,
  );
  return { root, dispose };
}

function mountHome(snapshot: ReturnType<typeof homeSnapshot>): {
  root: TestNode;
  dispose: () => void;
} {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(homeViewModule.HomeView, { snapshot, range: "7d" }),
    root,
  );
  return { root, dispose };
}

function renderSessionView(snapshot: SessionSnapshot): { root: TestNode; dispose: () => void } {
  const decoded = parseSessionSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
    "/api/v1/session/test",
  );
  expect(decoded.nodes).toEqual(snapshot.nodes);
  expect(decoded.ownSummary).toEqual(snapshot.ownSummary);
  expect(decoded.treeTotals).toEqual(snapshot.treeTotals);
  expect(decoded.steps).toEqual(snapshot.steps);
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(sessionViewModule.SessionView, { snapshot: decoded, range: "7d" }),
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

/** The visible heading for one Session axis. */
function sessionAxisTitle(root: TestNode, axis: "context" | "total"): string {
  const node = byClass(root, "text", `qg-chart__axis-title--${axis}`)[0] as TestNode;
  return graph.textOf(node);
}

function listener(node: TestNode, name: string): TestListener | undefined {
  return graph.listenerOf(node, name);
}

function descendants(node: TestNode): TestNode[] {
  const found: TestNode[] = [];
  for (const child of node.children) {
    if (child.kind === "element") {
      found.push(child);
      found.push(...descendants(child));
    }
  }
  return found;
}

/** The complete braces of a CSS block starting at `start`. */
function cssBlockAt(styles: string, start: number): string {
  const open = styles.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    else if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(start, index + 1);
    }
  }
  return "";
}

/** The narrow media block that owns a selector, with nested rules intact. */
function mediaBlockFor(styles: string, marker: string, selector: string): string {
  let index = styles.indexOf(marker);
  while (index !== -1) {
    const block = cssBlockAt(styles, index);
    if (block.includes(selector)) return block;
    index = styles.indexOf(marker, index + marker.length);
  }
  return "";
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "su").exec(source)?.[1] ?? "";
}

/**
 * The canonical chart chrome shared by Analytics, Project and Session.
 * Returns undefined when a surface does not render a complete shell, so one
 * test can prove all three hierarchies are structurally identical.
 */
function chartShellOf(root: TestNode):
  | {
      shell: TestNode;
      head: TestNode;
      title: TestNode;
      summary: TestNode;
      body: TestNode;
      order: (name: string) => number;
    }
  | undefined {
  const shell = byClass(root, "section", "qg-chart-shell")[0];
  if (!shell) return undefined;
  const head = byClass(shell, "header", "qg-chart-shell__head")[0];
  const title = byClass(shell, "span", "qg-chart__title")[0];
  const summary = byClass(shell, "div", "qg-summary")[0];
  const body = byClass(shell, "div", "qg-usage")[0];
  if (!head || !title || !summary || !body) return undefined;
  const sequence = descendants(shell);
  const order = (name: string) =>
    sequence.findIndex((node) =>
      String(node.props.class ?? "")
        .split(" ")
        .includes(name),
    );
  return { shell, head, title, summary, body, order };
}

function bucketOf(startMs: number, tokens: Partial<TokenStack>) {
  return { startMs, endMs: startMs + DAY_MS, tokens: costed(tokens) };
}

/** A representative five-category bar whose parts sum exactly to `total`. */
function fiveCategoryBucket(startMs: number, total: number) {
  const cacheRead = Math.round(total * 0.34);
  const input = Math.round(total * 0.25);
  const reasoning = Math.round(total * 0.08);
  const output = Math.round(total * 0.17);
  return bucketOf(startMs, {
    cacheRead,
    input,
    reasoning,
    output,
    cacheWrite: total - cacheRead - input - reasoning - output,
  });
}

/** Drive a chart's ResizeObserver to a fixed narrow width. */
function stubChartWidth(width: number): { fire: () => void; restore: () => void } {
  let fire: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
  class FakeResizeObserver {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      fire = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    fire: () => fire?.([{ contentRect: { width } }]),
    restore: () => vi.unstubAllGlobals(),
  };
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
      for (const segment of segments) {
        const width = Number(segment.props.width);
        const height = Number(segment.props.height);
        const radius = Math.min(1, width / 2, height / 2);
        expect(Number(segment.props.rx)).toBeCloseTo(radius, 10);
        expect(Number(segment.props.ry)).toBeCloseTo(radius, 10);
      }
      const legend = byClass(root, "button", "qg-legend__item");
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
      const legend = () => byClass(root, "button", "qg-legend__item");
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

  it("keeps truthful per-bucket stacks with external gaps and never creates a phantom gap for a zero series", () => {
    const buckets = [
      bucketOf(NOW - 3 * DAY_MS, { input: 10, cacheRead: 10 }),
      bucketOf(NOW - 2 * DAY_MS, { input: 10 }),
      bucketOf(NOW - DAY_MS, { input: 10, cacheRead: 10 }),
    ];
    const geometry = buildUsageGeometry(buckets);
    expect(geometry.bars.map((bar) => bar.segments.length)).toEqual([2, 1, 2]);
    for (const bar of geometry.bars) {
      if (bar.segments.length === 0) continue;
      expect(bar.segments[0]?.y + (bar.segments[0]?.height ?? 0)).toBeCloseTo(
        geometry.plot.bottom,
        10,
      );
      for (let index = 1; index < bar.segments.length; index += 1) {
        const lower = bar.segments[index - 1];
        const upper = bar.segments[index];
        expect(lower?.y).toBeCloseTo((upper?.y as number) + (upper?.height as number) + 1, 10);
      }
      const coloredHeight = bar.segments.reduce((sum, segment) => sum + segment.height, 0);
      expect(bar.top).toBeCloseTo(
        geometry.plot.bottom - coloredHeight - (bar.segments.length - 1),
        10,
      );
    }
    const { root, dispose } = mountUsage(buckets);
    try {
      expect(byClass(root, "line", "qg-chart__separator")).toHaveLength(0);
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
    expect(tiny?.radius).toBeCloseTo((tiny?.height as number) / 2, 12);

    const { root, dispose } = mountUsage([
      bucketOf(NOW - DAY_MS, { input: 1_000_000, reasoning: 1 }),
    ]);
    try {
      const rendered = byClass(root, "rect", "qg-chart__segment").find(
        (segment) => segment.props["data-category"] === "reasoning",
      );
      expect(Number(rendered?.props.height)).toBeCloseTo(tiny?.height as number, 10);
      expect(Number(rendered?.props.height)).toBeLessThan(0.01);
      expect(Number(rendered?.props.rx)).toBeCloseTo(tiny?.radius as number, 12);
      expect(Number(rendered?.props.ry)).toBeCloseTo(tiny?.radius as number, 12);
      expect(byClass(root, "line", "qg-chart__separator")).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("uses a regular two-day stride for the 20–27 Oct narrow charts", () => {
    const buckets = Array.from({ length: 8 }, (_, index) => ({
      startMs: Date.UTC(2026, 9, 20 + index),
      endMs: Date.UTC(2026, 9, 21 + index),
      tokens: costed({ input: 1 }),
    }));
    for (const width of [375, 357, 342]) {
      const geometry = buildUsageGeometry(buckets, {
        width,
        height: 220,
        padding: { top: 12, right: 12, bottom: 24, left: 48 },
      });
      expect(geometry.labelIndexes).toEqual([0, 2, 4, 6]);
      expect(
        geometry.labelIndexes.map((index) => formatDay(buckets[index]?.startMs as number, "UTC")),
      ).toEqual(["20 Oct", "22 Oct", "24 Oct", "26 Oct"]);
    }
  });

  it("uses a constant label stride with an explicit final-endpoint policy", () => {
    const eightBuckets = Array.from({ length: 8 }, (_, index) =>
      bucketOf(NOW + index * DAY_MS, { input: 1 }),
    );
    const desktop = buildUsageGeometry(eightBuckets);
    expect(desktop.labelIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const narrow = buildUsageGeometry(eightBuckets, {
      width: 375,
      height: 220,
      padding: { top: 12, right: 12, bottom: 24, left: 48 },
    });
    // The final bucket is labelled only when it lands on the stride. Here one
    // more label would create a misleading one-step gap, so it is omitted.
    expect(narrow.labelIndexes).toEqual([0, 2, 4, 6]);
    expect(narrow.labelIndexes.at(-1)).toBe(6);
    expect(7 - (narrow.labelIndexes.at(-1) ?? 0)).toBeLessThan(
      (narrow.labelIndexes[1] as number) - (narrow.labelIndexes[0] as number),
    );
    const narrowGaps = narrow.labelIndexes
      .slice(1)
      .map((value, index) => value - (narrow.labelIndexes[index] as number));
    expect(new Set(narrowGaps)).toEqual(new Set([2]));
    expect(Math.min(...narrowGaps) * narrow.slot).toBeGreaterThanOrEqual(40);

    expect(axisLabelIndexes(8, 100, 40)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(axisLabelIndexes(8, 29, 40)).toEqual([0, 2, 4, 6]);
    // An aligned endpoint is kept; only an unaligned one is omitted.
    expect(axisLabelIndexes(9, 29, 40)).toEqual([0, 2, 4, 6, 8]);

    const hourly = Array.from({ length: 24 }, (_, index) =>
      bucketOf(NOW + index * DAY_MS, { input: 1 }),
    );
    const hourlyNarrow = buildUsageGeometry(hourly, {
      width: 291,
      height: 220,
      padding: { top: 12, right: 12, bottom: 24, left: 48 },
    });
    expect(hourlyNarrow.labelIndexes).toEqual([0, 5, 10, 15, 20]);
    expect(
      hourlyNarrow.labelIndexes
        .slice(1)
        .map((value, index) => value - (hourlyNarrow.labelIndexes[index] as number)),
    ).toEqual([5, 5, 5, 5]);

    const base = sessionSnapshot();
    const firstStep = base.steps[0] as (typeof base.steps)[number];
    const steps = Array.from({ length: 16 }, (_, index) => ({
      ...firstStep,
      messageId: `msg-${index}`,
      atMs: NOW + index * 60_000,
    }));
    const session = sessionSnapshot({ steps });
    const sessionDesktop = buildSessionChartGeometry(session);
    expect(sessionDesktop.labelIndexes).toEqual(Array.from({ length: 16 }, (_, index) => index));

    for (const width of [375, 357, 342]) {
      const sessionNarrow = buildSessionChartGeometry(session, {
        width,
        height: 220,
        padding: { top: 34, right: 56, bottom: 34, left: 52 },
      });
      expect(sessionNarrow.labelIndexes).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
      expect(
        sessionNarrow.labelIndexes
          .slice(1)
          .map((value, index) => value - (sessionNarrow.labelIndexes[index] as number)),
      ).toEqual([2, 2, 2, 2, 2, 2, 2]);
      expect(2 * (sessionNarrow.plot.width / (sessionNarrow.stepCount - 1))).toBeGreaterThanOrEqual(
        24,
      );
    }
  });

  it("shows a range-end caption when the narrow date endpoint is omitted", async () => {
    const buckets = Array.from({ length: 8 }, (_, index) => ({
      startMs: Date.UTC(2026, 9, 20 + index),
      endMs: Date.UTC(2026, 9, 21 + index),
      tokens: costed({ input: 1 }),
    }));
    const desktop = mountUsage(buckets);
    try {
      expect(byClass(desktop.root, "p", "qg-chart__axis-caption")).toHaveLength(0);
    } finally {
      desktop.dispose();
    }

    const width = stubChartWidth(342);
    const { root, dispose } = mountUsage(buckets);
    try {
      width.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const labels = byClass(root, "text", "qg-chart__axis-label")
        .filter((node) => !hasClass(node, "qg-chart__axis-label--rate"))
        .map((node) => graph.textOf(node))
        .filter((label) => label.endsWith("Oct"));
      expect(labels).toEqual(["20 Oct", "22 Oct", "24 Oct", "26 Oct"]);
      const caption = byClass(root, "p", "qg-chart__axis-caption")[0];
      expect(caption).toBeDefined();
      expect(graph.textOf(caption as TestNode)).toBe("Through 27 Oct");
    } finally {
      dispose();
      width.restore();
    }
  });

  it("shows a range-end step caption when the narrow step endpoint is omitted", async () => {
    const base = sessionSnapshot();
    const firstStep = base.steps[0] as (typeof base.steps)[number];
    const steps = Array.from({ length: 16 }, (_, index) => ({
      ...firstStep,
      messageId: `msg-${index}`,
      atMs: NOW + index * 60_000,
    }));
    const width = stubChartWidth(342);
    const { root, dispose } = mountSession(sessionSnapshot({ steps }));
    try {
      width.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        byClass(root, "text", "qg-chart__axis-label--step").map((node) => graph.textOf(node)),
      ).toEqual(["1", "3", "5", "7", "9", "11", "13", "15"]);
      const caption = byClass(root, "p", "qg-chart__axis-caption")[0];
      expect(caption).toBeDefined();
      expect(graph.textOf(caption as TestNode)).toBe("Through step 16");
    } finally {
      dispose();
      width.restore();
    }
  });

  it("shortens the Session axis headings before they collide at 375", async () => {
    const wide = mountSession(sessionSnapshot());
    try {
      expect(sessionAxisTitle(wide.root, "context")).toBe("Context tokens");
      expect(sessionAxisTitle(wide.root, "total")).toBe("Cumulative tokens");
    } finally {
      wide.dispose();
    }

    // The 375 Session chart is 310px wide inside its padded card.
    const width = stubChartWidth(310);
    const { root, dispose } = mountSession(sessionSnapshot());
    try {
      width.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionAxisTitle(root, "context")).toBe("Context");
      expect(sessionAxisTitle(root, "total")).toBe("Cumulative");
      const svg = graph.elementsNamed(root, "svg")[0] as TestNode;
      expect(svg.props["aria-label"]).toContain("focus-session context");
      expect(svg.props["aria-label"]).toContain("cumulative consumption");
    } finally {
      dispose();
      width.restore();
    }

    // At 390 the plot still holds the full pair, so the bounded fix leaves it.
    const width390 = stubChartWidth(325);
    const at390 = mountSession(sessionSnapshot());
    try {
      width390.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionAxisTitle(at390.root, "context")).toBe("Context tokens");
      expect(sessionAxisTitle(at390.root, "total")).toBe("Cumulative tokens");
    } finally {
      at390.dispose();
      width390.restore();
    }
  });

  it("keeps the model tooltip footer whole at 380px and below", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    const narrow = mediaBlockFor(styles, "@media (max-width: 380px)", ".qg-model-tooltip__footer");
    expect(narrow).not.toBe("");
    expect(cssRuleBody(narrow, ".qg-model-tooltip__footer")).toContain("gap: 6px");
    expect(cssRuleBody(narrow, ".qg-model-tooltip__footer .qg-totals__label")).toContain(
      "font-size: 11px",
    );
    const value = cssRuleBody(narrow, ".qg-model-tooltip__footer .qg-totals__value");
    expect(value).toContain("flex: none");
    expect(value).toContain("font-size: 11px");
    expect(value).toContain("white-space: nowrap");
    const badge = cssRuleBody(narrow, ".qg-model-tooltip__footer .qg-partial");
    expect(badge).toContain("flex: none");
    expect(badge).toContain("padding-inline: 4px");
  });

  it("keeps y-axis labels unique for one- to three-token totals", () => {
    for (const total of [1, 2, 3]) {
      const geometry = buildUsageGeometry([bucketOf(NOW - DAY_MS, { input: total })]);
      const labels = geometry.ticks.map((tick) => formatTokenCount(tick.value));
      expect(geometry.ticks.every((tick) => Number.isInteger(tick.value))).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("does not add a full tick step to an exact Session cumulative maximum", () => {
    const base = sessionSnapshot();
    const firstStep = base.steps[0] as (typeof base.steps)[number];
    const exact = sessionSnapshot({
      steps: [{ ...firstStep, contextTokens: 1_000, totalTokens: 8_000 }],
    });
    const geometry = buildSessionChartGeometry(exact);
    expect(geometry.tree.domainMax).toBe(8_000);
    expect(geometry.tree.scaleMax).toBe(8_000);
    expect(geometry.cumulativeTicks.at(-1)?.value).toBe(8_000);
  });

  it("puts Analytics and Project on one shared multisegment nice ceiling", () => {
    for (const total of [5_890, 6_255]) {
      const bucket = fiveCategoryBucket(NOW - DAY_MS, total);
      const geometry = buildUsageGeometry([bucket]);
      expect(geometry.yMax).toBe(total);
      expect(geometry.scaleMax).toBeGreaterThanOrEqual(total);
      expect(geometry.scaleMax).toBe(7_000);
      expect(geometry.ticks.at(-1)?.value).toBe(7_000);
      expect(geometry.bars[0]?.segments).toHaveLength(5);
      // Four external gaps plus a clear band sit above the tallest bar.
      expect(geometry.bars[0]?.top).toBeGreaterThan(geometry.plot.top + 8);

      const narrow = buildUsageGeometry([bucket], {
        width: 375,
        height: 220,
        padding: { top: 12, right: 12, bottom: 24, left: 48 },
      });
      expect(narrow.scaleMax).toBe(7_000);
      expect(narrow.ticks.at(-1)?.value).toBe(7_000);
      expect(narrow.bars[0]?.top).toBeGreaterThan(narrow.plot.top + 8);

      const home = mountHome(homeSnapshot({ usage: usage("7d", [bucket]) }));
      try {
        const labels = byClass(home.root, "text", "qg-chart__axis-label")
          .filter((node) => !hasClass(node, "qg-chart__axis-label--rate"))
          .map((node) => graph.textOf(node));
        expect(labels).toContain("7.0k");
      } finally {
        home.dispose();
      }

      const project = mountProject(projectSnapshot({ usage: usage("7d", [bucket]) }));
      try {
        const labels = byClass(project.root, "text", "qg-chart__axis-label")
          .filter((node) => !hasClass(node, "qg-chart__axis-label--rate"))
          .map((node) => graph.textOf(node));
        expect(labels).toContain("7.0k");
      } finally {
        project.dispose();
      }
    }
  });

  it("moves an exact-multiple usage peak to the next tick so the gap never closes", () => {
    for (const [total, expected] of [
      [6_000, 7_000],
      [7_000, 8_000],
    ] as const) {
      const geometry = buildUsageGeometry([fiveCategoryBucket(NOW - DAY_MS, total)]);
      expect(geometry.yMax).toBe(total);
      expect(geometry.scaleMax).toBe(expected);
      expect(geometry.ticks.at(-1)?.value).toBe(expected);
      expect(geometry.scaleMax).toBeGreaterThan(total);
      expect(geometry.bars[0]?.top).toBeGreaterThan(geometry.plot.top + 8);
    }
  });

  it("keeps the Session cumulative ceiling above its raw maximum", () => {
    const base = sessionSnapshot();
    const firstStep = base.steps[0] as (typeof base.steps)[number];
    const highSession = sessionSnapshot({
      steps: [{ ...firstStep, contextTokens: 1_000, totalTokens: 7_770 }],
    });
    const sessionGeometry = buildSessionChartGeometry(highSession);
    expect(sessionGeometry.tree.domainMax).toBe(7_770);
    expect(sessionGeometry.tree.scaleMax).toBe(8_000);
    expect(sessionGeometry.cumulativeTicks.at(-1)?.value).toBe(8_000);

    const sessionRoot = mountSession(highSession);
    try {
      const totalLabels = byClass(sessionRoot.root, "text", "qg-chart__axis-label--total").map(
        (node) => graph.textOf(node),
      );
      expect(totalLabels.at(-1)).toBe("8.0k");
    } finally {
      sessionRoot.dispose();
    }
  });

  it("draws a smooth non-overshooting cache-rate curve with fixed integer ticks", () => {
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

  it("renders an actual planned same-day lifetime bucket as one date", () => {
    const nowMs = Date.UTC(2026, 9, 27, 12, 30);
    const planned = planRangeBuckets("lifetime", nowMs, Date.UTC(2026, 9, 27, 9, 15), {
      timeZone: "UTC",
    })[0] as { startMs: number; endMs: number };
    expect(planned).toEqual({ startMs: Date.UTC(2026, 9, 27), endMs: nowMs });
    const bucket = { ...planned, tokens: costed({ input: 10 }) };
    const { root, dispose } = mountUsage([bucket], "lifetime");
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      listener(hit, "onFocus")?.({});
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("27 Oct");
      expect(graph.textOf(tooltip)).not.toContain("27 Oct – 27 Oct");
      expect(hit.props["aria-label"]).toContain("27 Oct");
      // The plan still ends at the clipped window edge, not a fabricated midnight.
      expect(planned.endMs).toBe(nowMs);
    } finally {
      dispose();
    }
  });

  it("shows one date in a same-day bucket tooltip without changing the half-open end", () => {
    const startMs = Date.UTC(2026, 9, 27);
    const endMs = startMs + DAY_MS - 1;
    const bucket = { startMs, endMs, tokens: costed({ input: 10 }) };
    const { root, dispose } = mountUsage([bucket]);
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      listener(hit, "onFocus")?.({});
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("27 Oct");
      expect(graph.textOf(tooltip)).not.toContain("27 Oct – 27 Oct");
      expect(hit.props["aria-label"]).toContain("27 Oct");
      // The supplied exclusive end is untouched; a next-day boundary still reads as a range.
      expect(endMs).toBe(startMs + DAY_MS - 1);
    } finally {
      dispose();
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
      expect(byClass(root, "button", "qg-legend__item")).toHaveLength(2);
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

describe("canonical chart shell", () => {
  it("gives Analytics, Project and Session the same head, summary and chart hierarchy", () => {
    const surfaces = [
      {
        name: "Analytics",
        view: mountUsage([bucketOf(NOW - DAY_MS, { input: 10 })]),
        title: "Daily token usage",
      },
      { name: "Project", view: mountProject(projectSnapshot()), title: "Daily token usage" },
      { name: "Session", view: mountSession(sessionSnapshot()), title: "Usage by step" },
    ];
    try {
      for (const surface of surfaces) {
        const shell = chartShellOf(surface.view.root);
        expect(shell, surface.name).toBeDefined();
        if (!shell) continue;
        expect(byClass(shell.shell, "header", "qg-chart-shell__head")).toHaveLength(1);
        expect(byClass(shell.shell, "div", "qg-chart-shell__stat").length).toBeGreaterThan(0);
        expect(byClass(shell.shell, "span", "qg-chart-shell__value").length).toBeGreaterThan(0);
        expect(graph.textOf(shell.title)).toBe(surface.title);
        expect(shell.order("qg-chart-shell__head")).toBeLessThan(shell.order("qg-summary"));
        expect(shell.order("qg-summary")).toBeLessThan(shell.order("qg-usage"));
        expect(byClass(shell.shell, "div", "qg-chart-shell__panel")).toHaveLength(1);
      }
    } finally {
      for (const surface of surfaces) surface.view.dispose();
    }
  });

  it("integrates the Project summary and chart while keeping page context and Sessions", () => {
    const { root, dispose } = mountProject(projectSnapshot());
    try {
      const shell = chartShellOf(root);
      expect(shell).toBeDefined();
      if (!shell) return;
      expect(graph.textOf(shell.summary)).toContain("Sessions");
      expect(graph.textOf(shell.summary)).toContain("4");
      expect(shell.order("qg-summary")).toBeLessThan(shell.order("qg-usage"));
      // Breadcrumbs and worktree stay outside the chart shell.
      expect(byClass(shell.shell, "nav", "qg-breadcrumbs")).toHaveLength(0);
      expect(byClass(root, "nav", "qg-breadcrumbs")).toHaveLength(1);
      expect(graph.textOf(root)).toContain("alpha-main");
      // The chart shell does not take over the Sessions section or its rows.
      const rootsHeadings = graph
        .elementsNamed(root, "h2")
        .filter((node) => node.props.id === "qg-project-roots");
      expect(rootsHeadings).toHaveLength(1);
      expect(byClass(root, "a", "qg-list__row")).toHaveLength(2);
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
      expect(byClass(root, "path", "qg-chart__area--own")).toHaveLength(1);
      expect(byClass(root, "path", "qg-chart__area--total")).toHaveLength(1);
      expect(byClass(root, "path", "qg-chart__line--own")).toHaveLength(1);
      expect(byClass(root, "path", "qg-chart__line--total")).toHaveLength(1);
      expect(byClass(root, "line", "qg-chart__marker")).toHaveLength(1);
      const legend = byClass(root, "div", "qg-legend__item");
      expect(legend).toHaveLength(3);
      expect(
        legend.map((item) => (item.props.style as Record<string, string>)["--qg-swatch"]),
      ).toEqual(["var(--qg-chart-context)", "var(--qg-chart-own)", "var(--qg-chart-total)"]);
      // The tree series carries a non-colour distinction in both the plot and legend.
      expect(byClass(root, "span", "qg-legend__swatch--dashed")).toHaveLength(1);
      expect(graph.elementsNamed(root, "title")).toHaveLength(0);

      const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
      expect(styles).toContain("--qg-chart-own: #ffb900");
      expect(styles).toContain("--qg-chart-total: #ff8904");
      expect(styles).toMatch(/\.qg-chart__line--total\s*\{[^}]*stroke-dasharray:/su);
      expect(styles).not.toMatch(/\.qg-chart__line--own\s*\{[^}]*stroke-dasharray:/su);
      expect(styles).toMatch(/\.qg-legend__swatch--dashed\s*\{/u);
      // Wide rows stay single-line; only the narrow breakpoint reveals names.
      const nodeName = cssRuleBody(styles, ".qg-node__name");
      expect(nodeName).toContain("overflow: hidden");
      expect(nodeName).toContain("text-overflow: ellipsis");
      expect(nodeName).toContain("white-space: nowrap");
      expect(nodeName).toContain("--qg-node-depth");
      expect(nodeName).not.toContain("overflow-wrap: anywhere");
      const narrowTree = mediaBlockFor(styles, "@media (max-width: 640px)", ".qg-node__name");
      expect(narrowTree).not.toBe("");
      const narrowName = cssRuleBody(narrowTree, ".qg-node__name");
      expect(narrowName).toContain("overflow-wrap: break-word");
      expect(narrowName).not.toContain("overflow-wrap: anywhere");
      expect(narrowName).toContain("word-break: normal");
      expect(narrowName).toContain("padding-left: min(calc(var(--qg-node-depth, 0) * 8px), 40px)");
      expect(narrowName).toContain("white-space: normal");
      expect(narrowName).not.toContain("white-space: nowrap");
      expect(narrowName).not.toContain("text-overflow: ellipsis");
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
      expect(graph.textOf(tooltip as TestNode)).toContain("Cumulative · this session");
      expect(graph.textOf(tooltip as TestNode)).toContain("Cumulative · session tree");
      expect(graph.textOf(tooltip as TestNode)).toContain("1,500");
      let cursor = byClass(root, "line", "qg-chart__cursor")[0];
      expect(cursor?.props.x1).toBeCloseTo(geometry.stepX(1), 10);

      listener(surface as TestNode, "onPointerMove")?.(pointerEvent(geometry.stepX(2), rect));
      await Promise.resolve();
      tooltip = graph.elementsNamed(root, "output")[0];
      expect(graph.textOf(tooltip as TestNode)).toContain("Step 3");
      expect(graph.textOf(tooltip as TestNode)).toContain("Context · last known focus");
      expect(graph.textOf(tooltip as TestNode)).toContain("800");
      expect(graph.textOf(tooltip as TestNode)).toContain("Cumulative · this session");
      expect(graph.textOf(tooltip as TestNode)).toContain("1,500");
      expect(graph.textOf(tooltip as TestNode)).toContain("Cumulative · session tree");
      expect(graph.textOf(tooltip as TestNode)).toContain("2,900");
      expect(
        byClass(tooltip as TestNode, "span", "qg-tooltip__swatch").map(
          (swatch) => (swatch.props.style as Record<string, string>)["--qg-swatch"],
        ),
      ).toEqual(["var(--qg-chart-context)", "var(--qg-chart-own)", "var(--qg-chart-total)"]);
      expect(surface?.props["aria-valuetext"]).toContain("Context last known focus 800");
      expect(surface?.props["aria-valuetext"]).toContain("Cumulative this session 1,500");
      expect(surface?.props["aria-valuetext"]).toContain("Cumulative session tree 2,900");
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

  it("keeps full Session tree names in the wrapping row markup", () => {
    const titles = [
      "Synthetic Alpha root",
      "Synthetic Alpha child one",
      "Synthetic Alpha child two",
      "Synthetic Alpha child three",
    ];
    const nodes = titles.map((title, index) => ({
      sessionId: index === 0 ? "session-root-1" : `session-child-${index}`,
      title,
      depth: index,
      childIds: index === 0 ? ["session-child-1", "session-child-2", "session-child-3"] : [],
      ownTokens: costed({ input: 10 }),
      subtreeTokens: costed({ input: 10 }),
      stepCount: 1,
      subtreeNodeCount: 1,
      latestActivityAtMs: NOW - index,
    }));
    const { root, dispose } = renderSessionView(sessionSnapshot({ nodes }));
    try {
      const names = byClass(root, "span", "qg-node__name");
      expect(names.map((node) => graph.textOf(node))).toEqual(titles);
      expect(names.every((node) => node.props.title === graph.textOf(node))).toBe(true);
      expect(
        names.map((node) => (node.props.style as Record<string, string>)["--qg-node-depth"]),
      ).toEqual(["0", "1", "2", "3"]);
      expect(
        names.every(
          (node) => (node.props.style as Record<string, string>)["padding-left"] === undefined,
        ),
      ).toBe(true);
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
      // Context, own-session and session-tree series use ordinary square swatches.
      expect(byClass(tooltip, "span", "qg-tooltip__swatch")).toHaveLength(3);
      expect(graph.textOf(root)).not.toContain("Cache rate");
    } finally {
      dispose();
    }
  });

  it("shows own only for a leaf and both cumulative series for a subsession with descendants", async () => {
    const base = sessionSnapshot();
    const childNode = base.nodes[1] as SessionSnapshot["nodes"][number];
    const childStep = base.steps[2] as SessionSnapshot["steps"][number];

    const leafSnapshot = sessionSnapshot({
      focusSessionId: childNode.sessionId,
      nodes: [{ ...childNode, childIds: [] }],
      steps: [childStep],
      compactionMarkers: [],
      ownSummary: { ...costed({ input: 1200, output: 200 }), stepCount: 1 },
      treeTotals: costed({ input: 1200, output: 200 }),
    });
    const leaf = mountSession(leafSnapshot);
    try {
      expect(byClass(leaf.root, "path", "qg-chart__line--own")).toHaveLength(1);
      expect(byClass(leaf.root, "path", "qg-chart__line--total")).toHaveLength(0);
      expect(byClass(leaf.root, "path", "qg-chart__area--total")).toHaveLength(0);
      expect(byClass(leaf.root, "circle", "qg-chart__point--own")).toHaveLength(1);
      expect(byClass(leaf.root, "circle", "qg-chart__point--total")).toHaveLength(0);
      expect(byClass(leaf.root, "div", "qg-legend__item")).toHaveLength(2);
      expect(graph.textOf(leaf.root)).toContain("Cumulative · this session");
      expect(graph.textOf(leaf.root)).toContain("Total tokens · this session");
      expect(graph.textOf(leaf.root)).not.toContain("Tree total tokens");
      expect(graph.textOf(leaf.root)).not.toContain("Cumulative · session tree");
      expect(graph.textOf(leaf.root)).not.toContain("Cumulative tokens (session tree)");

      const surface = byClass(leaf.root, "div", "qg-chart__surface")[0];
      listener(surface as TestNode, "onFocus")?.({});
      await Promise.resolve();
      const tooltip = graph.elementsNamed(leaf.root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("Context · focus session");
      expect(graph.textOf(tooltip)).toContain("Cumulative · this session");
      expect(graph.textOf(tooltip)).not.toContain("Cumulative · session tree");
    } finally {
      leaf.dispose();
    }

    const grandchildId = "session-grandchild";
    const grandchildNode = {
      ...childNode,
      sessionId: grandchildId,
      parentId: childNode.sessionId,
      title: "Grandchild",
      depth: 2,
      childIds: [],
      ownTokens: costed({ input: 10 }),
      subtreeTokens: costed({ input: 10 }),
    };
    const grandchildStep = {
      ...childStep,
      sessionId: grandchildId,
      messageId: "msg-grandchild",
      atMs: childStep.atMs + 30 * 60_000,
      contextTokens: 999,
      totalTokens: 100,
    };
    const withDescendant = sessionSnapshot({
      focusSessionId: childNode.sessionId,
      nodes: [{ ...childNode, childIds: [grandchildId] }, grandchildNode],
      steps: [childStep, grandchildStep],
      compactionMarkers: [],
      ownSummary: { ...costed({ input: 1200, output: 200 }), stepCount: 1 },
      treeTotals: costed({ input: 1210, output: 200 }),
    });
    const subsession = mountSession(withDescendant);
    try {
      expect(byClass(subsession.root, "path", "qg-chart__line--own")).toHaveLength(1);
      expect(byClass(subsession.root, "path", "qg-chart__line--total")).toHaveLength(1);
      expect(byClass(subsession.root, "path", "qg-chart__area--own")).toHaveLength(1);
      expect(byClass(subsession.root, "path", "qg-chart__area--total")).toHaveLength(1);
      expect(byClass(subsession.root, "div", "qg-legend__item")).toHaveLength(3);
      const surface = byClass(subsession.root, "div", "qg-chart__surface")[0];
      listener(surface as TestNode, "onFocus")?.({});
      listener(surface as TestNode, "onKeyDown")?.({ key: "End", preventDefault: () => {} });
      await Promise.resolve();
      const tooltip = graph.elementsNamed(subsession.root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("Step 2");
      expect(graph.textOf(tooltip)).toContain("Context · last known focus");
      expect(graph.textOf(tooltip)).toContain("1,200");
      expect(graph.textOf(tooltip)).toContain("Cumulative · this session");
      expect(graph.textOf(tooltip)).toContain("1,400");
      expect(graph.textOf(tooltip)).toContain("Cumulative · session tree");
      expect(graph.textOf(tooltip)).toContain("1,500");
      expect(surface?.props["aria-valuetext"]).toContain("Context last known focus 1,200");
    } finally {
      subsession.dispose();
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
      nodes: [{ ...rootNode, agent: "build" }, { ...childNode }],
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

  it("preserves HTTP JSON metadata and hides the tree only for a focused leaf child", () => {
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

  it.each(["agent", "parentId"])("rejects invalid optional HTTP node %s types", (field) => {
    for (const invalid of [null, 42, true, [], {}]) {
      const wire = JSON.parse(JSON.stringify(sessionSnapshot()));
      wire.nodes[0][field] = invalid;
      expect(() => parseSessionSnapshot(wire, "/api/v1/session/test")).toThrow(`nodes[].${field}`);
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
      expect(byClass(root, "div", "qg-list__head").map((node) => graph.textOf(node))).toEqual([
        "NameWorktreeTokens",
      ]);
    } finally {
      dispose();
    }
  });

  it("pins the exact token palette and shared chart chrome in the stylesheet", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-token-cache-read: #51a2ff");
    expect(styles).toContain("--qg-token-input: #a684ff");
    expect(styles).toContain("--qg-token-reasoning: #00d5be");
    expect(styles).toContain("--qg-token-output: #9ae600");
    expect(styles).toContain("--qg-token-cache-write: #00d3f2");
    // The v1.1 palette intentionally swaps Input and Cache Read.
    expect(styles).not.toContain("--qg-token-cache-read: #a684ff");
    expect(styles).not.toContain("--qg-token-input: #51a2ff");
    expect(styles).toContain("--qg-chart-rate: #ffb900");
    expect(styles).toContain("--qg-chart-context: #51a2ff");
    expect(styles).toContain("--qg-chart-own: #ffb900");
    expect(styles).toContain("--qg-chart-total: #ff8904");
    expect(styles).toContain(".qg-chart__segment");
    expect(styles).not.toContain(".qg-chart__separator");
    expect(styles).toMatch(/\.qg-chart__rate-line\s*\{[^}]*stroke-linecap:\s*round;/s);
    expect(styles).toMatch(/\.qg-chart__rate-line\s*\{[^}]*stroke-linejoin:\s*round;/s);
    // One shared shell owns the heading, summary and chart surface.
    expect(styles).toMatch(/\.qg-chart-shell__head\s*\{/);
    expect(styles).toMatch(/\.qg-chart-shell__panel\s*\{/);
    expect(styles).toMatch(/\.qg-chart-shell__summary|\.qg-chart-shell \.qg-summary/);
    // The Session inspection surface must let a phone page scroll vertically.
    expect(styles).toMatch(/\.qg-chart__surface\s*\{[^}]*touch-action:\s*pan-y;/s);
    expect(styles).not.toMatch(/\.qg-chart__surface\s*\{[^}]*touch-action:\s*none;/s);
  });
});
