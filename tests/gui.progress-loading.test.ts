import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuotaCardRow } from "../src/contracts/dashboard.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import { percentRow } from "./fixtures/gui-ui-fixtures.js";

/**
 * Focused quota-progress and foreground-loading contract.
 *
 * The bar is the original two-segment geometry restored from 6bc3919f: an
 * 8 px pair with the original variable boundary gap, independent segments and
 * 2 px corners. Loading keeps its one-second delay, fixed panel, exact
 * Loading/Updating analytics copy and border-only motion.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(path.join(repoRoot, "src/ui/styles.css"), "utf8");
const appSource = readFileSync(path.join(repoRoot, "src/ui/app.tsx"), "utf8");

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (modulePath: string) => Promise<Record<string, unknown>>;
}

interface QuotaModule {
  QuotaBar: unknown;
  quotaUsedPercent: (row: QuotaCardRow) => number | undefined;
  quotaSeverity: (usedPercent: number | undefined) => "healthy" | "warning" | "critical";
  rowPercent: (row: QuotaCardRow, preferences: DisplayPreferences) => number | undefined;
}

interface BusyModule {
  BUSY_DELAY_MS: number;
  BusyOverlay: unknown;
  createBusyIndicator: (delayMs?: number) => {
    visible: () => boolean;
    hasData: () => boolean;
    update: (state: { active: boolean; hasData: boolean }) => void;
    dispose: () => void;
  };
}

interface DisplayPreferences {
  percentMode: "used" | "remaining";
  percentLabelStyle?: "full" | "bare";
  showRunway: boolean;
  detailed: boolean;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;
let quotaModule: QuotaModule;
let busyModule: BusyModule;

beforeAll(async () => {
  const created = await createServer({
    configFile: false,
    root: path.join(repoRoot, "src/ui"),
    plugins: [
      // The quota card imports the public tooltip, whose client portal is not
      // part of this string-render check.
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
    resolve: { dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
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
  quotaModule = (await graph.load("/components/quota-card.tsx")) as unknown as QuotaModule;
  busyModule = (await graph.load("/components/busy.tsx")) as unknown as BusyModule;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function render(component: unknown, props: unknown): string {
  return graph.renderToString(() => graph.createComponent(component, props));
}

/** First exact CSS rule body for a selector; an absent selector is an empty body. */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s").exec(source);
  return match?.[1] ?? "";
}

const preferences: DisplayPreferences = {
  percentMode: "used",
  showRunway: false,
  detailed: false,
};

function busyIndicator(visible: boolean, hasData: boolean) {
  return {
    visible: () => visible,
    hasData: () => hasData,
    update: () => {},
    dispose: () => {},
  };
}

describe("QuotaBar original two-segment geometry", () => {
  it.each([
    0.1, 25.125, 50, 99.9,
  ])("renders exactly two independent segments at %s percent", (displayPercent) => {
    const html = render(quotaModule.QuotaBar, {
      label: "Synthetic window",
      displayPercent,
      displayMode: "used",
    });
    expect(html.match(/qg-row__bar-fill/gu)).toHaveLength(1);
    expect(html.match(/qg-row__bar-remaining/gu)).toHaveLength(1);
    expect(html).not.toContain("qg-row__bar-gap");
    expect(html).not.toContain("qg-row__bar-track");
    expect(html).toContain(`--qg-used-position:${displayPercent}%`);
  });

  it.each([0, 100])("renders one segment and no gap at %s percent", (displayPercent) => {
    const html = render(quotaModule.QuotaBar, {
      label: "Synthetic window",
      displayPercent,
      displayMode: "used",
    });
    const segments =
      (html.match(/qg-row__bar-fill/gu) ?? []).length +
      (html.match(/qg-row__bar-remaining/gu) ?? []).length;
    expect(segments).toBe(1);
    expect(html).not.toContain("qg-row__bar-gap");
    if (displayPercent === 0) {
      expect(html).not.toContain("qg-row__bar-fill");
      expect(html).toContain("qg-row__bar-remaining");
    } else {
      expect(html).toContain("qg-row__bar-fill");
      expect(html).not.toContain("qg-row__bar-remaining");
    }
  });

  it("restores the original 8px height, 3px-capped boundary gap and 2px corners", () => {
    const bar = cssRule(styles, ".qg-row__bar");
    expect(bar).toContain("height: 8px");
    expect(bar).toContain("display: flex");
    expect(bar).toContain("gap: var(--qg-quota-gap)");
    expect(bar).toMatch(
      /--qg-quota-gap:\s*min\(\s*3px,\s*calc\(var\(--qg-used-position\) \/ 2\),\s*calc\(\(100% - var\(--qg-used-position\)\) \/ 2\)\s*\)/su,
    );
    // A single independent pair: no outer track, pill, inset padding or painted shell.
    expect(bar).not.toContain("background:");
    expect(bar).not.toContain("padding:");
    expect(bar).not.toContain("border-radius:");
    expect(bar).not.toContain("999px");

    const fill = cssRule(styles, ".qg-row__bar-fill");
    const remaining = cssRule(styles, ".qg-row__bar-remaining");
    expect(fill).toContain("flex: 0 0 auto");
    expect(fill).toContain("width: calc(var(--qg-used-position) - var(--qg-quota-gap) / 2)");
    expect(remaining).toContain("flex: 1 1 0");
    for (const segment of [fill, remaining]) {
      expect(segment).toContain("border-radius: 2px");
    }
    expect(fill).toContain("background: #72d78c");
    expect(remaining).toContain("background: #494949");
    expect(styles).not.toContain(".qg-row__bar-gap");
    expect(styles).not.toContain(".qg-row__bar-track");
  });

  it("keeps Used 0/50/100 and Remaining 100/50/0 display semantics", () => {
    for (const [used, remaining] of [
      [0, 100],
      [50, 50],
      [100, 0],
    ] as const) {
      const row = percentRow({ percentUsed: used, percentRemaining: remaining });
      expect(quotaModule.rowPercent(row, { ...preferences, percentMode: "used" })).toBe(used);
      expect(quotaModule.rowPercent(row, { ...preferences, percentMode: "remaining" })).toBe(
        remaining,
      );
    }
  });

  it("derives exhaustion severity from true used quota, not display direction", () => {
    const almostExhausted = percentRow({ percentUsed: 5, percentRemaining: 95 });
    const exhausted = percentRow({ percentUsed: 95, percentRemaining: 5 });
    expect(quotaModule.quotaUsedPercent(almostExhausted)).toBe(5);
    expect(quotaModule.quotaSeverity(quotaModule.quotaUsedPercent(almostExhausted))).toBe(
      "healthy",
    );
    expect(quotaModule.quotaUsedPercent(exhausted)).toBe(95);
    expect(quotaModule.quotaSeverity(quotaModule.quotaUsedPercent(exhausted))).toBe("critical");

    // Flipping the badge preference cannot move the exhaustion boundary.
    expect(
      quotaModule.quotaSeverity(
        quotaModule.quotaUsedPercent(percentRow({ percentUsed: 70, percentRemaining: 30 })),
      ),
    ).toBe("warning");
    expect(quotaModule.quotaSeverity(90)).toBe("critical");
  });
});

