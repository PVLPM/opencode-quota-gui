/**
 * Production dashboard lifecycle (design spec §4.3, R8, R34).
 *
 * `startDashboard` is the single entry point the server plugin calls after RPC,
 * commands, and the credential binding are in place. Repeated setup in one
 * process is a lease/refcount over one host per port. Every lease registers its
 * own source factory/client/workspace; requests are served through the active
 * owner's source, and when that owner disposes while other leases remain the
 * host switches to a live owner's source — created lazily on the next request —
 * without dropping the socket. The settings store is host-scoped file access.
 * The host closes with the last lease, releasing every source it created.
 *
 * The registry lives on `globalThis` under a versioned `Symbol.for` key (the
 * quota-telemetry precedent), so two separately loaded copies of this module in
 * one process share the same host and refcount instead of racing for the port.
 * Failures are classified by their controlled `code`, never by class identity:
 * an error thrown by another module graph is structurally identical.
 *
 * Nothing here throws into the plugin: every failure becomes one controlled log
 * line and a lease in state `unavailable`. A failed bind is terminal (spec
 * §4.3) — no alternate port is ever tried, and the plugin's other surfaces are
 * untouched.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type {
  DashboardDataSource,
  GuiSettingsStore,
  QuotaSnapshot,
} from "../contracts/dashboard.js";
import { getGuiConfigPath, loadConfig } from "../lib/config.js";
import type { QuotaProviderContext } from "../lib/entries.js";
import { parseConfigDocument } from "../lib/opencode-config-editor.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { createGuiSettingsStore, getGuiDashboardPort } from "./config.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import {
  createDashboardServer,
  type DashboardRestartController,
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
export type DashboardReadSource = Pick<DashboardDataSource, "home" | "project" | "session"> & {
  quota?(): Promise<QuotaSnapshot>;
  /** One shared analytics refresh per transport tick, when the owner loaded analytics. */
  refreshAnalytics?(): Promise<void>;
  /** Owner dispose / host close: releases lazily created analytics resources. */
  close?(): Promise<void>;
};

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

/**
 * One live setup's source registration. The first owner's source is created
 * eagerly so a broken factory still fails setup; every other owner's source is
 * created lazily on the first request after that owner becomes active. Dispose
 * clears the factory/client/workspace references, so a disposed owner retains
 * nothing that belongs to an ended plugin setup.
 */
interface DashboardOwner {
  factory: DashboardSourceFactory | undefined;
  sourceOptions: DashboardSourceOptions | undefined;
  source?: DashboardReadSource;
  creating?: Promise<DashboardReadSource>;
  /** Bumped by every release so an in-flight creation cannot publish again. */
  sourceVersion: number;
  disposed: boolean;
}

/** Which owner's source serves the host right now; switched on active dispose. */
interface OwnerDelegation {
  readonly owners: DashboardOwner[];
  activeOwner?: DashboardOwner;
}

/**
 * Host-scoped pieces needed to build a replacement transport. They survive
 * owner disposal because they are not a setup's client/workspace; the source is
 * the stable delegate whose per-owner factories are recreated lazily.
 */
interface HostTransport {
  readonly source: DashboardReadSource;
  readonly settings: GuiSettingsStore;
  readonly createServer: (options: DashboardServerOptions) => Promise<DashboardServerHandle>;
  readonly minIntervalMs: () => number;
}

/** One acknowledged restart reservation, kept until its replacement settles. */
interface PendingRestart {
  readonly id: string;
  phase: "pending" | "running";
  readonly done: Promise<void>;
  resolveDone(): void;
}

interface DashboardHost {
  readonly port: number;
  readonly logger: GuiLogger;
  readonly delegation: OwnerDelegation;
  refs: number;
  /** Resolves with the initial handle, or rejects with the contained failure. */
  readonly start: Promise<DashboardServerHandle>;
  transport?: HostTransport;
  /** The live listener; mutable so every lease disposes the current generation. */
  handle?: DashboardServerHandle;
  failure?: DashboardUnavailableReason;
  /** Set by the last lease before it stops the host: never resurrect. */
  retired: boolean;
  restart?: PendingRestart;
}

