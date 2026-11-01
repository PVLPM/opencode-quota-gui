import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Host } from "@opencode/plugin/host";
import { describe, expect, it } from "vitest";

// The installed OpenCode host module is the same resolver and loader OpenCode
// uses for a local plugin directory, so these checks follow the real loader
// shape instead of a hand-rolled imitation.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(repoRoot, "server.ts");
const distEntry = join(repoRoot, "dist", "index.js");

describe("local OpenCode plugin entry", () => {
  it("resolves the repository directory through the manifest, so it is not server-only", () => {
    const entrypoints = Host.resolve({ directory: repoRoot });

    // A named package with an `exports` map resolves like the published
    // package, so a local directory load finds the built server and the
    // prebuilt GUI bundle rather than the root `server.ts` shim.
    expect(entrypoints.server).toBe(pathToFileURL(distEntry).href);
    expect(entrypoints.gui).toBe(
      pathToFileURL(join(repoRoot, "dist", "gui-experimental.cjs")).href,
    );
    // The inherited TUI source is intentionally not published or exported.
    expect(entrypoints.tui).toBeUndefined();
    expect(entrypoints.rpc).toBeUndefined();
  });

  it("keeps exactly one root server entry file", () => {
    expect(existsSync(serverEntry)).toBe(true);
    // A second extension would make Bun and Node resolvers disagree about which
    // file a local directory target loads.
    expect(existsSync(join(repoRoot, "server.js"))).toBe(false);
  });

  it("re-exports only the built plugin default", () => {
    const source = readFileSync(serverEntry, "utf8");

    expect(source.match(/^\s*export\b/gm) ?? []).toHaveLength(1);
    expect(source).toContain('export { default } from "./dist/index.js"');
    expect(source).not.toContain("export *");
  });

  it("documents the explicit server file as a server-only local entry", () => {
    const manualInstall = readFileSync(
      join(repoRoot, "docs", "readme", "manual-install.md"),
      "utf8",
    );
    const localCheckout = manualInstall.slice(
      manualInstall.indexOf("## Local checkout (development)"),
      manualInstall.indexOf("## Pre-release tarball"),
    );

    expect(localCheckout).toContain(
      '"plugins": ["file:///absolute/path/to/opencode-quota-gui/server.ts"]',
    );
    // The explicit server file deliberately skips the package exports map, so
    // it cannot load the Desktop GUI entry.
    expect(localCheckout).toContain("loads only the server");
    expect(localCheckout).toContain("does not discover the Desktop GUI export");
    // Desktop GUI development needs the directory entry instead.
    expect(localCheckout).toContain("built package directory entry");
    expect(localCheckout).toContain("`./gui-experimental`");
  });

  it("loads the built plugin default through the explicit server file after a build", async (context) => {
    if (!existsSync(distEntry)) {
      context.skip("dist/index.js is missing; run `pnpm run build` before this loader check");
      return;
    }

    const loaded = (await Host.load(pathToFileURL(serverEntry).href)) as Record<string, unknown>;
    expect(Object.keys(loaded)).toEqual(["default"]);
    const plugin = loaded.default as { id?: unknown; setup?: unknown; effect?: unknown };
    expect(plugin.id).toBe("opencode-quota-gui.server");
    expect(typeof plugin.setup === "function" || typeof plugin.effect === "function").toBe(true);

    const built = (await Host.load(pathToFileURL(distEntry).href)) as Record<string, unknown>;
    expect(loaded.default).toBe(built.default);
  });
});
