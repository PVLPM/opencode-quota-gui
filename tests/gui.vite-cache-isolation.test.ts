import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineConfig, ViteDevServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Vite test-server cache isolation.
 *
 * Each GUI test renders shipped Solid components through its own Vite dev
 * server. Left on the default configuration, every one of those servers resolves
 * the same `node_modules/.vite` dependency cache: Vite picks the nearest package
 * directory, not the per-test root. The optimizer clears that directory while
 * pre-bundling, so two test files running in parallel can recursively remove
 * each other's cache and fail with ENOTEMPTY (Windows) or missing dep chunks.
 *
 * These checks pin the isolation contract the GUI harnesses rely on: every test
 * server owns a distinct temporary cache directory, and closing the server
 * removes it again.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "src/ui");
const defaultCacheDir = path.normalize(path.join(repoRoot, "node_modules", ".vite"));

const servers: ViteDevServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** The two roots the GUI test servers use; neither belongs to its own package. */
function testConfig(root: string, name: string): InlineConfig {
  return {
    configFile: false,
    root,
    plugins: [{ name, enforce: "pre", transform: () => undefined }],
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  };
}

async function start(config: InlineConfig): Promise<ViteDevServer> {
  const server = await createIsolatedViteServer(config);
  servers.push(server);
  return server;
}

describe("GUI test Vite server caches", () => {
  it("never shares a cache directory between independently created servers", async () => {
    const [repoServer, uiServer] = await Promise.all([
      start(testConfig(repoRoot, "repo-root")),
      start(testConfig(uiRoot, "ui-root")),
    ]);

    expect(path.normalize(repoServer.config.cacheDir)).not.toBe(defaultCacheDir);
    expect(path.normalize(uiServer.config.cacheDir)).not.toBe(defaultCacheDir);
    expect(repoServer.config.cacheDir).not.toBe(uiServer.config.cacheDir);
  });

  it("removes the private cache directory when the server closes", async () => {
    const server = await start(testConfig(repoRoot, "cleanup"));
    const cacheDir = path.normalize(server.config.cacheDir);
    expect(existsSync(cacheDir)).toBe(true);

    await server.close();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("keeps two identically configured servers independent while loading modules", async () => {
    const [first, second] = await Promise.all([
      start(testConfig(repoRoot, "parallel-a")),
      start(testConfig(repoRoot, "parallel-b")),
    ]);

    await Promise.all([
      first.ssrLoadModule(path.join(repoRoot, "src/ui/format.ts")),
      second.ssrLoadModule(path.join(repoRoot, "src/ui/format.ts")),
    ]);

    expect(first.config.cacheDir).not.toBe(second.config.cacheDir);
    expect(path.normalize(first.config.cacheDir)).not.toBe(defaultCacheDir);
    expect(path.normalize(second.config.cacheDir)).not.toBe(defaultCacheDir);
  });
});
