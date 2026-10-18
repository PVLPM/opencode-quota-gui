import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  HomeSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../src/contracts/dashboard";
import { buildRowKey, composeRowId } from "../src/contracts/identity";
import type { RangeKey } from "../src/contracts/ranges";
import {
  buildStepGeometry,
  buildUsageGeometry,
  shouldUseTotalsFallback,
  THIN_SLICE_SHARE,
} from "../src/ui/chart-geometry";
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
  formatRunway,
  formatTimestamp,
  formatTokenCount,
} from "../src/ui/format";
import {
  formatHash,
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
  providerSelection,
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
  renderGraph = {
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
 * `own <!--$-->1,500<!--/--> tokens` is the same sentence a browser shows as
 * `own 1,500 tokens`. Prose assertions read the normalized text.
 */
function text(html: string): string {
  return html.replace(/<!--\$-->|<!--\/-->|<!--#-->/g, "");
}

const noop = async (): Promise<void> => {};

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
  it("keeps UTC day labels aligned with server buckets across local timezone boundaries", () => {
    const midnight = Date.UTC(2026, 9, 19);
    expect(formatBucketTick(midnight, "day")).toBe("19 Oct");
    expect(formatBucketTick(midnight, "hour")).toBe("00:00");
    expect(formatTimestamp(midnight)).toContain("UTC");
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

  it("keeps chart inspection transient rather than exposing category filters or pinning", () => {
    const source = readFileSync(path.join(repoRoot, "src/ui/components/usage-chart.tsx"), "utf8");
    expect(source).toContain("onPointerLeave={() => setHighlight(undefined)}");
    expect(source).toContain("onBlur={() => setHighlight(undefined)}");
    expect(source).not.toContain("aria-pressed");
    expect(source).not.toContain("setPinned");
    expect(source).not.toContain("onClick=");
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

  it("never renders a raw exception, and asks for a reload on a contract mismatch", () => {
    expect(describeError(new Error("ENOENT: C:\\Users\\local\\secret.json"))).toBe(
      "The dashboard server did not answer. Check that the local dashboard is still running.",
    );
    expect(contractMismatchMessage(1)).toBeUndefined();
    const mismatch = contractMismatchMessage(2);
    expect(mismatch).toContain("Reload the page");
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

  it("hides cards and rows by stable id only", () => {
    const cards = [providerCard(), providerCard({ cardId: "provider-2#hash" as never })];
    expect(visibleCards(cards, [])).toHaveLength(2);
    expect(visibleCards(cards, ["provider-2#hash"])).toHaveLength(1);
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
  it("renders quota cards, usage and projects in the fixed order", async () => {
    const html = await renderView("/views/home.tsx", "HomeView", homeProps());
    const quota = html.indexOf('id="qg-home-quota"');
    const usageSection = html.indexOf('id="qg-home-usage"');
    const projects = html.indexOf('id="qg-home-projects"');
    expect(quota).toBeGreaterThan(-1);
    expect(usageSection).toBeGreaterThan(quota);
    expect(projects).toBeGreaterThan(usageSection);
  });

  it("keeps a provider failure card-local and names it provider-level when no account is known", async () => {
    const html = await renderView(
      "/views/home.tsx",
      "HomeView",
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
      "HomeView",
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
      "HomeView",
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
      "HomeView",
      homeProps({ hiddenCards: ["provider-1#cardhash"] }),
    );
    expect(html).toContain("Every provider card is hidden");
    expect(html).not.toContain("qg-card-grid");
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
      "HomeView",
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
    // toggle — Settings → Visible cards and rows is the one unhide path.
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
      "HomeView",
      homeProps({
        hiddenRows: ["provider-1#cardhash#window:five_hour"],
      }),
    );
    expect(allHidden).toContain("Every row on this card is hidden");
    expect(allHidden).toContain("Settings → Visible cards and rows");
    expect(allHidden).not.toContain("Five hour window");
    // The card itself is not hidden, so it stays on the page.
    expect(allHidden).toContain("qg-card-grid");
    expect(allHidden).not.toContain("qg-card__rows");
    expect(allHidden).not.toContain("No quota rows are reported for this account.");

    const genuinelyEmpty = await renderView(
      "/views/home.tsx",
      "HomeView",
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
    const remaining = await renderView("/views/home.tsx", "HomeView", homeProps({ snapshot }));
    expect(remaining).toContain("62%");
    expect(remaining).not.toContain("38%");
    expect(text(remaining)).toContain("Runs out");
    const used = await renderView(
      "/views/home.tsx",
      "HomeView",
      homeProps({ snapshot, preferences: { ...preferences, percentMode: "used" } }),
    );
    expect(used).toContain("38%");
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
    const summary = await renderView("/views/home.tsx", "HomeView", homeProps({ snapshot }));
    expect(summary).not.toContain("Requests");
    const detailed = await renderView(
      "/views/home.tsx",
      "HomeView",
      homeProps({ snapshot, preferences: { ...preferences, detailed: true } }),
    );
    expect(detailed).toContain("Requests");
    expect(detailed).toContain("Credits");
    // Safe field details stay inside a collapsed disclosure.
    expect(detailed).toContain("<details");
    expect(summary).toContain("<details");
    expect(summary).toContain("Plan");
  });

  it("marks a card stale without replacing its numbers", async () => {
    const html = await renderView("/views/home.tsx", "HomeView", homeProps({ stale: true }));
    expect(html).toContain('data-stale="true"');
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
    expect(projects).toContain('href="#/project/project-alpha?range=7d"');
  });
});

describe("usage chart", () => {
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

  it("stacks the five categories and never hides one", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", stackedBuckets),
    });
    expect(html.match(/qg-chart__segment/g)).toHaveLength(5);
    for (const label of ["Input", "Cache read", "Cache write", "Output", "Reasoning"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("9,250");
    expect(html).toContain("API-equivalent");
  });

  it("falls back to one totals series when stacking would show nothing", async () => {
    const html = await renderView("/components/usage-chart.tsx", "UsageChart", {
      usage: usage("7d", [{ startMs: NOW - DAY_MS, endMs: NOW, tokens: costed({ input: 1000 }) }]),
    });
    expect(html.match(/qg-chart__segment/g)).toHaveLength(1);
    expect(html).toContain("totals series");
    // The legend still names every category, and no segment can be hidden.
    expect(html).toContain("Reasoning");
    expect(html).toContain('class="qg-legend__item"');
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
    // Bucket plus the five categories plus the total.
    expect(table.match(/scope="col"/g)?.length).toBe(7);
    expect(table).toContain("9,250");
  });

  it("reports unpriced tokens instead of quietly shrinking the estimate", async () => {
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
    expect(text(html)).toContain("7 unpriced");
    expect(text(html)).toContain("3 unknown");
  });

  it("decides the fallback from the data, not from a setting", () => {
    expect(shouldUseTotalsFallback([])).toBe(false);
    expect(shouldUseTotalsFallback([{ startMs: 0, endMs: 1, tokens: costed({ input: 10 }) }])).toBe(
      true,
    );
    expect(
      shouldUseTotalsFallback([
        { startMs: 0, endMs: 1, tokens: costed({ input: 5000, output: 5000 }) },
      ]),
    ).toBe(false);
    // A category that is a sliver in every bucket it appears in stacks to nothing visible.
    const sliver = costed({ input: 1000 });
    sliver.reasoning = 1000 * THIN_SLICE_SHARE * 0.5;
    sliver.total = sliver.input + sliver.reasoning;
    expect(shouldUseTotalsFallback([{ startMs: 0, endMs: 1, tokens: sliver }])).toBe(true);
  });

  it("formats numbers and cost predictably", () => {
    expect(formatTokenCount(9250)).toBe("9.3k");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatApiEquivalentCost(null)).toBe("≈ USD —");
    expect(formatApiEquivalentCost(1.5)).toBe("≈ USD 1.50");
    expect(formatPercent(62)).toBe("62%");
    expect(formatRunway(undefined)).toBeUndefined();
    expect(formatRunway({ kind: "lasts_past_reset" })).toBe("Lasts past reset");
    expect(
      formatRunway({ kind: "before_reset", projectedAtIso: new Date(NOW).toISOString() }),
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
    expect(html).toContain('href="#/session/session-root-1?range=7d"');
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

  it("marks the current page and keeps the server's root order", async () => {
    const snapshot = projectSnapshot();
    const html = await renderView("/views/project.tsx", "ProjectView", { snapshot, range: "7d" });
    expect(html).toContain('aria-current="page"');
    expect(html.indexOf(snapshot.roots[0]?.title ?? "")).toBeLessThan(
      html.indexOf(snapshot.roots[1]?.title ?? ""),
    );
    expect(text(html)).toContain("4 sessions");
    expect(html).toContain("≈ USD 0.60");
    expect(text(html)).toContain("2 root sessions");
  });
});

describe("session view composition", () => {
  it("renders breadcrumbs with the current page marked, the own summary, and tree totals", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="#/session/session-ancestor?range=7d"');
    expect(text(html)).toContain("own 1,500 tokens");
    expect(text(html)).toContain("tree 2,900 tokens");
    expect(html).toContain("One step is one completed assistant message");
  });

  it("shows each node's own tokens as secondary text and links immediate children", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(text(html)).toContain("own 1,500");
    expect(text(html)).toContain("subtree 2,900");
    expect(html).toContain('href="#/session/session-child-1?range=7d"');
    expect(html).toContain("alpha-feature");
    expect(html).toContain('data-focus="true"');
  });

  it("draws compaction markers as ticks, never as steps", async () => {
    const html = await renderView("/views/session.tsx", "SessionView", {
      snapshot: sessionSnapshot(),
      range: "7d",
    });
    expect(html).toContain("qg-chart__marker");
    expect(html).toContain("Compaction markers");
    expect(html).toContain("session-root-1");
    expect(text(html)).toContain("3 steps");
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
    expect(text(html)).toContain("tree 999,999 tokens");
    expect(text(html)).toContain("250 nodes");
  });

  it("breaks a branch's context line at a session or branch change", () => {
    const snapshot = sessionSnapshot();
    const geometry = buildStepGeometry(snapshot.steps, snapshot.compactionMarkers);
    expect(geometry.contextRuns).toHaveLength(2);
    expect(geometry.totalRuns).toHaveLength(2);
    expect(geometry.contextRuns.map((run) => run.sessionId)).toEqual([
      "session-root-1",
      "session-child-1",
    ]);
    expect(geometry.compaction).toHaveLength(1);
    expect(geometry.stepCount).toBe(3);
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

  it("renders groups, named visibility eyes, unknown hidden IDs, and the revision-checked save bar", async () => {
    const snapshot = settingsSnapshot();
    snapshot.values["dashboard.hiddenCards"] = ["card-hidden", "unknown-retained"];
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
        cards: [
          { id: "card-visible", label: "Visible account" },
          { id: "card-hidden", label: "Hidden account" },
        ],
        rows: [{ id: "row-visible", label: "Weekly quota" }],
      },
      onReload: noop,
    });
    for (const title of [
      "Wait for quota reset",
      "Display",
      "Advanced",
      "Visible cards and rows",
      "Dashboard",
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("4144");
    expect(html).toContain('aria-label="Hide Visible account"');
    expect(html).toContain('aria-label="Show Hidden account"');
    expect(html).toContain('aria-label="Hide Weekly quota"');
    expect(html).toContain("unknown-retained");
    expect(html).toContain("http://127.0.0.1:4144");
    expect(html).toContain("changing the port needs a restart");
    expect(html).toContain("No unsaved changes.");
    expect(text(html)).toContain("saved as global defaults");
    expect(text(html)).toContain("saving here does not edit them");
    expect(text(html)).toContain("import may remain available after a successful copy");
    expect(html).toContain("effective value inherited from");
    expect(html).toContain("inherited from opencode-quota/quota-toast.jsonc");
    expect(html).toContain("Preview import");
    expect(html).toContain("Affects toasts, TUI sidebar, and compact status only");
    // The library's own components render in the page: adoption is real, not a plan.
    expect(html).toContain('data-component="button-v2"');
    expect(html).toContain('data-component="switch"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('data-component="segmented-control-v2"');
    expect(html).toContain("text-input-v2");
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
      /** The quota cards' stale flag, which the card renders as `data-stale`. */
      cardsStale: () =>
        renderGraph
          .elementsNamed(root, "article")
          .map((card) => card.props["data-stale"] === "true"),
      dispose,
    };
  }

  /** Render effects run with the update; this lets any deferred one land too. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("renders the new range's numbers after the payload changes", async () => {
    const rig = mountSection({ data: payload("7d", "alpha-7d", 960), loading: false });
    expect(rig.text()).toContain("7d · per day");
    expect(rig.text()).toContain("alpha-7d");
    expect(rig.text()).toContain("Total tokens960");

    rig.setState(resolveLoadState({ data: payload("24h", "beta-24h", 480), loading: false }));
    rig.setRange("24h");
    await settle();

    const text = rig.text();
    expect(text).toContain("24h · per hour");
    expect(text).toContain("beta-24h");
    expect(text).toContain("Total tokens480");
    // The previous range's numbers are gone, not merely joined by new ones.
    expect(text).not.toContain("7d · per day");
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

  it("keeps the stale marker in step with the payload it describes", async () => {
    const fresh = payload("7d", "alpha-7d", 960);
    const rig = mountSection({ data: fresh, loading: false });
    expect(rig.cardsStale()).toEqual([false]);

    // A failed refetch keeps the payload and marks it stale.
    rig.setState(
      resolveLoadState({
        data: fresh,
        error: new DashboardError("internal", 500, "refetch failed"),
        loading: false,
      }),
    );
    await settle();
    expect(rig.cardsStale()).toEqual([true]);

    // The next good payload is not stale any more.
    rig.setState(resolveLoadState({ data: payload("24h", "beta-24h", 480), loading: false }));
    await settle();
    expect(rig.cardsStale()).toEqual([false]);
    rig.dispose();
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
  }) {
    const server = settingsQuery(options.initial);
    const saves: SaveInput[] = [];
    const toasts: { tone: string; message: string }[] = [];
    const client: DashboardClient = {
      health: notUsed,
      home: notUsed,
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
          catalog: () => ({ cards: [], rows: [] }),
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

  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`probe: ${what} never happened`);
  }

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

    expectRejected(
      () =>
        parseSessionSnapshot(
          {
            focusSessionId: "s",
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
  it("parses the four hash routes", () => {
    expect(parseLocation("#/", "7d").route).toEqual({ name: "home" });
    expect(parseLocation("#/settings", "7d").route).toEqual({ name: "settings" });
    expect(parseLocation("#/project/alpha?range=30d", "7d")).toEqual({
      route: { name: "project", projectId: "alpha" },
      range: "30d",
    });
    expect(parseLocation("#/session/ses%201", "7d").route).toEqual({
      name: "session",
      sessionId: "ses 1",
    });
    expect(parseLocation("#/nope", "7d").route).toEqual({ name: "not-found", path: "/nope" });
  });

  it("lets a URL range win and keeps the session page range-free", () => {
    expect(parseLocation("#/?range=24h", "30d").range).toBe("24h");
    expect(parseLocation("#/?range=bogus", "30d").range).toBe("30d");
    expect(parseLocation("#/session/abc?range=24h", "30d")).toEqual({
      route: { name: "session", sessionId: "abc" },
      range: "24h",
    });
    expect(routeUsesRange({ name: "home" })).toBe(true);
    expect(routeUsesRange({ name: "project", projectId: "a" })).toBe(true);
    expect(routeUsesRange({ name: "session", sessionId: "a" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "session", sessionId: "a" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "settings" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "home" })).toBe(true);
  });

  it("round-trips every route through the hash builder", () => {
    expect(formatHash({ name: "home" }, "7d")).toBe("#/?range=7d");
    expect(formatHash({ name: "project", projectId: "a b" }, "24h")).toBe(
      "#/project/a%20b?range=24h",
    );
    expect(formatHash({ name: "session", sessionId: "ses_1" }, "30d")).toBe(
      "#/session/ses_1?range=30d",
    );
    expect(formatHash({ name: "settings" }, "lifetime")).toBe("#/settings?range=lifetime");
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
  it("composes the whole shell against an in-memory data source", async () => {
    const snapshot = settingsSnapshot();
    const client = {
      connection: () => "connecting" as const,
      onConnectionChange: () => () => {},
      subscribe: () => () => {},
      health: async () => ({ app: "opencode-quota-gui" as const, contractVersion: 1 }),
      home: async () => homeSnapshot(),
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
    expect(html).toContain('aria-label="Home"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('href="#/?range=7d"');
    expect(html).toContain("Time range");
    expect(html).toContain('data-component="segmented-control-v2"');
    expect(html).toContain("Settings");
    expect(html).toContain("qg-skeleton");
    expect(html).toContain("Connecting");
    // No route data has arrived yet, so no card grid or chart is rendered.
    expect(html).not.toContain("qg-card-grid");
  });

  it("uses a scoped Console palette while retaining public-library typography and motion", () => {
    const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
    expect(styles).toContain("--qg-bg: #0a0a0a");
    expect(styles).toContain("--qg-frame: #151515");
    expect(styles).toContain("--qg-surface: #232323");
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
