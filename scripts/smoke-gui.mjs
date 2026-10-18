#!/usr/bin/env node
/**
 * Synthetic GUI smoke (P7; plan P7 step 2; spec §12 R43/R49/R51).
 *
 * Starts the built dashboard (`dist/gui` server + read source + settings store)
 * over a fully synthetic fixture: an invented SQLite database in this process's
 * own temp root, invented projects/sessions/messages, and two invented provider
 * accounts with a provider-reported currency row. Before any dist module loads,
 * the process points `OPENCODE_DB`, `OPENCODE_CONFIG_DIR`, and the XDG
 * data/cache/state/config dirs at that fixture root, so no real OpenCode
 * profile, config, database, credential, or provider API is read. The
 * environment is restored and the temp root removed on close; `close()` is
 * idempotent, so signal shutdown and test teardown can both call it.
 *
 * Usage: `node scripts/smoke-gui.mjs [--port <n>]` after `pnpm run build`.
 * `--port 0` binds an ephemeral port (tests). No fallback port is ever tried.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildSyntheticProviderProbes,
  SYNTHETIC_PROVIDER_ID,
  SYNTHETIC_PROVIDER_LABEL,
  seedSyntheticFixture,
} from "./fixtures/synthetic-gui-dashboard.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DIST_MODULES = {
  server: join(REPO_ROOT, "dist", "gui", "server.js"),
  sources: join(REPO_ROOT, "dist", "gui", "sources.js"),
  config: join(REPO_ROOT, "dist", "gui", "config.js"),
  types: join(REPO_ROOT, "dist", "lib", "types.js"),
};

/** Every path-bearing env var the fixture pins before dist modules load. */
const ENV_KEYS = [
  "OPENCODE_DB",
  "OPENCODE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

function removeFixtureRoot(root) {
  return rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertBuiltDist() {
  const missing = Object.entries(DIST_MODULES)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `the built dashboard modules are missing (${missing.join(", ")}); run "pnpm run build" first`,
    );
  }
}

async function importDistModules() {
  assertBuiltDist();
  const [server, sources, config, types] = await Promise.all([
    import(pathToFileURL(DIST_MODULES.server).href),
    import(pathToFileURL(DIST_MODULES.sources).href),
    import(pathToFileURL(DIST_MODULES.config).href),
    import(pathToFileURL(DIST_MODULES.types).href),
  ]);
  return { server, sources, config, types };
}

/**
 * Starts the built dashboard over a fresh synthetic fixture and returns
 * `{ url, close }`. `close()` is idempotent and removes only the temp root this
 * call created after restoring the previous environment.
 */
export async function startSyntheticDashboard(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-gui-smoke-"));
  const previousEnv = new Map();

  function restoreEnvironment() {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function removeOwnRoot() {
    try {
      await removeFixtureRoot(root);
    } catch {
      // Best effort: the OS temp cleaner owns anything a locked file prevents.
    }
  }

  let dashboard;

  try {
    const fixture = seedSyntheticFixture(root, nowMs);
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.OPENCODE_DB = fixture.dbPath;
    process.env.OPENCODE_CONFIG_DIR = fixture.configDir;
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    process.env.XDG_DATA_HOME = join(root, "xdg-data");
    process.env.XDG_CACHE_HOME = join(root, "xdg-cache");
    process.env.XDG_STATE_HOME = join(root, "xdg-state");

    const modules = await importDistModules();
    const settings = modules.config.createGuiSettingsStore({
      configDir: fixture.configDir,
      workspaceRoot: fixture.workspaceRoot,
    });
    const source = modules.sources.createDashboardReadSource({
      // Unused: provider results are injected below, so no credential or
      // provider implementation is ever touched (R51).
      client: {},
      workspaceRoot: fixture.workspaceRoot,
      configDir: fixture.configDir,
      now: () => nowMs,
      collectProviderResults: () => Promise.resolve(buildSyntheticProviderProbes(nowMs)),
      providerLabel: (providerId) =>
        providerId === SYNTHETIC_PROVIDER_ID ? SYNTHETIC_PROVIDER_LABEL : providerId,
    });
    const port = options.port ?? modules.types.DEFAULT_DASHBOARD_PORT;
    const handle = await modules.server.createDashboardServer({ port, source, settings });
    dashboard = { handle };
  } catch (error) {
    restoreEnvironment();
    await removeOwnRoot();
    throw error;
  }

  let closing;
  function close() {
    if (closing === undefined) {
      closing = (async () => {
        let closeFailure;
        try {
          await dashboard.handle.close();
        } catch (error) {
          closeFailure = error;
        }
        restoreEnvironment();
        await removeOwnRoot();
        if (closeFailure !== undefined) throw closeFailure;
      })();
    }
    return closing;
  }

  return { url: dashboard.handle.url, close };
}

/**
 * Minimal parser: `--port <n>` only. `0` is accepted for tests; an occupied
 * port is a terminal failure, never a fallback.
 */
function parseCliArgs(argv) {
  const parsed = { port: undefined, error: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const inlineValue = arg.startsWith("--port=") ? arg.slice("--port=".length) : undefined;
    const inline = inlineValue !== undefined;
    if (arg !== "--port" && !inline) {
      parsed.error = `unknown argument: ${arg}`;
      return parsed;
    }
    const value = Number(inline ? inlineValue : argv[index + 1]);
    if (!inline) index += 1;
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      parsed.error = "invalid --port value; expected an integer between 0 and 65535";
      return parsed;
    }
    parsed.port = value;
  }
  return parsed;
}

async function runCli() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(`smoke-gui: ${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }

  let dashboard;
  try {
    dashboard =
      parsed.port === undefined
        ? await startSyntheticDashboard()
        : await startSyntheticDashboard({ port: parsed.port });
  } catch (error) {
    const code = error === null || error === undefined ? undefined : error.code;
    if (code === "unavailable") {
      process.stderr.write(
        `smoke-gui: 127.0.0.1:${error.port} is already in use; no fallback port is attempted\n`,
      );
    } else {
      process.stderr.write(
        'smoke-gui: could not start the synthetic dashboard (run "pnpm run build" first)\n',
      );
    }
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    dashboard.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The only stdout contract: the ready URL and one synthetic-data notice.
  process.stdout.write(`synthetic dashboard ready at ${dashboard.url}\n`);
  process.stdout.write(
    "synthetic fixture data only; no real OpenCode config, database, or provider API is read\n",
  );
}

const invokedAsScript =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  runCli().catch(() => {
    process.stderr.write("smoke-gui: unexpected failure\n");
    process.exitCode = 1;
  });
}
