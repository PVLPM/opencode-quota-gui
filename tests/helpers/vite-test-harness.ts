import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";

/**
 * A Vite dev server for a test file, with a dependency cache of its own.
 *
 * Vite resolves the default `node_modules/.vite` cache from the nearest package
 * directory, which is the repository for every GUI test root. Nine test files
 * therefore shared one cache, and the dep optimizer clears that directory while
 * pre-bundling: parallel test files could delete each other's cache mid-run
 * (ENOTEMPTY on Windows, missing dep chunks elsewhere).
 *
 * Each server gets a fresh directory under the OS temp directory instead.
 * `afterAll` already closes these servers, so closing is wrapped to remove the
 * directory once Vite has released its watchers and optimizer handles; the
 * wrapper is idempotent like `ViteDevServer.close` itself.
 */
export async function createIsolatedViteServer(config: InlineConfig): Promise<ViteDevServer> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "opencode-quota-gui-vite-"));
  let server: ViteDevServer;
  try {
    server = await createServer({ ...config, cacheDir });
  } catch (error) {
    await removeCacheDir(cacheDir);
    throw error;
  }

  const close = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () => {
    closing ??= close().then(
      () => removeCacheDir(cacheDir),
      async (error: unknown) => {
        await removeCacheDir(cacheDir);
        throw error;
      },
    );
    return closing;
  };
  return server;
}

async function removeCacheDir(cacheDir: string): Promise<void> {
  // Windows can still hold optimizer handles briefly after close(); the retry
  // budget covers that without masking a genuine cleanup failure.
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
