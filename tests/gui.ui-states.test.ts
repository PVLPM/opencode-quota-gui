import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  HomeSnapshot,
  ProjectSnapshot,
  QuotaCardRow,
  SettingsSnapshot,
  SettingsWriteResult,
  Usage,
} from "../src/contracts/dashboard";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard";
import { buildRowKey, composeRowId } from "../src/contracts/identity";
import { OPENAI_CREDITS_INFO, OPENAI_RESETS_INFO } from "../src/contracts/openai-quota";
import type { RangeKey } from "../src/contracts/ranges";
import { buildSessionChartGeometry, buildUsageGeometry } from "../src/ui/chart-geometry";
import type { Toaster } from "../src/ui/components/toast";
import {
  type DashboardClient,
  DashboardError,
  parseHomeSnapshot,
  parseImportPreview,
  parseProjectSnapshot,
  parseSessionSnapshot,
  parseSettingsSnapshot,
  parseSettingsWriteResult,
} from "../src/ui/dashboard-client";
import {
  formatApiEquivalentCost,
  formatBucketTick,
  formatPercent,
  formatPercentExact,
  formatRunway,
  formatTimestamp,
  formatTimestampMinutes,
  formatTokenCount,
} from "../src/ui/format";
import {
  formatPath,
  parseLocation,
  RANGE_STORAGE_KEY,
  readStoredRange,
  routeShowsRangeSelector,
  routeUsesRange,
  writeStoredRange,
} from "../src/ui/routing";
import {
  applyConflict,
  applyWriteResult,
  dirtyKeys,
  displayPreferencesFromValues,
  fieldErrors,
  initialDraft,
  keyboardMovedProviderOrder,
  orderedProviderIds,
  providerSelection,
  reorderedProviderOrder,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  type SettingsField,
  stringList,
  toPatch,
  validateValue,
  windowSelection,
} from "../src/ui/settings-model";
import {
  contractMismatchMessage,
  describeEmptyActivity,
  describeError,
  describeNoProviders,
  type FetchOutcome,
  isStaleAfterReconnect,
  type LoadState,
  resolveLoadState,
  shouldRefetchOnReconnect,
  visibleCards,
  visibleRows,
} from "../src/ui/view-model";
import type { VisibilityCatalog } from "../src/ui/views/settings";
import { readVisibilityCatalog } from "../src/ui/visibility-catalog";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { SettingsQuerySeam } from "./fixtures/gui-live-settings.js";
import type { TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import {
  costed,
  DAY_MS,
  HOUR_MS,
  homeSnapshot,
  NOW,
  percentRow,
  projectSnapshot,
  providerCard,
  sessionSnapshot,
  settingsSnapshot,
  stack,
  usage,
} from "./fixtures/gui-ui-fixtures.js";

/**
 * Section states, view composition, and settings semantics (design spec §10,
 * §5.4; R14, R15, R33, R35).
 *
 * The views are the real components rendered through this project's own Solid
 * pipeline: a Vite SSR server reusing `SOLID_JSX_SOURCES` from
 * `vite.ui.config.mjs`, so `@opencode/ui` and `@kobalte/core` TSX is compiled
 * by the same Solid include the production build uses. Rendering to a string
 * needs no DOM and no test environment, and the assertions read actual markup:
 * skeletons, card-local errors, empty states, the stale marker, column
 * composition, a11y attributes, and the settings groups. The client build
 * itself — module graph, emitted assets, stylesheet — is covered by
 * `gui.ui-bundle.test.ts` and the browser pass.
 *
 * A string render can only ever see one snapshot, so a second server compiles
 * the same components for the client with `generate: "universal"` and mounts
 * them on the fixture renderer instead of the DOM. That rig drives real payload
 * changes through the real sections and asserts what they render *next*, which
 * is the only way to catch a section that stops following its payload.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;

const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const solidWebShimPath = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));
const liveSectionPath = fileURLToPath(new URL("./fixtures/gui-live-section.ts", import.meta.url));
const liveSettingsPath = fileURLToPath(new URL("./fixtures/gui-live-settings.ts", import.meta.url));

/** The client-compiled rig: the same components, written to a plain object tree. */
interface RenderGraph {
  dashboardFailure: (code: string, status: number, message: string) => unknown;
  app: (props: { client: DashboardClient }) => TestNode;
  chart: (props: { usage: Usage }) => TestNode;
  createSignal: <T>(value: T) => [() => T, (next: T) => void];
  liveSection: (props: { state: () => LoadState<HomeSnapshot>; range: () => RangeKey }) => TestNode;
  liveSettings: (props: {
    client: DashboardClient;
    query: SettingsQuerySeam;
    catalog: () => VisibilityCatalog;
    toaster: Toaster;
    stale: () => boolean;
  }) => TestNode;
  /** A `config-changed` failure from the same module graph as the mounted route. */
  configChangedError: () => unknown;
  mount: (code: () => TestNode, root: TestNode) => () => void;
  createTestRoot: () => TestNode;
  textOf: (node: TestNode) => string;
  elementsNamed: (node: TestNode, tag: string) => TestNode[];
  listenerOf: (node: TestNode, name: string) => TestListener | undefined;
}

let renderServer: ViteDevServer | undefined;
let renderGraph: RenderGraph;

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    // The same Solid include as the client build, compiled for the server so a
    // node test can render the real components; only the target differs.
    plugins: [
      // The public tooltip imports Kobalte's client-only portal at module load.
      // SSR asserts link semantics; the real tooltip gets browser keyboard/hover QA.
      {
        name: "tooltip-ssr-boundary",
        enforce: "pre",
        transform(_code, id) {
          if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx"))
            return "export function Tooltip(props) { return props.children }";
        },
      },
      solid({ include: [...SOLID_JSX_SOURCES], ssr: true }),
    ],
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"],
    },
    // The public package exports TSX source, not executable Node modules.
    // Explicitly keep it inside the Solid/Babel pipeline in both test graphs.
    ssr: { noExternal: ["@opencode/ui"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const web = (await created.ssrLoadModule("solid-js/web")) as {
    renderToString: SsrGraph["renderToString"];
  };
  const core = (await created.ssrLoadModule("solid-js")) as {
    createComponent: SsrGraph["createComponent"];
  };
  graph = {
    renderToString: web.renderToString,
    createComponent: core.createComponent,
    load: (modulePath) => created.ssrLoadModule(modulePath) as Promise<Record<string, unknown>>,
  };

  const rendering = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [
      // The settings route lives in `app.tsx`, which imports the public tooltip
      // and with it Kobalte's client-only portal at module load. The route never
      // renders a tooltip on this rig, so the same boundary the SSR server uses
      // keeps the module graph loadable.
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
        // `universal` writes the tree through the fixture renderer rather than the
        // DOM; the components themselves are the shipped ones.
        solid: { generate: "universal", moduleName: "@gui-test-renderer" },
      }),
    ],
    resolve: {
      alias: [
        { find: "@gui-test-renderer", replacement: rendererPath },
        // The client build of the reactive core. Under the node condition the
        // signals would be the server's inert ones and no section would update.
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "dist", "solid.js"),
        },
        // Kobalte is part of the shipped settings controls; it has to run on the
        // same client runtime as the components around it. Its `Dynamic` gets a
        // DOM-free body from the rig (see the shim), so this swaps the whole
        // module rather than aliasing it directly.
        { find: /^solid-js\/web$/, replacement: solidWebShimPath },
        {
          find: /^solid-js\/store$/,
          replacement: path.join(repoRoot, "node_modules", "solid-js", "store", "dist", "store.js"),
        },
      ],
    },
    // The settings controls pull Kobalte and its Solid helpers through
    // `@opencode/ui`. Those packages live in pnpm's nested store, so the Solid
    // plugin's framework-package crawl cannot see them and would leave them
    // externalized — where they resolve `solid-js` to the server build and fail
    // on client-only APIs.
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
  renderServer = rendering;
  // `ssrLoadModule` hands back dynamic module exports; `satisfies` checks the shape
  // this rig depends on (a missing or renamed export fails here) without asserting.
  const renderCore = await rendering.ssrLoadModule("solid-js");
  const renderer = await rendering.ssrLoadModule(rendererPath);
  const live = await rendering.ssrLoadModule(liveSectionPath);
  const liveSettings = await rendering.ssrLoadModule(liveSettingsPath);
  const chartModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/components/usage-chart.tsx"),
  );
  const appModule = await rendering.ssrLoadModule(path.join(repoRoot, "src/ui/app.tsx"));
  const clientModule = await rendering.ssrLoadModule(
    path.join(repoRoot, "src/ui/dashboard-client.ts"),
  );
  renderGraph = {
    dashboardFailure: (code, status, message) =>
      new clientModule.DashboardError(code, status, message),
    app: (props) => renderCore.createComponent(appModule.App, props),
    chart: (props) => renderCore.createComponent(chartModule.UsageChart, props),
    createSignal: renderCore.createSignal,
    liveSection: live.LiveHomeSection,
    liveSettings: liveSettings.LiveSettingsRoute,
    configChangedError: liveSettings.configChangedError,
    mount: renderer.mountTestTree,
    createTestRoot: renderer.createTestRoot,
    textOf: renderer.textOf,
    elementsNamed: renderer.elementsNamed,
    listenerOf: renderer.listenerOf,
  } satisfies RenderGraph;
}, 60_000);

afterAll(async () => {
  await renderServer?.close();
  await server?.close();
});

/** Renders one exported component with props, returning the SSR markup. */
async function renderView(modulePath: string, exportName: string, props: unknown): Promise<string> {
  const module = await graph.load(modulePath);
  const component = module[exportName];
  if (typeof component !== "function")
    throw new Error(`${modulePath} does not export ${exportName}`);
  return graph.renderToString(() => graph.createComponent(component, props));
}

/** The markup of one section, so a check stays scoped to that section. */
function sectionOf(html: string, sectionId: string): string {
  const start = html.indexOf(`id="${sectionId}"`);
  if (start === -1) return "";
  const next = html.indexOf('class="qg-section"', start);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

/**
 * Solid's SSR output separates adjacent dynamic text with hydration comments, so
 * `Tree <!--$-->2,900<!--/--> tokens` is the same sentence a browser shows as
 * `Tree 2,900 tokens`. Prose assertions read the normalized text.
 */
function text(html: string): string {
  return html.replace(/<!--\$-->|<!--\/-->|<!--#-->/g, "");
}

const noop = async (): Promise<void> => {};

/** Browser seam for the universal renderer: links invoke the shipped click
 * listener and the app, not the harness, performs History API navigation. */
function historyBrowser(
  initialPath: string,
  storage: Pick<Storage, "getItem" | "setItem"> = { getItem: () => null, setItem: () => {} },
) {
  let location = new URL(initialPath, "http://localhost:4144");
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    get location() {
      return location;
    },
    localStorage: storage,
    history: {
      pushState: (_state: unknown, _title: string, path: string) => {
        location = new URL(path, location);
      },
      replaceState: (_state: unknown, _title: string, path: string) => {
        location = new URL(path, location);
      },
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      listeners.set(name, listener);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
    listenerCount: () => listeners.size,
    follow: (href: string) => {
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
      expect(location.pathname + location.search).toBe(href);
    },
  };
}

const preferences = { percentMode: "remaining" as const, showRunway: true, detailed: false };

function homeProps(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: homeSnapshot(),
    preferences,
    hiddenCards: [],
    hiddenRows: [],
    stale: false,
    range: "7d" as const,
    ...overrides,
  };
}

describe("section state machine", () => {
  it("formats labels in the supplied host timezone, never the browser default", () => {
    const midnight = Date.UTC(2026, 9, 19);
    expect(formatBucketTick(midnight, "day", "UTC")).toBe("19 Oct");
    expect(formatBucketTick(midnight, "hour", "UTC")).toBe("00:00");
    // The same instant in a host zone west of UTC is still the previous evening.
    expect(formatBucketTick(midnight, "hour", "America/New_York")).toBe("20:00");
    expect(formatTimestamp(midnight, "UTC")).toBe("19/10/2026, 00:00:00");
    expect(formatTimestamp(midnight, "UTC")).not.toContain("UTC");

    const polled = Date.UTC(2026, 9, 22, 10, 39, 22);
    expect(formatTimestampMinutes(polled, "Europe/Istanbul")).toBe("22/10/2026, 13:39");
    expect(formatTimestampMinutes(polled, "UTC")).toBe("22/10/2026, 10:39");
    expect(formatTimestampMinutes(midnight, "America/New_York")).toBe("18/10/2026, 20:00");
    // The detailed formatter used by Session tooltips keeps its seconds.
    expect(formatTimestamp(polled, "Europe/Istanbul")).toBe("22/10/2026, 13:39:22");
  });

  it("wires full and bare percentage labels for both display modes", async () => {
    const module = await graph.load("/components/quota-card.tsx");
    const valueText = module.rowValueText as (row: unknown, preferences: unknown) => string;
    const row = percentRow({ percentUsed: 38, percentRemaining: 62 });
    for (const percentDisplayMode of ["used", "remaining"]) {
      const full = displayPreferencesFromValues({ percentDisplayMode, percentLabelStyle: "full" });
      const bare = displayPreferencesFromValues({ percentDisplayMode, percentLabelStyle: "bare" });
      expect(valueText(row, full)).toBe(
        `${percentDisplayMode === "used" ? 38 : 62}% ${percentDisplayMode}`,
      );
      expect(valueText(row, bare)).toBe(`${percentDisplayMode === "used" ? 38 : 62}%`);
    }
  });

  it("complements an opposite-only percentage and leaves absent percentages unlabelled", async () => {
    const module = await graph.load("/components/quota-card.tsx");
    const valueText = module.rowValueText as (row: unknown, preferences: unknown) => string;
    const shownPercent = module.rowPercent as (
      row: unknown,
      preferences: unknown,
    ) => number | undefined;
    const remainingOnly = percentRow({ percentRemaining: 30, percentUsed: undefined });
    const usedOnly = percentRow({ percentRemaining: undefined, percentUsed: 20 });
    const neither = percentRow({ percentRemaining: undefined, percentUsed: undefined });
    for (const percentLabelStyle of ["full", "bare"]) {
      for (const percentDisplayMode of ["used", "remaining"]) {
        const preferences = displayPreferencesFromValues({ percentDisplayMode, percentLabelStyle });
        const suffix = percentLabelStyle === "full" ? ` ${percentDisplayMode}` : "";
        expect(shownPercent(remainingOnly, preferences)).toBe(
          percentDisplayMode === "used" ? 70 : 30,
        );
        expect(valueText(remainingOnly, preferences)).toBe(
          `${percentDisplayMode === "used" ? 70 : 30}%${suffix}`,
        );
        expect(shownPercent(usedOnly, preferences)).toBe(percentDisplayMode === "used" ? 20 : 80);
        expect(valueText(usedOnly, preferences)).toBe(
          `${percentDisplayMode === "used" ? 20 : 80}%${suffix}`,
        );
        expect(shownPercent(neither, preferences)).toBeUndefined();
        expect(valueText(neither, preferences)).toBe("—");
      }
    }
  });

  it("rounds currency quantities to two decimals and leaves other units exact", async () => {
    const module = await graph.load("/components/quota-card.tsx");
    const valueText = module.rowValueText as (row: unknown, preferences: unknown) => string;
    const quantityRow = (decimal: string, unit: unknown) => ({
      kind: "quantity",
      quantity: { decimal, unit },
    });

    expect(
      valueText(quantityRow("1.62481239", { kind: "currency", code: "USD" }), preferences),
    ).toBe("1.62 USD");
    expect(valueText(quantityRow("0", { kind: "currency", code: "USD" }), preferences)).toBe(
      "0.00 USD",
    );
    expect(valueText(quantityRow("-0.004", { kind: "currency", code: "USD" }), preferences)).toBe(
      "0.00 USD",
    );
    expect(valueText(quantityRow("-1.625", { kind: "currency", code: "USD" }), preferences)).toBe(
      "-1.63 USD",
    );
    expect(
      valueText(quantityRow("1.62481239", { kind: "count", unit: "token" }), preferences),
    ).toBe("1.62481239 token");
  });

  it("labels legend inspection without exposing toggle semantics", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: homeSnapshot().usage,
    });
    expect(html).toContain('aria-label="Highlight Input"');
    expect(html).not.toContain("aria-pressed");
  });
  it("shows a skeleton only on the first load", () => {
    expect(resolveLoadState<number>({ loading: true })).toEqual({ kind: "skeleton" });
    expect(resolveLoadState<number>({ loading: false })).toEqual({ kind: "skeleton" });
  });

  it("keeps the previous payload with a stale marker instead of flashing a skeleton", () => {
    const failure = new DashboardError(
      "internal",
      500,
      "The dashboard could not read the quota log.",
    );
    expect(resolveLoadState<number>({ data: 42, error: failure, loading: false })).toEqual({
      kind: "ready",
      data: 42,
      stale: true,
      refreshing: false,
    });
    expect(resolveLoadState<number>({ data: 42, loading: true })).toEqual({
      kind: "ready",
      data: 42,
      stale: false,
      refreshing: true,
    });
  });

  it("makes a failure without a previous payload a retryable, section-local error", () => {
    const failure = new DashboardError(
      "internal",
      500,
      "The dashboard could not read the quota log.",
    );
    expect(resolveLoadState<number>({ loading: false, error: failure })).toEqual({
      kind: "error",
      message: "The dashboard could not read the quota log.",
      retryable: true,
    });
  });

  it("rejects a stale server contract before treating it as compatible", () => {
    expect(describeError(new Error("ENOENT: C:\\Users\\local\\secret.json"))).toBe(
      "The dashboard server did not answer. Check that the local dashboard is still running.",
    );
    expect(contractMismatchMessage(DASHBOARD_CONTRACT_VERSION)).toBeUndefined();
    // A newly rebuilt UI can meet an older, still-running server: same /api/v1
    // path, older payload revision. It must be rejected before any payload is
    // treated as compatible, and a browser refresh alone cannot repair it.
    const oldServer = DASHBOARD_CONTRACT_VERSION - 1;
    const mismatch = contractMismatchMessage(oldServer);
    expect(mismatch).toContain("Restart the dashboard/OpenCode");
    expect(mismatch).toContain("reload the page");
    expect(mismatch).not.toContain("Reload the page to get a matching build");
    expect(resolveLoadState<number>({ data: 1, loading: false }, mismatch)).toEqual({
      kind: "reload-required",
      message: mismatch,
    });
  });

  it("explains the empty states explicitly", () => {
    expect(describeNoProviders("auto")).toContain("No provider accounts are available");
    expect(describeNoProviders([])).toContain("No providers are enabled");
    expect(describeNoProviders(["anthropic"])).toContain("reported no accounts");
    expect(describeEmptyActivity(false)).toContain("No activity in this range");
    expect(describeEmptyActivity(true)).toContain("No tokens were recorded");
  });

  it("hides cards by stable card id or provider id, and rows by stable id only", () => {
    const cards = [
      providerCard(),
      providerCard({
        cardId: "opencode#hash" as never,
        providerId: "opencode",
        providerLabel: "OpenCode Zen",
      }),
    ];
    expect(visibleCards(cards, [])).toEqual(cards);
    // The provider-level key hides that provider's whole card group.
    expect(visibleCards(cards, ["opencode"])).toEqual([cards[0]]);
    expect(visibleCards(cards, ["synthetic-provider", "opencode"])).toEqual([]);
    // A legacy card-level key still hides exactly its own card.
    expect(visibleCards(cards, ["opencode#hash"])).toEqual([cards[0]]);
    const rows = [percentRow(), percentRow({ rowId: "provider-1#cardhash#aggregate" as never })];
    expect(visibleRows(rows, ["provider-1#cardhash#aggregate"]).map((row) => row.rowId)).toEqual([
      "provider-1#cardhash#window:five_hour",
    ]);
  });

  it("renders a skeleton as a status region", async () => {
    const html = await renderView("/components/states.tsx", "Skeleton", {
      label: "Loading quota",
      lines: 3,
    });
    expect(html).toContain("<output");
    expect(html).toContain('class="qg-skeleton"');
    expect(html).toContain('aria-label="Loading quota"');
    // One shimmering line per requested row, announced as a single region.
    expect(html.match(/qg-skeleton__line/g)?.length).toBe(3);
  });
});