interface HostContext {
  configDir: string;
  port: number;
  minIntervalMs: number | undefined;
  logger: GuiLogger;
}

/**
 * Versioned process-wide host registry. `Symbol.for` is realm-global, so every
 * separately loaded copy of this module in the same process resolves the same
 * map and shares the refcount and socket. The version is bumped when the host
 * record shape changes (`v2` adds owner delegation): an older copy then fails
 * the fixed port terminally instead of mutating a host it does not understand.
 */
const HOST_REGISTRY_KEY = Symbol.for("opencode-quota-gui/dashboard-lifecycle/v2");

interface DashboardHostRegistry {
  readonly hosts: Map<number, DashboardHost>;
}

function hostRegistry(): DashboardHostRegistry {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalState[HOST_REGISTRY_KEY] as DashboardHostRegistry | undefined;
  if (existing) return existing;

  const registry: DashboardHostRegistry = { hosts: new Map() };
  globalState[HOST_REGISTRY_KEY] = registry;
  return registry;
}

function createOwner(options: StartDashboardOptions, configDir: string): DashboardOwner {
  return {
    factory: options.createSource ?? createProductionSource,
    sourceOptions: {
      client: options.client,
      workspaceRoot: options.workspaceRoot,
      configDir,
    },
    sourceVersion: 0,
    disposed: false,
  };
}

/** The owner's source, created at most once and shared by concurrent callers. */
function ownerSource(owner: DashboardOwner, logger: GuiLogger): Promise<DashboardReadSource> {
  if (owner.source) return Promise.resolve(owner.source);
  if (owner.creating) return owner.creating;

  const { factory, sourceOptions } = owner;
  if (!factory || !sourceOptions) {
    return Promise.reject(new DashboardLifecycleError("source-unavailable"));
  }

  let created: Promise<DashboardReadSource>;
  try {
    created = Promise.resolve(factory(sourceOptions));
  } catch (error) {
    return Promise.reject(error);
  }

  const version = owner.sourceVersion;
  const attempt = created.then(async (source) => {
    if (owner.disposed || owner.sourceVersion !== version) {
      // A release invalidated this creation while it was in flight (dispose or
      // restart handoff). Close it here and reject; the release continuation
      // observes the rejection and cannot close it again. Never publish it as
      // reusable state.
      await closeSource(source, logger);
      throw new DashboardLifecycleError("source-unavailable");
    }
    owner.source = source;
    return source;
  });
  owner.creating = attempt;
  const clear = () => {
    if (owner.creating === attempt) owner.creating = undefined;
  };
  // Clears the shared attempt on both settlement paths without a floating
  // rejection of its own.
  void attempt.then(clear, clear);
  return attempt;
}

/** Closes one optional source; a close failure is contained and logged once. */
async function closeSource(source: DashboardReadSource, logger: GuiLogger): Promise<void> {
  try {
    await source.close?.();
  } catch (error) {
    logger.warn("dashboard source close failed", failureLabel(error));
  }
}

/** Releases the owner's source now, or when an in-flight creation settles. */
function releaseOwnerSource(owner: DashboardOwner, logger: GuiLogger): Promise<void> {
  const source = owner.source;
  const creating = owner.creating;
  owner.source = undefined;
  owner.creating = undefined;
  // Invalidate the creation before its continuation can run. If it already
  // published `source`, the branch below closes that exact object once.
  owner.sourceVersion += 1;
  if (source) return closeSource(source, logger);
  if (creating) {
    return creating.then(
      (created) => {
        // Defensive: if a published source somehow raced the capture, clear the
        // reusable slot before closing it.
        if (owner.source === created) owner.source = undefined;
        return closeSource(created, logger);
      },
      () => undefined,
    );
  }
  return Promise.resolve();
}

