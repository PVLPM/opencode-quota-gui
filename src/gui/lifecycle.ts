/**
 * Production dashboard lifecycle (design spec §4.3, R8, R34).
 *
 * `startDashboard` is the single entry point the server plugin calls after RPC,
 * commands, and the credential binding are in place. Repeated setup in one
 * process is a lease/refcount over one host per port: the first owner's client,
 * workspace and settings store keep the host, later leases attach to it, a
 * non-final dispose never stops it, and the host closes with the last lease.
 *
 * Nothing here throws into the plugin: every failure becomes one controlled log
 * line and a lease in state `unavailable`. A failed bind is terminal (spec
 * §4.3) — no alternate port is ever tried, and the plugin's other surfaces are
 * untouched.
 */

import { existsSync, readFileSync } from "node:fs";

import type { DashboardDataSource, GuiSettingsStore } from "../contracts/dashboard.js";
import { getGuiConfigPath, loadConfig } from "../lib/config.js";
import type { QuotaProviderContext } from "../lib/entries.js";
import { parseConfigDocument } from "../lib/opencode-config-editor.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { createGuiSettingsStore, getGuiDashboardPort } from "./config.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import {
  createDashboardServer,
  DashboardBindError,
  type DashboardServerHandle,
  type DashboardServerOptions,
} from "./server.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./snapshot-service.js";
import { createDashboardReadSource } from "./sources.js";

/**
 * The V1-shaped client the quota read path already receives (plugin `client`):
 * config reads plus the provider id list. The P3 read source accepts this shape.
 */
export type DashboardClient = QuotaProviderContext["client"];

/** The read side of the dashboard source this lifecycle needs (P3 producer). */
export type DashboardReadSource = Pick<DashboardDataSource, "home" | "project" | "session">;

export interface DashboardSourceOptions {
  client: DashboardClient;
  workspaceRoot: string;
  configDir: string;
}

export type DashboardSourceFactory = (
  options: DashboardSourceOptions,
) => DashboardReadSource | Promise<DashboardReadSource>;

export type DashboardUnavailableReason =
  | "port-unavailable"
  | "source-unavailable"
  | "settings-unavailable"
  | "server-unavailable";

/**
 * One setup's claim on the dashboard host. `running` leases share the host bound
 * on `port`; `unavailable` leases report a controlled `reason` and hold no
 * socket. Disposing is idempotent and never rejects.
 */
export interface DashboardLease {
  readonly port: number;
  readonly state: "running" | "unavailable";
  readonly url?: string;
  readonly reason?: DashboardUnavailableReason;
  dispose(): Promise<void>;
}

export interface StartDashboardOptions {
  client: DashboardClient;
  /** The first owner's workspace: supplies the project config import root. */
  workspaceRoot: string;
  /** Global OpenCode config dir; defaults to the runtime dirs. */
  configDir?: string;
  /** Test/P7 seam: replaces the P3 read-source factory. */
  createSource?: DashboardSourceFactory;
  /** Test seam: replaces the P2 settings store factory. */
  createSettingsStore?: (options: { configDir: string; workspaceRoot: string }) => GuiSettingsStore;
  /** Test seam: replaces the transport factory. */
  createServer?: (options: DashboardServerOptions) => Promise<DashboardServerHandle>;
  logger?: GuiLogger;
}

interface DashboardHost {
  readonly port: number;
  readonly logger: GuiLogger;
  refs: number;
  /** Resolves with the handle, or rejects with the contained failure. */
  readonly start: Promise<DashboardServerHandle>;
  failure?: DashboardUnavailableReason;
}

interface HostContext {
  configDir: string;
  port: number;
  minIntervalMs: number | undefined;
  logger: GuiLogger;
}

/** One host per port for the process lifetime of its leases (spec §4.3). */
const hosts = new Map<number, DashboardHost>();

/** A controlled failure; the code is the only thing ever logged. */
class DashboardLifecycleError extends Error {
  readonly code: DashboardUnavailableReason;

  constructor(code: DashboardUnavailableReason) {
    super(code);
    this.name = "DashboardLifecycleError";
    this.code = code;
  }
}

function positiveNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Strict finite-number check: `Number.isFinite` coerces nothing, so it implies a number primitive. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/** A safe log label: an error code shape, never a raw message. */
function failureLabel(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(code)) return code;
  }
  return "failed";
}

/**
 * The effective poll interval. `minIntervalMs` is effective without restart
 * (R16): the P2 store emits no events, so the getter re-reads the canonical file
 * on each call (a successful settings save or import lands there before the
 * transport restarts the poller) and falls back to the value loaded at startup
 * when the key is cleared, malformed or unreadable, then to the transport
 * default. Reading through also follows a foreign edit of the file.
 */
function minIntervalGetter(context: HostContext): () => number {
  const startup = positiveNumber(context.minIntervalMs);
  return () => canonicalMinIntervalMs(context.configDir) ?? startup ?? DEFAULT_POLL_INTERVAL_MS;
}

