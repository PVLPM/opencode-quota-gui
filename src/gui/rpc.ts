/**
 * Typed dashboard RPC transport (Stage 3).
 *
 * This adapter attaches to the host-owned `SnapshotService` and settings store
 * from `lifecycle.ts`. It never constructs a source, snapshot service, worker or
 * poller, so native-only, web-only, both and neither all share one runtime.
 * Inputs are validated by the RPC definition; failures are mapped to the fixed
 * transport error vocabulary without raw messages or private paths. No method
 * accepts a filesystem path, credential, or workspace override: reads execute
 * through the host's active owner and its configured workspace.
 *
 * Authorization is the host's: OpenCode applies its server-wide
 * `Authorization` middleware to the RPC route (the normal CLI defaults to
 * loopback plus a generated password; embedded/passwordless hosts rely on their
 * embedder). No caller identity or per-method permission is exposed to a
 * handler (2.0.16 `RpcCallContext` has only `signal` and `error`), so this
 * transport does not invent a second permission model. Settings writes keep
 * their optimistic `expectedRevision` guard but rely on the host's server-level
 * access control.
 */

import type {
  RpcCallContext,
  RpcDomain,
  RpcHandlers,
  RpcRegistration,
} from "@opencode/plugin/promise/rpc";
import type { Rpc } from "@opencode/plugin/rpc";

import { BUILD_IDENTITY } from "../contracts/build-identity.js";
import type { DashboardEvent, DashboardHealth, GuiSettingsStore } from "../contracts/dashboard.js";
import {
  DASHBOARD_HEALTH,
  DashboardRpc,
  type DashboardRpcErrorCode,
  type DashboardRpcErrorDetails,
  type DashboardRpcEventData,
  type DashboardRpcMethod,
  type DashboardRpcWatchInput,
  type DashboardRpcWatchOutput,
} from "../rpc.js";
import { GuiSettingsError } from "./config.js";
import {
  DASHBOARD_ERROR_MESSAGES,
  type DashboardErrorCode,
  isDashboardSourceErrorCode,
  sanitizeDashboardErrorDetails,
} from "./dashboard-errors.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import type { SnapshotService } from "./snapshot-service.js";

/** The host-owned dependencies every transport attaches to. */
export interface DashboardRpcRuntime {
  readonly snapshots: SnapshotService;
  readonly settings: GuiSettingsStore;
}

/** The complete OpenCode location whose event stream this transport serves. */
export interface DashboardRpcLocation {
  readonly directory: string;
  readonly workspaceID?: string;
}

export interface RegisterDashboardRpcOptions {
  logger?: GuiLogger;
  /**
   * The complete location this setup serves. OpenCode's event bus filters on
   * both `directory` and `workspaceID`, so sharing is keyed by both: setups at
   * the same directory but different workspaces keep independent
   * subscriptions. A missing location never shares with a present one.
   */
  location?: DashboardRpcLocation;
}

/**
 * Collision-safe transport key for the full location. JSON array encoding keeps
 * the two components distinct even when a directory or id contains separators,
 * and distinguishes an absent workspace from a present one.
 */
function locationKey(location: DashboardRpcLocation | undefined): string {
  return location === undefined
    ? "none"
    : JSON.stringify([location.directory, location.workspaceID ?? null]);
}

export type DashboardRpcRegister = Pick<RpcDomain, "register">;

/** One setup's SDK-scoped RPC registration plus the viewers its calls hold. */
interface SharedMember {
  readonly registration: RpcRegistration<typeof DashboardRpc>;
  readonly heldWatches: Set<() => void>;
  alive: boolean;
}

/**
 * One shared snapshot subscription per host snapshot owner and location.
 *
 * Registrations stay per setup: the host's SDK scope finalizer disposes the
 * registrations a setup created, regardless of any local reference count. In
 * OpenCode 2.0.16 (`packages/core/src/rpc.ts`) same-id registrations are kept
 * in order, calls route to the newest, and disposing one removes only its own
 * entry, so disposing a setup hands method routing to its surviving sibling.
 * One shared subscription still fans each change out exactly once.
 *
 * The SDK registration's `events.emit` publishes on the event bus even after
 * that registration is disposed (`packages/core/src/rpc.ts` v2.0.16), so
 * emitter choice must not depend on a disposed emitter rejecting. The normal
 * unload lifecycle calls the setup cleanup (which removes the member) before
 * the enclosing scope runs the registration finalizer, so the first live
 * member is the correct emitter. A scope that ends without our cleanup can
 * still publish through the disposed registration, but never twice.
 */
interface SharedEntry {
  readonly members: SharedMember[];
  unsubscribe: () => void;
}

const SHARED_REGISTRY_KEY = Symbol.for("opencode-quota-gui/dashboard-rpc-registry/v3");