/** Ends one owner: drop its client/workspace refs, then release its source. */
function disposeOwner(owner: DashboardOwner, logger: GuiLogger): Promise<void> {
  owner.disposed = true;
  owner.factory = undefined;
  owner.sourceOptions = undefined;
  return releaseOwnerSource(owner, logger);
}

/** Removes a disposed owner and hands the host to the most recent live owner. */
function dropOwner(host: DashboardHost, owner: DashboardOwner): void {
  const { owners } = host.delegation;
  const index = owners.indexOf(owner);
  if (index !== -1) owners.splice(index, 1);
  if (host.delegation.activeOwner === owner) {
    host.delegation.activeOwner = owners[owners.length - 1];
  }
}

/**
 * The stable source the transport keeps for the host's lifetime. Every read
 * resolves the active owner's source; a delegate's source is not created until
 * a request needs it, so a handoff starts no analytics work by itself.
 */
function createDelegatingSource(
  delegation: OwnerDelegation,
  logger: GuiLogger,
): DashboardReadSource {
  const requireSource = (): Promise<DashboardReadSource> => {
    const owner = delegation.activeOwner;
    if (!owner) return Promise.reject(new DashboardLifecycleError("source-unavailable"));
    return ownerSource(owner, logger);
  };

  return {
    home: async (input) => (await requireSource()).home(input),
    project: async (input) => (await requireSource()).project(input),
    session: async (input) => (await requireSource()).session(input),
    quota: async () => {
      const source = await requireSource();
      // Mirrors `SnapshotService`: a source without quota answers as unavailable.
      if (!source.quota) throw new Error("Quota source unavailable");
      return source.quota();
    },
    refreshAnalytics: async () => {
      // Only refresh an already-created active source; never build one here.
      await delegation.activeOwner?.source?.refreshAnalytics?.();
    },
    close: async () => {
      // Bind failure and final close both land here: release every source this
      // host created, without ending the leases themselves.
      await Promise.all(delegation.owners.map((owner) => releaseOwnerSource(owner, logger)));
    },
  };
}

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
  const code = controlledCode(error);
  if (typeof code === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(code)) return code;
  return "failed";
}

/** The stable `code` field of a controlled failure, across module graphs. */
function controlledCode(error: unknown): unknown {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return error.code;
}

/**
 * Maps a thrown failure to the lease reason by its controlled code shape.
 * Class identity is graph-local: the transport bind error carries
 * `code: "unavailable"` (and already logged its one line), lifecycle errors
 * carry their reason directly. Anything else is an unexpected server failure.
 */
