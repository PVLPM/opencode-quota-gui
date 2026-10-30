import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotaSnapshot, SettingsSnapshot } from "../src/contracts/dashboard.js";
import type {
  TemporalModelStatus,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
} from "../src/contracts/temporal.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { providerCard, settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;

const tooltipBoundary = {
  name: "tooltip-ssr-boundary",
  enforce: "pre" as const,
  transform(_code: string, id: string) {
    if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx")) {
      return "export function Tooltip(props) { return props.children }";
    }
  },
};

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [tooltipBoundary, solid({ include: [...SOLID_JSX_SOURCES], ssr: true })],
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"],
    },
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
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function renderView(modulePath: string, exportName: string, props: unknown): Promise<string> {
  const module = await graph.load(modulePath);
  const component = module[exportName];
  if (typeof component !== "function") {
    throw new Error(`${modulePath} does not export ${exportName}`);
  }
  return graph.renderToString(() => graph.createComponent(component, props));
}

/** Solid SSR inserts hydration comments between adjacent text nodes. */
function visibleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
}

function temporalStrip(html: string): string {
  const start = html.indexOf('class="qg-temporal"');
  const end = html.indexOf('class="qg-card-grid"', start);
  return start === -1 ? "" : html.slice(start, end === -1 ? undefined : end);
}

function model(
  modelId: string,
  state: "peak" | "offpeak" | "unknown",
  factor?: number,
): TemporalModelStatus {
  const effect =
    factor === undefined
      ? undefined
      : {
          factor,
          direction: state === "peak" ? ("peak" as const) : ("offpeak" as const),
          unit: "api_price" as const,
        };
  return {
    modelId,
    state,
    ...(effect ? { effect } : {}),
    nextChangeAtMs: NOW + 2 * HOUR,
    intervals: [
      {
        startMs: NOW - HOUR,
        endMs: NOW + 2 * HOUR,
        phase: state,
        ...(effect ? { effect } : {}),
      },
      {
        startMs: NOW + 2 * HOUR,
        endMs: NOW + 5 * HOUR,
        phase: state === "peak" ? "offpeak" : "peak",
        ...(effect
          ? {
              effect: {
                ...effect,
                factor: 1 / effect.factor,
                direction: state === "peak" ? ("offpeak" as const) : ("peak" as const),
              },
            }
          : {}),
      },
    ],
  };
}

function provider(
  providerId: string,
  providerLabel: string,
  models: TemporalModelStatus[],
  phase: TemporalProviderStatus["phase"],
  discovered = true,
): TemporalProviderStatus {
  return {
    providerId,
    providerLabel,
    discovered,
    phase,
    models,
    holidays: [
      {
        jurisdiction: "CN",
        id: "spring-festival",
        localStart: "2026-02-15",
        localEnd: "2026-02-24",
        startMs: Date.parse("2026-02-14T16:00:00.000Z"),
        endMs: Date.parse("2026-02-23T16:00:00.000Z"),
      },
    ],
  };
}

const deepseek = provider("deepseek", "DeepSeek", [model("deepseek-v4-pro", "peak", 2)], "peak");
const mixed = provider(
  "test-mixed",
  "Test Mixed",
  [model("peak-model", "peak", 2), model("offpeak-model", "offpeak", 0.5)],
  "mixed",
);
const zai = {
  ...provider(
    "zai",
    "Z.ai",
    [
      {
        ...model("glm-5", "peak", 2),
        effect: { factor: 2, direction: "peak", unit: "quota_points" },
        intervals: [
          {
            startMs: NOW - HOUR,
            endMs: NOW + 2 * HOUR,
            phase: "peak",
            effect: { factor: 2, direction: "peak", unit: "quota_points" },
          },
        ],
      },
    ],
    "peak",
    true,
  ),
  source: {
    label: "Z.ai current credits-plan usage",
    url: "https://docs.z.ai/devpack/overview#usage-instruction",
    accessedAt: "2026-10-30",
  },
};

function temporal(): TemporalStatusSnapshot {
  return {
    generatedAtMs: NOW,
    providers: [deepseek, mixed, zai],
    snapshot: { revision: "4a58d0bc74552942a2aa29bc9065a38ed3fe04e4", generatedAtMs: NOW },
  };
}

