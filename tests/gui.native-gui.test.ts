import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Desktop GUI wiring (Stage 5).
 *
 * The native bundle is the product's second host, not a second product. These
 * checks keep that true at the seams a build cannot prove on its own: one side
 * panel that renders the shared dashboard route containers, window-local
 * navigation for Analytics/Models/drilldowns, an official SettingsPage using
 * the shared settings view and backend, the two module substitutions the host
 * cannot provide, the release manifest, and the stylesheet split that lets the
 * same product CSS be injected into a foreign document without repainting it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

interface ConditionalExport {
  default?: string;
  types?: string;
}

interface PackageManifest {
  scripts?: Record<string, string>;
  exports?: Record<string, ConditionalExport>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PluginManifest {
  version?: string;
  exports?: Record<string, ConditionalExport | null>;
}

function readJson<T>(relativePath: string): T {
  // SAFETY: every path below is this repository's own JSON manifest, and the
  // assertions that follow fail loudly if a field this test reads is absent.
  return JSON.parse(read(relativePath)) as T;
}

function nativeSources(directory = "src/native"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...nativeSources(relative));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(relative);
  }
  return files.sort();
}

/** Comments describe the bundle; only executable text can make it reach for an API. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
  ]) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.add(match[1] ?? "");
      match = pattern.exec(source);
    }
  }
  return [...specifiers];
}

const packageJson = readJson<PackageManifest>("package.json");
const packageScripts = packageJson.scripts ?? {};
const devDependencies = packageJson.devDependencies ?? {};
const dependencies = packageJson.dependencies ?? {};
const peerDependencies = packageJson.peerDependencies ?? {};
const exportsMap = packageJson.exports ?? {};

const guiSource = read("src/native/gui.tsx");
const panelSource = read("src/native/panel.tsx");
const stateSource = read("src/native/panel-state.ts");
const navigationSource = read("src/native/navigation.ts");
const settingsPageSource = read("src/native/settings-page.tsx");
const settingsStateSource = read("src/native/settings-page-state.ts");
const routesSource = read("src/ui/routes.tsx");
const appSource = read("src/ui/app.tsx");
const settingsView = read("src/ui/views/settings.tsx");
const settingsModel = read("src/ui/settings-model.ts");
const configSource = read("vite.native.config.mjs");
const productCss = read("src/ui/styles.css");
const baseCss = read("src/ui/base.css");
const nativeCss = read("src/native/native.css");
const browserEntry = read("src/ui/main.tsx");
const buildRunner = read("scripts/build-identity.mjs");

describe("Desktop GUI entry", () => {
  it("registers one side panel that renders the shared dashboard shell", () => {
    expect(guiSource).toContain('from "@opencode/plugin/gui"');
    expect(guiSource).toMatch(/ctx\.add\(Panel,\s*\{/u);
    expect(guiSource).toMatch(/region:\s*"side"/u);
    expect(guiSource).toMatch(/const TAB_ID = "dashboard"/u);
    expect(guiSource).toMatch(/mobile:\s*\{[^}]*kind:\s*"menu"/su);
    expect(guiSource).toMatch(/render:\s*\(\)\s*=>\s*<NativeDashboardPanel\s*\/>/u);
    expect(guiSource).toMatch(/visible=\{panel\.visible\}/u);
    expect(panelSource).toContain("DashboardPanel");
  });

  it("follows the host's live built-in server connection", () => {
    expect(guiSource).toContain("ctx.servers");
    expect(guiSource).toContain(".builtin");
    expect(guiSource).toContain(".connected");
    expect(guiSource).toMatch(/hostConnected=\{hostConnected\}/u);
    expect(panelSource).toContain("hostConnected");
  });

  it("offers an accessible retry while data is stale", () => {
    expect(panelSource).toContain('class="qg-stale__retry"');
    expect(panelSource).toContain('aria-label="Retry dashboard data"');
    expect(panelSource).toContain("onClick={() => panel.retry()}");
    expect(nativeCss).toContain(".qg-stale__retry");
  });

  it("opens the same tab from the command palette and the + menu", () => {
    expect(guiSource).toMatch(/ctx\.add\(Command,\s*\{/u);
    expect(guiSource).toMatch(/ctx\.add\(MenuItem,\s*\{/u);
    expect(guiSource).toContain('menu: "session.panel"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the assertion is the literal source of the host tab key.
    expect(guiSource).toContain("`${ctx.id}:${TAB_ID}`");
    expect(guiSource).toMatch(/title:\s*"Open dashboard panel"/u);
    expect(guiSource).toMatch(/title:\s*"Dashboard"/u);
  });

  it("injects the product stylesheet before the host-only additions", () => {
    const product = guiSource.indexOf("ctx.add(Style, productCss)");
    const native = guiSource.indexOf("ctx.add(Style, nativeCss)");
    expect(product).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(product);
    expect(guiSource).toContain('from "../ui/styles.css?inline"');
    expect(guiSource).toContain('from "./native.css?inline"');
  });

  it("reuses the shared route containers and feature views rather than redrawing them", () => {
    expect(panelSource).toContain('from "../ui/routes"');
    for (const route of [
      "QuotaRoute",
      "AnalyticsRoute",
      "ModelsRoute",
      "GroupDetailRoute",
      "ProjectRoute",
      "SessionRoute",
    ]) {
      expect(panelSource, `missing ${route}`).toContain(route);
    }
    expect(panelSource).toContain("AnalyticsTabs");
    expect(panelSource).toContain("SegmentedControl");
    expect(panelSource).toContain("TemporalStatusStrip");
    expect(panelSource.match(/enabled=\{props\.visible\}/gu)?.length).toBe(7);
    expect(routesSource).toContain("function routeEnabled");
    expect(routesSource).toContain("props.enabled?.() !== false");
    expect(routesSource.match(/props\.onFresh\?\.\(\)/gu)?.length).toBe(6);
    expect(stateSource).toContain('from "../ui/query.js"');

    for (const view of [
      "QuotaView",
      "QuotaLoading",
      "HomeView",
      "ModelsView",
      "ModelDetailView",
      "ProviderDetailView",
      "ProjectView",
      "SessionView",
      "SettingsView",
    ]) {
      expect(routesSource, `missing ${view}`).toContain(view);
    }
    expect(appSource).toContain('from "./routes"');
  });

  it("replaces the staged Analytics entry with the current internal hierarchy", () => {
    expect(panelSource).not.toContain("not yet available");
    expect(panelSource).not.toContain('aria-disabled="true"');
    expect(panelSource).toContain('aria-label="Analytics"');
    expect(panelSource).toContain(
      'data-section-active={analyticsTab() === undefined ? undefined : "true"}',
    );
    expect(panelSource).toContain('formatPath({ name: "analytics" }, range())');
    expect(panelSource).toContain("modelsDimension() ?? rememberedModelsDimension()");
    for (const name of ["home", "analytics", "models", "model", "provider", "project", "session"]) {
      expect(panelSource, `missing ${name} route`).toContain(`when={route().name === "${name}"}`);
    }
    expect(panelSource).not.toContain("SettingsRoute");
  });

  it("keeps navigation window-local: no browser URL, history or storage", () => {
    expect(panelSource).toContain("initialNativeLocation");
    expect(panelSource).toContain("navigateNative");
    expect(panelSource).toContain('addEventListener("click", handleClick)');
    expect(panelSource).toContain('addEventListener("auxclick", handleAuxClick)');
    expect(navigationSource).toContain("parseLocation(path, current.range)");
    expect(navigationSource).toContain("setNativeRange");
    expect(navigationSource).toContain("replaceModelsDimension");

    const executable = stripComments(navigationSource);
    for (const token of ["history", "localStorage", "window.location", "pushState"]) {
      expect(executable, `navigation uses ${token}`).not.toContain(token);
    }
  });

  it("reaches no browser dashboard, no UI library and no second transport", () => {
    for (const file of nativeSources()) {
      const source = read(file);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, file).not.toMatch(/^@opencode\/ui(?:\/|$)/u);
        expect(specifier, file).not.toMatch(/^@opencode\/client(?:\/|$)/u);
        expect(specifier, file).not.toMatch(/^@opencode\/schema(?:\/|$)/u);
        expect(specifier, file).not.toMatch(/(?:^|\/)gui\/server(?:\.|$)/u);
      }
      const executable = stripComments(source);
      for (const token of [
        "EventSource",
        "localStorage",
        "history.pushState",
        "window.location",
        "WebSocket",
        "localhost",
      ]) {
        expect(executable, `${file} uses ${token}`).not.toContain(token);
      }
    }
  });

  it("returns the shared transport to the Stage 3 client seam", () => {
    expect(guiSource).toContain("createGuiRpcCaller(ctx)");
    expect(read("src/native/rpc.ts")).toContain("ctx.client.rpc(DashboardRpc)");
    expect(read("src/native/dashboard-client.ts")).toContain("createNativeDashboardClient");
  });

  it("registers the official SettingsPage with the shared settings view and backend", () => {
    expect(guiSource).toMatch(/ctx\.add\(SettingsPage,\s*\{/u);
    expect(guiSource).toContain("id: SETTINGS_PAGE_ID");
    expect(guiSource).toContain('title: "Quota & analytics"');
    expect(guiSource).toContain('icon: "window-analytics"');
    expect(guiSource).toMatch(/render:\s*\(\)\s*=>\s*<NativeSettingsPage ctx=\{ctx\}\s*\/>/u);
    expect(guiSource).toContain("ctx.layout.settings(SETTINGS_PAGE_ID)");
    expect(settingsPageSource).toContain('from "../ui/routes"');
    expect(settingsPageSource).toContain("SettingsRoute");
    expect(settingsPageSource).toContain("createNativeDashboardClient");
    expect(settingsPageSource).toContain("createGuiRpcCaller");
    expect(settingsPageSource).toContain("ctx.servers");
    expect(settingsPageSource).toContain(".builtin");
    expect(settingsPageSource).toContain(".connected");
    expect(settingsPageSource).toContain("hostConnected");
    expect(settingsPageSource).toContain('data-settings="true"');
    expect(settingsStateSource).toContain("hostStale");
    expect(settingsStateSource).toContain("recoveredHostEpoch");
  });

  it("keeps settings capabilities in the shared view, not a native copy", () => {
    expect(settingsStateSource).toContain("client.settings()");
    expect(settingsStateSource).toContain("client.quota()");
    expect(settingsStateSource).toContain("client.onReconnect");
    expect(settingsStateSource).toContain("visibilityCatalogEquals");
    expect(settingsStateSource).not.toContain("localStorage");

    expect(settingsView).toContain("props.client.saveSettings");
    expect(settingsView).toContain("SETTINGS_FIELDS");
    for (const key of [
      "dashboard.hiddenCards",
      "dashboard.cardOrder",
      "dashboard.temporalProviderOverrides",
      "dashboard.enabled",
      "dashboard.port",
    ]) {
      expect(settingsModel, `missing ${key}`).toContain(key);
    }
    expect(settingsModel).toContain("fieldErrors");
    expect(settingsModel).toContain("applyConflict");
  });

  it("exposes the Web dashboard switch and quota staleness only on the native surface", () => {
    // Native Settings opts into the shared Web-dashboard row; the Web shell does not.
    expect(settingsPageSource).toContain("webDashboardToggle");
    expect(settingsView).toContain("webDashboardToggle");
    expect(settingsView).toContain("dashboard.enabled");
    expect(routesSource).toContain("webDashboardToggle");
    expect(appSource).not.toContain("webDashboardToggle");

    // Quota feeds visibility, catalog and temporal rows, so its failure or stale
    // flag has to be reported and retried without dropping the cached catalog.
    expect(settingsStateSource).toContain("quotaStale");
    expect(settingsStateSource).toContain("quotaQuery.error()");
    expect(settingsStateSource).toContain("quotaQuery.data()?.stale");
    expect(settingsPageSource).toContain("state.quotaStale()");
    expect(settingsPageSource).toContain("Quota data may be stale");
    expect(settingsPageSource).toContain("Retry settings and quota data");

    // Settings and quota each anchor their own reconnect freshness. A clean
    // first load waits for both; a settled failure becomes actionable at once,
    // so Retry is never hidden behind the other read's pending state.
    expect(settingsStateSource).toContain("quotaFreshEpoch");
    expect(settingsStateSource).toContain(
      "isStaleAfterReconnect(reconnectEpoch(), quotaFreshEpoch())",
    );
    expect(settingsStateSource).toContain("const loading =");
    expect(settingsStateSource).toContain("settledError");
    expect(settingsStateSource).toContain("const retryable =");
    expect(settingsPageSource).toContain("state.loading()");
    expect(settingsPageSource).toContain("Loading settings and quota data");
    expect(settingsPageSource).toContain("state.retryable()");
    expect(settingsPageSource).not.toContain("<Show when={!state.loading()}>");

    // A quota failure with no payload gets an explicit retryable error instead
    // of mounting the editor on an empty catalog.
    expect(settingsPageSource).toContain("contentMode");
    expect(settingsPageSource).toContain('"quota-error"');
    expect(settingsPageSource).toContain("Quota data could not be loaded");
    expect(settingsPageSource).toContain("state.quota() === undefined");
  });

  it("never renders quota cards from default visibility before settings load", () => {
    // The settings read owns hidden cards/rows. Until it succeeds there is no
    // authoritative visibility, so the Quota route is gated and fails closed.
    expect(panelSource).toContain("when={panel.settings()}");
    expect(panelSource).toContain("panel.settingsError()");
    expect(panelSource).toContain("ErrorCard");
    expect(panelSource).toContain("settings().visibility.hiddenCards");
    expect(panelSource).toContain("settings().visibility.hiddenRows");
    expect(panelSource).not.toContain("panel.hiddenCards()");
    expect(panelSource).not.toContain("panel.hiddenRows()");
    expect(stateSource).not.toContain("hiddenCards");
    expect(stateSource).not.toContain("settingsQuery.data()?.values ?? {}");

    // A failed shell read is reported in the header and retried locally while
    // the transport is still live.
    expect(panelSource).toContain("panel.settingsStale()");
    expect(panelSource).toContain("Display settings unavailable");
    expect(panelSource).toContain("Display settings may be stale");
    expect(stateSource).toContain("settingsStale");
    expect(stateSource).toContain("refreshSettings()");
  });

  it("recovers read failures without falling back to a browser reload", () => {
    expect(routesSource).not.toContain("location.reload");
    expect((routesSource.match(/onRetry=/gu) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(settingsPageSource).toContain("onRetry={state.retry}");
  });

  it("keeps the product hierarchy, in order", () => {
    let previous = -1;
    for (const name of ["qg-app", "qg-chrome", "qg-frame", "qg-main"]) {
      const position = panelSource.indexOf(`class="${name}"`);
      expect(position, `missing ${name}`).toBeGreaterThan(previous);
      previous = position;
    }
  });
});

describe("native build configuration", () => {
  it("uses the host preset and swaps only the two modules the app cannot provide", () => {
    expect(configSource).toContain(
      'gui({ entry: "src/native/gui.tsx", outFile: "dist/gui-experimental.cjs" })',
    );
    expect(configSource).toContain("opencode-ui$");
    expect(configSource).toContain("src/native/ui.tsx");
    expect(configSource).toContain("provider-logo$");
    expect(configSource).toContain("components\\/provider-logo$");
    expect(configSource).toContain("src/native/provider-logo.tsx");
    expect(configSource).toMatch(/dedupe:\s*\["solid-js", "solid-js\/web", "solid-js\/store"\]/u);
    expect(configSource).toMatch(/sourcemap:\s*false/u);
    expect(configSource).toContain("__OPENCODE_QUOTA_BUILD_IDENTITY__");
  });

  it("ships the bundle from the same package with a bounded server peer", () => {
    expect(exportsMap["./gui-experimental"]?.default).toBe("./dist/gui-experimental.cjs");
    expect(packageScripts["build:gui"]).toBe("vite build --config vite.native.config.mjs");
    expect(devDependencies["@opencode/plugin"]).toBe("2.2.0");
    expect(peerDependencies["@opencode/plugin"]).toBe(">=2.0.16 <2.3.0");
    expect(dependencies["@opencode/plugin"]).toBeUndefined();
    expect(dependencies["@opencode/ui"]).toBeUndefined();
    expect(devDependencies["@opencode/ui"]).toBe("2.0.32");

    const installed = readJson<PluginManifest>("node_modules/@opencode/plugin/package.json");
    expect(installed.version).toBe("2.2.0");
    const pluginExports = installed.exports ?? {};
    expect(pluginExports["./gui"]).toBeDefined();
    expect(pluginExports["./gui/vite"]).toBeDefined();
  });

  it("builds the Desktop artifact after the browser UI in the release runner", () => {
    const browser = buildRunner.indexOf('"vite.ui.config.mjs"');
    const desktop = buildRunner.indexOf('"vite.native.config.mjs"');
    expect(browser).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(browser);
    expect(packageScripts.build).toBe("node scripts/build-identity.mjs");
  });

  it("typechecks the Desktop program as its own Solid project", () => {
    expect(packageScripts.typecheck).toContain("tsc -p tsconfig.native.json");
    const backend = readJson<{ exclude?: string[] }>("tsconfig.json");
    expect(backend.exclude).toContain("src/native");
    const nativeProject = readJson<{
      compilerOptions?: { jsxImportSource?: string; noEmit?: boolean };
      include?: string[];
    }>("tsconfig.native.json");
    expect(nativeProject.compilerOptions?.jsxImportSource).toBe("solid-js");
    expect(nativeProject.compilerOptions?.noEmit).toBe(true);
    expect(nativeProject.include).toContain("src/native/**/*");
  });
});

