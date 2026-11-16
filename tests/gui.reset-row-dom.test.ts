import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderCard } from "../src/contracts/dashboard.js";
import type { BankedResetCredit } from "../src/contracts/openai-quota.js";
import type { DisplayPreferences } from "../src/ui/components/quota-card.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { percentRow, providerCard } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * The shared saved-resets row is rendered for OpenAI and Claude Agent only.
 * The tooltip is stubbed to its children under SSR, so each segment's screen
 * reader text (which repeats the tooltip's title/expiry/relative lines) is the
 * observable tooltip content.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (path: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;

beforeAll(async () => {
  const created = await createIsolatedViteServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [
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
    resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"] },
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

const preferences: DisplayPreferences = {
  percentMode: "remaining",
  percentLabelStyle: "full",
  showRunway: false,
  detailed: false,
};

async function render(providerId: string, credits: BankedResetCredit[], count = credits.length) {
  const module = await graph.load("/components/quota-card.tsx");
  const component = module.QuotaCardView;
  if (typeof component !== "function") throw new Error("QuotaCardView missing");
  const card: ProviderCard = providerCard({
    providerId,
    providerLabel: providerId,
    rows: [
      percentRow({
        label: "Resets",
        kind: "value",
        bankedResets: { availableCount: count, credits },
        runway: undefined,
        countdown: undefined,
      }),
    ],
  });
  const html = graph.renderToString(() =>
    graph.createComponent(component, {
      card,
      preferences,
      hiddenRows: [],
      stale: false,
      timeZone: "UTC",
    }),
  );
  return html.replace(/<!--[\s\S]*?-->/gu, "");
}

// Countdown text uses the real clock, so expiries are relative to Date.now().
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const segmentCount = (html: string) => html.match(/class="qg-reset__segment"/gu)?.length ?? 0;
const srTexts = (html: string) =>
  [...html.matchAll(/<span[^>]*class="sr-only">(Reset \d+ of [^<]*)<\/span>/gu)].map((m) => m[1]);

describe("saved-resets row DOM", () => {
  it("renders one Claude Agent segment per reset, nearest first, with summary and tooltip text", async () => {
    const html = await render("claude-agent", [
      { expiresAtIso: inHours(48) },
      { expiresAtIso: null },
      { expiresAtIso: inHours(24) },
      {},
    ]);
    expect(html).toContain("qg-row--resets");
    expect(segmentCount(html)).toBe(4);
    expect(html).toContain('data-count="4"');
    expect(html).toContain("4 available");
    expect(html).toContain('<span class="qg-reset__summary">Expires in');
    const texts = srTexts(html);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toMatch(/^Reset 1 of 4\. Full reset\. Expires .*\. In /u);
    expect(texts[1]).toMatch(/^Reset 2 of 4\. Full reset\. Expires .*\. In /u);
    expect(texts[2]).toBe("Reset 3 of 4. Full reset. No expiry");
    expect(texts[3]).toBe("Reset 4 of 4. Full reset. Expiry unknown");
    expect(html.indexOf('data-expiry="known"')).toBeLessThan(html.indexOf('data-expiry="none"'));
    expect(html.indexOf('data-expiry="none"')).toBeLessThan(html.indexOf('data-expiry="unknown"'));
  });

  it("keeps equal known expiries as separate segments", async () => {
    const same = inHours(24);
    const html = await render("claude-agent", [{ expiresAtIso: same }, { expiresAtIso: same }]);
    expect(segmentCount(html)).toBe(2);
    const [first, second] = srTexts(html);
    expect(first?.replace("1 of 2", "")).toBe(second?.replace("2 of 2", ""));
  });

  it("shows unknown expiry for a count with no detail records", async () => {
    const html = await render("claude-agent", [], 2);
    expect(segmentCount(html)).toBe(2);
    expect(html).toContain("2 available");
    expect(html).toContain('<span class="qg-reset__summary">Expiry unknown</span>');
  });

  it("does not render the reset component for direct Anthropic", async () => {
    const html = await render("anthropic", [{ expiresAtIso: inHours(24) }]);
    expect(html).not.toContain("qg-row--resets");
    expect(html).not.toContain("qg-reset__segment");
  });

  it("keeps the OpenAI reset row unchanged", async () => {
    const html = await render("openai", [{ expiresAtIso: inHours(24) }, { expiresAtIso: null }]);
    expect(html).toContain("qg-row--resets");
    expect(segmentCount(html)).toBe(2);
    expect(html).toContain("2 available");
    expect(srTexts(html)[1]).toBe("Reset 2 of 2. Full reset. No expiry");
    expect(html).toContain('<span class="qg-reset__summary">Expires in');
  });
});