function unavailableReason(error: unknown): DashboardUnavailableReason {
  const code = controlledCode(error);
  switch (code) {
    case "port-unavailable":
    case "source-unavailable":
    case "settings-unavailable":
    case "server-unavailable":
      return code;
    case "unavailable":
      return "port-unavailable";
    default:
      return "server-unavailable";
  }
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

/**
 * Reserves one restart. The reservation exists before the transport writes its
 * 202, so a concurrent request is rejected instead of racing a second stop.
 */
function createRestartController(host: DashboardHost): DashboardRestartController {
  return {
    begin() {
      if (host.restart) return { ok: false, code: "restart-in-progress" };
      if (host.retired || host.refs <= 0 || !host.transport || !host.handle) {
        return { ok: false, code: "restart-unavailable" };
      }

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const pending: PendingRestart = {
        id: randomUUID(),
        phase: "pending",
        done,
        resolveDone,
      };
      host.restart = pending;
      return {
        ok: true,
        ticket: {
          restartId: pending.id,
          run: () => runRestart(host, pending),
          cancel: () => cancelRestart(host, pending),
        },
      };
    },
  };
}

function cancelRestart(host: DashboardHost, pending: PendingRestart): void {
  // Only a reservation whose response never finished can be cancelled. Once the
  // replacement is running, the host's retired/refcount checks own the outcome.
  if (host.restart !== pending || pending.phase !== "pending") return;
  host.restart = undefined;
  pending.resolveDone();
}

/**
 * Stops the current listener and binds its replacement on the same actual port.
 * The source/SSE state belongs to the stopped transport, so the replacement
 * builds new snapshot state over the host's stable delegating source; owner
 * factories recreate their per-lease source on the next request.
 */
async function runRestart(host: DashboardHost, pending: PendingRestart): Promise<void> {
  if (host.restart !== pending || pending.phase !== "pending") {
    pending.resolveDone();
    return;
  }
  pending.phase = "running";

  try {
    const current = host.handle;
    const transport = host.transport;
    if (host.retired || host.refs <= 0 || !current || !transport) return;
    // Bind the port the old listener actually took, never the configured value
    // (they differ when the configured port is 0 in transport tests).
    const actualPort = current.port;

    // From here on the host temporarily has no current handle; every reader
    // (dispose, duplicate begin) observes the reservation or `retired`.
    host.handle = undefined;
    try {
      await current.close();
    } catch (error) {
      // The old listener was not proven stopped. Keep it current so a retry can
      // target it again instead of claiming a replacement exists.
      host.handle = current;
      host.logger.warn("dashboard restart failed", failureLabel(error));
      return;
    }
    if (host.retired || host.refs <= 0) return;

    try {
      const next = await transport.createServer({
        port: actualPort,
        source: transport.source,
        settings: transport.settings,
        minIntervalMs: transport.minIntervalMs,
        logger: host.logger,
        restart: createRestartController(host),
        restartId: pending.id,
      });
      if (host.retired || host.refs <= 0) {
        // The last lease ended while the replacement was binding: close it so a
        // stopped host can never resurrect a listener.
        try {
          await next.close();
        } catch (error) {
          host.logger.warn("dashboard restart failed", failureLabel(error));
        }
        return;
      }
      host.handle = next;
    } catch (error) {
      // The listener is already gone, so this is terminal for the current host:
      // a browser cannot retry through an absent socket. Log the controlled code
      // only; a later setup starts a fresh host.
      host.failure = "server-unavailable";
      host.logger.warn("dashboard restart failed", failureLabel(error));
    }
  } finally {
    if (host.restart === pending) host.restart = undefined;
    pending.resolveDone();
  }
}

/** One started host promise that can be handed to `attachLease`. */
interface StartDeferred {
  readonly promise: Promise<DashboardServerHandle>;
  resolve(handle: DashboardServerHandle): void;
  reject(error: unknown): void;
}

function deferredStart(): StartDeferred {
  let resolve!: (handle: DashboardServerHandle) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DashboardServerHandle>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Settings store, first owner's eager source and transport, in that order; each
 * failure is contained. The source passed to the transport is the host's stable
 * delegating source, so later owner handoffs keep the same snapshot service.
 */
async function startHost(
  host: DashboardHost,
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

  const firstOwner = host.delegation.activeOwner;
  if (!firstOwner) throw new DashboardLifecycleError("source-unavailable");
  try {
    // Eager for the first owner only: a broken factory still fails setup with
    // `source-unavailable` and binding is never attempted.
    await ownerSource(firstOwner, context.logger);
  } catch {
    throw new DashboardLifecycleError("source-unavailable");
  }

  const source = createDelegatingSource(host.delegation, context.logger);
  const transport: HostTransport = {
    source,
    settings,
    createServer: options.createServer ?? createDashboardServer,
    minIntervalMs: minIntervalGetter(context),
  };
  host.transport = transport;
  try {
    const handle = await transport.createServer({
      port: context.port,
      source,
      settings,
      minIntervalMs: transport.minIntervalMs,
      logger: host.logger,
      restart: createRestartController(host),
    });
    host.handle = handle;
    return handle;
  } catch (error) {
    // A bind failure already logged its one controlled line inside the transport
    // and keeps its `port-unavailable` reason; every other server failure is
    // reported as `server-unavailable`.
    host.transport = undefined;
    throw new DashboardLifecycleError(unavailableReason(error));
  }
}

function makeDispose(host: DashboardHost, owner: DashboardOwner): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    host.refs = Math.max(0, host.refs - 1);
    dropOwner(host, owner);
    const closing = disposeOwner(owner, host.logger);
    if (host.refs > 0) {
      // A live lease keeps the socket; the surviving owner serves next request.
      await closing;
      return;
    }

    // Last lease: remove the host first, then make sure a reserved/in-flight
    // restart cannot rebind the socket after this disposal.
    host.retired = true;
    const hosts = hostRegistry().hosts;
    if (hosts.get(host.port) === host) hosts.delete(host.port);

    const restart = host.restart;
    if (restart) {
      if (restart.phase === "pending") {
        // The response has not finished scheduling the shutdown yet; cancel the
        // reservation so it can never run after the host is gone.
        host.restart = undefined;
        restart.resolveDone();
      } else {
        // A replacement is mid-close or mid-bind. It observes `retired` and
        // closes anything it created before settling.
        await restart.done;
      }
    }

    // Read the current generation, not the handle captured when this lease
    // attached: a restart may have replaced it.
    const handle = host.handle;
    host.handle = undefined;
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        host.logger.warn("dashboard stop failed", failureLabel(error));
      }
    }
    await closing;
  };
}