describe("stylesheet scoping for a host document", () => {
  it("moves document rules out of the product stylesheet", () => {
    expect(productCss).not.toMatch(/^html\s*\{/mu);
    expect(productCss).not.toMatch(/^body\s*\{/mu);
    expect(productCss).not.toContain("*::before");
    expect(productCss).not.toContain("animation-duration: 0.001ms");

    expect(baseCss).toMatch(/^html\s*\{/mu);
    expect(baseCss).toMatch(/^body\s*\{/mu);
    expect(baseCss).toContain("box-sizing: border-box");
    expect(baseCss).toContain("animation-duration: 0.001ms !important");
  });

  it("makes the product variables reachable from the native root", () => {
    expect(productCss).toMatch(/:root,\s*\.qg-native\s*\{/u);
  });

  it("loads the document rules last in the browser entry", () => {
    const wrapper = browserEntry.indexOf('import "./opencode-ui"');
    const product = browserEntry.indexOf('import "./styles.css"');
    const document = browserEntry.indexOf('import "./base.css"');
    expect(wrapper).toBeGreaterThan(-1);
    expect(product).toBeGreaterThan(wrapper);
    expect(document).toBeGreaterThan(product);
  });

  it("keeps host styling inside the panel and settings scopes", () => {
    expect(nativeCss).not.toMatch(/^html\s*\{/mu);
    expect(nativeCss).not.toMatch(/^body\s*\{/mu);
    expect(nativeCss).not.toMatch(/^:root\s*\{/mu);
    expect(nativeCss).toContain(".qg-panel-root");
    expect(nativeCss).toContain(".qg-native.qg-settings-page");
    expect(nativeCss).toContain(".qg-settings-page__status");
    expect(nativeCss).toContain(".qg-settings-page .qg-toasts");
    expect(nativeCss).toContain(":where(.qg-native)");
    expect(nativeCss).toContain("prefers-reduced-motion");
  });

  it("styles the shared library button variants the settings view uses", () => {
    for (const variant of ["outline", "contrast", "ghost-muted"]) {
      expect(nativeCss, `missing ${variant}`).toContain(`.qg-button--${variant}`);
    }
  });

  it("scopes the screen-reader utility for host injection", () => {
    expect(productCss).not.toMatch(/^\.sr-only\s*\{/mu);
    expect(productCss).toContain(".qg-native .sr-only");
    expect(baseCss).toMatch(/^\.sr-only\s*\{/mu);
  });
});