describe("home view composition", () => {
  it("does not collapse separate accounts when their provider names match", async () => {
    // Card ids are opaque server-side hashes (`provider#hash`); two accounts
    // under the same provider name must keep distinct ids and distinct cards.
    const cards = ["Synthetic team one", "Synthetic team two"].map((accountLabel, index) =>
      providerCard({ cardId: `synthetic-provider#${index + 1}` as never, accountLabel }),
    );
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({ providers: { cards, enabledProviders: "auto", polledAtMs: NOW } }),
      }),
    );
    expect(html.match(/class="qg-card"/g)).toHaveLength(2);
    expect(text(html)).toContain("Synthetic team one");
    expect(text(html)).toContain("Synthetic team two");
  });
  it("keeps provider and subscription/account in one inline hierarchy", async () => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({ accountLabel: "[Synthetic Provider] (Standard)" }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    const identity = text(html).slice(
      html.indexOf('class="qg-card__identity"'),
      html.indexOf("</header>"),
    );
    expect(identity).toContain('class="qg-card__provider">Synthetic Provider</span>');
    expect(identity).toContain(
      'class="qg-card__account"><span aria-hidden="true">· </span>Standard</span>',
    );
    expect(identity).not.toContain("[Synthetic Provider]");
    expect(identity).not.toContain("<br");
  });

  it.each([
    "[Other Provider] (Standard)",
    "Standard · Synthetic team one",
    "[Synthetic Provider] (Standard) · Synthetic team two",
    "[Synthetic Provider] (Team (West))",
  ])("preserves distinguishing account text: %s", async (accountLabel) => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({ accountLabel }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    expect(text(html)).toContain(accountLabel);
  });
  it.each([0, 0.1, 25.125, 100])("renders an honest used-mode bar at %s percent", async (used) => {
    const html = await renderView("/components/quota-card.tsx", "QuotaBar", {
      label: "Synthetic window",
      displayPercent: used,
      displayMode: "used",
    });
    expect(html).toContain("<meter");
    expect(html).toContain('min="0"');
    expect(html).toContain('max="100"');
    expect(html).toContain(`value="${used}"`);
    expect(html).toContain(`aria-valuetext="${used}% used"`);
    expect(html).toContain(`--qg-used-position:${used}%`);
    expect(html).not.toContain("qg-row__bar-gap");
  });

  it.each([
    0, 0.1, 25.125, 100,
  ])("paints the displayed remaining percent without inverting twice at %s", async (remaining) => {
    const html = await renderView("/components/quota-card.tsx", "QuotaBar", {
      label: "Synthetic window",
      displayPercent: remaining,
      displayMode: "remaining",
    });
    expect(html).toContain(`value="${remaining}"`);
    expect(html).toContain(`aria-valuetext="${remaining}% remaining"`);
    expect(html).toContain(`--qg-used-position:${remaining}%`);
  });

  it("keeps the bar on the displayed quota while severity uses true used quota", async () => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({ rows: [percentRow({ percentUsed: 25, percentRemaining: 75 })] }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    // Remaining mode shows 75% and fills 75% of the independent segment pair.
    expect(text(html)).toContain("75% remaining");
    expect(html).toContain('value="75"');
    expect(html).toContain('data-mode="remaining"');
    expect(html).toContain("--qg-used-position:75%");
    // 25% used is healthy even though the painted fraction is large.
    expect(html).toContain('data-severity="healthy"');
  });

  it("maps complementary used/remaining values to the same exhaustion band", async () => {
    // 5% remaining == 95% used: critical in either display mode.
    for (const percentDisplayMode of ["used", "remaining"] as const) {
      const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
        card: providerCard({ rows: [percentRow({ percentUsed: 95, percentRemaining: 5 })] }),
        preferences: displayPreferencesFromValues({ percentDisplayMode }),
        hiddenRows: [],
        stale: false,
        timeZone: "UTC",
      });
      expect(html).toContain('data-severity="critical"');
      expect(html).toContain(percentDisplayMode === "used" ? 'value="95"' : 'value="5"');
    }
  });

  it.each([
    [90, "critical"],
    [89.9, "warning"],
    [70, "warning"],
    [69.9, "healthy"],
    [100, "critical"],
    [0, "healthy"],
  ])("bands %s true used percent as %s", async (percentUsed, severity) => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({
        rows: [percentRow({ percentUsed, percentRemaining: 100 - percentUsed })],
      }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    expect(html).toContain(`data-severity="${severity}"`);
  });

  it.each([
    [10, "critical"],
    [10.1, "warning"],
    [30, "warning"],
    [30.1, "healthy"],
  ])("bands %s true remaining percent as %s from the used complement", async (percentRemaining, severity) => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({
        rows: [percentRow({ percentUsed: undefined, percentRemaining })],
      }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    expect(html).toContain(`data-severity="${severity}"`);
  });

  it("shows the row info affordance only when the row carries info, and keeps the label", async () => {
    const html = await renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({
        rows: [
          percentRow({
            label: "Monthly spend",
            info: "Workspace monthly spend (includes Go API equivalent)",
          }),
          percentRow({
            rowId: "provider-1#cardhash#window:weekly" as never,
            label: "Weekly quota",
          }),
        ],
      }),
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    });
    // Only the row that carries `info` gets the affordance; the other stays bare.
    expect(html.match(/class="qg-row__info"/g)).toHaveLength(1);
    // The affordance is an accessible control that names what it explains.
    expect(text(html)).toContain("More information about Monthly spend");
    expect(text(html)).not.toContain("More information about Weekly quota");
    // The label text is untouched: the sentence travels in the tooltip value.
    expect(html).toContain('class="qg-row__label">Monthly spend</span>');
    expect(html).not.toContain('class="qg-row__label">Monthly spend (includes');
  });

  it("separates Quota from Analytics and keeps usage before projects", async () => {
    const html = await renderView("/views/home.tsx", "HomeView", homeProps());
    const quota = html.indexOf('id="qg-home-quota"');
    const usageSection = html.indexOf('id="qg-home-usage"');
    const projects = html.indexOf('id="qg-home-projects"');
    expect(quota).toBe(-1);
    expect(usageSection).toBeGreaterThan(quota);
    expect(projects).toBeGreaterThan(usageSection);
    const quotaHtml = await renderView("/views/home.tsx", "QuotaView", homeProps());
    expect(quotaHtml).toContain('id="qg-home-quota"');
    expect(quotaHtml).not.toContain('id="qg-home-usage"');
    expect(quotaHtml).not.toContain("Observed");
    expect(quotaHtml).toContain("Polled");
  });

  it("keeps seconds out of the Quota Polled footer while preserving the host-zone date and minute", async () => {
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: {
          ...homeSnapshot({
            providers: {
              cards: [],
              enabledProviders: "auto",
              polledAtMs: Date.UTC(2026, 9, 22, 10, 39, 22),
            },
          }),
          timeZone: "UTC",
        },
      }),
    );
    const rendered = text(html);
    expect(rendered).toContain("Polled 22/10/2026, 10:39");
    expect(rendered).not.toContain("10:39:22");
  });

  it("keeps a provider failure card-local and names it provider-level when no account is known", async () => {
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({
          providers: {
            cards: [
              providerCard({
                accountLabel: undefined,
                labelSource: "provider",
                rows: [],
                errors: [
                  {
                    label: "Quota request failed",
                    message: "Provider request failed; check upstream quota diagnostics.",
                  },
                ],
              }),
            ],
            enabledProviders: ["synthetic-provider"],
            polledAtMs: NOW,
          },
        }),
      }),
    );
    expect(html).toContain("Provider-level error");
    expect(html).toContain("Provider request failed; check upstream quota diagnostics.");
    expect(html).toContain('data-level="provider"');
  });

  it("attributes a failure to its account when the card knows one", async () => {
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({
          providers: {
            cards: [
              providerCard({
                errors: [{ label: "Token expired", message: "Reconnect the account." }],
              }),
            ],
            enabledProviders: "auto",
            polledAtMs: NOW,
          },
        }),
      }),
    );
    expect(html).not.toContain("Provider-level error");
    expect(html).toContain("Token expired");
    expect(html).toContain('data-level="account"');
  });

  it("states the empty provider and empty activity cases explicitly", async () => {
    const emptyProviders = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({ providers: { cards: [], enabledProviders: [], polledAtMs: NOW } }),
      }),
    );
    expect(emptyProviders).toContain("No providers are enabled.");
    expect(emptyProviders).not.toContain("qg-card-grid");

    const emptyRange = await renderView(
      "/views/home.tsx",
      "HomeView",
      homeProps({
        snapshot: homeSnapshot({ usage: usage("24h", []), projects: [] }),
        range: "24h",
      }),
    );
    expect(emptyRange).toContain("No activity in this range");
  });

  it("reports every card as hidden rather than pretending there are none", async () => {
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({ hiddenCards: ["provider-1#cardhash"] }),
    );
    expect(html).toContain("Every provider card is hidden");
    expect(html).not.toContain("qg-card-grid");
  });

  it("a provider-level hidden-card key hides that provider on Home while others stay", async () => {
    const balanceRowId = composeRowId(
      "opencode#hash" as never,
      "component:current_balance" as never,
    );
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({
          providers: {
            cards: [
              providerCard(),
              providerCard({
                cardId: "opencode#hash" as never,
                providerId: "opencode",
                providerLabel: "OpenCode Zen",
                rows: [
                  percentRow({
                    rowId: composeRowId("opencode#hash" as never, "window:five_hour" as never),
                  }),
                  percentRow({
                    rowId: balanceRowId,
                    label: "Current balance",
                    kind: "value",
                    value: "12.50 USD",
                  }),
                ],
              }),
            ],
            enabledProviders: "auto",
            polledAtMs: NOW,
          },
        }),
        // The provider eye's providerId key, saved by Settings.
        hiddenCards: ["synthetic-provider"],
        // Row hiding keeps filtering within the provider that stays visible.
        hiddenRows: [composeRowId("opencode#hash" as never, "window:five_hour" as never)],
      }),
    );
    // The whole OpenCode Zen provider is hidden by its provider id; the other
    // provider's card remains, and a hidden row still filters inside it.
    expect(html).not.toContain("Synthetic Provider");
    expect(html).toContain("OpenCode Zen");
    expect(html).not.toContain("Five hour window");
    expect(html).toContain("Current balance");
  });

  it("omits a hidden row entirely and keeps the unhide path in Settings", async () => {
    const balanceRowId = composeRowId(
      providerCard().cardId,
      buildRowKey({ kind: "component", component: "current_balance" }),
    );
    const twoRows = [
      percentRow(),
      percentRow({
        rowId: balanceRowId,
        label: "Current balance",
        kind: "value",
        value: "12.50 USD",
      }),
    ];
    const hiddenRowId = "provider-1#cardhash#window:five_hour";
    const html = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({
          providers: {
            cards: [providerCard({ rows: twoRows })],
            enabledProviders: "auto",
            polledAtMs: NOW,
          },
        }),
        hiddenRows: [hiddenRowId],
      }),
    );
    // The hidden row is gone: no label, no value, and no in-place "Show … row"
    // toggle — Settings → Visibility is the one unhide path.
    expect(html).not.toContain("Five hour window");
    expect(html).not.toContain('aria-label="Show the Five hour window row"');
    expect(html).not.toContain('aria-label="Hide the Five hour window row"');
    // Home is read-only; visibility is managed exclusively in Settings.
    expect(html).toContain("Current balance");
    expect(html).not.toContain('aria-label="Hide the Current balance row"');
    expect(html).not.toContain('aria-label="Hide the Synthetic Provider card"');
    expect(html.match(/aria-pressed="true"/g)).toBeNull();
    expect(html).not.toContain('class="qg-eye"');
  });

  it("says so when every row on a card is hidden, instead of claiming it has none", async () => {
    const allHidden = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        hiddenRows: ["provider-1#cardhash#window:five_hour"],
      }),
    );
    expect(allHidden).toContain("Every row on this card is hidden");
    expect(allHidden).toContain("Settings → Visibility");
    expect(allHidden).not.toContain("Five hour window");
    // The card itself is not hidden, so it stays on the page.
    expect(allHidden).toContain("qg-card-grid");
    expect(allHidden).not.toContain("qg-card__rows");
    expect(allHidden).not.toContain("No quota rows are reported for this account.");

    const genuinelyEmpty = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({
        snapshot: homeSnapshot({
          providers: {
            cards: [providerCard({ rows: [] })],
            enabledProviders: "auto",
            polledAtMs: NOW,
          },
        }),
      }),
    );
    expect(genuinelyEmpty).toContain("No quota rows are reported for this account.");
    expect(genuinelyEmpty).not.toContain("Every row on this card is hidden");
  });

  it("shows the percent the user asked for, from the numbers the row carries", async () => {
    const snapshot = homeSnapshot({
      providers: { cards: [providerCard()], enabledProviders: "auto", polledAtMs: NOW },
    });
    const remaining = await renderView("/views/home.tsx", "QuotaView", homeProps({ snapshot }));
    expect(remaining).toContain('class="qg-row__value">62% remaining</span>');
    expect(remaining).not.toContain('class="qg-row__value">38%');
    expect(remaining).toContain('aria-valuetext="62% remaining"');
    expect(remaining).not.toContain('aria-valuetext="38%');
    expect(text(remaining)).toContain("Runs out");
    const used = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({ snapshot, preferences: { ...preferences, percentMode: "used" } }),
    );
    expect(used).toContain('class="qg-row__value">38% used</span>');
    expect(used).toContain('aria-valuetext="38% used"');
  });

  it("reveals detail rows only for the detailed accounting setting, and keeps details collapsed", async () => {
    const snapshot = homeSnapshot({
      providers: {
        cards: [
          providerCard({
            rows: [
              percentRow({
                detailRows: [
                  { label: "Requests", value: "12" },
                  { label: "Credits", value: "3.5" },
                ],
              }),
            ],
            details: [{ label: "Plan", value: "synthetic" }],
          }),
        ],
        enabledProviders: "auto",
        polledAtMs: NOW,
      },
    });
    const summary = await renderView("/views/home.tsx", "QuotaView", homeProps({ snapshot }));
    expect(summary).not.toContain("Requests");
    const detailed = await renderView(
      "/views/home.tsx",
      "QuotaView",
      homeProps({ snapshot, preferences: { ...preferences, detailed: true } }),
    );
    expect(detailed).toContain("Requests");
    expect(detailed).toContain("Credits");
    // Safe field details stay inside a collapsed disclosure.
    expect(detailed).toContain("<details");
    expect(summary).toContain("<details");
    expect(summary).toContain("Plan");
  });

  it("keeps stale card numbers without duplicating chrome status", async () => {
    const html = await renderView("/views/home.tsx", "QuotaView", homeProps({ stale: true }));
    expect(html).not.toContain('data-stale="true"');
    expect(html).toContain("Five hour window");
  });

  it("gives projects exactly two columns, in the server's order", async () => {
    const html = await renderView("/views/home.tsx", "HomeView", homeProps());
    const projects = sectionOf(html, "qg-home-projects");
    expect(projects).toContain("qg-list__title");
    expect(projects).toContain("qg-list__tokens");
    expect(projects).not.toContain("qg-list__worktree");
    expect(projects).not.toContain("USD");
    expect(projects.indexOf("alpha")).toBeLessThan(projects.indexOf("beta"));
    expect(projects).toContain('href="/project/project-alpha?range=7d"');
  });
});

describe("usage chart", () => {
  it.each([
    "24h",
    "7d",
    "30d",
    "lifetime",
  ] as const)("omits an all-zero %s range from bars, legend and tooltip", async (range) => {
    const buckets = [{ startMs: NOW - HOUR_MS, endMs: NOW, tokens: costed({}) }];
    const geometry = buildUsageGeometry(buckets);
    expect(geometry.visibleCategories).toEqual([]);
    expect(geometry.bars[0]?.segments).toEqual([]);
    expect(geometry.bars[0]?.top).toBe(geometry.plot.bottom);
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage(range, buckets),
    });
    expect(html).not.toContain("qg-chart__segment");
    expect(html).not.toContain("qg-chart__separator");
    expect(html).not.toContain("Highlight Cache Write");
    expect(html).not.toContain("Highlight Cache Read");
    // The bucket is still inspectable; only the visible categories disappear.
    expect(html).toContain("total 0 tokens");
    expect(html).toContain("cache rate —");
    expect(html).not.toContain("Input 0");
  });

  it.each([
    "24h",
    "7d",
    "30d",
    "lifetime",
  ] as const)("keeps the tiny nonzero inspection transient in %s", async (range) => {
    const root = renderGraph.createTestRoot();
    const snapshot = usage(range, [
      { startMs: NOW - HOUR_MS, endMs: NOW, tokens: costed({ input: 1000000, reasoning: 1 }) },
    ]);
    const dispose = renderGraph.mount(() => renderGraph.chart({ usage: snapshot }), root);
    const segments = () =>
      renderGraph
        .elementsNamed(root, "rect")
        .filter((node) => node.props.class === "qg-chart__segment");
    const buttons = renderGraph.elementsNamed(root, "button");
    const hit = buttons.find((node) => node.props.class === "qg-chart__hit");
    const legend = renderGraph
      .elementsNamed(root, "li")
      .find((node) => node.props["aria-label"] === "Highlight Reasoning");
    expect(hit).toBeDefined();
    expect(legend).toBeDefined();
    if (!hit || !legend) {
      dispose();
      return;
    }
    const initialSegments = segments().map((node) => node.props.y);
    // Only the two categories with range activity are drawn; zero series are absent.
    expect(initialSegments).toHaveLength(2);
    expect(renderGraph.elementsNamed(root, "output")).toHaveLength(0);
    renderGraph.listenerOf(hit, "onFocus")?.({});
    await Promise.resolve();
    const tooltip = renderGraph.elementsNamed(root, "output")[0];
    expect(tooltip).toBeDefined();
    if (tooltip) {
      const values = renderGraph
        .elementsNamed(tooltip, "span")
        .filter((node) => node.props.class === "qg-totals__value")
        .map(renderGraph.textOf);
      expect(values).toEqual(["1,000,000", "1", "0.00%"]);
    }
    renderGraph.listenerOf(hit, "onBlur")?.({});
    expect(renderGraph.elementsNamed(root, "output")).toHaveLength(0);
    // Hover emphasis is transient: only while the pointer is over the legend.
    renderGraph.listenerOf(legend, "onPointerEnter")?.({});
    expect(segments().filter((node) => node.props["data-highlighted"] === "true")).toHaveLength(1);
    expect(segments()).toHaveLength(2);
    renderGraph.listenerOf(legend, "onPointerLeave")?.({});
    expect(segments().filter((node) => node.props["data-highlighted"] === "true")).toHaveLength(2);
    // Focus emphasis is transient too.
    renderGraph.listenerOf(legend, "onFocus")?.({});
    expect(segments().filter((node) => node.props["data-highlighted"] === "true")).toHaveLength(1);
    renderGraph.listenerOf(legend, "onBlur")?.({});
    expect(segments().filter((node) => node.props["data-highlighted"] === "true")).toHaveLength(2);
    // There is no click/pin or keyboard-release handler on a legend entry.
    expect(renderGraph.listenerOf(legend, "onClick")).toBeUndefined();
    expect(renderGraph.listenerOf(legend, "onKeyDown")).toBeUndefined();
    expect(segments().map((node) => node.props.y)).toEqual(initialSegments);
    dispose();
  });

  it("keeps legend emphasis transient and never pins a clicked series", () => {
    const root = renderGraph.createTestRoot();
    const snapshot = usage("7d", [
      { startMs: NOW - HOUR_MS, endMs: NOW, tokens: costed({ input: 10, cacheRead: 5 }) },
    ]);
    const dispose = renderGraph.mount(() => renderGraph.chart({ usage: snapshot }), root);
    const segments = () =>
      renderGraph
        .elementsNamed(root, "rect")
        .filter((node) => node.props.class === "qg-chart__segment");
    const highlighted = () =>
      segments().filter((node) => node.props["data-highlighted"] === "true");
    const legend = renderGraph
      .elementsNamed(root, "li")
      .find((node) => node.props["aria-label"] === "Highlight Input");
    expect(legend).toBeDefined();
    if (!legend) {
      dispose();
      return;
    }
    const baseline = segments().map((node) => [node.props.y, node.props.height]);
    expect(segments()).toHaveLength(2);

    // The legend entry is a focusable, non-actionable list item: it has no
    // button activation semantics, no click handler, and no pressed state.
    expect(legend.tag).toBe("li");
    expect(legend.props.tabIndex).toBe(0);
    expect(renderGraph.listenerOf(legend, "onClick")).toBeUndefined();
    expect(renderGraph.listenerOf(legend, "onKeyDown")).toBeUndefined();
    expect(legend.props["aria-pressed"]).toBeUndefined();
    expect(legend.props["data-pressed"]).toBeUndefined();

    // Pointer activation natively focuses the entry. Emphasis may appear while
    // hovered, but pointer leave must ALWAYS clear it even when no blur fires.
    renderGraph.listenerOf(legend, "onPointerEnter")?.({});
    renderGraph.listenerOf(legend, "onFocus")?.({});
    expect(highlighted()).toHaveLength(1);
    expect(highlighted()[0]?.props.fill).toBe("var(--qg-token-input)");
    expect(segments()).toHaveLength(2);
    expect(
      renderGraph.elementsNamed(root, "div").find((node) => node.props.class === "qg-chart")?.props[
        "data-highlight"
      ],
    ).toBe("true");
    renderGraph.listenerOf(legend, "onClick")?.({});
    renderGraph.listenerOf(legend, "onPointerLeave")?.({});
    expect(highlighted()).toHaveLength(2);
    expect(
      renderGraph.elementsNamed(root, "div").find((node) => node.props.class === "qg-chart")?.props[
        "data-highlight"
      ],
    ).toBeUndefined();

    // Keyboard focus emphasises one series; losing focus restores normal.
    renderGraph.listenerOf(legend, "onFocus")?.({});
    expect(highlighted()).toHaveLength(1);
    renderGraph.listenerOf(legend, "onBlur")?.({});
    expect(highlighted()).toHaveLength(2);

    // No series is hidden or toggled at any point, and the stack is unchanged.
    expect(
      segments().every(
        (node) =>
          node.props.hidden === undefined &&
          node.props["aria-hidden"] === undefined &&
          node.props["aria-pressed"] === undefined &&
          node.props.display === undefined,
      ),
    ).toBe(true);
    expect(segments()).toHaveLength(2);
    expect(segments().map((node) => [node.props.y, node.props.height])).toEqual(baseline);
    dispose();
  });

  it("reduces axis label density at narrow container widths", () => {
    const buckets = Array.from({ length: 24 }, (_, index) => ({
      startMs: NOW + index * HOUR_MS,
      endMs: NOW + (index + 1) * HOUR_MS,
      tokens: costed({ input: index + 1 }),
    }));
    const geometry = buildUsageGeometry(buckets, {
      width: 291,
      height: 220,
      padding: { top: 12, right: 12, bottom: 24, left: 48 },
    });
    expect(geometry.labelIndexes.length).toBeLessThanOrEqual(3);
    expect(geometry.labelIndexes[0]).toBe(0);
    expect(geometry.labelIndexes.at(-1)).toBe(23);
  });
  const stackedBuckets = [
    {
      startMs: NOW - DAY_MS,
      endMs: NOW,
      tokens: costed({
        input: 3000,
        cacheRead: 4000,
        cacheWrite: 500,
        output: 1500,
        reasoning: 250,
      }),
    },
  ];

  it("stacks the five categories in the fixed order and never hides one with activity", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", stackedBuckets),
    });
    expect(html.match(/qg-chart__segment/g)).toHaveLength(5);
    for (const label of ["Cache Read", "Input", "Reasoning", "Output", "Cache Write"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("qg-chart__boundary");
    expect(html).not.toContain("qg-chart__cursor");
    expect(html).toContain("Highlight Cache Write");
    expect(html).toContain("9,250");
    expect(html).toContain("API-equivalent");
  });

  it("renders only the one category with activity in the range", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", [{ startMs: NOW - DAY_MS, endMs: NOW, tokens: costed({ input: 1000 }) }]),
    });
    expect(html.match(/qg-chart__segment/g)).toHaveLength(1);
    expect(html).not.toContain("totals series");
    expect(html).not.toContain("Reasoning");
    expect(html).not.toContain("Cache Write");
    expect(html).toContain('class="qg-legend__item"');
    expect(html).toContain("Highlight Input");
  });

  it("duplicates the series in a visually hidden table with five categories plus the total", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", stackedBuckets),
    });
    const table = html.slice(html.indexOf("<table"));
    // A clipping wrapper is essential: an HTML table keeps its intrinsic minimum
    // width even when the sr-only class requests 1px on the table itself.
    expect(html).toContain('class="sr-only"><table>');
    expect(table).toContain("<caption>");
    // Bucket plus the five categories plus the cache rate plus the total.
    expect(table.match(/scope="col"/g)?.length).toBe(8);
    expect(table).toContain("9,250");
  });

  it("puts estimate exclusions behind one info affordance, not in the summary body", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", [
        {
          startMs: NOW - DAY_MS,
          endMs: NOW,
          tokens: costed(
            { input: 100 },
            { apiEquivalentCostUsd: 0.01, unpricedTokens: 7, unknownTokens: 3 },
          ),
        },
      ]),
    });
    expect(text(html)).not.toContain("7 unpriced");
    expect(text(html)).not.toContain("3 unknown");
    expect(text(html)).toContain("About the API-equivalent estimate");
  });

  it("keeps bar stacks externally separated and preserves a tiny category truthfully", () => {
    const geometry = buildUsageGeometry([
      { startMs: 0, endMs: 1, tokens: costed({ input: 1000000, reasoning: 1 }) },
      { startMs: 1, endMs: 2, tokens: costed({ output: 3 }) },
      { startMs: 2, endMs: 3, tokens: costed({ input: 100 }) },
    ]);
    expect(geometry.visibleCategories.map((category) => category.key)).toEqual([
      "input",
      "reasoning",
      "output",
    ]);
    expect(geometry.bars).toHaveLength(3);
    for (const bar of geometry.bars) {
      if (bar.segments.length === 0) continue;
      expect(bar.segments[0]?.y + (bar.segments[0]?.height ?? 0)).toBeCloseTo(
        geometry.plot.bottom,
        10,
      );
      for (let index = 1; index < bar.segments.length; index += 1) {
        const previous = bar.segments[index - 1];
        const current = bar.segments[index];
        expect(previous?.y).toBeCloseTo(
          (current?.y as number) + (current?.height as number) + 1,
          10,
        );
      }
      for (const segment of bar.segments) {
        expect(segment.height).toBeGreaterThanOrEqual(0);
        expect(segment.radius).toBeCloseTo(Math.min(2, segment.width / 2, segment.height / 2), 10);
        expect(Number.isFinite(segment.y)).toBe(true);
        expect(Number.isFinite(segment.height)).toBe(true);
      }
    }
    // A one-token category is not inflated to a visible minimum; the external
    // background gap and constrained corner radius are the only cues.
    const tiny = geometry.bars[0]?.segments.find((segment) => segment.key === "reasoning");
    expect(tiny?.height).toBeGreaterThan(0);
    expect(tiny?.height).toBeLessThan(0.001);
    expect(tiny?.radius).toBeCloseTo((tiny?.height as number) / 2, 12);
  });

  it("formats numbers and cost predictably", () => {
    expect(formatTokenCount(9250)).toBe("9.3k");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatApiEquivalentCost(null)).toBe("≈ USD —");
    expect(formatApiEquivalentCost(1.5)).toBe("≈ USD 1.50");
    expect(formatPercent(62)).toBe("62%");
    expect(formatPercentExact(96.37)).toBe("96.37%");
    expect(formatPercentExact(null)).toBe("—");
    expect(formatRunway(undefined, "UTC")).toBeUndefined();
    expect(formatRunway({ kind: "lasts_past_reset" }, "UTC")).toBe("Lasts past reset");
    expect(
      formatRunway({ kind: "before_reset", projectedAtIso: new Date(NOW).toISOString() }, "UTC"),
    ).toContain("Runs out");
  });
});