function quotaSnapshot(): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [
        providerCard({ providerId: "deepseek", providerLabel: "DeepSeek" }),
        providerCard({ providerId: "test-mixed", providerLabel: "Test Mixed" }),
        providerCard({ providerId: "zai", providerLabel: "Z.ai" }),
      ],
      enabledProviders: "auto",
      polledAtMs: NOW,
    },
    temporal: temporal(),
  };
}

function temporalWithNoAccount(): TemporalStatusSnapshot {
  const snapshot = temporal();
  return {
    ...snapshot,
    providers: [
      ...snapshot.providers,
      provider("google", "Google", [model("gemini-3-pro", "offpeak", 0.5)], "offpeak", false),
    ],
  };
}

function preferences(overrides: Record<string, boolean> = {}) {
  return {
    percentMode: "remaining" as const,
    percentLabelStyle: "full" as const,
    showRunway: false,
    detailed: false,
    temporalProviderOverrides: overrides,
  };
}

function temporalSettings(overrides: Record<string, boolean> = {}): SettingsSnapshot {
  const base = settingsSnapshot();
  return {
    ...base,
    values: {
      ...base.values,
      "dashboard.temporalProviderOverrides": overrides,
    },
    writable: [...base.writable, "dashboard.temporalProviderOverrides"],
  };
}