function canonicalMinIntervalMs(configDir: string): number | undefined {
  try {
    const path = getGuiConfigPath(configDir);
    if (!existsSync(path)) return undefined;
    const parsed = parseConfigDocument(readFileSync(path, "utf8"), "jsonc", path);
    // The parsed file is an I/O boundary: narrow once, then use the typed helper.
    const raw: unknown = parsed.minIntervalMs;
    if (!isFiniteNumber(raw)) return undefined;
    return positiveNumber(raw);
  } catch {
    return undefined;
  }
}

/** Port and interval from the effective config; a read failure keeps the defaults. */
async function readDashboardConfig(
  workspaceRoot: string,
  configDir: string,
  logger: GuiLogger,
): Promise<{ port: number; minIntervalMs: number | undefined }> {
  try {
    const config = await loadConfig(undefined, undefined, {
      configRootDir: workspaceRoot,
      globalConfigDir: configDir,
    });
    return {
      port: getGuiDashboardPort(config),
      minIntervalMs: positiveNumber(config.minIntervalMs),
    };
  } catch {
    logger.warn("dashboard config unavailable; using the default port", "config-unavailable");
    return { port: getGuiDashboardPort(undefined), minIntervalMs: undefined };
  }
}

async function createProductionSource(
  options: DashboardSourceOptions,
): Promise<DashboardReadSource> {
  return createDashboardReadSource(options);
}

/** Settings store, source and transport, in that order; each failure is contained. */
async function startHost(
  options: StartDashboardOptions,
  context: HostContext,
): Promise<DashboardServerHandle> {
  const createSettingsStore = options.createSettingsStore ?? createGuiSettingsStore;
  let settings: GuiSettingsStore;
  try {
    settings = createSettingsStore({
      configDir: context.configDir,
      workspaceRoot: options.workspaceRoot,
    });
  } catch {
    throw new DashboardLifecycleError("settings-unavailable");
  }

  const createSource = options.createSource ?? createProductionSource;
  let source: DashboardReadSource;
  try {
    source = await createSource({
      client: options.client,
      workspaceRoot: options.workspaceRoot,
      configDir: context.configDir,
    });
  } catch {
    throw new DashboardLifecycleError("source-unavailable");
  }

  const createServer = options.createServer ?? createDashboardServer;
  try {
    return await createServer({
      port: context.port,
      source,
      settings,
      minIntervalMs: minIntervalGetter(context),
      logger: context.logger,
    });
  } catch (error) {
    // A bind failure already logged its one controlled line inside the transport.
    if (error instanceof DashboardBindError) throw error;
    throw new DashboardLifecycleError("server-unavailable");
  }
}

function makeDispose(
  host: DashboardHost,
  handle: DashboardServerHandle | undefined,
): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    host.refs = Math.max(0, host.refs - 1);
    if (host.refs > 0) return;
    if (hosts.get(host.port) === host) hosts.delete(host.port);
    if (!handle) return;
    try {
      await handle.close();
    } catch (error) {
      host.logger.warn("dashboard stop failed", failureLabel(error));
    }
  };
}

async function attachLease(host: DashboardHost): Promise<DashboardLease> {
  let handle: DashboardServerHandle;
  try {
    handle = await host.start;
  } catch (error) {
    // One controlled line per failed host, however many leases attach to it.
    if (host.failure === undefined) {
      host.failure =
        error instanceof DashboardLifecycleError
          ? error.code
          : error instanceof DashboardBindError
            ? "port-unavailable"
            : "server-unavailable";
      // A bind failure already logged its one line inside the transport.
      if (host.failure !== "port-unavailable") {
        host.logger.error("dashboard unavailable", host.failure);
      }
    }
    return {
      port: host.port,
      state: "unavailable",
      reason: host.failure,
      dispose: makeDispose(host, undefined),
    };
  }
  return {
    port: host.port,
    state: "running",
    url: handle.url,
    dispose: makeDispose(host, handle),
  };
}

/**
 * Starts (or attaches to) the dashboard host for this setup. Always resolves: a
 * failed host yields an `unavailable` lease, never an exception.
 */
export async function startDashboard(options: StartDashboardOptions): Promise<DashboardLease> {
  const logger = options.logger ?? createGuiLogger();
  const configDir = options.configDir ?? getOpencodeRuntimeDirs().configDir;
  const { port, minIntervalMs } = await readDashboardConfig(
    options.workspaceRoot,
    configDir,
    logger,
  );

  const existing = hosts.get(port);
  if (existing) {
    existing.refs += 1;
    return attachLease(existing);
  }

  const host: DashboardHost = {
    port,
    logger,
    refs: 1,
    start: startHost(options, { configDir, port, minIntervalMs, logger }),
  };
  hosts.set(port, host);
  return attachLease(host);
}