describe("project view composition", () => {
  it("renders three columns per root: title, muted worktree, tokens", async () => {
    const html = await renderView("/views/project.tsx", "ProjectView", {
      snapshot: projectSnapshot(),
      range: "7d",
    });
    expect(html).toContain("qg-list__title");
    expect(html).toContain("qg-list__worktree");
    expect(html).toContain("qg-list__tokens");
    expect(html).toContain("alpha-main");
    expect(html).toContain('href="/session/session-root-1"');
    // No step count and no latest-activity column on this page's root rows.
    const roots = sectionOf(html, "qg-project-roots");
    expect(roots).not.toContain("steps");
    expect(roots).not.toContain(new Date(NOW - 1000).toLocaleString());
  });

  it("shows the shared worktree basename in the header only when every root agrees", async () => {
    const shared = await renderView("/views/project.tsx", "ProjectView", {
      snapshot: projectSnapshot(),
      range: "7d",
    });
    const header = shared.slice(0, shared.indexOf("qg-usage"));
    expect(header).toContain("alpha-main");

    const mixed = await renderView("/views/project.tsx", "ProjectView", {
      snapshot: projectSnapshot({
        roots: projectSnapshot().roots.map((root, index) => ({
          ...root,
          worktreeLabel: index === 0 ? "alpha-main" : "alpha-feature",
        })),
      }),
      range: "7d",
    });
    const mixedHeader = mixed.slice(0, mixed.indexOf("qg-usage"));
    expect(mixedHeader).not.toContain("alpha-main");
    expect(mixed).toContain("alpha-feature");
  });

  it("keeps metrics in one summary strip, not duplicated in the header", async () => {
    const html = await renderView("/views/project.tsx", "ProjectView", {
      snapshot: projectSnapshot(),
      range: "7d",
    });
    const header = html.slice(0, html.indexOf('class="qg-summary"'));
    expect(header).toContain("alpha-main");
    expect(text(header)).not.toContain("4 sessions");
    expect(text(header)).not.toContain("≈ USD");
    expect(text(header)).not.toContain("tokens");
    const summary = html.slice(
      html.indexOf('class="qg-summary"'),
      html.indexOf('class="qg-usage"'),
    );
    expect(text(summary)).toContain("Sessions");
    expect(summary).toContain(">4</span>");
    expect(text(html)).toContain("Total tokens");
    expect(text(html)).toContain("API-equivalent estimate");
    expect(text(html)).toContain("About the API-equivalent estimate");
    // The chart carries the semantic title only; the summary strip is the one place
    // project totals and the estimate are stated.
    expect(html).toContain('class="qg-chart__title">Daily token usage</span>');
    expect(html.match(/class="qg-summary-number"/g) ?? []).toHaveLength(0);
    expect(html.match(/class="qg-summary-cost"/g) ?? []).toHaveLength(0);
    expect(text(html).match(/≈ USD/g) ?? []).toHaveLength(1);
  });

  it("marks the current page and keeps the server's activity order", async () => {
    const snapshot = projectSnapshot();
    const html = await renderView("/views/project.tsx", "ProjectView", { snapshot, range: "7d" });
    expect(html).toContain('aria-current="page"');
    expect(html.indexOf(snapshot.roots[0]?.title ?? "")).toBeLessThan(
      html.indexOf(snapshot.roots[1]?.title ?? ""),
    );
    expect(html).toContain('aria-label="Sort sessions"');
    expect(text(html)).not.toContain("root sessions");
  });
});

describe("session view composition", () => {
  it("renders breadcrumbs with the current page marked and the chart summaries", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/session/session-ancestor"');
    expect(text(html)).toContain("Tree total tokens");
    expect(text(html)).toContain("2,900");
    expect(text(html)).toContain("This session");
    expect(text(html)).toContain("1,500");
    expect(text(html)).not.toContain("own 1,500 tokens");
    expect(text(html)).not.toContain("tree 2,900 tokens");
    expect(html).toContain("One step is one completed assistant message");
  });

  it("puts the project between Analytics and the session ancestors", async () => {
    const snapshot = sessionSnapshot({
      projectId: "project-gamma",
      projectName: "Gamma Workspace",
    });
    const html = await renderView("/views/session.tsx", "SessionView", { snapshot, range: "7d" });
    const crumbs = html.slice(html.indexOf('class="qg-breadcrumbs"'), html.indexOf("</nav>"));
    expect(crumbs).toContain('href="/project/project-gamma?range=7d">Gamma Workspace</a>');
    const analyticsAt = crumbs.indexOf('href="/analytics?range=7d"');
    const projectAt = crumbs.indexOf("Gamma Workspace");
    const ancestorAt = crumbs.indexOf('href="/session/session-ancestor"');
    const focusAt = crumbs.indexOf('aria-current="page"');
    expect(analyticsAt).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(analyticsAt);
    expect(ancestorAt).toBeGreaterThan(projectAt);
    expect(focusAt).toBeGreaterThan(ancestorAt);
    // One project crumb only: the ancestors and the focus stay single, too.
    expect(crumbs.match(/Gamma Workspace/g)).toHaveLength(1);
    expect(crumbs.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("renders aligned Name | Agent | Steps | Tokens rows without own/subtree prose", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(text(html)).not.toContain("own 1,500");
    expect(text(html)).not.toContain("tree 2,900");
    // Totals stay in the chart summary, not as a prose sentence in the header.
    expect(text(html)).toContain("Tree total tokens");
    expect(text(html)).toContain("This session");
    // The chart headline has no valueless "Completed steps" subtitle.
    expect(html).not.toContain('qg-section__meta">Completed steps');
    // Explicit columns replace the old secondary own/subtree sentence.
    expect(html).toContain('class="qg-nodes__head"');
    expect(text(html)).toContain("Name");
    expect(text(html)).toContain("Agent");
    expect(text(html)).toContain("Steps");
    expect(text(html)).toContain("Tokens");
    expect(text(html)).not.toContain("Worktree");
    expect(html).not.toContain("qg-node__own");
    expect(html).not.toContain("qg-node__worktree");
    expect(text(html)).not.toContain("own 2,900");
    expect(text(html)).not.toContain("subtree");
    expect(html).toContain('class="qg-node__steps">3</span>');
    expect(html).toContain('class="qg-node__steps">2</span>');
    expect(html).toContain('href="/session/session-child-1"');
    // The synthetic fixture has no stored agent, so the cell is an em dash.
    expect(html.match(/class="qg-node__agent">—<\/span>/g)).toHaveLength(2);
    expect(html).toContain('data-focus="true"');
    expect(html).not.toContain("children:");
    expect(html).not.toContain('class="qg-node__children"');
    // Both rendered nodes are row links; the current page's row is aria-current.
    expect((html.match(/<a[^>]*class="qg-node"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-current="page"');
  });

  it("draws focus compaction markers as ticks and drops the prose list", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(html).toContain("qg-chart__marker");
    // No native title tooltip; the custom inspection carries compaction metadata.
    expect(html).not.toContain("<title>");
    expect(html).not.toContain("qg-chart__hover");
    expect(text(html)).not.toContain("Compaction markers");
    expect(text(html)).not.toContain("msg-compaction");
    expect(html).toContain('class="qg-node__steps">3</span>');
  });

  it("windows a very large node list without shrinking the totals", async () => {
    const nodes = Array.from({ length: 250 }, (_, index) => ({
      sessionId: `session-${index}`,
      title: `Node ${index}`,
      depth: index % 3,
      childIds: [],
      ownTokens: costed({ input: 10 }),
      subtreeTokens: costed({ input: 10 }),
      stepCount: 1,
      subtreeNodeCount: 1,
      latestActivityAtMs: NOW - index,
    }));
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot({
        nodes,
        treeTotals: costed({ input: 999_999 }),
        ownSummary: { ...costed({ input: 100 }), stepCount: 1 },
      }),
      range: "7d",
    });
    expect(text(html)).toContain("Show 50 more nodes");
    expect(text(html)).toContain("Tree total tokens");
    expect(text(html)).toContain("999,999");
  });

  it("carries focus context through descendants and separates own from tree cumulative totals", () => {
    const snapshot = sessionSnapshot();
    const geometry = buildSessionChartGeometry(snapshot);

    expect(geometry.stepCount).toBe(3);
    expect(geometry.focusStepCount).toBe(2);
    expect(geometry.hasDescendants).toBe(true);
    // The child's 1,200-token context is never borrowed: the last focus value
    // carries through the child step, but it does not become a focus step.
    expect(geometry.contextValues).toEqual([500, 800, 800]);
    expect(geometry.context.points.map((point) => point.stepIndex)).toEqual([0, 1, 2]);
    expect(geometry.context.points.map((point) => point.value)).toEqual([500, 800, 800]);
    // Own holds on the child; tree follows every scoped step.
    expect(geometry.ownCumulativeValues).toEqual([500, 1500, 1500]);
    expect(geometry.treeCumulativeValues).toEqual([500, 1500, 2900]);
    expect(geometry.own.points.map((point) => point.value)).toEqual([500, 1500, 1500]);
    expect(geometry.tree.points.map((point) => point.value)).toEqual([500, 1500, 2900]);
    // Context remains independently scaled on the left; both cumulative
    // series share the right scale.
    expect(geometry.context.domainMax).toBe(800);
    expect(geometry.own.domainMax).toBe(2900);
    expect(geometry.tree.domainMax).toBe(2900);
    expect(geometry.cumulativeTicks).toEqual(geometry.tree.ticks);
    expect(geometry.own.ticks).toEqual(geometry.tree.ticks);
    expect(geometry.compaction).toHaveLength(1);
    expect(geometry.compaction[0]).toMatchObject({
      stepIndex: 1,
      sessionId: "session-root-1",
    });
  });

  it("places compaction ticks only at a subsequent focus step", () => {
    const between = buildSessionChartGeometry(
      sessionSnapshot({
        compactionMarkers: [
          { sessionId: "session-root-1", atMs: NOW - 2.5 * HOUR_MS, messageId: "msg-between" },
        ],
      }),
    );
    expect(between.compaction).toEqual([
      expect.objectContaining({ sessionId: "session-root-1", stepIndex: 1 }),
    ]);

    // No focus step at or after the marker: the step-index axis has no truthful
    // position, so the tick is omitted instead of snapping to the first step.
    const afterFinal = buildSessionChartGeometry(
      sessionSnapshot({
        compactionMarkers: [
          { sessionId: "session-root-1", atMs: NOW - 30 * 60_000, messageId: "msg-late" },
        ],
      }),
    );
    expect(afterFinal.compaction).toEqual([]);

    const descendant = buildSessionChartGeometry(
      sessionSnapshot({
        compactionMarkers: [
          { sessionId: "session-child-1", atMs: NOW - 90 * 60_000, messageId: "msg-child" },
        ],
      }),
    );
    expect(descendant.compaction).toEqual([]);
  });

  it("keeps both cumulative totals monotonic across branches and compactions", () => {
    const snapshot = sessionSnapshot();
    const geometry = buildSessionChartGeometry(snapshot);

    for (const series of [geometry.own, geometry.tree]) {
      for (let index = 1; index < series.points.length; index += 1) {
        const previous = series.points[index - 1];
        const current = series.points[index];
        expect(current?.value).toBeGreaterThanOrEqual(previous?.value as number);
        // Value grows, so its pixel y must fall (or stay flat), never rise.
        expect(current?.y).toBeLessThanOrEqual((previous?.y as number) + 1e-9);
      }
      expect(series.linePath).toContain(" C ");
      expect(series.linePath).not.toMatch(/NaN|Infinity|undefined/);
    }
    const markerIndex = geometry.compaction[0]?.stepIndex as number;
    for (const series of [geometry.own, geometry.tree]) {
      expect(series.points[markerIndex]?.value).toBeGreaterThanOrEqual(
        series.points[markerIndex - 1]?.value as number,
      );
    }
    for (let index = 0; index < geometry.stepCount; index += 1) {
      expect(geometry.ownCumulativeValues[index]).toBeLessThanOrEqual(
        geometry.treeCumulativeValues[index] as number,
      );
    }
  });

  it("renders labelled dual axes from the same chart on root and subsession pages", async () => {
    const rootSnapshot = sessionSnapshot();
    const childNode = rootSnapshot.nodes[1];
    const childStep = rootSnapshot.steps[2];
    if (!childNode || !childStep) throw new Error("session fixture is missing the child rows");
    const subsessionSnapshot = sessionSnapshot({
      focusSessionId: "session-child-1",
      breadcrumbs: [
        { sessionId: "session-root-1", title: "Refactor the quota aggregation", isFocus: false },
        {
          sessionId: "session-child-1",
          title: "Sub-agent: verify the bucket edges",
          isFocus: true,
        },
      ],
      nodes: [childNode],
      steps: [childStep],
      compactionMarkers: [],
      ownSummary: { ...costed({ input: 1200, output: 200 }), stepCount: 1 },
      treeTotals: costed({ input: 1200, output: 200 }),
    });

    const root = await renderView("/views/session.tsx", "SessionView", {
      snapshot: rootSnapshot,
      range: "7d",
    });
    const subsession = await renderView("/views/session.tsx", "SessionView", {
      snapshot: subsessionSnapshot,
      range: "7d",
    });

    for (const html of [root, subsession]) {
      expect(html).toContain('class="qg-usage qg-usage--session"');
      expect(html).toContain("Context · focus session");
      expect(html).toContain("Cumulative · this session");
      expect(html).not.toContain("(left)");
      expect(html).not.toContain("(right)");
      expect(html).toContain("qg-chart__axis-title--context");
      expect(html).toContain("qg-chart__axis-title--total");
      expect(html).toContain("qg-chart__axis-label--context");
      expect(html).toContain("qg-chart__axis-label--total");
      expect(html).toContain("qg-chart__line--context");
      expect(html).toContain("qg-chart__line--own");
      expect(html).not.toMatch(/NaN|Infinity/);
    }
    // Root with descendants adds the orange tree series; the leaf subsession
    // keeps only the yellow own series.
    expect(root).toContain("Cumulative · session tree");
    expect(root).toContain("qg-chart__line--total");
    expect(subsession).not.toContain("Cumulative · session tree");
    expect(subsession).not.toContain("qg-chart__line--total");
    // Multi-point areas fill under each line; the one-step subsession keeps
    // single-point dots instead of an invented area.
    expect(root).toContain("qg-chart__area--context");
    expect(root).toContain("qg-chart__area--own");
    expect(root).toContain("qg-chart__area--total");
    expect(subsession).toContain("qg-chart__point--context");
    expect(subsession).toContain("qg-chart__point--own");
    expect(subsession).not.toContain("qg-chart__point--total");
  });

  it("keeps both session scales finite for zero, tiny, single-point, and focus-less data", () => {
    const base = sessionSnapshot();
    const empty = sessionSnapshot({ steps: [] });
    const zero = sessionSnapshot({
      steps: base.steps.map((step) => ({ ...step, contextTokens: 0, totalTokens: 0 })),
    });
    const tiny = sessionSnapshot({
      steps: base.steps.map((step) => ({ ...step, contextTokens: 0.4, totalTokens: 0.2 })),
    });
    const noFocusSnapshot = sessionSnapshot({
      focusSessionId: "session-missing",
      steps: base.steps,
    });

    for (const snapshot of [empty, zero, tiny, noFocusSnapshot]) {
      const geometry = buildSessionChartGeometry(snapshot);
      for (const series of [geometry.context, geometry.own, geometry.tree]) {
        expect(Number.isFinite(series.domainMax)).toBe(true);
        expect(series.domainMax).toBeGreaterThanOrEqual(0);
        expect(series.linePath).not.toMatch(/NaN|Infinity|undefined/);
        expect(series.areaPath).not.toMatch(/NaN|Infinity|undefined/);
        for (const point of series.points) {
          expect(Number.isFinite(point.x)).toBe(true);
          expect(Number.isFinite(point.y)).toBe(true);
          expect(point.value).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(geometry.plot.top - 1e-9);
          expect(point.y).toBeLessThanOrEqual(geometry.plot.bottom + 1e-9);
        }
      }
    }

    const single = buildSessionChartGeometry({
      ...base,
      steps: base.steps.slice(0, 1),
    });
    expect(single.context.points).toHaveLength(1);
    expect(single.own.points).toHaveLength(1);
    expect(single.tree.points).toHaveLength(1);
    expect(single.context.linePath).toMatch(/^M /);
    expect(single.context.areaPath).toBe("");

    const noFocus = buildSessionChartGeometry(noFocusSnapshot);
    expect(noFocus.focusStepCount).toBe(0);
    expect(noFocus.context.points).toHaveLength(0);
    expect(noFocus.own.points).toHaveLength(3);
    expect(noFocus.tree.points).toHaveLength(3);
    expect(noFocus.tree.areaPath).toContain(" C ");
  });

  it("explains a focus-less chart while keeping the tree total visible", async () => {
    const snapshot = sessionSnapshot({ focusSessionId: "session-missing" });
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot,
      range: "7d",
    });
    expect(text(html)).toContain("No completed steps in the focus session yet");
    expect(html).toContain("qg-chart__line--own");
    expect(html).toContain("qg-chart__line--total");
    expect(html).not.toContain("qg-chart__line--context");
  });
});

