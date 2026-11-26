import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CostedTokens,
  HomeSnapshot,
  ProjectActivityRow,
  Usage,
} from "../src/contracts/dashboard";
import { buildUsageGeometry, DEFAULT_USAGE_SIZE } from "../src/ui/chart-geometry";
import {
  createProjectChartComposition,
  type ProjectChartComposition,
} from "../src/ui/project-composition";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import { costed, DAY_MS, homeSnapshot, NOW, usage } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Home project composition: the selected project's share inside the shared
 * token-category bars, plus its API-equivalent contribution in the summary and
 * tooltip. The chart's totals, scale and stack geometry never move.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const solidWebShimPath = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));

interface RenderGraph {
  createComponent: (component: unknown, props: unknown) => unknown;
  mount: (code: () => unknown, root: TestNode) => () => void;
  createTestRoot: () => TestNode;
  textOf: (node: TestNode) => string;
  elementsNamed: (node: TestNode, tag: string) => TestNode[];
  listenerOf: (node: TestNode, name: string) => TestListener | undefined;
}

let server: ViteDevServer | undefined;
let graph: RenderGraph;
let usageChartModule: Record<string, unknown>;
let homeViewModule: Record<string, unknown>;

beforeAll(async () => {
  const rendering = await createIsolatedViteServer({
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
  homeViewModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/views/home.tsx"));
  graph = {
    createComponent: renderCore.createComponent,
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

function homeUsage(): Usage {
  return usage("7d", [
    {
      startMs: NOW - 2 * DAY_MS,
      endMs: NOW - DAY_MS,
      tokens: costed({ input: 100, output: 50 }, { apiEquivalentCostUsd: 0.3 }),
    },
    {
      startMs: NOW - DAY_MS,
      endMs: NOW,
      tokens: costed({ input: 70, cacheRead: 30 }, { apiEquivalentCostUsd: 0.1 }),
    },
  ]);
}

function alphaBuckets(): CostedTokens[] {
  return [
    costed({ input: 40, output: 25 }, { apiEquivalentCostUsd: 0.13 }),
    costed({ input: 35, cacheRead: 15 }, { apiEquivalentCostUsd: 0.05 }),
  ];
}

function alphaProject(overrides: Partial<ProjectActivityRow> = {}): ProjectActivityRow {
  return {
    projectId: "project-alpha",
    name: "alpha",
    tokens: costed({ input: 75, output: 25, cacheRead: 15 }, { apiEquivalentCostUsd: 0.18 }),
    rootSessionCount: 2,
    latestActivityAtMs: NOW - 1000,
    buckets: alphaBuckets(),
    ...overrides,
  };
}

function betaProject(): ProjectActivityRow {
  return {
    projectId: "project-beta",
    name: "beta",
    tokens: costed({ input: 20 }, { apiEquivalentCostUsd: 0.02 }),
    rootSessionCount: 1,
    latestActivityAtMs: NOW - 5 * DAY_MS,
    buckets: [costed({ input: 10 }, { apiEquivalentCostUsd: 0.01 }), costed({ input: 10 })],
  };
}

function homeWithComposition(): HomeSnapshot {
  return homeSnapshot({
    usage: homeUsage(),
    projects: [alphaProject(), betaProject()],
  });
}

function compositionFor(chart: Usage, project: ProjectActivityRow): ProjectChartComposition {
  const composition = createProjectChartComposition(chart, project);
  if (composition === undefined) throw new Error("expected an aligned project composition");
  return composition;
}

function mountHome(snapshot: HomeSnapshot): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(homeViewModule.HomeView, { snapshot, range: "7d" }),
    root,
  );
  return { root, dispose };
}

function mountUsage(
  chart: Usage,
  composition?: ProjectChartComposition,
): { root: TestNode; dispose: () => void } {
  const root = graph.createTestRoot();
  const dispose = graph.mount(
    () => graph.createComponent(usageChartModule.UsageChart, { usage: chart, composition }),
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

function rowFor(root: TestNode, name: string): TestNode {
  const row = byClass(root, "a", "qg-list__row").find((node) =>
    graph.textOf(node).startsWith(name),
  );
  if (row === undefined) throw new Error(`missing project row ${name}`);
  return row;
}

function summaryOf(root: TestNode): TestNode {
  return byClass(root, "div", "qg-summary")[0] as TestNode;
}

function overlayRects(root: TestNode): TestNode[] {
  return byClass(root, "rect", "qg-chart__composition");
}

function baseRects(root: TestNode): TestNode[] {
  return byClass(root, "rect", "qg-chart__segment");
}

function baseGeometry(root: TestNode): Record<string, unknown>[] {
  return baseRects(root).map((segment) => ({
    category: segment.props["data-category"],
    x: segment.props.x,
    y: segment.props.y,
    width: segment.props.width,
    height: segment.props.height,
  }));
}

describe("home project composition", () => {
  it("keeps the default chart unchanged and draws no overlay", () => {
    const { root, dispose } = mountHome(homeWithComposition());
    try {
      expect(overlayRects(root)).toHaveLength(0);
      expect(baseRects(root).every((rect) => rect.props["data-composition"] === undefined)).toBe(
        true,
      );
      const rows = byClass(root, "a", "qg-list__row");
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (row) =>
            row.props["data-highlighted"] === undefined && row.props["data-dimmed"] === undefined,
        ),
      ).toBe(true);

      const summary = summaryOf(root);
      expect(byClass(summary, "div", "qg-chart-shell__stat")).toHaveLength(2);
      expect(graph.textOf(summary)).toContain("Total tokens");
      expect(graph.textOf(summary)).toContain("250");
      expect(graph.textOf(summary)).not.toContain("alpha");

      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      expect(String(hit.props["aria-label"])).not.toContain("alpha");
      const table = graph.elementsNamed(root, "table")[0] as TestNode;
      expect(graph.textOf(table)).not.toContain("alpha tokens");
    } finally {
      dispose();
    }
  });

  it("reveals the selected project's share inside each category segment from row pointer", () => {
    const snapshot = homeWithComposition();
    const geometry = buildUsageGeometry(snapshot.usage.buckets, DEFAULT_USAGE_SIZE);
    const { root, dispose } = mountHome(snapshot);
    try {
      const before = baseGeometry(root);
      const alpha = rowFor(root, "alpha");
      graph.listenerOf(alpha, "onPointerEnter")?.({});

      expect(alpha.props["data-highlighted"]).toBe("true");
      expect(rowFor(root, "beta").props["data-dimmed"]).toBe("true");
      expect(baseGeometry(root)).toEqual(before);
      expect(baseRects(root).every((rect) => rect.props["data-composition"] === "base")).toBe(true);

      const overlays = overlayRects(root);
      expect(overlays).toHaveLength(4);
      const input = geometry.bars[0]?.segments.find((segment) => segment.key === "input");
      expect(input).toBeDefined();
      const overlay = overlays.find(
        (rect) => rect.props["data-category"] === "input" && rect.props["data-bucket"] === 0,
      );
      expect(overlay).toBeDefined();
      if (input === undefined || overlay === undefined) return;
      // 40 of the bucket's 100 input tokens: the inset keeps the base height.
      expect(overlay.props.x).toBeCloseTo(input.x, 6);
      expect(overlay.props.width).toBeCloseTo(input.width, 6);
      expect(overlay.props.height).toBeCloseTo(input.height * 0.4, 6);
      expect(Number(overlay.props.y)).toBeCloseTo(input.y + input.height * 0.6, 6);

      const summary = graph.textOf(summaryOf(root));
      expect(summary).toContain("alpha");
      expect(summary).toContain("115 tokens · 46.00%");
      expect(summary).toContain("≈ $0.18");
      expect(summary).toContain("45.00% of estimate");
      expect(summary).toContain("250");
    } finally {
      dispose();
    }
  });

  it("reveals the same composition from row focus and clears it on unrelated focus", () => {
    const snapshot = homeWithComposition();
    const geometry = buildUsageGeometry(snapshot.usage.buckets, DEFAULT_USAGE_SIZE);
    const { root, dispose } = mountHome(snapshot);
    try {
      const alpha = rowFor(root, "alpha");
      const chartHits = byClass(root, "div", "qg-chart__hits")[0] as TestNode;
      graph.listenerOf(alpha, "onFocus")?.({});
      expect(overlayRects(root)).toHaveLength(4);
      expect(alpha.props["data-highlighted"]).toBe("true");

      const input = geometry.bars[0]?.segments.find((segment) => segment.key === "input");
      const overlay = overlayRects(root).find(
        (rect) => rect.props["data-category"] === "input" && rect.props["data-bucket"] === 0,
      );
      expect(input).toBeDefined();
      expect(overlay).toBeDefined();
      if (input !== undefined && overlay !== undefined) {
        expect(overlay.props.height).toBeCloseTo(input.height * 0.4, 6);
      }

      // A handoff into the chart keeps the selection for the chart's handlers.
      graph.listenerOf(alpha, "onBlur")?.({ relatedTarget: chartHits });
      const wrapper = byClass(root, "div", "qg-home-composition")[0] as TestNode;
      graph.listenerOf(wrapper, "onFocusOut")?.({ relatedTarget: chartHits });
      expect(alpha.props["data-highlighted"]).toBeUndefined();
      expect(overlayRects(root)).toHaveLength(4);

      // Leaving to an unrelated control must drop the preview.
      graph.listenerOf(wrapper, "onFocusOut")?.({});
      expect(overlayRects(root)).toHaveLength(0);
      expect(baseRects(root).every((rect) => rect.props["data-composition"] === undefined)).toBe(
        true,
      );
    } finally {
      dispose();
    }
  });

  it("drops a row preview when the pointer leaves for an unrelated control", () => {
    const { root, dispose } = mountHome(homeWithComposition());
    try {
      const alpha = rowFor(root, "alpha");
      const heading = byClass(root, "h2", "qg-section__title")[0] as TestNode;
      graph.listenerOf(alpha, "onPointerEnter")?.({});
      expect(overlayRects(root)).toHaveLength(4);

      graph.listenerOf(alpha, "onPointerLeave")?.({ relatedTarget: heading });
      expect(overlayRects(root)).toHaveLength(0);
      expect(alpha.props["data-highlighted"]).toBeUndefined();

      // Moving into another project row keeps a handoff, then its own enter wins.
      graph.listenerOf(alpha, "onPointerEnter")?.({});
      const beta = rowFor(root, "beta");
      graph.listenerOf(alpha, "onPointerLeave")?.({ relatedTarget: beta });
      expect(overlayRects(root)).toHaveLength(4);
      graph.listenerOf(beta, "onPointerEnter")?.({});
      expect(beta.props["data-highlighted"]).toBe("true");
    } finally {
      dispose();
    }
  });

  it("does not hand a preview to a row without composition", () => {
    const snapshot = homeWithComposition();
    const { root, dispose } = mountHome({
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.projectId === "project-beta" ? { ...project, buckets: undefined } : project,
      ),
    });
    try {
      const alpha = rowFor(root, "alpha");
      const beta = rowFor(root, "beta");
      expect(alpha.props["data-composition-target"]).toBe("row");
      expect(beta.props["data-composition-target"]).toBeUndefined();

      graph.listenerOf(alpha, "onPointerEnter")?.({});
      expect(overlayRects(root)).toHaveLength(4);
      graph.listenerOf(alpha, "onPointerLeave")?.({ relatedTarget: beta });
      expect(overlayRects(root)).toHaveLength(0);

      graph.listenerOf(beta, "onPointerEnter")?.({});
      graph.listenerOf(beta, "onFocus")?.({});
      expect(overlayRects(root)).toHaveLength(0);
      expect(beta.props["data-highlighted"]).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("highlights the matching row from chart bucket pointer and focus", () => {
    const { root, dispose } = mountHome(homeWithComposition());
    try {
      const alpha = rowFor(root, "alpha");
      graph.listenerOf(alpha, "onFocus")?.({});
      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      graph.listenerOf(alpha, "onBlur")?.({ relatedTarget: hit });
      expect(alpha.props["data-highlighted"]).toBeUndefined();
      expect(overlayRects(root)).toHaveLength(4);

      graph.listenerOf(hit, "onPointerEnter")?.({});
      expect(alpha.props["data-highlighted"]).toBe("true");
      expect(rowFor(root, "beta").props["data-dimmed"]).toBe("true");
      expect(overlayRects(root)).toHaveLength(4);

      const wrapper = byClass(root, "div", "qg-home-composition")[0] as TestNode;
      graph.listenerOf(wrapper, "onPointerLeave")?.({});
      expect(overlayRects(root)).toHaveLength(0);

      graph.listenerOf(alpha, "onFocus")?.({});
      graph.listenerOf(alpha, "onBlur")?.({ relatedTarget: hit });
      graph.listenerOf(hit, "onFocus")?.({});
      expect(alpha.props["data-highlighted"]).toBe("true");
      graph.listenerOf(hit, "onBlur")?.({});
      graph.listenerOf(wrapper, "onFocusOut")?.({});
      expect(overlayRects(root)).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("includes the project contribution in bucket labels, the tooltip and the sr-only table", () => {
    const chart = homeUsage();
    const project = alphaProject();
    const { root, dispose } = mountUsage(chart, compositionFor(chart, project));
    try {
      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      expect(hit.props["aria-label"]).toContain("alpha 65 tokens");
      expect(hit.props["aria-label"]).toContain("API-equivalent ≈ $0.13");

      graph.listenerOf(hit, "onFocus")?.({});
      const tooltip = graph.elementsNamed(root, "output")[0] as TestNode;
      expect(graph.textOf(tooltip)).toContain("alpha");
      expect(graph.textOf(tooltip)).toContain("65 · ≈ $0.13");

      const table = graph.elementsNamed(root, "table")[0] as TestNode;
      expect(graph.textOf(table)).toContain("alpha tokens");
      expect(graph.textOf(table)).toContain("65");
      expect(graph.textOf(table)).toContain("150");
    } finally {
      dispose();
    }
  });

  it("shows a partial project estimate without a fabricated cost share", () => {
    const chart = homeUsage();
    const partial = alphaProject({
      tokens: costed(
        { input: 75, output: 25, cacheRead: 15 },
        { apiEquivalentCostUsd: 0.18, unpricedTokens: 7 },
      ),
      buckets: [
        costed({ input: 40, output: 25 }, { apiEquivalentCostUsd: 0.13, unpricedTokens: 7 }),
        costed({ input: 35, cacheRead: 15 }, { apiEquivalentCostUsd: 0.05 }),
      ],
    });
    const { root, dispose } = mountUsage(chart, compositionFor(chart, partial));
    try {
      const summary = graph.textOf(summaryOf(root));
      expect(summary).toContain("Partial estimate");
      expect(summary).toContain("115 tokens · 46.00%");
      expect(summary).not.toContain("of estimate");

      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      graph.listenerOf(hit, "onFocus")?.({});
      const tooltip = graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode);
      expect(tooltip).toContain("Partial estimate");
    } finally {
      dispose();
    }
  });

  it("shows Unpriced without inventing a cost share", () => {
    const chart = homeUsage();
    const unpriced = alphaProject({
      tokens: costed({ input: 75, output: 25, cacheRead: 15 }),
      buckets: [costed({ input: 40, output: 25 }), costed({ input: 35, cacheRead: 15 })],
    });
    const { root, dispose } = mountUsage(chart, compositionFor(chart, unpriced));
    try {
      const summary = graph.textOf(summaryOf(root));
      expect(summary).toContain("Unpriced");
      expect(summary).not.toContain("of estimate");

      const hit = byClass(root, "button", "qg-chart__hit")[0] as TestNode;
      graph.listenerOf(hit, "onFocus")?.({});
      const tooltip = graph.textOf(graph.elementsNamed(root, "output")[0] as TestNode);
      expect(tooltip).toContain("Unpriced");
    } finally {
      dispose();
    }
  });

  it("names an incomplete chart estimate instead of a cost share", () => {
    const chart = usage("7d", [
      {
        startMs: NOW - 2 * DAY_MS,
        endMs: NOW - DAY_MS,
        tokens: costed(
          { input: 100, output: 50 },
          { apiEquivalentCostUsd: 0.3, unpricedTokens: 5 },
        ),
      },
      {
        startMs: NOW - DAY_MS,
        endMs: NOW,
        tokens: costed({ input: 70, cacheRead: 30 }, { apiEquivalentCostUsd: 0.1 }),
      },
    ]);
    const { root, dispose } = mountUsage(chart, compositionFor(chart, alphaProject()));
    try {
      const summary = graph.textOf(summaryOf(root));
      expect(summary).toContain("115 tokens · 46.00%");
      expect(summary).toContain("Cost share unavailable: estimate incomplete.");
      expect(summary).not.toContain("of estimate");
    } finally {
      dispose();
    }
  });

  it("does not call a fully priced free range incomplete", () => {
    const chart = usage("7d", [
      {
        startMs: NOW - 2 * DAY_MS,
        endMs: NOW - DAY_MS,
        tokens: costed({ input: 100 }, { apiEquivalentCostUsd: 0 }),
      },
      {
        startMs: NOW - DAY_MS,
        endMs: NOW,
        tokens: costed({ input: 50 }, { apiEquivalentCostUsd: 0 }),
      },
    ]);
    const free = alphaProject({
      tokens: costed({ input: 75, output: 25, cacheRead: 15 }, { apiEquivalentCostUsd: 0 }),
      buckets: [
        costed({ input: 40, output: 25 }, { apiEquivalentCostUsd: 0 }),
        costed({ input: 35, cacheRead: 15 }, { apiEquivalentCostUsd: 0 }),
      ],
    });
    const { root, dispose } = mountUsage(chart, compositionFor(chart, free));
    try {
      const summary = graph.textOf(summaryOf(root));
      expect(summary).toContain("Free");
      expect(summary).not.toContain("Cost share unavailable");
      expect(summary).not.toContain("estimate incomplete");
    } finally {
      dispose();
    }
  });

  it("keeps older rows aggregate-only when the payload has no buckets", () => {
    const { root, dispose } = mountHome(homeSnapshot());
    try {
      const alpha = rowFor(root, "alpha");
      expect(alpha.props["data-composition-target"]).toBeUndefined();
      graph.listenerOf(alpha, "onPointerEnter")?.({});
      graph.listenerOf(alpha, "onFocus")?.({});
      expect(overlayRects(root)).toHaveLength(0);
      expect(alpha.props["data-highlighted"]).toBeUndefined();
      expect(rowFor(root, "beta").props["data-dimmed"]).toBeUndefined();
      expect(byClass(summaryOf(root), "div", "qg-chart-shell__stat")).toHaveLength(2);
      expect(graph.textOf(summaryOf(root))).not.toContain("alpha");
    } finally {
      dispose();
    }
  });
});