describe("temporal live status UI", () => {
  it("groups compact provider chips by peak, off-peak and mixed state", async () => {
    const html = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: quotaSnapshot(),
      preferences: preferences(),
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    expect(html).toContain('aria-label="Temporal pricing status"');
    expect(html.match(/class="qg-temporal__group"/g)).toHaveLength(2);
    expect(html).not.toContain('class="qg-temporal__label"');
    expect(html).toContain('data-phase="peak"');
    expect(html).toContain('data-phase="mixed"');
    const text = visibleText(html);
    expect(text).toContain("DeepSeek: Peak. Show peak and off-peak details.");
    expect(text).toContain("Test Mixed: Mixed. Show peak and off-peak details.");
    expect(html).toContain('data-provider-logo="deepseek"');
    expect(html).toContain('data-provider-logo="zai"');
  });

  it("defaults chips off without an account and honors explicit on and off choices", async () => {
    const base = { ...quotaSnapshot(), temporal: temporalWithNoAccount() };
    const defaults = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: base,
      preferences: preferences(),
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    const defaultStrip = temporalStrip(defaults);
    expect(defaultStrip).not.toContain('data-provider-logo="google"');
    expect(defaultStrip).toContain('data-provider-logo="deepseek"');

    const explicit = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: base,
      preferences: preferences({ google: true, deepseek: false }),
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    const explicitStrip = temporalStrip(explicit);
    expect(explicitStrip).toContain('data-provider-logo="google"');
    expect(explicitStrip).not.toContain('data-provider-logo="deepseek"');
  });

  it("renders the shared popover with local schedules, countdown and holiday intervals", async () => {
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: deepseek,
    });
    const text = visibleText(html);
    expect(text).toContain("models.dev schedule");
    expect(text).toContain("times local to you");
    expect(text).toContain("deepseek-v4-pro");
    expect(text).toContain("Peak");
    expect(text).toContain("2× API price");
    expect(text).toContain("Next change in 2h");
    expect(text).toContain("Holiday exceptions");
    expect(text).toContain("CN");
    expect(text).not.toContain("USD");
  });

  it("labels Z.ai effects as quota points and names their own source", async () => {
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: zai,
    });
    const text = visibleText(html);
    expect(text).toContain("Z.ai current credits-plan usage");
    expect(text).toContain("2× quota points");
    expect(text).not.toContain("USD");
    expect(text).not.toContain("models.dev schedule");
  });

  it("explains a live unresolved window instead of only saying Unknown", async () => {
    const unresolved = provider(
      "future-calendar",
      "Future Calendar",
      [
        {
          modelId: "calendar-model",
          state: "offpeak",
          reason: "snapshot-time reason",
          intervals: [
            {
              startMs: NOW - HOUR,
              endMs: NOW + HOUR,
              phase: "unknown",
              reason: "CN public holiday calendar for 2027 is unavailable",
            },
          ],
        },
      ],
      "unknown",
    );
    const html = await renderView("/components/temporal-status.tsx", "TemporalPopoverBody", {
      status: unresolved,
    });
    const text = visibleText(html);
    expect(text).toContain("Unknown");
    expect(text).toContain("CN public holiday calendar for 2027 is unavailable");
    expect(text).not.toContain("snapshot-time reason");
  });

  it("keeps the header strip and settings summary quiet when no route matches", async () => {
    const empty: TemporalStatusSnapshot = { ...temporal(), providers: [] };
    const quotaHtml = await renderView("/views/home.tsx", "QuotaView", {
      snapshot: { ...quotaSnapshot(), temporal: empty },
      preferences: preferences(),
      hiddenCards: [],
      hiddenRows: [],
      stale: false,
    });
    expect(quotaHtml).not.toContain('aria-label="Temporal pricing status"');

    const settingsHtml = await renderView("/views/settings.tsx", "SettingsView", {
      snapshot: temporalSettings(),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      temporal: empty,
      onReload: async () => {},
    });
    const text = visibleText(settingsHtml);
    expect(text).toContain("No temporal pricing providers are available.");
    expect(text).not.toContain("Defaults follow discovered accounts.");
  });

  it("lists every temporal provider with account-driven defaults and explicit overrides", async () => {
    const base = {
      snapshot: temporalSettings(),
      client: {},
      toaster: { toasts: () => [], push: () => {}, dismiss: () => {} },
      catalog: { cards: [] },
      temporal: temporalWithNoAccount(),
      onReload: async () => {},
    };
    const defaultsHtml = await renderView("/views/settings.tsx", "SettingsView", base);
    expect(defaultsHtml.match(/class="qg-field qg-temporal-settings__row"/g)).toHaveLength(4);
    const defaultRows = defaultsHtml.split('<div class="qg-field qg-temporal-settings__row">');
    const googleRow =
      defaultRows.find((row) => row.includes("Show peak and off-peak pricing for Google")) ?? "";
    const deepseekRow =
      defaultRows.find((row) => row.includes("Show peak and off-peak pricing for DeepSeek")) ?? "";
    expect(googleRow).toContain('aria-checked="false"');
    expect(deepseekRow).toContain('aria-checked="true"');
    const defaultText = visibleText(defaultsHtml);
    expect(defaultText).toContain("No account discovered.");
    expect(defaultText).toContain("Defaults follow discovered accounts.");

    const overridesHtml = await renderView("/views/settings.tsx", "SettingsView", {
      ...base,
      snapshot: temporalSettings({ google: true, deepseek: false, zai: true }),
    });
    const rows = overridesHtml.split('<div class="qg-field qg-temporal-settings__row">');
    const googleOverride = rows.find((row) => row.includes("pricing for Google")) ?? "";
    const deepseekOverride = rows.find((row) => row.includes("pricing for DeepSeek")) ?? "";
    const zaiOverride = rows.find((row) => row.includes("pricing for Z.ai")) ?? "";
    expect(googleOverride).toContain('aria-checked="true"');
    expect(deepseekOverride).toContain('aria-checked="false"');
    expect(zaiOverride).toContain('aria-checked="true"');
    expect(visibleText(overridesHtml)).toContain(
      "3 manual choices; the rest follow discovered accounts.",
    );
    expect(overridesHtml).toContain('id="qg-settings-temporal"');
    expect(overridesHtml).toContain('data-provider-logo="google"');
    expect(visibleText(overridesHtml)).toContain("Peak and off-peak pricing details for DeepSeek");
  });

  it("does not add an independent clock or poll to the temporal UI", () => {
    const component = readFileSync(
      path.join(repoRoot, "src/ui/components/temporal-status.tsx"),
      "utf8",
    );
    const format = readFileSync(path.join(repoRoot, "src/ui/temporal-format.ts"), "utf8");
    for (const source of [component, format]) {
      expect(source).not.toMatch(/setInterval|setTimeout|onMount|onCleanup/);
    }
  });

  it("keeps the issue #9 text-then-control row contract and local styles scoped", () => {
    expect(styles).toContain(".qg-temporal-settings__row");
    expect(styles).toContain(".qg-temporal-popover");
    expect(styles).toMatch(
      /\.qg-field\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(220px, 320px\)/s,
    );
    expect(styles).not.toMatch(/\.qg-field\s*\{[^}]*grid-template-columns:\s*1fr\s*;/s);
  });
});