describe("settings page", () => {
  const fieldFor = (key: string): SettingsField => {
    const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key);
    if (!field) throw new Error(`settings field ${key} is missing`);
    return field;
  };

  it("exposes exactly the GUI keys from the contract, with the port read-only", () => {
    expect(SETTINGS_FIELDS.map((field) => field.key).sort()).toEqual(
      [
        "accountingDetail",
        "dashboard.hiddenCards",
        "dashboard.hiddenRows",
        "dashboard.port",
        "dashboard.providerOrder",
        "enabledProviders",
        "formatStyle",
        "minIntervalMs",
        "opencodeGoWindows",
        "opencodeMonthlyLimit",
        "percentDisplayMode",
        "percentLabelStyle",
        "quotaProjection",
        "requestTimeoutMs",
        "resetTimeDecimals",
        "resetTimeSpaced",
        "waitForQuotaReset",
      ].sort(),
    );
    expect(fieldFor("dashboard.port")?.control).toBe("readonly");
  });

  it("keeps provider order as a hidden string-list field in the visibility group", () => {
    const order = fieldFor("dashboard.providerOrder");
    expect(order.group).toBe("visibility");
    expect(order.hidden).toBe(true);
    expect(validateValue(order, [])).toBeUndefined();
    expect(validateValue(order, ["a", 1])).toContain("takes a list of ids");
  });

  it("offers the requested groups only", () => {
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual([
      "wait",
      "display",
      "advanced",
      "visibility",
      "dashboard",
    ]);
  });

  it("leaves telemetry, toast groups, and reset notifications out of the page", () => {
    for (const field of SETTINGS_FIELDS) {
      expect(field.key).not.toMatch(/telemetry|analytics|toast|notification/i);
    }
  });

  it("labels the row style as affecting legacy surfaces only", () => {
    expect(fieldFor("formatStyle")?.help).toBe(
      "Affects toasts, TUI sidebar, and compact status only — not this page.",
    );
  });

  it("validates every control the way the contract describes", () => {
    expect(validateValue(fieldFor("minIntervalMs"), 0)).toContain("greater than zero");
    expect(validateValue(fieldFor("minIntervalMs"), -1)).toContain("greater than zero");
    expect(validateValue(fieldFor("minIntervalMs"), 300000)).toBeUndefined();
    expect(validateValue(fieldFor("requestTimeoutMs"), 1)).toBeUndefined();
    expect(validateValue(fieldFor("resetTimeDecimals"), 5)).toContain("at most 4");
    expect(validateValue(fieldFor("resetTimeDecimals"), 2.5)).toContain("whole number");
    expect(validateValue(fieldFor("resetTimeDecimals"), undefined)).toBeUndefined();
    expect(validateValue(fieldFor("percentDisplayMode"), "sideways")).toContain("Pick one");
    expect(validateValue(fieldFor("opencodeGoWindows"), [])).toContain("at least one window");
    expect(validateValue(fieldFor("opencodeGoWindows"), ["rolling"])).toBeUndefined();
    expect(validateValue(fieldFor("opencodeGoWindows"), ["yearly"])).toContain("rolling, weekly");
    expect(validateValue(fieldFor("opencodeMonthlyLimit"), 0)).toBeUndefined();
    expect(validateValue(fieldFor("opencodeMonthlyLimit"), -1)).toContain("at least 0");
    expect(validateValue(fieldFor("enabledProviders"), [])).toBeUndefined();
    expect(validateValue(fieldFor("enabledProviders"), "auto")).toBeUndefined();
    expect(validateValue(fieldFor("enabledProviders"), [""])).toContain("non-empty strings");
    expect(validateValue(fieldFor("waitForQuotaReset"), undefined)).toContain("needs a value");
    expect(validateValue(fieldFor("quotaProjection"), null)).toBeUndefined();
  });

  it("accepts the documented set value for the clearable Runway projection switch", () => {
    const projection = fieldFor("quotaProjection");
    expect(projection.onValue).toBe("runway");
    // The switch writes `"runway"` when on and `null` when off (settings.tsx), so
    // both have to validate or the save bar stays disabled forever.
    expect(validateValue(projection, "runway")).toBeUndefined();
    expect(validateValue(projection, null)).toBeUndefined();
    expect(validateValue(projection, undefined)).toBeUndefined();
    // A legacy boolean in the canonical file stays a value the user can save past.
    expect(validateValue(projection, false)).toBeUndefined();
    expect(validateValue(projection, true)).toBeUndefined();
    expect(validateValue(projection, "sometimes")).toContain("runway");
    // A non-clearable switch still demands a real boolean.
    expect(validateValue(fieldFor("resetTimeSpaced"), "runway")).toContain("true or false");

    const onDraft = { ...initialDraft("r1"), edits: { quotaProjection: "runway" } };
    expect(fieldErrors(onDraft, SETTINGS_FIELDS)).toEqual([]);
  });

  it("clears a key with null and keeps a real false or zero as a value", () => {
    const values = { minIntervalMs: 300000, resetTimeSpaced: true, resetTimeDecimals: 2 };
    const draft = {
      ...initialDraft("revision-1"),
      edits: { minIntervalMs: undefined, resetTimeSpaced: false, resetTimeDecimals: 0 },
    };
    const dirty = dirtyKeys(draft, values, Object.keys(values));
    expect(dirty).toEqual(["minIntervalMs", "resetTimeDecimals", "resetTimeSpaced"]);
    expect(toPatch(draft, dirty)).toEqual({
      minIntervalMs: null,
      resetTimeDecimals: 0,
      resetTimeSpaced: false,
    });
  });

  it("ignores edits to keys the server does not report as writable", () => {
    const values = { minIntervalMs: 300000 };
    const draft = { ...initialDraft("r1"), edits: { "dashboard.port": 5555 } };
    expect(dirtyKeys(draft, values, ["minIntervalMs"])).toEqual([]);
    expect(toPatch(draft, dirtyKeys(draft, values, ["minIntervalMs"]))).toEqual({});
  });

  it("blocks the save while a field is invalid", () => {
    const draft = { ...initialDraft("r1"), edits: { minIntervalMs: 0 } };
    expect(fieldErrors(draft, SETTINGS_FIELDS)).toEqual([
      { key: "minIntervalMs", message: expect.stringContaining("greater than zero") },
    ]);
  });

  it("keeps the edits and adopts the revision on a 409", () => {
    const draft = { ...initialDraft("revision-1"), edits: { accountingDetail: "detailed" } };
    const conflicted = applyConflict(draft, "revision-2");
    expect(conflicted.edits).toEqual({ accountingDetail: "detailed" });
    expect(conflicted.revision).toBe("revision-2");
    expect(conflicted.conflict).toBe(true);
    expect(applyWriteResult({ revision: "revision-3", applied: {}, warnings: [] })).toEqual({
      edits: {},
      revision: "revision-3",
      conflict: false,
    });
  });

  it("reads provider, window, and list values defensively", () => {
    expect(providerSelection("auto")).toEqual({ mode: "auto", ids: [] });
    expect(providerSelection(["anthropic", 7])).toEqual({ mode: "manual", ids: ["anthropic"] });
    expect(providerSelection(undefined)).toEqual({ mode: "auto", ids: [] });
    expect(windowSelection(["weekly", "bogus"])).toEqual(["weekly"]);
    expect(windowSelection("weekly")).toEqual([]);
    expect(stringList(["a", 2, "b"])).toEqual(["a", "b"]);
    expect(stringList(undefined)).toEqual([]);
  });

  it("orders visibility providers by the stored order first, appending unknown or new ones", () => {
    expect(orderedProviderIds([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(orderedProviderIds(["c", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(orderedProviderIds(["a", "a"], ["a", "b"])).toEqual(["a", "b"]);
    // A stored id the catalog no longer knows is ignored; new providers append.
    expect(orderedProviderIds(["d", "a"], ["a", "b", "d"])).toEqual(["d", "a", "b"]);
  });

  it("computes a remove-then-insert full order for drag and keyboard moves", () => {
    expect(reorderedProviderOrder(["a", "b", "c"], "b", 0)).toEqual(["b", "a", "c"]);
    expect(reorderedProviderOrder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(reorderedProviderOrder(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(keyboardMovedProviderOrder(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(keyboardMovedProviderOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    // The ends clamp instead of wrapping.
    expect(keyboardMovedProviderOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(keyboardMovedProviderOrder(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("drafts a provider-order edit and saves it through the revision-checked patch", () => {
    const values = { "dashboard.providerOrder": [] };
    const writable = ["dashboard.providerOrder"];
    const draft = { ...initialDraft("r1"), edits: { "dashboard.providerOrder": ["b", "a"] } };
    expect(dirtyKeys(draft, values, writable)).toEqual(["dashboard.providerOrder"]);
    expect(toPatch(draft, dirtyKeys(draft, values, writable))).toEqual({
      "dashboard.providerOrder": ["b", "a"],
    });
  });

  it("renders provider-grouped visibility cards with named eyes and unknown retained ids", async () => {
    const snapshot = settingsSnapshot({
      provenance: { percentDisplayMode: { scope: "legacy" } },
    });
    snapshot.values["dashboard.hiddenCards"] = ["hidden-provider#cardhash", "unknown-retained"];
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot,
      client: {
        settings: async () => snapshot,
        saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
        saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
        importPreview: async () => ({
          from: "workspace: synthetic",
          keys: [],
          issues: [],
          expectedRevision: "r",
        }),
        importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
      },
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: {
        providers: [
          {
            providerId: "visible-provider",
            providerLabel: "Visible Provider",
            accountLabels: ["Plus"],
            cardIds: ["visible-provider#cardhash"],
            rows: [{ id: "visible-provider#cardhash#window:five_hour", label: "5h" }],
          },
          {
            providerId: "hidden-provider",
            providerLabel: "Hidden Provider",
            accountLabels: ["Legacy", "Team"],
            cardIds: ["hidden-provider#cardhash"],
            rows: [{ id: "hidden-provider#cardhash#component:current_balance", label: "Balance" }],
          },
        ],
      },
      onReload: noop,
    });
    for (const title of [
      "Wait for quota reset",
      "Display",
      "Advanced",
      "Visibility",
      "Dashboard",
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("4144");
    // One dark card per provider, with inline account identification.
    expect(html.match(/class="qg-vis-provider"/g)).toHaveLength(2);
    expect(html).toContain('class="qg-vis-provider__name">Visible Provider</span>');
    expect(html).toContain('class="qg-vis-provider__account">Plus</span>');
    expect(html).toContain("Legacy · Team");
    // The provider eye hides/shows all of a provider's cards, not the row list.
    expect(html).toContain('aria-label="Hide Visible Provider"');
    expect(html).toContain('aria-label="Show Hidden Provider"');
    // Row eyes keep working while the provider is hidden; labels only, no ids.
    expect(html).toContain('aria-label="Hide 5h"');
    expect(html).toContain('aria-label="Hide Balance"');
    expect(html).toContain("outline-eye-slash");
    expect(html).toContain("outline-eye");
    // Grip affordance on every card, never the eye as a drag handle.
    expect(html.match(/class="qg-vis-grip"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Hide id');
    // No manual id editors, no chips, no raw ids, unknown or known — retained ids
    // keep working in storage but never surface anywhere.
    expect(html).not.toContain("id to hide");
    expect(html).not.toContain("Additional Hidden cards ID");
    expect(html).not.toContain("Clear all");
    expect(html).not.toContain("unknown-retained");
    expect(html).not.toContain("cardhash");
    expect(html).not.toContain("#window");
    expect(html).not.toContain("qg-chip");
    // This section configures visibility only: no live quota values.
    expect(html).not.toContain("qg-row__bar");
    expect(html).not.toContain("Resets in");
    expect(html).not.toContain("12.50");
    expect(html).toContain("http://127.0.0.1:4144");
    // One read-only Address row carries the full loopback URL; the separate
    // Port row is gone, but the server resilience note stays beside it.
    expect(html.match(/qg-field__label">Address</g)).toHaveLength(1);
    expect(html).toContain("Bound to loopback only");
    expect(html).toContain("No unsaved changes.");
    expect(text(html)).toContain("saved as global defaults");
    expect(text(html)).toContain("saving here does not edit them");
    expect(html).toContain("Legacy OpenCode Quota settings detected");
    expect(html).toContain("Legacy override");
    expect(html).not.toContain("effective value inherited from");
    expect(html).toContain("Preview migration");
    expect(html).not.toContain("Affects toasts, TUI sidebar, and compact status only");
    // The library's own components render in the page: adoption is real, not a plan.
    expect(html).toContain('data-component="button-v2"');
    expect(html).toContain('data-component="switch"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('data-component="segmented-control-v2"');
    expect(html).toContain("text-input-v2");
  });

  it.each([
    ["defaults", undefined],
    ["global", undefined],
    ["workspace", "Workspace override"],
    ["project", "Project override"],
    ["legacy", "Legacy override"],
  ] as const)("renders only meaningful structured %s provenance", async (scope, note) => {
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot: settingsSnapshot({
        sources: { minIntervalMs: "synthetic/raw/source.json" },
        provenance: { minIntervalMs: { scope } },
        import: { available: false, issues: [] },
      }),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { providers: [] },
      onReload: noop,
    });
    expect(html).not.toContain("synthetic/raw/source.json");
    expect(html).not.toContain("effective value inherited from");
    if (note) expect(html).toContain(note);
    else expect(html).not.toMatch(/(?:Workspace|Project|Legacy) override/);
    expect(html).not.toContain('id="qg-settings-import"');
    expect(html).not.toContain("Preview migration");
    for (const label of [
      "Runway projection",
      "Countdown decimals",
      "Space countdown units",
      "Quota row style",
      "Go windows",
      "Monthly limit",
    ]) {
      expect(html).not.toContain(label);
    }
  });

  it("does not guess provenance from source strings on older hosts", async () => {
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot: settingsSnapshot({
        sources: { minIntervalMs: "defaults", percentDisplayMode: "project synthetic.json" },
        import: { available: false, issues: [] },
      }),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { providers: [] },
      onReload: noop,
    });
    expect(html).not.toContain("effective value inherited from");
    expect(html).not.toMatch(/(?:Workspace|Project|Legacy) override/);
  });

  it("names the account inline on every row when a provider has multiple accounts", async () => {
    const snapshot = settingsSnapshot();
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot,
      client: {
        settings: async () => snapshot,
        saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
        saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
        importPreview: async () => ({ from: "w", keys: [], issues: [], expectedRevision: "r" }),
        importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
      },
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: {
        providers: [
          {
            providerId: "multi-provider",
            providerLabel: "Multi Provider",
            accountLabels: ["Plus", "Team"],
            cardIds: ["multi-provider#plus", "multi-provider#team"],
            rows: [
              {
                id: "multi-provider#plus#window:weekly",
                label: "Weekly",
                accountLabel: "Plus",
              },
              {
                id: "multi-provider#team#window:weekly",
                label: "Weekly",
                accountLabel: "Team",
              },
            ],
          },
        ],
      },
      onReload: noop,
    });

    expect(text(html)).toContain("Weekly · Plus");
    expect(text(html)).toContain("Weekly · Team");
    expect(html).toContain('aria-label="Hide Weekly · Plus"');
    expect(html).toContain('aria-label="Hide Weekly · Team"');
    expect(html).not.toContain("multi-provider");
    expect(html).not.toContain("#window");
  });

  it("shows a plain, id-free empty state when the visibility catalog is unavailable", async () => {
    const snapshot = settingsSnapshot();
    snapshot.values["dashboard.hiddenCards"] = ["provider-x#cardhash"];
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot,
      client: {
        settings: async () => snapshot,
        saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
        saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
        importPreview: async () => ({ from: "w", keys: [], issues: [], expectedRevision: "r" }),
        importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
      },
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { providers: [] },
      onReload: noop,
    });
    expect(html).toContain("No provider accounts are available to configure yet.");
    expect(html).not.toContain("provider-x");
    expect(html).not.toContain("cardhash");
    expect(html).not.toContain("qg-vis-provider");
  });

  it("renders the supplied chart-line and faders glyphs as the tab icons", async () => {
    const analytics = await renderView("/components/icons.tsx", "AnalyticsIcon", {});
    expect(analytics).toContain('viewBox="0 0 256 256"');
    expect(analytics).toContain('width="16"');
    expect(analytics).toContain('height="16"');
    expect(analytics).toContain('fill="currentColor"');
    expect(analytics).not.toContain('stroke-width="1.5"');
    expect(analytics).toContain("V151.19L93.37");
    const quota = await renderView("/components/icons.tsx", "QuotaIcon", {});
    expect(quota).toContain('viewBox="0 0 256 256"');
    expect(quota).toContain('fill="currentColor"');
    expect(quota).toContain("M180,80a4,4,0,0,1,4-4h32");
  });
});

describe("OpenAI reset and credit rows", () => {
  const resetsRowId = "openai#account#openai:resets" as never;
  const creditsRowId = "openai#account#openai:credits" as never;

  function optionalRow(overrides: Partial<QuotaCardRow> = {}): QuotaCardRow {
    return {
      rowId: resetsRowId,
      label: "Resets",
      kind: "value",
      resultType: "quota",
      value: "0 available",
      ...overrides,
    };
  }

  function creditsRow(overrides: Partial<QuotaCardRow> = {}): QuotaCardRow {
    return {
      rowId: creditsRowId,
      label: "Credits",
      kind: "value",
      resultType: "balance",
      value: "12.34",
      ...overrides,
    };
  }

  async function renderQuota(
    rows: QuotaCardRow[],
    hiddenRows: string[] = [],
    timeZone = "UTC",
  ): Promise<string> {
    return renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({
        providerId: "openai",
        providerLabel: "OpenAI",
        accountLabel: "Plus",
        rows,
      }),
      preferences,
      hiddenRows,
      stale: false,
      timeZone,
    });
  }

  it("hides zero, negative, and OFF optional rows without hiding positive data", async () => {
    const html = await renderQuota([
      optionalRow({
        bankedResets: { availableCount: 0, credits: [] },
        value: "1 available",
      }),
      optionalRow({
        rowId: "openai#account#openai:resets:second" as never,
        bankedResets: { availableCount: 2, credits: [] },
        value: "99 available",
      }),
      creditsRow({ value: "0" }),
      creditsRow({ rowId: "openai#account#openai:credits:second" as never, value: "9.5" }),
    ]);

    expect(text(html)).toContain("2 available");
    expect(text(html)).not.toContain("1 available");
    expect(text(html)).not.toContain("99 available");
    expect(html.match(/class="qg-reset__segment"/g)).toHaveLength(2);
    expect(text(html)).toContain("9.5");
    expect(text(html)).not.toContain("Credits 0");
    expect(text(html)).not.toContain("$");
  });

  it("keeps Resets and Credits visibility independent", async () => {
    const resets = optionalRow({
      bankedResets: { availableCount: 3, credits: [] },
      value: "3 available",
    });
    const credits = creditsRow({ value: "12.34" });

    const creditsHidden = await renderQuota([resets, credits], [credits.rowId]);
    expect(text(creditsHidden)).toContain("3 available");
    expect(text(creditsHidden)).not.toContain("Credits");
    expect(creditsHidden.match(/class="qg-reset__segment"/g)).toHaveLength(3);

    const resetsHidden = await renderQuota([resets, credits], [resets.rowId]);
    expect(text(resetsHidden)).toContain("Credits");
    expect(text(resetsHidden)).toContain("12.34");
    expect(resetsHidden).not.toContain('class="qg-reset__segment"');
  });

  it("renders only a finite positive balance or the exact Unlimited value", async () => {
    const positive = await renderQuota([creditsRow({ value: "12.34" })]);
    expect(text(positive)).toContain("Credits");
    expect(text(positive)).toContain("12.34");
    expect(positive.replace(/<!--.*?-->/g, "")).not.toContain("$");
    expect(positive).not.toContain('class="qg-reset__segment"');

    const unlimited = await renderQuota([creditsRow({ value: "Unlimited" })]);
    expect(text(unlimited)).toContain("Credits");
    expect(text(unlimited)).toContain("Unlimited");

    for (const value of ["0", "0.00", "-1", "", "not-a-number", "Infinity"]) {
      const hidden = await renderQuota([creditsRow({ value })]);
      expect(text(hidden)).not.toContain("Credits");
      expect(hidden.replace(/<!--.*?-->/g, "")).not.toContain("$");
    }
  });

  it.each([1, 3, 20])("renders %i equal reset segments over one shared width", async (count) => {
    const credits = Array.from({ length: count }, (_value, index) => ({
      expiresAtIso: new Date(NOW + (index + 1) * DAY_MS).toISOString(),
    }));
    const html = await renderQuota([
      optionalRow({
        bankedResets: { availableCount: count, credits },
        value: `${count} available`,
      }),
    ]);

    expect(text(html)).toContain(`${count} available`);
    expect(html).toContain(`--qg-reset-count:${count}`);
    expect(html.match(/class="qg-reset__segment"/g)).toHaveLength(count);
    expect(html).toContain('aria-label="Available reset expiries"');
  });

  it("orders nearest known expiry first and represents null and unknown honestly", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const nearest = new Date(NOW + 2 * DAY_MS + 4 * HOUR_MS + 18 * 60_000).toISOString();
      const later = new Date(NOW + 8 * DAY_MS).toISOString();
      const html = await renderQuota(
        [
          optionalRow({
            bankedResets: {
              availableCount: 5,
              credits: [
                { title: "Later", expiresAtIso: later },
                { expiresAtIso: null },
                { title: "Unknown detail" },
                { title: "Nearest reset", expiresAtIso: nearest },
              ],
            },
            value: "5 available",
          }),
        ],
        [],
        "America/New_York",
      );

      expect(text(html)).toContain("5 available");
      expect(text(html)).toContain("Expires in 2d 4h 18m");
      expect(html.match(/data-expiry="known"/g)).toHaveLength(2);
      expect(html.match(/data-expiry="none"/g)).toHaveLength(1);
      expect(html.match(/data-expiry="unknown"/g)).toHaveLength(2);
      expect(html.match(/class="qg-reset__segment"/g)).toHaveLength(5);

      const firstKnown = html.indexOf('data-expiry="known"');
      const latestKnown = html.indexOf('data-expiry="known"', firstKnown + 1);
      const noExpiry = html.indexOf('data-expiry="none"');
      const unknown = html.indexOf('data-expiry="unknown"');
      expect(firstKnown).toBeGreaterThan(-1);
      expect(latestKnown).toBeGreaterThan(firstKnown);
      expect(noExpiry).toBeGreaterThan(latestKnown);
      expect(unknown).toBeGreaterThan(noExpiry);

      expect(text(html)).toContain("Nearest reset");
      expect(text(html)).toContain("20/10/2026, 12:18:00");
      expect(text(html)).toContain("In 2d 4h 18m");
      expect(text(html)).toContain("No expiry");
      expect(text(html)).toContain("Expiry unknown");
      expect(text(html)).toContain("Full reset");
      expect(text(html)).not.toContain("In reset");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fabricate a countdown for invalid or past details", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const html = await renderQuota([
        optionalRow({
          bankedResets: {
            availableCount: 3,
            credits: [
              { title: "Invalid detail", expiresAtIso: "not-a-date" },
              { title: "No expiry", expiresAtIso: null },
              { title: "Past detail", expiresAtIso: new Date(NOW - HOUR_MS).toISOString() },
            ],
          },
          value: "3 available",
        }),
      ]);

      expect(html.match(/data-expiry="known"/g)).toHaveLength(1);
      expect(html.match(/data-expiry="none"/g)).toHaveLength(1);
      expect(html.match(/data-expiry="unknown"/g)).toHaveLength(1);
      expect(text(html)).toContain("Nearest expiry has passed");
      expect(text(html)).toContain("Expired");
      expect(text(html)).toContain("No expiry");
      expect(text(html)).toContain("Expiry unknown");
      expect(text(html)).not.toContain("In reset");
    } finally {
      vi.useRealTimers();
    }
  });

  it("places optional-row info beside the label, before the row eye", async () => {
    const snapshot = settingsSnapshot();
    const html = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot,
      client: {
        settings: async () => snapshot,
        saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
        saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
        importPreview: async () => ({ from: "w", keys: [], issues: [], expectedRevision: "r" }),
        importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
      },
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: {
        providers: [
          {
            providerId: "openai",
            providerLabel: "OpenAI",
            accountLabels: [],
            cardIds: ["openai#account"],
            rows: [
              {
                id: "openai#account#openai:resets",
                label: "Resets",
                info: OPENAI_RESETS_INFO,
              },
              {
                id: "openai#account#openai:credits",
                label: "Credits",
                info: OPENAI_CREDITS_INFO,
              },
            ],
          },
        ],
      },
      onReload: noop,
    });

    expect(html.match(/class="qg-row__info"/g)).toHaveLength(2);
    expect(text(html)).toContain("More information about Resets");
    expect(text(html)).toContain("More information about Credits");
    for (const label of ["Resets", "Credits"]) {
      const labelAt = html.indexOf(`<span>${label}</span>`);
      const infoAt = html.indexOf('class="qg-row__info"', labelAt);
      const screenReaderAt = html.indexOf('class="sr-only"', labelAt);
      const eyeAt = html.indexOf(`aria-label="Hide ${label}"`, labelAt);
      expect(labelAt).toBeGreaterThan(-1);
      expect(infoAt).toBeGreaterThan(labelAt);
      expect(screenReaderAt).toBeGreaterThan(labelAt);
      expect(infoAt).toBeLessThan(eyeAt);
      expect(screenReaderAt).toBeLessThan(eyeAt);
    }
  });
});

describe("OpenAI optional semantics stay provider-scoped", () => {
  async function renderProvider(
    providerId: string,
    providerLabel: string,
    rows: QuotaCardRow[],
    hiddenRows: string[] = [],
  ): Promise<string> {
    return renderView("/components/quota-card.tsx", "QuotaCardView", {
      card: providerCard({ providerId, providerLabel, accountLabel: "Main account", rows }),
      preferences,
      hiddenRows,
      stale: false,
      timeZone: "UTC",
    });
  }

  it("keeps Copilot percent and value Credits rows", async () => {
    const html = await renderProvider("github-copilot", "GitHub Copilot", [
      percentRow({ rowId: "copilot#credits-percent" as never, label: "Credits" }),
      {
        rowId: "copilot#credits-value" as never,
        label: "Credits",
        kind: "value",
        resultType: "balance",
        value: "Used 12 | Included 10",
      },
    ]);

    expect(text(html)).toContain("Credits");
    expect(html).toContain("qg-row__bar");
    expect(text(html)).toContain("Used 12 | Included 10");
  });

  it("keeps Kilo Credits percent rows", async () => {
    const html = await renderProvider("kilo", "Kilo", [
      percentRow({
        rowId: "kilo#credits" as never,
        label: "Credits",
        percentRemaining: 42,
        percentUsed: 58,
      }),
    ]);

    expect(text(html)).toContain("Credits");
    expect(html).toContain("qg-row__bar");
    expect(text(html)).toContain("42% remaining");
  });

  it("keeps custom-provider Credits and Resets labels", async () => {
    const html = await renderProvider("custom-provider", "Custom Provider", [
      {
        rowId: "custom#credits" as never,
        label: "Credits",
        kind: "value",
        resultType: "quota",
        value: "custom credits",
      },
      {
        rowId: "custom#resets" as never,
        label: "Resets",
        kind: "value",
        resultType: "quota",
        value: "custom resets",
      },
    ]);

    expect(text(html)).toContain("Credits");
    expect(text(html)).toContain("custom credits");
    expect(text(html)).toContain("Resets");
    expect(text(html)).toContain("custom resets");
    expect(html).not.toContain('class="qg-reset__segment"');
  });

  it("uses OpenAI balance/banked-reset semantics instead of display labels", async () => {
    const html = await renderProvider("openai", "OpenAI", [
      {
        rowId: "openai#balance-zero" as never,
        label: "Zero balance row",
        kind: "value",
        resultType: "balance",
        value: "0",
      },
      percentRow({
        rowId: "openai#balance-percent" as never,
        label: "Balance reserve",
        resultType: "balance",
      }),
      {
        rowId: "openai#credits-renamed" as never,
        label: "Available credit",
        kind: "value",
        resultType: "balance",
        value: "12.34",
      },
      {
        rowId: "openai#refills" as never,
        label: "Quota refills",
        kind: "value",
        resultType: "quota",
        bankedResets: { availableCount: 2, credits: [] },
      },
    ]);

    expect(text(html)).not.toContain("Balance reserve");
    expect(text(html)).not.toContain("Zero balance row");
    expect(text(html)).toContain("Available credit");
    expect(text(html)).toContain("12.34");
    expect(text(html)).toContain("Quota refills");
    expect(text(html)).toContain("2 available");
    expect(html).toContain('class="qg-reset__segment"');
    expect(html).not.toContain("qg-row__bar");
  });
});

describe("cached visibility catalog", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`probe: ${what} never happened`);
  }

  it("keeps absent OpenAI optional rows account-scoped in Settings", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const browser = historyBrowser("/settings", storage);
    vi.stubGlobal("window", browser);
    const snapshot = settingsSnapshot();
    const cards = ["Plus", "Team"].map((account, index) =>
      providerCard({
        cardId: `openai#account-${index}` as never,
        providerId: "openai",
        providerLabel: "OpenAI",
        accountLabel: account,
        labelSource: "connection",
        rows: [],
        visibilityRows: [
          {
            rowId: `openai#account-${index}#openai:resets` as never,
            label: "Resets",
            info: OPENAI_RESETS_INFO,
          },
          {
            rowId: `openai#account-${index}#openai:credits` as never,
            label: "Credits",
            info: OPENAI_CREDITS_INFO,
          },
        ],
      }),
    );
    const client: DashboardClient = {
      setActiveView: async () => {},
      connection: () => "live",
      onConnectionChange: () => () => {},
      subscribe: () => () => {},
      health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
      quota: async () =>
        homeSnapshot({
          providers: { cards, enabledProviders: "auto", polledAtMs: NOW },
        }),
      home: async () => homeSnapshot(),
      project: async () => projectSnapshot(),
      session: async () => sessionSnapshot(),
      settings: async () => snapshot,
      saveSettings: async (input) => ({
        revision: snapshot.revision,
        applied: input.patch,
        warnings: [],
      }),
      saveVisibility: async () => ({ revision: snapshot.revision, applied: {}, warnings: [] }),
      importPreview: async () => ({
        from: "workspace: synthetic",
        keys: [],
        issues: [],
        expectedRevision: snapshot.revision,
      }),
      importApply: async () => ({ revision: snapshot.revision, applied: {}, warnings: [] }),
    };

    const root = renderGraph.createTestRoot();
    const dispose = renderGraph.mount(() => renderGraph.app({ client }), root);
    const buttonByLabel = (label: string): TestNode | undefined =>
      renderGraph.elementsNamed(root, "button").find((node) => node.props["aria-label"] === label);
    try {
      await until(
        () => buttonByLabel("Hide Resets · Plus") !== undefined,
        "the account-scoped Resets eye",
      );
      expect(buttonByLabel("Hide Resets · Team")).toBeDefined();
      expect(buttonByLabel("Hide Credits · Plus")).toBeDefined();
      expect(buttonByLabel("Hide Credits · Team")).toBeDefined();
      expect(renderGraph.textOf(root)).toContain("More information about Resets");
      expect(
        renderGraph
          .elementsNamed(root, "span")
          .filter((node) => node.props.class === "qg-row__info"),
      ).toHaveLength(4);
      expect(renderGraph.textOf(root)).not.toContain("openai:resets");
      expect(renderGraph.textOf(root)).not.toContain("openai:credits");

      browser.follow("/quota");
      await settle();
      browser.follow("/settings");
      await settle();
      await until(
        () => buttonByLabel("Hide Resets · Plus") !== undefined,
        "the cached Resets eyes after navigation",
      );
      expect(buttonByLabel("Hide Credits · Team")).toBeDefined();
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a hidden provider configurable across filtered quota cycles, navigation and reload", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const browser = historyBrowser("/quota", storage);
    vi.stubGlobal("window", browser);

    const visibleCard = providerCard();
    const hiddenCard = providerCard({
      cardId: "hidden-provider#cardhash" as never,
      providerId: "hidden-provider",
      providerLabel: "Hidden Provider",
      accountLabel: "Team",
      rows: [
        percentRow({
          rowId: "hidden-provider#cardhash#window:weekly" as never,
          label: "Weekly",
        }),
      ],
    });
    const snapshot = settingsSnapshot();
    let filtered = false;
    let onEvent: Parameters<DashboardClient["subscribe"]>[0] | undefined;
    const saves: Parameters<DashboardClient["saveSettings"]>[0][] = [];
    const client: DashboardClient = {
      setActiveView: async () => {},
      connection: () => "live",
      onConnectionChange: () => () => {},
      subscribe: (callback) => {
        onEvent = callback;
        return () => {
          onEvent = undefined;
        };
      },
      health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
      quota: async () =>
        homeSnapshot({
          providers: {
            cards: filtered ? [visibleCard] : [visibleCard, hiddenCard],
            enabledProviders: "auto",
            polledAtMs: NOW,
          },
        }),
      home: async () => homeSnapshot(),
      project: async () => projectSnapshot(),
      session: async () => sessionSnapshot(),
      settings: async () => snapshot,
      saveSettings: async (input) => {
        saves.push(input);
        return { revision: "revision-2", applied: input.patch, warnings: [] };
      },
      saveVisibility: async () => ({ revision: "revision-2", applied: {}, warnings: [] }),
      importPreview: async () => ({
        from: "workspace: synthetic",
        keys: [],
        issues: [],
        expectedRevision: snapshot.revision,
      }),
      importApply: async () => ({ revision: "revision-2", applied: {}, warnings: [] }),
    };

    const root = renderGraph.createTestRoot();
    let dispose = renderGraph.mount(() => renderGraph.app({ client }), root);
    let reloadedDispose: (() => void) | undefined;
    const buttonByLabel = (scope: TestNode, label: string): TestNode => {
      const found = renderGraph
        .elementsNamed(scope, "button")
        .find((node) => node.props["aria-label"] === label);
      if (found === undefined) throw new Error(`probe: no button labelled ${label}`);
      return found;
    };
    const navigate = async (path: string) => {
      browser.follow(path);
      await settle();
    };

    try {
      // The first unfiltered snapshot reaches the browser-local cache.
      await until(
        () =>
          readVisibilityCatalog(storage).providers.some(
            (entry) => entry.providerId === "hidden-provider",
          ),
        "the cache to learn both providers",
      );

      await navigate("/settings");
      expect(renderGraph.textOf(root)).toContain("Hidden Provider");
      renderGraph.listenerOf(buttonByLabel(root, "Hide Hidden Provider"), "onClick")?.({});
      await settle();
      // Persist the hidden provider id before the filtered cycle arrives.
      snapshot.values["dashboard.hiddenCards"] = ["hidden-provider"];
      snapshot.visibility.hiddenCards = ["hidden-provider"];
      const saveButton = renderGraph
        .elementsNamed(root, "button")
        .find((node) => renderGraph.textOf(node) === "Save");
      if (saveButton === undefined) throw new Error("probe: no Save button");
      renderGraph.listenerOf(saveButton, "onClick")?.({});
      await until(() => saves.length === 1, "the visibility save");
      expect(saves[0]?.patch["dashboard.hiddenCards"]).toEqual(["hidden-provider"]);

      // The server now excludes the hidden provider from quota probes. The
      // filtered snapshot must not erase its Settings card.
      filtered = true;
      await navigate("/quota");
      await settle();
      onEvent?.({ topic: "quota.changed", at: NOW });
      await settle();
      expect(renderGraph.textOf(root)).not.toContain("Hidden Provider");
      expect(readVisibilityCatalog(storage).providers.map((entry) => entry.providerId)).toContain(
        "hidden-provider",
      );

      await navigate("/settings");
      expect(renderGraph.textOf(root)).toContain("Hidden Provider");
      expect(buttonByLabel(root, "Show Hidden Provider").props["aria-pressed"]).toBe("true");
      expect(buttonByLabel(root, "Hide Weekly")).toBeDefined();

      // Leaving and returning still finds the cached provider.
      await navigate("/quota");
      await navigate("/settings");
      expect(renderGraph.textOf(root)).toContain("Hidden Provider");
      expect(buttonByLabel(root, "Show Hidden Provider")).toBeDefined();

      // A reload starts from storage alone; the quota snapshot stays filtered.
      dispose();
      dispose = () => {};
      const reloaded = renderGraph.createTestRoot();
      reloadedDispose = renderGraph.mount(() => renderGraph.app({ client }), reloaded);
      await until(
        () => renderGraph.textOf(reloaded).includes("Hidden Provider"),
        "the cached provider after reload",
      );
      expect(buttonByLabel(reloaded, "Show Hidden Provider")).toBeDefined();
      expect(buttonByLabel(reloaded, "Hide Weekly")).toBeDefined();
    } finally {
      reloadedDispose?.();
      dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe("reconnect recovery", () => {
  it("refetches only when the stream comes back from a drop", () => {
    // The one case that lost changes: reconnecting → live (spec §10 States).
    expect(shouldRefetchOnReconnect("reconnecting", "live")).toBe(true);
    // The first connect must not refetch: the initial load's own request is it.
    expect(shouldRefetchOnReconnect("connecting", "live")).toBe(false);
    expect(shouldRefetchOnReconnect(undefined, "live")).toBe(false);
    // Everything else is either a drop, a repeat, or not a reconnect at all.
    expect(shouldRefetchOnReconnect("live", "reconnecting")).toBe(false);
    expect(shouldRefetchOnReconnect("live", "live")).toBe(false);
    expect(shouldRefetchOnReconnect("connecting", "reconnecting")).toBe(false);
    expect(shouldRefetchOnReconnect("reconnecting", "reconnecting")).toBe(false);
  });

  it("stays stale from a reconnect until a fresh fetch lands", () => {
    // Nothing has reconnected yet: the initial load is not stale.
    expect(isStaleAfterReconnect(0, 0)).toBe(false);
    // A reconnect happened and no fresh payload has arrived: stale.
    expect(isStaleAfterReconnect(1, 0)).toBe(true);
    // The refetch that started after the reconnect succeeded: fresh again.
    expect(isStaleAfterReconnect(1, 1)).toBe(false);
    // A failed refetch leaves the anchor behind, so the marker stays.
    expect(isStaleAfterReconnect(2, 1)).toBe(true);
    expect(isStaleAfterReconnect(3, 3)).toBe(false);
  });
});

/**
 * A section has to follow *its payload*, not just its first payload. `Switch`
 * calls a `Match` child inside `untrack` and its non-keyed condition compares
 * only truthiness, so a non-keyed branch renders once and then holds that first
 * payload for the life of the page. An SSR snapshot cannot see that; a browser
 * shows it as a usage chart and a project list that keep the old range's numbers
 * while the URL, the range buttons and the links all move on.
 */
describe("a section follows its payload", () => {
  function payload(range: RangeKey, projectName: string, tokens: number): HomeSnapshot {
    return homeSnapshot({
      range,
      usage: usage(range, [
        { startMs: NOW - HOUR_MS, endMs: NOW, tokens: costed({ input: tokens }) },
      ]),
      projects: [
        {
          projectId: `project-${projectName}`,
          name: projectName,
          tokens: costed({ input: tokens }),
          rootSessionCount: 1,
          latestActivityAtMs: NOW,
        },
      ],
    });
  }

  function mountSection(initial: FetchOutcome<HomeSnapshot>) {
    const [state, setState] = renderGraph.createSignal(resolveLoadState(initial));
    const [range, setRange] = renderGraph.createSignal<RangeKey>("7d");
    const root = renderGraph.createTestRoot();
    const dispose = renderGraph.mount(() => renderGraph.liveSection({ state, range }), root);
    return {
      root,
      setState,
      setRange,
      text: () => renderGraph.textOf(root),
      dispose,
    };
  }

  /** Render effects run with the update; this lets any deferred one land too. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("renders the new range's numbers after the payload changes", async () => {
    const rig = mountSection({ data: payload("7d", "alpha-7d", 960), loading: false });
    expect(rig.text()).toContain("Daily token usage");
    expect(rig.text()).toContain("alpha-7d");
    expect(rig.text()).toContain("Total tokens960");

    rig.setState(resolveLoadState({ data: payload("24h", "beta-24h", 480), loading: false }));
    rig.setRange("24h");
    await settle();

    const text = rig.text();
    expect(text).toContain("Hourly token usage");
    expect(text).toContain("beta-24h");
    expect(text).toContain("Total tokens480");
    // The previous range's numbers are gone, not merely joined by new ones.
    expect(text).not.toContain("Daily token usage");
    expect(text).not.toContain("alpha-7d");
    expect(text).not.toContain("Total tokens960");
    rig.dispose();
  });

  it("shows the new failure when a retry fails differently", async () => {
    const rig = mountSection({
      error: new DashboardError("internal", 500, "First failure"),
      loading: false,
    });
    expect(rig.text()).toContain("First failure");

    rig.setState(
      resolveLoadState({
        error: new DashboardError("internal", 500, "Second failure"),
        loading: false,
      }),
    );
    await settle();

    expect(rig.text()).toContain("Second failure");
    expect(rig.text()).not.toContain("First failure");
    rig.dispose();
  });

  it("retains last-good Analytics during failure and accepts recovery", async () => {
    const fresh = payload("7d", "alpha-7d", 960);
    const rig = mountSection({ data: fresh, loading: false });
    expect(rig.text()).toContain("alpha-7d");

    // A failed refetch keeps the payload and marks it stale.
    rig.setState(
      resolveLoadState({
        data: fresh,
        error: new DashboardError("internal", 500, "refetch failed"),
        loading: false,
      }),
    );
    await settle();
    expect(rig.text()).toContain("alpha-7d");
    expect(rig.text()).toContain("Total tokens960");

    // The next good payload is not stale any more.
    rig.setState(resolveLoadState({ data: payload("24h", "beta-24h", 480), loading: false }));
    await settle();
    expect(rig.text()).toContain("beta-24h");
    expect(rig.text()).not.toContain("alpha-7d");
    rig.dispose();
  });
});

describe("range transitions name the range still on screen", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function analyticsPayload(range: RangeKey, projectName: string, tokens: number): HomeSnapshot {
    return homeSnapshot({
      range,
      usage: usage(range, [
        { startMs: NOW - HOUR_MS, endMs: NOW, tokens: costed({ input: tokens }) },
      ]),
      projects: [
        {
          projectId: "project-alpha",
          name: projectName,
          tokens: costed({ input: tokens }),
          rootSessionCount: 1,
          latestActivityAtMs: NOW,
        },
      ],
    });
  }

  function projectPayload(range: RangeKey, projectName: string): ProjectSnapshot {
    return projectSnapshot({
      range,
      name: projectName,
      totals: { ...costed({ input: 700 }), sessionCount: 1 },
      usage: usage(range, [{ startMs: NOW - DAY_MS, endMs: NOW, tokens: costed({ input: 700 }) }]),
      roots: [
        {
          sessionId: "session-root-1",
          title: `root-${range}`,
          worktreeLabel: "alpha-main",
          tokens: costed({ input: 700 }),
          latestActivityAtMs: NOW,
        },
      ],
    });
  }

  interface AppHarness {
    root: TestNode;
    navigate: (path: string) => Promise<void>;
    text: () => string;
    notice: () => TestNode | undefined;
    mainLink: (href: string) => TestNode | undefined;
    dispose: () => void;
  }

  /**
   * Mounts the real `App` on the test renderer with a controllable data source.
   * Link navigation goes through the production click/History API path, so
   * range and route signals update exactly as they do in a tab.
   */
  function mountApp(options: {
    path: string;
    home?: DashboardClient["home"];
    project?: DashboardClient["project"];
    health?: DashboardClient["health"];
  }): AppHarness {
    const browser = historyBrowser(options.path);
    vi.stubGlobal("window", browser);

    const client: DashboardClient = {
      connection: () => "live",
      onConnectionChange: () => () => {},
      subscribe: () => () => {},
      health: options.health ?? (async () => ({ app: "opencode-quota-gui", contractVersion: 2 })),
      home: options.home ?? (async () => homeSnapshot()),
      quota: async () => homeSnapshot(),
      project: options.project ?? (async () => projectSnapshot()),
      session: async () => sessionSnapshot(),
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

    const root = renderGraph.createTestRoot();
    const stop = renderGraph.mount(() => renderGraph.app({ client }), root);
    return {
      root,
      navigate: async (path) => {
        browser.follow(path);
        await settle();
      },
      text: () => renderGraph.textOf(root),
      notice: () =>
        [
          ...renderGraph.elementsNamed(root, "div"),
          ...renderGraph.elementsNamed(root, "output"),
        ].find((node) => node.props.class === "qg-range-failure"),
      mainLink: (href) => {
        const main = renderGraph.elementsNamed(root, "main")[0];
        if (!main) return undefined;
        return renderGraph.elementsNamed(main, "a").find((node) => node.props.href === href);
      },
      dispose: () => {
        stop();
        vi.unstubAllGlobals();
      },
    };
  }

  it("blocks an older server contract before treating its payload as ready", async () => {
    const app = mountApp({
      path: "/analytics?range=7d",
      health: async () => ({
        app: "opencode-quota-gui",
        contractVersion: DASHBOARD_CONTRACT_VERSION - 1,
      }),
    });
    try {
      await settle();
      const body = app.text();
      expect(body).toContain("Restart the dashboard/OpenCode");
      expect(body).toContain("reload the page");
      expect(body).not.toContain("Total tokens");
    } finally {
      app.dispose();
    }
  });

  it("keeps the old range on screen without adding an inline transition row", async () => {
    const oldPayload = analyticsPayload("7d", "alpha-7d", 960);
    const nextPayload = deferred<HomeSnapshot>();
    const requests: RangeKey[] = [];
    const app = mountApp({
      path: "/analytics?range=7d",
      home: ({ range }) => {
        requests.push(range);
        return range === "7d" ? Promise.resolve(oldPayload) : nextPayload.promise;
      },
    });

    try {
      await settle();
      expect(requests).toEqual(["7d"]);
      expect(app.text()).toContain("alpha-7d");

      await app.navigate("/analytics?range=30d");
      expect(requests).toEqual(["7d", "30d"]);

      // No inline "Showing X while updating Y" row exists at all.
      expect(app.text()).not.toContain("Showing 7 days while updating");
      expect(app.notice()).toBeUndefined();
      // The old payload keeps its own labels and links until the new one lands.
      expect(app.text()).toContain("Daily token usage");
      expect(app.mainLink("/project/project-alpha?range=7d")).toBeDefined();
      expect(app.mainLink("/project/project-alpha?range=30d")).toBeUndefined();

      nextPayload.resolve(analyticsPayload("30d", "beta-30d", 480));
      await settle();
      await settle();

      expect(app.notice()).toBeUndefined();
      expect(app.text()).toContain("beta-30d");
      expect(app.text()).not.toContain("alpha-7d");
      expect(app.mainLink("/project/project-alpha?range=30d")).toBeDefined();
    } finally {
      app.dispose();
    }
  });

  it("keeps the old view and offers a local Retry when the range fetch fails", async () => {
    const oldPayload = analyticsPayload("7d", "alpha-7d", 960);
    const pending: Deferred<HomeSnapshot>[] = [];
    const requests: RangeKey[] = [];
    const app = mountApp({
      path: "/analytics?range=7d",
      home: ({ range }) => {
        requests.push(range);
        if (range === "7d") return Promise.resolve(oldPayload);
        const next = deferred<HomeSnapshot>();
        pending.push(next);
        return next.promise;
      },
    });

    try {
      await settle();
      await app.navigate("/analytics?range=30d");
      const first = pending[0];
      if (!first) throw new Error("the range request did not start");
      first.reject(new DashboardError("internal", 500, "range update failed"));
      await settle();
      await settle();

      // The failed range change leaves the last good payload untouched.
      expect(app.text()).toContain("alpha-7d");
      expect(app.text()).toContain("Daily token usage");
      expect(app.text()).not.toContain("beta-30d");

      const alert = app.notice();
      expect(alert?.props.role).toBe("alert");
      const alertText = alert ? renderGraph.textOf(alert) : "";
      expect(alertText).toContain("Showing 7 days");
      expect(alertText).toContain("Updating to 30 days failed");
      const retry = alert
        ? renderGraph
            .elementsNamed(alert, "button")
            .find((node) => renderGraph.textOf(node) === "Retry")
        : undefined;
      expect(retry).toBeDefined();
      if (!retry) throw new Error("the failed notice did not offer Retry");

      const beforeRetry = requests.length;
      renderGraph.listenerOf(retry, "onClick")?.({});
      await settle();

      expect(requests).toHaveLength(beforeRetry + 1);
      expect(requests.at(-1)).toBe("30d");
      expect(pending).toHaveLength(2);

      const second = pending[1];
      if (!second) throw new Error("Retry did not start a new range request");
      second.resolve(analyticsPayload("30d", "beta-30d", 480));
      await settle();
      await settle();

      expect(app.notice()).toBeUndefined();
      expect(app.text()).toContain("beta-30d");
    } finally {
      app.dispose();
    }
  });

  it("passes the payload's own range to the project view during a transition", async () => {
    const oldPayload = projectPayload("7d", "alpha-7d");
    const nextPayload = deferred<ProjectSnapshot>();
    const app = mountApp({
      path: "/project/project-alpha?range=7d",
      project: ({ range }) => (range === "7d" ? Promise.resolve(oldPayload) : nextPayload.promise),
    });

    try {
      await settle();
      expect(app.text()).toContain("alpha-7d");

      await app.navigate("/project/project-alpha?range=30d");
      expect(app.notice()).toBeUndefined();
      expect(app.text()).not.toContain("Showing 7 days while updating");
      // Inside the route, the breadcrumb and rows follow the payload, not the
      // range selector in the chrome.
      expect(app.text()).toContain("root-7d");
      expect(app.mainLink("/analytics?range=7d")).toBeDefined();
      expect(app.mainLink("/analytics?range=30d")).toBeUndefined();

      nextPayload.resolve(projectPayload("30d", "alpha-30d"));
      await settle();
      await settle();

      expect(app.notice()).toBeUndefined();
      expect(app.text()).toContain("alpha-30d");
      expect(app.text()).toContain("root-30d");
      expect(app.mainLink("/analytics?range=30d")).toBeDefined();
    } finally {
      app.dispose();
    }
  });

  it("leaves the session route and Quota without a range notice", async () => {
    const app = mountApp({ path: "/session/session-root-1" });
    try {
      await settle();
      expect(app.notice()).toBeUndefined();

      await app.navigate("/quota");
      await settle();
      expect(app.notice()).toBeUndefined();
      expect(app.text()).toContain("Five hour window");
    } finally {
      app.dispose();
    }
  });
});

/**
 * The settings editor holds the only unsaved draft on the dashboard, so unlike
 * the read-only sections it has to survive a refetch: every `settings.changed`
 * event (and every reconnect, and the reload after a 409) flips the query's
 * `loading`, and a keyed section branch would unmount the editor at each flip
 * and silently drop the draft. These tests mount the real `SettingsRoute` on the
 * universal renderer, type into the real fields, and drive the route's query
 * seam themselves, so the assertions read what the editor renders *next*
 * (design spec §10, §5.4; R14, R15).
 */
describe("the settings editor keeps its draft across refetches", () => {
  /** Render effects run with the update; this lets any deferred one land too. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  type SaveInput = Parameters<DashboardClient["saveSettings"]>[0];

  /** The query seam exactly as `createQuery` behaves: loading wraps the fetch. */
  function settingsQuery(initial: SettingsSnapshot | undefined) {
    const [data, setData] = renderGraph.createSignal<SettingsSnapshot | undefined>(initial);
    const [error, setError] = renderGraph.createSignal<unknown>(undefined);
    const [loading, setLoading] = renderGraph.createSignal(false);
    let queued: (() => SettingsSnapshot | Promise<SettingsSnapshot>) | undefined;
    const query = {
      data,
      error,
      loading,
      async run(): Promise<boolean> {
        setLoading(true);
        try {
          if (queued === undefined) throw new Error("probe: no settings fetch queued");
          setData(await queued());
          setError(undefined);
          return true;
        } catch (failure) {
          setError(failure);
          return false;
        } finally {
          setLoading(false);
        }
      },
    };
    return {
      query,
      setData,
      setLoading,
      /** The payload the next `run()` (an `onReload`) will land. */
      queueFetch(fetcher: () => SettingsSnapshot | Promise<SettingsSnapshot>): void {
        queued = fetcher;
      },
    };
  }

  const notUsed = (): Promise<never> =>
    Promise.reject(new Error("probe: unexpected dashboard call"));

  function mountSettings(options: {
    initial: SettingsSnapshot | undefined;
    saveSettings?: (input: SaveInput) => Promise<SettingsWriteResult>;
    openSettingsFile?: () => Promise<void>;
    catalog?: VisibilityCatalog;
  }) {
    const server = settingsQuery(options.initial);
    const saves: SaveInput[] = [];
    const toasts: { tone: string; message: string }[] = [];
    const client: DashboardClient = {
      openSettingsFile: options.openSettingsFile,
      health: notUsed,
      home: notUsed,
      quota: notUsed,
      project: notUsed,
      session: notUsed,
      settings: notUsed,
      saveVisibility: notUsed,
      importPreview: notUsed,
      importApply: notUsed,
      subscribe: () => () => {},
      connection: () => "live",
      onConnectionChange: () => () => {},
      async saveSettings(input) {
        saves.push(input);
        if (options.saveSettings) return options.saveSettings(input);
        return { revision: "revision-saved", applied: {}, warnings: [] };
      },
    };
    const root = renderGraph.createTestRoot();
    const dispose = renderGraph.mount(
      () =>
        renderGraph.liveSettings({
          client,
          query: server.query,
          catalog: () => options.catalog ?? { providers: [] },
          toaster: {
            toasts: () => [],
            push: (tone, message) => toasts.push({ tone, message }),
            dismiss: () => {},
          },
          stale: () => false,
        }),
      root,
    );
    return { root, server, saves, toasts, dispose };
  }

  /** Two providers with one card each; Beta carries no account identification. */
  function visibilityCatalog(): VisibilityCatalog {
    return {
      providers: [
        {
          providerId: "prov-alpha",
          providerLabel: "Alpha Provider",
          accountLabels: ["Plus"],
          cardIds: ["prov-alpha#cardhash"],
          rows: [{ id: "prov-alpha#cardhash#window:five_hour", label: "5h" }],
        },
        {
          providerId: "prov-beta",
          providerLabel: "Beta Provider",
          accountLabels: [],
          cardIds: ["prov-beta#cardhash"],
          rows: [{ id: "prov-beta#cardhash#window:weekly", label: "Weekly" }],
        },
      ],
    };
  }

  function findNode(nodes: TestNode[], match: (node: TestNode) => boolean, what: string): TestNode {
    const found = nodes.find(match);
    if (found === undefined) throw new Error(`probe: no ${what}`);
    return found;
  }

  const inputByLabel = (root: TestNode, label: string): TestNode =>
    findNode(
      renderGraph.elementsNamed(root, "input"),
      (node) => node.props["aria-label"] === label,
      `input labelled ${label}`,
    );

  const inputByPlaceholder = (root: TestNode, placeholder: string): TestNode =>
    findNode(
      renderGraph.elementsNamed(root, "input"),
      (node) => node.props.placeholder === placeholder,
      `input with placeholder ${placeholder}`,
    );

  const buttonByText = (root: TestNode, label: string): TestNode =>
    findNode(
      renderGraph.elementsNamed(root, "button"),
      (node) => renderGraph.textOf(node) === label,
      `button ${label}`,
    );

  /** Types into a rendered field the way typing in a browser would: through its own handler. */
  function typeInto(node: TestNode, value: string): void {
    const handler = renderGraph.listenerOf(node, "onInput");
    if (handler === undefined)
      throw new Error(
        `probe: <${node.tag}> has no onInput (props: ${Object.keys(node.props).join(", ")})`,
      );
    handler({ currentTarget: { value } });
  }

  function click(node: TestNode): void {
    const handler = renderGraph.listenerOf(node, "onClick");
    if (handler === undefined)
      throw new Error(
        `probe: <${node.tag}> has no onClick (props: ${Object.keys(node.props).join(", ")})`,
      );
    handler({});
  }

  /**
   * Fires one event listener out of the node's prop bag, whatever casing the
   * Solid compiler used for it, and explains the bag when it is missing: drag
   * events may not be delegated, so the exact stored name is not portable.
   */
  function fire(node: TestNode, name: string, event: TestEvent = {}): void {
    const key = Object.keys(node.props).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (key === undefined)
      throw new Error(
        `probe: <${node.tag}> has no ${name} (props: ${Object.keys(node.props).join(", ")})`,
      );
    const handler = renderGraph.listenerOf(node, key);
    if (handler === undefined)
      throw new Error(
        `probe: <${node.tag}>.${key} is not a listener (props: ${Object.keys(node.props).join(", ")})`,
      );
    handler(event);
  }

  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`probe: ${what} never happened`);
  }

  it("shows one Address, a complete native settings path, and opens only on explicit activation", async () => {
    const nativePath = path.join(
      path.parse(process.cwd()).root,
      "synthetic-settings",
      "quota",
      "config.jsonc",
    );
    let opens = 0;
    let finishOpen: (() => void) | undefined;
    const mounted = mountSettings({
      initial: settingsSnapshot({ pathLabel: nativePath }),
      openSettingsFile: async () => {
        opens += 1;
        await new Promise<void>((resolve) => {
          finishOpen = resolve;
        });
      },
    });
    const input = inputByLabel(mounted.root, "Minimum refresh interval (ms)");
    typeInto(input, "450000");
    const opener = renderGraph
      .elementsNamed(mounted.root, "button")
      .find((node) => node.props["aria-label"] === `Open settings file: ${nativePath}`);
    expect(opener).toBeDefined();
    if (!opener) throw new Error("Settings-file action missing");
    expect(renderGraph.textOf(opener)).toBe(nativePath);
    expect(
      renderGraph
        .elementsNamed(mounted.root, "a")
        .some((node) => String(node.props.href).startsWith("file:")),
    ).toBe(false);
    expect(
      renderGraph
        .elementsNamed(mounted.root, "input")
        .filter((node) => node.props["aria-label"] === "Dashboard address"),
    ).toHaveLength(1);
    expect(
      renderGraph
        .elementsNamed(mounted.root, "input")
        .some((node) => node.props["aria-label"] === "Dashboard port"),
    ).toBe(false);
    expect(opener.props.type).toBe("button");
    expect(opens).toBe(0);
    click(opener);
    await settle();
    expect(opens).toBe(1);
    expect(opener.props.disabled).toBe(true);
    click(opener);
    expect(opens).toBe(1);
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)")).toBe(input);
    finishOpen?.();
    await settle();
    expect(opener.props.disabled).toBe(false);
    expect(mounted.saves).toHaveLength(0);
    expect(mounted.toasts).toHaveLength(0);
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");
    mounted.dispose();
  });

  it.each([
    ["config-target-error", 409, "The settings file does not exist."],
    ["config-write-error", 500, "The default application could not be started."],
  ] as const)("keeps draft and shows an inline %s error without a success", async (code, status, message) => {
    const mounted = mountSettings({
      initial: settingsSnapshot(),
      openSettingsFile: async () => {
        throw renderGraph.dashboardFailure(code, status, message);
      },
    });
    const input = inputByLabel(mounted.root, "Minimum refresh interval (ms)");
    typeInto(input, "450000");
    const opener = renderGraph
      .elementsNamed(mounted.root, "button")
      .find((node) => String(node.props["aria-label"]).startsWith("Open settings file:"));
    if (!opener) throw new Error("Settings-file action missing");
    click(opener);
    await settle();
    expect(renderGraph.textOf(mounted.root)).toContain(message);
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)")).toBe(input);
    expect(input.props.value).toBe("450000");
    expect(mounted.toasts).toHaveLength(0);
    expect(mounted.saves).toHaveLength(0);
    expect(opener.props.disabled).toBe(false);
    mounted.dispose();
  });

  it("gracefully reports an older client without a file-open capability", async () => {
    const mounted = mountSettings({ initial: settingsSnapshot() });
    const opener = renderGraph
      .elementsNamed(mounted.root, "button")
      .find((node) => String(node.props["aria-label"]).startsWith("Open settings file:"));
    if (!opener) throw new Error("Settings-file action missing");
    click(opener);
    await settle();
    expect(renderGraph.textOf(mounted.root)).toContain(
      "Opening the settings file is not available with this server.",
    );
    expect(mounted.toasts).toHaveLength(0);
    mounted.dispose();
  });

  it("shows the first-load skeleton until a snapshot arrives, then the editor", async () => {
    const mounted = mountSettings({ initial: undefined });
    const skeleton = renderGraph.elementsNamed(mounted.root, "output");
    expect(skeleton.length).toBe(1);
    expect(skeleton[0]?.props["aria-label"]).toBe("Loading settings");
    expect(renderGraph.textOf(mounted.root)).not.toContain("No unsaved changes.");

    mounted.server.setData(settingsSnapshot());
    await settle();
    expect(renderGraph.elementsNamed(mounted.root, "output")).toHaveLength(0);
    expect(renderGraph.textOf(mounted.root)).toContain("No unsaved changes.");
    mounted.dispose();
  });

  it("keeps a typed edit through a refetch that starts and lands", async () => {
    const mounted = mountSettings({ initial: settingsSnapshot() });
    expect(renderGraph.textOf(mounted.root)).toContain("No unsaved changes.");

    const interval = () => inputByLabel(mounted.root, "Minimum refresh interval (ms)");
    typeInto(interval(), "450000");
    await settle();
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");
    const mountedInput = interval();

    // A `settings.changed` refetch: the query reports loading before the payload lands.
    mounted.server.setLoading(true);
    await settle();
    expect(interval()).toBe(mountedInput);
    expect(interval().props.value).toBe("450000");
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");

    // The refetch lands the same snapshot: the draft is still the user's.
    mounted.server.setData(settingsSnapshot());
    mounted.server.setLoading(false);
    await settle();
    expect(interval()).toBe(mountedInput);
    expect(interval().props.value).toBe("450000");
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");
    mounted.dispose();
  });

  it("the provider eye stores a provider id, leaves row ids alone, and surfaces no ids", async () => {
    const mounted = mountSettings({
      initial: settingsSnapshot(),
      catalog: visibilityCatalog(),
    });
    const eyeByLabel = (label: string): TestNode =>
      findNode(
        renderGraph.elementsNamed(mounted.root, "button"),
        (node) => node.props["aria-label"] === label,
        `eye ${label}`,
      );

    expect(eyeByLabel("Hide Alpha Provider").props["aria-pressed"]).toBe("false");
    expect(eyeByLabel("Hide Weekly").props["aria-pressed"]).toBe("false");

    // Hiding the provider names its id only; row eyes keep working underneath.
    click(eyeByLabel("Hide Alpha Provider"));
    await settle();
    expect(eyeByLabel("Show Alpha Provider").props["aria-pressed"]).toBe("true");
    click(eyeByLabel("Hide 5h"));
    await settle();
    expect(eyeByLabel("Show 5h").props["aria-pressed"]).toBe("true");

    // Showing the provider clears its card entries; the hidden row id survives.
    click(eyeByLabel("Show Alpha Provider"));
    await settle();
    expect(eyeByLabel("Hide Alpha Provider").props["aria-pressed"]).toBe("false");
    expect(eyeByLabel("Show 5h").props["aria-pressed"]).toBe("true");

    // Stable ids never display anywhere, retained or drafted.
    expect(renderGraph.textOf(mounted.root)).not.toContain("prov-alpha");
    expect(renderGraph.textOf(mounted.root)).not.toContain("cardhash");

    click(buttonByText(mounted.root, "Save"));
    await until(() => mounted.saves.length === 1, "the save");
    expect(mounted.saves[0]?.patch["dashboard.hiddenRows"]).toEqual([
      "prov-alpha#cardhash#window:five_hour",
    ]);
    expect(mounted.saves[0]?.patch["dashboard.hiddenCards"]).toBeUndefined();
    mounted.dispose();
  });

  it("Alt+Arrow reorders a provider and the save carries the complete provider order", async () => {
    const mounted = mountSettings({
      initial: settingsSnapshot(),
      catalog: visibilityCatalog(),
    });
    const betaGrip = findNode(
      renderGraph.elementsNamed(mounted.root, "button"),
      (node) => node.props["aria-label"] === "Reorder Beta Provider",
      "the Beta grip",
    );
    expect(betaGrip.props.draggable).toBe(true);
    const keyDown = renderGraph.listenerOf(betaGrip, "onKeyDown");
    expect(keyDown).toBeDefined();

    // A move writes the full current order, not a partial compare.
    keyDown?.({ altKey: true, key: "ArrowUp", preventDefault: () => {} });
    await settle();
    expect(renderGraph.textOf(mounted.root)).toContain("Beta Provider moved up.");
    expect(
      renderGraph
        .elementsNamed(mounted.root, "article")
        .find((node) => renderGraph.textOf(node).includes("Beta Provider")),
    ).toBeDefined();

    click(buttonByText(mounted.root, "Save"));
    await until(() => mounted.saves.length === 1, "the save");
    expect(mounted.saves[0]?.patch["dashboard.providerOrder"]).toEqual(["prov-beta", "prov-alpha"]);
    expect(mounted.saves[0]?.expectedRevision).toBe("revision-1");
    mounted.dispose();
  });

  it("dragging one provider card onto another writes the remove-then-insert order", async () => {
    const mounted = mountSettings({
      initial: settingsSnapshot(),
      catalog: visibilityCatalog(),
    });
    const cardOf = (label: string): TestNode =>
      findNode(
        renderGraph.elementsNamed(mounted.root, "article"),
        (node) => renderGraph.textOf(node).includes(label),
        `the ${label} card`,
      );
    const betaGrip = findNode(
      renderGraph.elementsNamed(mounted.root, "button"),
      (node) => node.props["aria-label"] === "Reorder Beta Provider",
      "the Beta grip",
    );
    const transfer = {
      setData: () => {},
      getData: () => "prov-beta",
      dropEffect: "",
      effectAllowed: "",
    };

    // The grip — never the eye — is the drag handle, and it carries the id.
    fire(betaGrip, "onDragStart", { dataTransfer: transfer });
    await settle();
    expect(cardOf("Beta Provider").props["data-dragging"]).toBe("true");
    fire(cardOf("Alpha Provider"), "onDragOver", {
      preventDefault: () => {},
      dataTransfer: transfer,
    });
    await settle();
    expect(cardOf("Alpha Provider").props["data-drop"]).toBe("true");

    fire(cardOf("Alpha Provider"), "onDrop", { preventDefault: () => {}, dataTransfer: transfer });
    await settle();
    expect(cardOf("Beta Provider").props["data-dragging"]).toBeUndefined();
    expect(cardOf("Alpha Provider").props["data-drop"]).toBeUndefined();

    click(buttonByText(mounted.root, "Save"));
    await until(() => mounted.saves.length === 1, "the save");
    expect(mounted.saves[0]?.patch["dashboard.providerOrder"]).toEqual(["prov-beta", "prov-alpha"]);
    mounted.dispose();
  });

  it("adopts a fresh revision on a clean refresh so the next save carries it", async () => {
    const mounted = mountSettings({ initial: settingsSnapshot() });
    const fresh = settingsSnapshot({ revision: "revision-2" });
    fresh.values.minIntervalMs = 400000;
    mounted.server.setData(fresh);
    await settle();

    // The snapshot prop is reactive: the mounted field shows the file's value.
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)").props.value).toBe("400000");

    typeInto(inputByLabel(mounted.root, "Request timeout (ms)"), "25000");
    await settle();
    mounted.server.queueFetch(() => settingsSnapshot({ revision: "revision-3" }));
    click(buttonByText(mounted.root, "Save"));
    await until(() => mounted.saves.length === 1, "the save request");
    expect(mounted.saves[0]).toEqual({
      patch: { requestTimeoutMs: 25000 },
      expectedRevision: "revision-2",
    });
    await until(
      () => renderGraph.textOf(mounted.root).includes("No unsaved changes."),
      "the save to clear the draft",
    );
    mounted.dispose();
  });

  it("keeps the edits and adopts the latest revision after a 409, so an explicit retry saves them", async () => {
    let attempts = 0;
    const mounted = mountSettings({
      initial: settingsSnapshot(),
      saveSettings: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw renderGraph.configChangedError();
        }
        return { revision: "revision-4", applied: input.patch, warnings: [] };
      },
    });

    typeInto(inputByLabel(mounted.root, "Minimum refresh interval (ms)"), "450000");
    await settle();

    // The reload after the conflict reports what is actually on disk now.
    const latest = settingsSnapshot({ revision: "revision-2" });
    latest.values.minIntervalMs = 400000;
    mounted.server.queueFetch(() => latest);

    click(buttonByText(mounted.root, "Save"));
    await until(
      () => renderGraph.textOf(mounted.root).includes("settings changed elsewhere"),
      "the conflict notice",
    );
    expect(mounted.saves[0]?.expectedRevision).toBe("revision-1");
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)").props.value).toBe("450000");
    expect(mounted.toasts.some((toast) => toast.message.includes("Your edits were kept"))).toBe(
      true,
    );

    mounted.server.queueFetch(() => settingsSnapshot({ revision: "revision-3" }));
    click(buttonByText(mounted.root, "Save"));
    await until(() => mounted.saves.length === 2, "the retry");
    expect(mounted.saves[1]).toEqual({
      patch: { minIntervalMs: 450000 },
      expectedRevision: "revision-2",
    });
    await until(
      () => renderGraph.textOf(mounted.root).includes("No unsaved changes."),
      "the retry to clear the draft",
    );
    mounted.dispose();
  });

  it("discard returns the editor to the fresh snapshot", async () => {
    const mounted = mountSettings({ initial: settingsSnapshot() });
    typeInto(inputByLabel(mounted.root, "Minimum refresh interval (ms)"), "450000");
    await settle();

    const latest = settingsSnapshot({ revision: "revision-2" });
    latest.values.minIntervalMs = 400000;
    mounted.server.setData(latest);
    await settle();
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)").props.value).toBe("450000");
    expect(renderGraph.textOf(mounted.root)).toContain("settings changed elsewhere");

    click(buttonByText(mounted.root, "Discard"));
    await settle();
    expect(inputByLabel(mounted.root, "Minimum refresh interval (ms)").props.value).toBe("400000");
    expect(renderGraph.textOf(mounted.root)).toContain("No unsaved changes.");
    expect(renderGraph.textOf(mounted.root)).not.toContain("settings changed elsewhere");
    mounted.dispose();
  });

  it("keeps provider text in step with the inherited list until the user types", async () => {
    const manual = settingsSnapshot();
    manual.values.enabledProviders = ["anthropic", "openai"];
    const mounted = mountSettings({ initial: manual });
    const providerText = () => inputByPlaceholder(mounted.root, "provider ids, comma separated");
    expect(providerText().props.value).toBe("anthropic, openai");

    // Clean: a refresh brings the file's inherited list and the text follows it.
    const inherited = settingsSnapshot({ revision: "revision-2" });
    inherited.values.enabledProviders = ["anthropic"];
    mounted.server.setData(inherited);
    await settle();
    expect(providerText().props.value).toBe("anthropic");

    // Dirty: the user's unsaved text belongs to the user; a refresh must not drop it.
    typeInto(providerText(), "anthropic, google");
    await settle();
    const changed = settingsSnapshot({ revision: "revision-3" });
    changed.values.enabledProviders = ["openai"];
    mounted.server.setData(changed);
    await settle();
    expect(providerText().props.value).toBe("anthropic, google");
    expect(renderGraph.textOf(mounted.root)).toContain("1 unsaved change(s)");
    mounted.dispose();
  });
});

