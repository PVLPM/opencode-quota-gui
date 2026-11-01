import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Desktop GUI bundle evidence (Stage 4).
 *
 * The host loads one CommonJS file and supplies its own copies of Solid and the
 * plugin API, so the artifact must require nothing else. The test runs the real
 * `vite.native.config.mjs` build and inspects the emitted file: the module set,
 * the shipped product CSS and selectors, the inlined provider marks, and the
 * absence of the browser dashboard transport and the UI library.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(repoRoot, "dist/gui-experimental.cjs");

/** The only specifiers the host guarantees to a plugin GUI. */
const ALLOWED_REQUIRES = new Set([
  "@opencode/plugin/gui",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
]);

let bundle = "";

beforeAll(async () => {
  await build({
    configFile: path.join(repoRoot, "vite.native.config.mjs"),
    root: repoRoot,
    logLevel: "silent",
  });
  bundle = readFileSync(bundlePath, "utf8");
}, 120_000);

describe("Desktop GUI bundle", () => {
  it("emits one CommonJS window bundle with a default plugin export", () => {
    expect(bundle.length).toBeGreaterThan(0);
    expect(bundle).toMatch(/exports\.default\s*=/u);
  });

  it("requires only the modules the app provides", () => {
    const requires = [...bundle.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1] ?? "");
    expect(requires.length).toBeGreaterThan(0);
    for (const specifier of requires) {
      expect(ALLOWED_REQUIRES.has(specifier), `unexpected require: ${specifier}`).toBe(true);
    }
    expect(requires).toContain("@opencode/plugin/gui");
    expect(requires).toContain("solid-js");
  });

  it("carries the shipped product stylesheet and its selectors", () => {
    for (const token of [
      ":root,.qg-native",
      "qg-panel-root",
      "qg-quota",
      "qg-card-grid",
      "qg-temporal__chip",
      "qg-temporal-popover",
      "qg-native-popover",
      "qg-stale__retry",
      "Retry quota connection",
      ".qg-native .sr-only",
    ]) {
      expect(bundle, `missing ${token}`).toContain(token);
    }
    // The injected product sheet must not style the host's own `.sr-only`.
    expect(bundle).not.toMatch(/(?:^|[},])\.sr-only\{/u);
  });

  it("inlines the provider marks instead of fetching browser assets", () => {
    // The glob is compiled to the raw sources; every shipped mark contributes
    // one `viewBox`, so a catalog that silently stopped inlining fails here.
    expect(bundle).toContain("data:image/svg+xml");
    expect(bundle).toContain("data-provider-logo");
    expect(bundle.match(/viewBox=/gu)?.length ?? 0).toBeGreaterThan(200);
  });

  it("keeps the browser dashboard transport out of the window", () => {
    for (const token of [
      "@opencode/ui",
      "EventSource",
      "localStorage",
      "history.pushState",
      "localhost",
      "sourceMappingURL",
    ]) {
      expect(bundle, `unexpected ${token}`).not.toContain(token);
    }
  });
});