async function attachLease(host: DashboardHost, owner: DashboardOwner): Promise<DashboardLease> {
  if (host.failure !== undefined) {
    return {
      port: host.port,
      state: "unavailable",
      reason: host.failure,
      dispose: makeDispose(host, owner),
    };
  }

  try {
    await host.start;
  } catch (error) {
    // One controlled line per failed host, however many leases attach to it.
    // Structural classification keeps this correct when the rejecting promise
    // was created by another module graph with its own error classes.
    if (host.failure === undefined) {
      host.failure = unavailableReason(error);
      // A bind failure already logged its one line inside the transport.
      if (host.failure !== "port-unavailable") {
        host.logger.error("dashboard unavailable", host.failure);
      }
    }
    return {
      port: host.port,
      state: "unavailable",
      reason: host.failure,
      dispose: makeDispose(host, owner),
    };
  }
  // A restart may already be replacing the initial handle, leaving it
  // transiently absent. Wait for the replacement (including one that started
  // between two checks) and classify against the current generation, not the
  // initial handle resolved by `host.start`.
  while (host.restart) {
    await host.restart.done;
  }

  const current = host.handle;
  if (host.failure !== undefined || host.retired || current === undefined) {
    return {
      port: host.port,
      state: "unavailable",
      reason: host.failure ?? "server-unavailable",
      dispose: makeDispose(host, owner),
    };
  }
  return {
    port: host.port,
    state: "running",
    url: current.url,
    dispose: makeDispose(host, owner),
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

  const hosts = hostRegistry().hosts;
  const existing = hosts.get(port);
  if (existing) {
    const owner = createOwner(options, configDir);
    existing.refs += 1;
    existing.delegation.owners.push(owner);
    return attachLease(existing, owner);
  }

  const owner = createOwner(options, configDir);
  const delegation: OwnerDelegation = { owners: [owner], activeOwner: owner };
  const started = deferredStart();
  const host: DashboardHost = {
    port,
    logger,
    delegation,
    refs: 1,
    start: started.promise,
    retired: false,
  };
  // The host record exists before startup resolves so the restart controller can
  // refer to the mutable handle, while leases still await one start promise.
  void startHost(host, options, { configDir, port, minIntervalMs, logger }).then(
    started.resolve,
    started.reject,
  );
  hosts.set(port, host);
  return attachLease(host, owner);
}