/**
 * Process-wide (and module-graph-wide) sharing of the snapshot subscription per
 * host snapshot owner and location. The lifecycle already shares the source,
 * settings store and `SnapshotService`; each lease receives a fresh runtime
 * wrapper around those objects, so the snapshot service is the stable identity.
 */
function sharedRegistry(): WeakMap<object, Map<string, SharedEntry>> {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalState[SHARED_REGISTRY_KEY] as
    | WeakMap<object, Map<string, SharedEntry>>
    | undefined;
  if (existing) return existing;

  const registry = new WeakMap<object, Map<string, SharedEntry>>();
  globalState[SHARED_REGISTRY_KEY] = registry;
  return registry;
}

interface MappedRpcError {
  code: DashboardRpcErrorCode;
  message: string;
  details: DashboardRpcErrorDetails;
}

const SETTINGS_ERROR_CODES: ReadonlySet<string> = new Set([
  "config-read-error",
  "config-changed",
  "config-target-error",
  "config-write-error",
  "unknown-setting",
  "invalid-setting",
]);

function controlledCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorDetails(error: unknown): { key?: string; reason?: string } | undefined {
  if (error === null || typeof error !== "object" || !("details" in error)) return undefined;
  const details = error.details;
  if (details === null || typeof details !== "object") return undefined;
  const result: { key?: string; reason?: string } = {};
  if ("key" in details && typeof details.key === "string") result.key = details.key;
  if ("reason" in details && typeof details.reason === "string") result.reason = details.reason;
  return result;
}

/** Maps a controlled or unexpected failure to the RPC error vocabulary. */
function mapRpcError(error: unknown): MappedRpcError {
  const code = error instanceof GuiSettingsError ? error.code : controlledCode(error);
  if (code !== undefined && (isDashboardSourceErrorCode(code) || SETTINGS_ERROR_CODES.has(code))) {
    // SAFETY: both membership checks above only admit codes from the shared
    // dashboard error vocabulary, all of which the RPC map declares.
    const safeCode = code as DashboardErrorCode;
    return {
      // SAFETY: every code admitted above is one of the dashboard RPC error keys.
      code: safeCode as DashboardRpcErrorCode,
      message: DASHBOARD_ERROR_MESSAGES[safeCode],
      details: sanitizeDashboardErrorDetails(safeCode, errorDetails(error)) ?? {},
    };
  }
  return {
    code: "internal",
    message: DASHBOARD_ERROR_MESSAGES.internal,
    details: {},
  };
}

/**
 * The error factory is typed per method, but every dashboard method declares
 * the same controlled vocabulary. The safety assertion only narrows the
 * already-validated shared code to that method's error-name union.
 */
function failure<M extends DashboardRpcMethod>(
  context: RpcCallContext<M>,
  error: unknown,
): Rpc.HandlerError<M> {
  const mapped = mapRpcError(error);
  // SAFETY: every dashboard method declares the shared error map, so its
  // factory accepts exactly the controlled code/message/details triple below.
  const factory = context.error as unknown as (
    type: DashboardRpcErrorCode,
    message: string,
    details: DashboardRpcErrorDetails,
  ) => Rpc.HandlerError<M>;
  return factory(mapped.code, mapped.message, mapped.details);
}

async function guard<M extends DashboardRpcMethod, T>(
  context: RpcCallContext<M>,
  run: () => Promise<T>,
): Promise<T | Rpc.HandlerError<M>> {
  try {
    return await run();
  } catch (error: unknown) {
    return failure(context, error);
  }
}