describe("response boundary decoding", () => {
  function stack(input: number, rest = 0) {
    return { input, cacheRead: rest, cacheWrite: rest, output: rest, reasoning: rest };
  }

  function costed(input: number) {
    return {
      input,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: input,
      apiEquivalentCostUsd: null,
      unpricedTokens: 0,
      unknownTokens: 0,
    };
  }

  function validHome() {
    return {
      generatedAtMs: 1_700_000_000_000,
      range: "7d",
      stale: false,
      providers: {
        cards: [
          {
            cardId: "provider-1#cardhash",
            providerId: "synthetic",
            providerLabel: "Synthetic Provider",
            accountLabel: "Main account",
            labelSource: "connection",
            rows: [
              {
                rowId: "provider-1#cardhash#window:five_hour",
                label: "Five hour window",
                kind: "percent",
                resultType: "quota",
                percentRemaining: 62,
                percentUsed: 38,
              },
            ],
            errors: [],
          },
        ],
        enabledProviders: "auto",
        polledAtMs: 1_700_000_000_000,
      },
      usage: {
        range: "7d",
        window: { sinceMs: 1_699_000_000_000, untilMs: 1_700_000_000_000 },
        bucketUnit: "day",
        timeZone: "UTC",
        buckets: [{ startMs: 1_699_000_000_000, endMs: 1_700_000_000_000, tokens: costed(150) }],
        totals: costed(150),
        stepCount: 1,
        sessionCount: 1,
        stale: false,
      },
      projects: [
        {
          projectId: "project-alpha",
          name: "alpha",
          tokens: costed(10),
          rootSessionCount: 1,
          latestActivityAtMs: 1_700_000_000_000,
        },
      ],
    };
  }

  function validSettings() {
    return {
      revision: "revision-1",
      pathLabel: "config.jsonc",
      values: {
        formatStyle: "singleWindow",
        quotaProjection: "runway",
        resetTimeDecimals: 2,
        enabledProviders: ["anthropic"],
        waitForQuotaReset: null,
      },
      sources: { formatStyle: "quota-toast.jsonc" },
      writable: ["formatStyle"],
      dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
      visibility: { hiddenCards: [], hiddenRows: ["provider-1#cardhash#aggregate"] },
      import: { available: true, from: "workspace: synthetic", keyCount: 2, issues: [] },
      issues: [],
    };
  }

  function expectRejected(run: () => void, field: string): void {
    try {
      run();
    } catch (error) {
      if (!(error instanceof DashboardError)) {
        throw new Error(`the boundary threw a non-dashboard error for ${field}: ${String(error)}`);
      }
      expect(error.code).toBe("invalid-response");
      expect(error.message).toContain(field);
      return;
    }
    throw new Error(`the boundary accepted a payload with a bad ${field}`);
  }

  it("builds the home payload field by field", () => {
    const snapshot = parseHomeSnapshot(validHome());
    expect(snapshot.range).toBe("7d");
    expect(snapshot.providers.cards).toHaveLength(1);
    expect(snapshot.providers.cards[0]?.cardId).toBe("provider-1#cardhash");
    expect(snapshot.providers.cards[0]?.accountLabel).toBe("Main account");
    expect(snapshot.providers.cards[0]?.rows[0]?.percentRemaining).toBe(62);
    expect(snapshot.usage.buckets[0]?.tokens.total).toBe(150);
    expect(snapshot.usage.window.sinceMs).toBe(1_699_000_000_000);
    expect(snapshot.projects[0]?.name).toBe("alpha");
  });

  it("omits optional fields the payload did not carry instead of inventing them", () => {
    const payload = validHome();
    const { accountLabel, ...cardWithoutAccount } = payload.providers.cards[0];
    void accountLabel;
    const snapshot = parseHomeSnapshot({
      ...payload,
      providers: { ...payload.providers, cards: [cardWithoutAccount] },
    });
    expect(snapshot.providers.cards[0]).not.toHaveProperty("accountLabel");
    expect(snapshot.providers.cards[0]).toHaveProperty("rows");
    // A lifetime window has no start.
    const lifetime = parseHomeSnapshot({
      ...payload,
      usage: { ...payload.usage, window: { untilMs: 1_700_000_000_000 } },
    });
    expect(lifetime.usage.window).not.toHaveProperty("sinceMs");
  });

  it("rejects a payload that is not an object, or whose root fields are missing", () => {
    expectRejected(() => parseHomeSnapshot("nope"), "/api/v1/home");
    const { generatedAtMs, ...withoutGeneratedAt } = validHome();
    void generatedAtMs;
    expectRejected(() => parseHomeSnapshot(withoutGeneratedAt), "generatedAtMs");
    const { providers, ...withoutProviders } = validHome();
    void providers;
    expectRejected(() => parseHomeSnapshot(withoutProviders), "providers");
  });

  it("rejects wrong-typed nested fields instead of rendering them", () => {
    const payload = validHome();
    const card = payload.providers.cards[0];
    expectRejected(
      () =>
        parseHomeSnapshot({
          ...payload,
          providers: { ...payload.providers, cards: [{ ...card, providerLabel: 7 }] },
        }),
      "providers.cards[].providerLabel",
    );
    expectRejected(
      () =>
        parseHomeSnapshot({
          ...payload,
          providers: { ...payload.providers, cards: [{ ...card, labelSource: "guesswork" }] },
        }),
      "providers.cards[].labelSource",
    );
    expectRejected(
      () =>
        parseHomeSnapshot({
          ...payload,
          providers: {
            ...payload.providers,
            cards: [{ ...card, rows: [{ ...card.rows[0], kind: "nope" }] }],
          },
        }),
      "providers.cards[].rows[].kind",
    );
    expectRejected(
      () => parseHomeSnapshot({ ...payload, usage: { ...payload.usage, bucketUnit: "minute" } }),
      "usage.bucketUnit",
    );
    expectRejected(() => parseHomeSnapshot({ ...payload, range: "90d" }), "range");
  });

  it("rejects a token total that is not the sum of the five categories (invariant 1)", () => {
    const payload = validHome();
    expectRejected(
      () =>
        parseHomeSnapshot({
          ...payload,
          usage: { ...payload.usage, totals: { ...payload.usage.totals, total: 999 } },
        }),
      "usage.totals",
    );
    expectRejected(
      () =>
        parseHomeSnapshot({
          ...payload,
          usage: {
            ...payload.usage,
            buckets: [
              { ...payload.usage.buckets[0], tokens: { ...payload.usage.totals, total: 999 } },
            ],
          },
        }),
      "usage.buckets[].tokens",
    );
  });

  it("keeps the settings values the contract allows and rejects wrong-typed ones", () => {
    const settings = parseSettingsSnapshot(validSettings());
    expect(settings.dashboard.port).toBe(4144);
    expect(settings.visibility.hiddenRows).toEqual(["provider-1#cardhash#aggregate"]);
    expect(settings.values.quotaProjection).toBe("runway");
    expect(settings.sources.formatStyle).toBe("quota-toast.jsonc");
    expect(settings.import.from).toBe("workspace: synthetic");

    const payload = validSettings();
    expectRejected(
      () => parseSettingsSnapshot({ ...payload, dashboard: { port: "4144", url: "http://x" } }),
      "dashboard.port",
    );
    expectRejected(
      () => parseSettingsSnapshot({ ...payload, visibility: { hiddenCards: [], hiddenRows: "x" } }),
      "visibility.hiddenRows",
    );
    expectRejected(
      () => parseSettingsSnapshot({ ...payload, sources: { formatStyle: 3 } }),
      "sources.formatStyle",
    );
    // An omitted optional import label stays omitted rather than becoming "".
    const minimal = parseSettingsSnapshot({
      ...payload,
      values: {},
      sources: {},
      writable: [],
      import: { available: false, issues: [] },
    });
    expect(minimal.import).not.toHaveProperty("from");
    expect(minimal.import).not.toHaveProperty("keyCount");
  });

  it("decodes the write result and the import preview", () => {
    const write = parseSettingsWriteResult(
      { revision: "revision-2", applied: { formatStyle: "allWindows" }, warnings: [] },
      "/api/v1/settings",
    );
    expect(write.revision).toBe("revision-2");
    expect(write.applied.formatStyle).toBe("allWindows");
    expectRejected(
      () =>
        parseSettingsWriteResult({ revision: 2, applied: {}, warnings: [] }, "/api/v1/settings"),
      "revision",
    );

    const preview = parseImportPreview(
      {
        from: "workspace: synthetic",
        keys: [{ key: "formatStyle", value: "allWindows" }],
        issues: [{ key: "quotaProjection", message: "unknown key" }],
        expectedRevision: "revision-3",
      },
      "/api/v1/settings/import",
    );
    expect(preview.keys[0]?.value).toBe("allWindows");
    expect(preview.issues[0]?.message).toBe("unknown key");
    expectRejected(
      () =>
        parseImportPreview(
          { from: "x", keys: [], issues: [], expectedRevision: 1 },
          "/api/v1/settings/import",
        ),
      "expectedRevision",
    );
  });

  it("decodes project and session payloads, including step stacks", () => {
    // These counts are nested by contract, not by convenience: src/contracts/dashboard.ts
    // declares `totals: CostedTokens & { sessionCount }` (:180) and
    // `ownSummary: CostedTokens & { stepCount }` (:217), and that is exactly what P4
    // builds (src/gui/aggregation.ts:810 `totals: { ...tokens, sessionCount }`,
    // :985 `ownSummary: { ...tokens, stepCount }`). The flat shapes are rejected at
    // the end of this test, so a reader that started accepting them would fail here.
    const projectPayload = {
      projectId: "project-alpha",
      name: "alpha",
      range: "30d",
      window: { untilMs: 2 },
      roots: [
        {
          sessionId: "session-root-1",
          title: "Refactor",
          worktreeLabel: "alpha-main",
          tokens: costed(1),
          latestActivityAtMs: 1,
        },
      ],
      totals: { ...costed(1), sessionCount: 1 },
      usage: validHome().usage,
      stale: false,
    };
    const project = parseProjectSnapshot(projectPayload, "/api/v1/projects/project-alpha");
    expect(project.roots[0]?.worktreeLabel).toBe("alpha-main");
    expect(project.totals.sessionCount).toBe(1);
    expect(project.window).not.toHaveProperty("sinceMs");

    const sessionPayload = {
      focusSessionId: "session-root-1",
      projectId: "project-alpha",
      projectName: "Alpha",
      timeZone: "UTC",
      breadcrumbs: [{ sessionId: "session-root-1", title: "Refactor", isFocus: true }],
      nodes: [
        {
          sessionId: "session-root-1",
          title: "Refactor",
          depth: 0,
          childIds: [],
          ownTokens: costed(1),
          subtreeTokens: costed(1),
          stepCount: 1,
          subtreeNodeCount: 1,
          latestActivityAtMs: 1,
        },
      ],
      steps: [
        {
          sessionId: "session-root-1",
          messageId: "msg-1",
          atMs: 1,
          branch: 0,
          stack: stack(1),
          contextTokens: 1,
          totalTokens: 1,
        },
      ],
      compactionMarkers: [{ sessionId: "session-root-1", atMs: 1, messageId: "msg-0" }],
      ownSummary: { ...costed(1), stepCount: 1 },
      treeTotals: costed(1),
      stepSemantics: "One step is one completed assistant message.",
    };
    const session = parseSessionSnapshot(sessionPayload, "/api/v1/sessions/session-root-1");
    expect(session.steps[0]?.stack.input).toBe(1);
    expect(session.ownSummary.stepCount).toBe(1);
    expect(session.compactionMarkers[0]?.messageId).toBe("msg-0");
    expect(session.breadcrumbs[0]?.isFocus).toBe(true);
    expect(session.projectId).toBe("project-alpha");
    expect(session.projectName).toBe("Alpha");

    // A flat count is the wrong shape: the nested field is what the contract and the
    // server both carry, so the reader must keep requiring it instead of quietly
    // accepting a root-level one.
    const { sessionCount, ...totalsWithoutCount } = projectPayload.totals;
    void sessionCount;
    expectRejected(
      () =>
        parseProjectSnapshot(
          { ...projectPayload, sessionCount, totals: totalsWithoutCount },
          "/api/v1/projects/project-alpha",
        ),
      "totals.sessionCount",
    );
    const { stepCount, ...ownSummaryWithoutSteps } = sessionPayload.ownSummary;
    void stepCount;
    expectRejected(
      () =>
        parseSessionSnapshot(
          { ...sessionPayload, stepCount, ownSummary: ownSummaryWithoutSteps },
          "/api/v1/sessions/session-root-1",
        ),
      "ownSummary.stepCount",
    );
    const { projectName, ...sessionWithoutProjectName } = sessionPayload;
    void projectName;
    expectRejected(
      () => parseSessionSnapshot(sessionWithoutProjectName, "/api/v1/sessions/session-root-1"),
      "projectName",
    );

    expectRejected(
      () =>
        parseSessionSnapshot(
          {
            focusSessionId: "s",
            projectId: "p",
            projectName: "Project",
            timeZone: "UTC",
            breadcrumbs: [],
            nodes: [],
            steps: [
              {
                sessionId: "s",
                messageId: "m",
                atMs: 1,
                branch: 0,
                stack: { input: -1, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
                contextTokens: 1,
                totalTokens: 1,
              },
            ],
            compactionMarkers: [],
            ownSummary: { ...costed(0), stepCount: 0 },
            treeTotals: costed(0),
            stepSemantics: "x",
          },
          "/api/v1/sessions/s",
        ),
      "steps[].stack",
    );
  });
});

describe("routing and range persistence", () => {
  it("replaces root with Quota and leaves analytics lazy while remembering the stored range", async () => {
    let url = new URL("http://localhost:4144/");
    const replace = vi.fn((_state: unknown, _title: string, path: string) => {
      url = new URL(path, url);
    });
    const stored = new Map([[RANGE_STORAGE_KEY, "30d"]]);
    vi.stubGlobal("window", {
      get location() {
        return url;
      },
      history: { replaceState: replace },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    let quotaReads = 0;
    let analyticsReads = 0;
    const client: DashboardClient = {
      connection: () => "live",
      onConnectionChange: () => () => {},
      subscribe: () => () => {},
      health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
      quota: async () => {
        quotaReads += 1;
        return homeSnapshot();
      },
      home: async () => {
        analyticsReads += 1;
        return homeSnapshot();
      },
      project: async () => projectSnapshot(),
      session: async () => sessionSnapshot(),
      settings: async () => settingsSnapshot(),
      saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
      saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
      importPreview: async () => ({
        from: "synthetic",
        keys: [],
        issues: [],
        expectedRevision: "r",
      }),
      importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
    };
    const root = renderGraph.createTestRoot();
    let dispose: (() => void) | undefined;
    try {
      dispose = renderGraph.mount(() => renderGraph.app({ client }), root);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/quota");
      expect(url.pathname).toBe("/quota");
      expect(quotaReads).toBe(1);
      expect(analyticsReads).toBe(0);
      expect(
        renderGraph
          .elementsNamed(root, "a")
          .find((node) => node.props["aria-label"] === "Analytics")?.props.href,
      ).toBe("/analytics?range=30d");
    } finally {
      dispose?.();
      vi.unstubAllGlobals();
    }
  });

  it("replaces startup URLs, pushes links once and follows back/forward without duplicate reads", async () => {
    const entries = [new URL("http://localhost:4144/#/analytics?range=24h")];
    let index = 0;
    const listeners = new Map<string, (event?: unknown) => void>();
    const stored = new Map([[RANGE_STORAGE_KEY, "30d"]]);
    const browser = {
      get location() {
        return entries[index];
      },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
      },
      history: {
        replaceState: (_state: unknown, _title: string, path: string) => {
          entries[index] = new URL(path, entries[index]);
        },
        pushState: (_state: unknown, _title: string, path: string) => {
          entries.splice(index + 1);
          entries.push(new URL(path, entries[index]));
          index += 1;
        },
        back: () => {
          index -= 1;
          listeners.get("popstate")?.();
        },
        forward: () => {
          index += 1;
          listeners.get("popstate")?.();
        },
      },
      addEventListener: (name: string, callback: () => void) => {
        listeners.set(name, callback);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    };
    vi.stubGlobal("window", browser);
    const ranges: RangeKey[] = [];
    const sessions: string[] = [];
    let subscriptions = 0;
    const client: DashboardClient = {
      connection: () => "live",
      onConnectionChange: () => () => {},
      subscribe: () => {
        subscriptions += 1;
        return () => {
          subscriptions -= 1;
        };
      },
      health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
      quota: async () => homeSnapshot(),
      home: async ({ range }) => {
        ranges.push(range);
        return homeSnapshot({ range });
      },
      project: async () => projectSnapshot(),
      session: async ({ sessionId }) => {
        sessions.push(sessionId);
        return sessionSnapshot();
      },
      settings: async () => settingsSnapshot(),
      saveSettings: async () => ({ revision: "r", applied: {}, warnings: [] }),
      saveVisibility: async () => ({ revision: "r", applied: {}, warnings: [] }),
      importPreview: async () => ({
        from: "synthetic",
        keys: [],
        issues: [],
        expectedRevision: "r",
      }),
      importApply: async () => ({ revision: "r", applied: {}, warnings: [] }),
    };
    const root = renderGraph.createTestRoot();
    let dispose: (() => void) | undefined;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const click = (href: string, modifiers: Record<string, unknown> = {}) => {
      const preventDefault = vi.fn();
      const anchor = {
        getAttribute: (key: string) => (key === "href" ? href : null),
        hasAttribute: () => false,
      };
      listeners.get("click")?.({
        button: 0,
        defaultPrevented: false,
        target: { closest: () => anchor },
        preventDefault,
        ...modifiers,
      });
      return preventDefault;
    };
    try {
      dispose = renderGraph.mount(() => renderGraph.app({ client }), root);
      await settle();
      expect(browser.location?.pathname + browser.location?.search).toBe("/analytics?range=24h");
      expect(browser.location?.hash).toBe("");
      expect(entries).toHaveLength(1);
      expect(ranges).toEqual(["24h"]);
      expect(stored.get(RANGE_STORAGE_KEY)).toBe("24h");
      expect(listeners.has("hashchange")).toBe(false);
      expect(subscriptions).toBe(1);
      expect(click("/analytics?range=7d", { ctrlKey: true })).not.toHaveBeenCalled();
      expect(click("/analytics?range=7d")).toHaveBeenCalledOnce();
      await settle();
      expect(entries).toHaveLength(2);
      expect(ranges).toEqual(["24h", "7d"]);
      click("/analytics?range=7d");
      await settle();
      expect(entries).toHaveLength(2);
      expect(ranges).toEqual(["24h", "7d"]);
      browser.history.back();
      await settle();
      expect(ranges).toEqual(["24h", "7d", "24h"]);
      expect(stored.get(RANGE_STORAGE_KEY)).toBe("24h");
      browser.history.forward();
      await settle();
      expect(ranges).toEqual(["24h", "7d", "24h", "7d"]);
      click("/session/ses%201");
      await settle();
      expect(sessions).toEqual(["ses 1"]);
      expect(browser.location?.search).toBe("");
      expect(subscriptions).toBe(1);
    } finally {
      dispose?.();
      expect(subscriptions).toBe(0);
      expect(listeners.size).toBe(0);
      vi.unstubAllGlobals();
    }
  });

  it("parses clean routes", () => {
    expect(parseLocation("/quota", "7d").route).toEqual({ name: "home" });
    expect(parseLocation("/analytics?range=24h", "7d")).toEqual({
      route: { name: "analytics" },
      range: "24h",
    });
    expect(parseLocation("/settings", "7d").route).toEqual({ name: "settings" });
    expect(parseLocation("/project/alpha?range=30d", "7d")).toEqual({
      route: { name: "project", projectId: "alpha" },
      range: "30d",
    });
    expect(parseLocation("/session/ses%201", "7d").route).toEqual({
      name: "session",
      sessionId: "ses 1",
    });
    expect(parseLocation("/nope", "7d").route).toEqual({ name: "not-found", path: "/nope" });
  });

  it("lets a URL range win and keeps the session page range-free", () => {
    expect(parseLocation("/analytics?range=24h", "30d").range).toBe("24h");
    expect(parseLocation("/analytics?range=bogus", "30d").range).toBe("30d");
    expect(parseLocation("/session/abc?range=24h", "30d")).toEqual({
      route: { name: "session", sessionId: "abc" },
      range: "24h",
    });
    expect(routeUsesRange({ name: "home" })).toBe(false);
    expect(routeUsesRange({ name: "analytics" })).toBe(true);
    expect(routeUsesRange({ name: "project", projectId: "a" })).toBe(true);
    expect(routeUsesRange({ name: "session", sessionId: "a" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "session", sessionId: "a" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "settings" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "home" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "analytics" })).toBe(true);
  });

  it("formats canonical paths with only range-scoped queries", () => {
    expect(formatPath({ name: "home" }, "7d")).toBe("/quota");
    expect(formatPath({ name: "analytics" }, "30d")).toBe("/analytics?range=30d");
    expect(formatPath({ name: "project", projectId: "a b" }, "24h")).toBe(
      "/project/a%20b?range=24h",
    );
    expect(formatPath({ name: "session", sessionId: "ses_1" }, "30d")).toBe("/session/ses_1");
    expect(formatPath({ name: "settings" }, "lifetime")).toBe("/settings");
  });

  it("persists the range and falls back safely", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(readStoredRange(undefined)).toBe("7d");
    expect(readStoredRange(storage)).toBe("7d");
    writeStoredRange(storage, "lifetime");
    expect(store.get(RANGE_STORAGE_KEY)).toBe("lifetime");
    expect(readStoredRange(storage)).toBe("lifetime");
    store.set(RANGE_STORAGE_KEY, "weekly");
    expect(readStoredRange(storage)).toBe("7d");
    expect(
      readStoredRange({
        getItem: () => {
          throw new Error("storage blocked");
        },
      }),
    ).toBe("7d");
  });
});

describe("styles and dependency boundaries", () => {
  it("loads Quota without analytics and reports reconnect only in chrome", async () => {
    const browser = historyBrowser("/quota");
    vi.stubGlobal("window", browser);
    let onConnection: ((state: "connecting" | "live" | "reconnecting") => void) | undefined;
    let onEvent: Parameters<DashboardClient["subscribe"]>[0] | undefined;
    let quotaReads = 0;
    let analyticsReads = 0;
    let failQuota = false;
    const viewSignals: string[] = [];
    let failViewSignal = false;
    let finishInitialSignal: (() => void) | undefined;
    const client: DashboardClient = {
      setActiveView: async (scope) => {
        viewSignals.push(scope);
        if (viewSignals.length === 1) {
          await new Promise<void>((resolve) => {
            finishInitialSignal = resolve;
          });
        }
        if (failViewSignal)
          throw new DashboardError("not-found", 404, "Optional endpoint unavailable.");
      },
      connection: () => "live",
      onConnectionChange: (callback) => {
        onConnection = callback;
        return () => {
          onConnection = undefined;
        };
      },
      subscribe: (callback) => {
        onEvent = callback;
        return () => {
          onEvent = undefined;
        };
      },
      health: async () => ({ app: "opencode-quota-gui", contractVersion: 2 }),
      quota: async () => {
        quotaReads += 1;
        if (failQuota) throw new Error("synthetic failure");
        return homeSnapshot();
      },
      home: async () => {
        analyticsReads += 1;
        return homeSnapshot();
      },
      project: async () => projectSnapshot(),
      session: async () => sessionSnapshot(),
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
    const root = renderGraph.createTestRoot();
    let dispose: (() => void) | undefined;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      dispose = renderGraph.mount(() => renderGraph.app({ client }), root);
      await settle();
      expect(quotaReads).toBe(1);
      expect(analyticsReads).toBe(0);
      expect(viewSignals).toEqual(["quota"]);
      onEvent?.({ topic: "sessions.changed", at: NOW });
      await settle();
      expect(quotaReads).toBe(1);
      expect(analyticsReads).toBe(0);
      expect(renderGraph.textOf(root)).toContain("Five hour window");
      expect(renderGraph.textOf(root)).not.toContain("Total tokens");
      const ancestors = (node: TestNode): TestNode[] => {
        const parents: TestNode[] = [];
        for (let parent = node.parent; parent; parent = parent.parent) parents.push(parent);
        return parents;
      };
      const chrome = renderGraph
        .elementsNamed(root, "header")
        .find((node) => node.props.class === "qg-chrome");
      const frame = renderGraph
        .elementsNamed(root, "div")
        .find((node) => node.props.class === "qg-frame");
      expect(chrome).toBeDefined();
      expect(frame).toBeDefined();
      for (const label of ["Quota", "Analytics", "Settings"]) {
        const link = renderGraph
          .elementsNamed(root, "a")
          .find((node) => node.props["aria-label"] === label);
        expect(link).toBeDefined();
        if (link) {
          expect(ancestors(link)).toContain(chrome);
          expect(ancestors(link)).not.toContain(frame);
        }
      }
      expect(renderGraph.textOf(root)).not.toContain("OpenCode");
      expect(viewSignals).toEqual(["quota"]);
      finishInitialSignal?.();
      await settle();
      expect(viewSignals).toEqual(["quota"]);
      const status = () =>
        renderGraph.elementsNamed(root, "span").filter((node) => node.props.class === "qg-stale");
      expect(status()).toHaveLength(0);
      onConnection?.("reconnecting");
      expect(status()).toHaveLength(1);
      expect(renderGraph.textOf(root)).toContain("Reconnecting…");
      expect(
        renderGraph.elementsNamed(root, "div").filter((node) => node.props.class === "qg-toast"),
      ).toHaveLength(0);
      failQuota = true;
      onConnection?.("live");
      await settle();
      expect(quotaReads).toBe(2);
      expect(viewSignals).toEqual(["quota", "quota"]);
      onConnection?.("live");
      await settle();
      expect(viewSignals).toEqual(["quota", "quota"]);
      expect(analyticsReads).toBe(0);
      expect(status()).toHaveLength(1);
      expect(renderGraph.textOf(root)).toContain("Data may be stale");
      expect(renderGraph.textOf(root)).toContain("Five hour window");
      failQuota = false;
      onConnection?.("reconnecting");
      onConnection?.("live");
      await settle();
      expect(status()).toHaveLength(0);
      expect(viewSignals).toEqual(["quota", "quota", "quota"]);
      browser.follow("/analytics?range=30d");
      await settle();
      expect(analyticsReads).toBe(1);
      expect(viewSignals).toEqual(["quota", "quota", "quota", "analytics"]);
      const rangeButton = renderGraph
        .elementsNamed(root, "button")
        .find((node) => renderGraph.textOf(node) === "24h");
      expect(rangeButton).toBeDefined();
      if (rangeButton) {
        expect(ancestors(rangeButton)).toContain(frame);
        expect(ancestors(rangeButton)).not.toContain(chrome);
      }
      onEvent?.({ topic: "quota.changed", at: NOW });
      await settle();
      expect(analyticsReads).toBe(1);
      expect(renderGraph.textOf(root)).toContain("Total tokens");
      expect(renderGraph.textOf(root)).not.toContain("Five hour window");
      expect(
        renderGraph
          .elementsNamed(root, "a")
          .find((node) => node.props["aria-label"] === "Analytics")?.props["aria-current"],
      ).toBe("page");
      const navigate = async (path: string) => {
        browser.follow(path);
        await settle();
      };
      await navigate("/analytics?range=7d");
      await navigate("/project/project-alpha?range=7d");
      await navigate("/session/session-root-1");
      expect(viewSignals).toEqual(["quota", "quota", "quota", "analytics"]);
      onConnection?.("reconnecting");
      onConnection?.("live");
      await settle();
      expect(viewSignals.at(-1)).toBe("analytics");
      expect(viewSignals).toHaveLength(5);
      await navigate("/quota");
      expect(viewSignals.at(-1)).toBe("quota");
      expect(viewSignals).toHaveLength(6);
      expect(renderGraph.textOf(root)).toContain("Five hour window");
      failViewSignal = true;
      await navigate("/settings");
      const interval = () =>
        renderGraph
          .elementsNamed(root, "input")
          .find((node) => node.props["aria-label"] === "Minimum refresh interval (ms)");
      const editorInput = interval();
      const dock = renderGraph
        .elementsNamed(root, "div")
        .find((node) => node.props.class === "qg-savebar");
      const scrollContent = renderGraph
        .elementsNamed(root, "div")
        .find((node) => node.props.class === "qg-form qg-settings__scroll");
      expect(dock).toBeDefined();
      expect(scrollContent).toBeDefined();
      expect(dock?.parent).toBe(scrollContent?.parent);
      expect(dock?.parent?.props.class).toBe("qg-settings");
      if (dock && scrollContent) expect(ancestors(dock)).not.toContain(scrollContent);
      expect(editorInput).toBeDefined();
      if (!editorInput) throw new Error("Settings editor did not mount");
      renderGraph.listenerOf(editorInput, "onInput")?.({ currentTarget: { value: "450000" } });
      await settle();
      expect(renderGraph.textOf(root)).toContain("1 unsaved change(s)");
      // Reassertion rejects like an older backend: no remount, blanking or retries.
      onConnection?.("reconnecting");
      onConnection?.("live");
      await settle();
      expect(viewSignals).toHaveLength(7);
      expect(viewSignals.at(-1)).toBe("quota");
      expect(interval()).toBe(editorInput);
      expect(
        renderGraph.elementsNamed(root, "div").find((node) => node.props.class === "qg-savebar"),
      ).toBe(dock);
      expect(interval()?.props.value).toBe("450000");
      expect(renderGraph.textOf(root)).toContain("1 unsaved change(s)");
      onEvent?.({ topic: "settings.changed", at: NOW });
      onConnection?.("live");
      await settle();
      await settle();
      expect(viewSignals).toHaveLength(7);
      expect(interval()).toBe(editorInput);
      expect(renderGraph.textOf(root)).not.toContain("Optional endpoint unavailable");
      client.setActiveView = undefined;
      await navigate("/analytics?range=7d");
      expect(renderGraph.textOf(root)).toContain("Total tokens");
      expect(viewSignals).toHaveLength(7);
    } finally {
      dispose?.();
      vi.unstubAllGlobals();
    }
    expect(onConnection).toBeUndefined();
    expect(onEvent).toBeUndefined();
    expect(browser.listenerCount()).toBe(0);
  });

  it("composes the whole shell against an in-memory data source", async () => {
    const snapshot = settingsSnapshot();
    const client = {
      connection: () => "connecting" as const,
      onConnectionChange: () => () => {},
      subscribe: () => () => {},
      health: async () => ({ app: "opencode-quota-gui" as const, contractVersion: 2 }),
      home: async () => homeSnapshot(),
      quota: async () => homeSnapshot(),
      project: async () => projectSnapshot(),
      session: async () => sessionSnapshot(),
      settings: async () => snapshot,
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
    const html = await renderView("/app.tsx", "App", { client });
    // Icon-only navigation retains explicit names and real route links.
    expect(html).not.toContain("OpenCode quota");
    expect(html).toContain('aria-label="Quota"');
    expect(html).toContain('aria-label="Analytics"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('href="/quota"');
    expect(html).not.toContain("Time range");
    expect(html).not.toContain('data-component="segmented-control-v2"');
    expect(html).toContain("Settings");
    expect(html).toContain("qg-skeleton");
    expect(html).toContain("Connecting");
    // Provider-shaped loading reserves the grid, not fabricated quota data.
    expect(html).toContain("qg-card-grid");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('class="qg-card"');
    expect(html).not.toContain('class="qg-usage"');
  });

  it("uses a scoped Console palette while retaining public-library typography and motion", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-bg: #0a0a0a");
    expect(styles).toContain("--qg-frame: #161616");
    expect(styles).toContain("--qg-surface: #232323");
    // Frozen v1 chart palette.
    expect(styles).toContain("--qg-token-input: #a583fe");
    expect(styles).toContain("--qg-token-cache-read: #ec6afe");
    expect(styles).toContain("--qg-token-reasoning: #7c85fe");
    expect(styles).toContain("--qg-token-output: #51a1fe");
    expect(styles).toContain("--qg-token-cache-write: #00d2f1");
    expect(styles).toContain("--qg-chart-context: #51a2ff");
    expect(styles).toContain("--qg-chart-own: #ffb900");
    expect(styles).toContain("--qg-chart-total: #ff8904");
    // Session keeps a white crosshair; usage has no crosshair or boundary overlay.
    expect(styles).toContain("stroke: #ffffff");
    expect(styles).toContain(".qg-chart__cursor");
    expect(styles).not.toContain(".qg-chart__separator");
    expect(styles).toContain(".qg-chart__surface");
    expect(styles).not.toContain(".qg-chart__boundary");
    expect(styles).not.toContain('.qg-chart__segment[data-thin="true"]');
    // Loading motion loops continuously: linear timing, no paused restart.
    expect(styles).toContain("qg-shimmer 1.4s linear infinite");
    expect(styles).toContain("qg-busy-border 2.4s ease-in-out infinite");
    expect(styles).toContain(".qg-busy");
    expect(styles).not.toContain(".qg-busy__dot");
    expect(styles).not.toContain("qg-progress");
    expect(styles).toContain("1056px");
    expect(styles).toContain(".qg-app:has(.qg-form) .qg-toasts");
    expect(styles).not.toContain(".qg-segmented");
    expect(styles).not.toContain(".qg-switch");
    expect(styles).toMatch(
      /\.sr-only\s*\{[^}]*position: absolute;[^}]*width: 1px;[^}]*height: 1px;[^}]*overflow: hidden;/s,
    );
    expect(styles).toContain("prefers-color-scheme: dark");
    expect(styles).toContain("prefers-reduced-motion");
    for (const token of ["input", "cache-read", "cache-write", "output", "reasoning"]) {
      expect(styles).toContain(`--qg-token-${token}:`);
    }
    // No font download and no parallel palette sweep of the library's variables.
    expect(styles).not.toMatch(/@import\s+url\(|fonts\.googleapis/);
    expect(styles).not.toContain("--font-family-sans:");
  });

  it("imports the library stylesheet only through the wrapper", () => {
    const main = readFileSync(path.join(repoRoot, "src/ui/main.tsx"), "utf8");
    expect(main).not.toContain("@opencode/ui");
    const wrapper = readFileSync(path.join(repoRoot, "src/ui/opencode-ui.ts"), "utf8");
    expect(wrapper).toContain('import "@opencode/ui/styles"');
  });

  it("always shows the ISO currency code and never a bare symbol", () => {
    expect(formatApiEquivalentCost(0)).toBe("≈ USD 0.00");
    expect(formatApiEquivalentCost(1234.5)).toBe("≈ USD 1234.50");
    expect(formatApiEquivalentCost(0)).not.toContain("$");
    expect(stack({ input: 1 }).input).toBe(1);
  });
});