describe("delayed foreground loading", () => {
  it("keeps the fixed 1000ms delay", () => {
    vi.useFakeTimers();
    try {
      expect(busyModule.BUSY_DELAY_MS).toBe(1000);
      const indicator = busyModule.createBusyIndicator();
      indicator.update({ active: true, hasData: false });
      vi.advanceTimersByTime(999);
      expect(indicator.visible()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(indicator.visible()).toBe(true);
      indicator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses exact Loading / Updating analytics copy with no percent or ETA", () => {
    const loading = render(busyModule.BusyOverlay, {
      indicator: busyIndicator(true, false),
      label: "analytics",
    });
    expect(loading).toContain('class="qg-busy"');
    expect(loading).toContain("Loading analytics…");
    expect(loading).not.toContain("qg-busy__dot");
    expect(loading).not.toMatch(/\d+\s*%|ETA|remaining/i);

    const updating = render(busyModule.BusyOverlay, {
      indicator: busyIndicator(true, true),
      label: "analytics",
    });
    expect(updating).toContain("Updating analytics…");
    expect(updating).not.toContain("qg-busy__dot");
  });

  it("is a fixed compact dark rectangle with border-only motion", () => {
    const busy = cssRule(styles, ".qg-busy");
    expect(busy).toContain("position: fixed");
    expect(busy).toContain("background: var(--qg-surface-raised)");
    expect(busy).toContain("border: 1px solid var(--qg-border-strong)");
    expect(busy).toContain("color: var(--qg-text-secondary)");
    expect(busy).toContain("border-radius: var(--qg-radius)");
    expect(busy).not.toContain("999px");
    expect(busy).toContain("animation: qg-busy-border 2.4s ease-in-out infinite");

    expect(styles).not.toContain(".qg-busy__dot");
    expect(styles).not.toContain("qg-busy-pulse");
    expect(styles).toContain("@keyframes qg-busy-border");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.qg-busy\s*\{[^}]*animation:\s*none;/u,
    );
  });

  it("gives every busy overlay an explicit label", () => {
    const overlays = [...appSource.matchAll(/<BusyOverlay\b([^>]*)>/gu)].map(
      (match) => match[1] ?? "",
    );
    const labels = overlays.map(
      (attributes) => /\blabel="([^"]+)"/u.exec(attributes)?.[1] ?? undefined,
    );
    // Five analytics surfaces (analytics home, models, model/provider detail,
    // projects, sessions) plus the single quota view.
    expect(overlays).toHaveLength(6);
    expect(labels.every((label) => label !== undefined)).toBe(true);
    expect(labels.filter((label) => label === "analytics")).toHaveLength(5);
    expect(labels.filter((label) => label === "quota")).toHaveLength(1);
  });

  it("does not toast background range work", () => {
    const subscribeStart = appSource.indexOf("props.client.subscribe(");
    const subscribeEnd = appSource.indexOf("void (async", subscribeStart);
    expect(subscribeStart).toBeGreaterThan(-1);
    expect(subscribeEnd).toBeGreaterThan(subscribeStart);
    const subscriptionHandler = appSource.slice(subscribeStart, subscribeEnd);
    expect(subscriptionHandler).toContain("setReloadToken");
    expect(subscriptionHandler).not.toContain("toaster");
    // The only toast API is absent from app-level event invalidation.
    expect(appSource).not.toMatch(/\btoaster\.push\(/u);
  });
});