function waitForAbort(signal: AbortSignal, onStop: (stop: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    onStop(finish);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

function createHandlers(
  runtime: DashboardRpcRuntime,
  heldWatches: Set<() => void>,
): RpcHandlers<typeof DashboardRpc> {
  async function watch(
    input: DashboardRpcWatchInput,
    context: RpcCallContext<typeof DashboardRpc.methods.watch>,
  ): Promise<DashboardRpcWatchOutput | Rpc.HandlerError<typeof DashboardRpc.methods.watch>> {
    return guard(context, async () => {
      const viewer = runtime.snapshots.addScopedViewer(input.scope);
      let stopped = false;
      let stop = () => {};
      await waitForAbort(context.signal, (finish) => {
        stop = () => {
          if (stopped) return;
          stopped = true;
          heldWatches.delete(stop);
          finish();
          viewer.release();
        };
        heldWatches.add(stop);
      });
      stop();
      return { active: false };
    });
  }

  const handlers = {
    health: async (): Promise<DashboardHealth> => ({
      ...DASHBOARD_HEALTH,
      version: BUILD_IDENTITY.version,
      build: BUILD_IDENTITY.build,
    }),
    quota: (_input, context) => guard(context, () => runtime.snapshots.quota()),
    home: (input, context) => guard(context, () => runtime.snapshots.home(input)),
    groups: (input, context) => guard(context, () => runtime.snapshots.groups(input)),
    project: (input, context) => guard(context, () => runtime.snapshots.project(input)),
    session: (input, context) => guard(context, () => runtime.snapshots.session(input)),
    settings: (_input, context) => guard(context, () => runtime.settings.settings()),
    saveSettings: (input, context) =>
      guard(context, async () => {
        const result = await runtime.settings.saveSettings(input);
        runtime.snapshots.notifySettingsChanged();
        return result;
      }),
    saveVisibility: (input, context) =>
      guard(context, async () => {
        const result = await runtime.settings.saveVisibility(input);
        runtime.snapshots.notifySettingsChanged({ scope: "visibility" });
        return result;
      }),
    importPreview: (_input, context) => guard(context, () => runtime.settings.importPreview()),
    importApply: (input, context) =>
      guard(context, async () => {
        const result = await runtime.settings.importApply(input);
        runtime.snapshots.notifySettingsChanged();
        return result;
      }),
    openSettingsFile: (_input, context) =>
      guard(context, async () => {
        const open = runtime.settings.openSettingsFile;
        if (!open) {
          throw new GuiSettingsError(
            "config-target-error",
            "Opening the settings file is not available",
          );
        }
        await open();
        return { opened: true };
      }),
    watch,
  } satisfies RpcHandlers<typeof DashboardRpc>;
  return handlers;
}

/** Adds a setup's registration to the shared entry, creating its subscription once. */
function joinSharedEntry(
  snapshots: SnapshotService,
  key: string,
  member: SharedMember,
): SharedEntry {
  const registry = sharedRegistry();
  let byKey = registry.get(snapshots);
  if (!byKey) {
    byKey = new Map<string, SharedEntry>();
    registry.set(snapshots, byKey);
  }

  const existing = byKey.get(key);
  if (existing) {
    existing.members.push(member);
    return existing;
  }

  let entry: SharedEntry | undefined;
  const unsubscribe = snapshots.subscribe((event: DashboardEvent) => {
    if (entry) emitInvalidation(entry, event);
  });
  entry = { members: [member], unsubscribe };
  byKey.set(key, entry);
  return entry;
}

/** Delivers one invalidation through the first registration this setup owns. */
function emitInvalidation(entry: SharedEntry, event: DashboardEvent): void {
  const member = entry.members.find((candidate) => candidate.alive);
  if (member === undefined) return;
  const data: DashboardRpcEventData = { topic: event.topic, at: event.at };
  if (event.scope !== undefined) data.scope = event.scope;
  // Events are live-only; a disconnected client re-subscribes and refetches.
  // A disposed SDK emitter still publishes, so this does not branch on failure.
  void member.registration.events.emit("invalidated", data).catch(() => undefined);
}

/** Releases one setup's held viewers and, on the last member, the subscription. */
function leaveSharedEntry(
  snapshots: SnapshotService,
  key: string,
  entry: SharedEntry,
  member: SharedMember,
): void {
  if (!member.alive) return;
  member.alive = false;
  const index = entry.members.indexOf(member);
  if (index >= 0) entry.members.splice(index, 1);
  for (const stop of Array.from(member.heldWatches)) stop();
  member.heldWatches.clear();
  if (entry.members.length > 0) return;
  entry.unsubscribe();
  const byKey = sharedRegistry().get(snapshots);
  if (byKey?.get(key) === entry) byKey.delete(key);
}

/**
 * Registers one setup's dashboard contract in that setup's SDK scope and joins
 * the shared snapshot subscription for its location. Duplicate setups with the
 * same host runtime and location still produce one invalidation per snapshot
 * change, but each owns its registration, so an SDK scope finalizer can dispose
 * one setup without affecting the others. The returned lease releases its own
 * viewers and registration; the final lease releases the shared subscription.
 */
export async function registerDashboardRpc(
  rpc: DashboardRpcRegister,
  runtime: DashboardRpcRuntime,
  options: RegisterDashboardRpcOptions = {},
): Promise<RpcRegistration<typeof DashboardRpc>> {
  const logger = options.logger ?? createGuiLogger();
  const key = locationKey(options.location);
  const heldWatches = new Set<() => void>();
  const registration = await rpc.register(DashboardRpc, createHandlers(runtime, heldWatches));
  const member: SharedMember = { registration, heldWatches, alive: true };
  const entry = joinSharedEntry(runtime.snapshots, key, member);

  let disposed = false;
  return {
    events: registration.events,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      leaveSharedEntry(runtime.snapshots, key, entry, member);
      try {
        await registration.dispose();
      } catch (error: unknown) {
        logger.warn("dashboard RPC registration dispose failed", "failed");
        throw error;
      }
    },
  };
}
