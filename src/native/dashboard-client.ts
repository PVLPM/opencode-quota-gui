/**
 * Transport-neutral native dashboard client seam.
 *
 * Stage 3 ships the client contract and its live-invalidation lifecycle only;
 * the native GUI host and its renderer are a later stage. The caller is the
 * official typed RPC client (or a fake in tests). RPC events are live-only, so
 * a disconnect keeps the last known product data in the feature layer, marks
 * the connection stale, and `reconnect()` explicitly re-subscribes, reacquires
 * the viewer scope and notifies refetch listeners. No heartbeat or recovery
 * timer is invented.
 *
 * Desktop's ordinary RPC deadline can expire a held watch while the host is
 * still healthy. In that one case the client verifies health and reacquires the
 * same watch in place, without tearing down the event stream or reporting a
 * disconnect. A genuine transport failure still reconnects.
 */

import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
  DashboardDataSource,
  DashboardEvent,
  DashboardHealth,
  HomeSnapshot,
  ImportPreview,
  JsonValue,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../contracts/dashboard.js";
import { isDashboardEvent } from "../contracts/guards.js";
import type { RangeKey } from "../contracts/ranges.js";
import type {
  DashboardRpcEventData,
  DashboardRpcNoInput,
  DashboardRpcQuotaNotificationData,
  DashboardRpcViewScope,
  DashboardRpcWatchInput,
  DashboardRpcWatchOutput,
} from "../rpc.js";

export type NativeDashboardConnection = "connecting" | "live" | "reconnecting" | "closed";

export interface DashboardRpcCallOptions {
  signal?: AbortSignal;
}

/**
 * The typed part of the official RPC client this seam needs. Every method is
 * explicit; no generic `call(name, input)` is exposed.
 */
export interface DashboardRpcCaller {
  health(input: DashboardRpcNoInput, options?: DashboardRpcCallOptions): Promise<DashboardHealth>;
  quota(input: DashboardRpcNoInput, options?: DashboardRpcCallOptions): Promise<QuotaSnapshot>;
  home(input: { range: RangeKey }, options?: DashboardRpcCallOptions): Promise<HomeSnapshot>;
  groups(
    input: AnalyticsGroupQuery,
    options?: DashboardRpcCallOptions,
  ): Promise<AnalyticsGroupSnapshot>;
  project(
    input: { projectId: string; range: RangeKey },
    options?: DashboardRpcCallOptions,
  ): Promise<ProjectSnapshot>;
  session(
    input: { sessionId: string },
    options?: DashboardRpcCallOptions,
  ): Promise<SessionSnapshot>;
  settings(
    input: DashboardRpcNoInput,
    options?: DashboardRpcCallOptions,
  ): Promise<SettingsSnapshot>;
  saveSettings(
    input: { patch: Record<string, JsonValue>; expectedRevision: string },
    options?: DashboardRpcCallOptions,
  ): Promise<SettingsWriteResult>;
  saveVisibility(
    input: { hiddenCards: string[]; hiddenRows: string[]; expectedRevision: string },
    options?: DashboardRpcCallOptions,
  ): Promise<SettingsWriteResult>;
  importPreview(
    input: DashboardRpcNoInput,
    options?: DashboardRpcCallOptions,
  ): Promise<ImportPreview>;
  importApply(
    input: { expectedRevision: string },
    options?: DashboardRpcCallOptions,
  ): Promise<SettingsWriteResult>;
  openSettingsFile(
    input: DashboardRpcNoInput,
    options?: DashboardRpcCallOptions,
  ): Promise<{ opened: true }>;
  watch(
    input: DashboardRpcWatchInput,
    options?: DashboardRpcCallOptions,
  ): Promise<DashboardRpcWatchOutput>;
  events: {
    subscribe(
      name: "invalidated",
      options?: DashboardRpcCallOptions,
    ): AsyncIterable<{ data: DashboardRpcEventData }>;
    subscribe(
      name: "quotaNotification",
      options?: DashboardRpcCallOptions,
    ): AsyncIterable<{ data: DashboardRpcQuotaNotificationData }>;
  };
}

export interface NativeDashboardClient extends DashboardDataSource {
  /** Current transport state; last known product data remains usable as stale. */
  connection(): NativeDashboardConnection;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  /** Called after successful transport recovery; consumers refetch here. */
  onReconnect(listener: () => void): () => void;
  /** Explicit recovery: re-subscribe, reacquire the viewer and refetch. */
  reconnect(): Promise<void>;
  /** Suspend transport resources while the host server is known to be down. */
  suspend(): void;
  /** Mark the host available and retry any pending recovery when eligible. */
  resume(): Promise<void>;
  setActiveView(scope: DashboardRpcViewScope): Promise<void>;
  /** Releases any subscription and held viewer. */
  dispose(): void;
}

export interface NativeDashboardClientOptions {
  rpc: DashboardRpcCaller;
  scope?: DashboardRpcViewScope;
  onConnectionChange?: (state: NativeDashboardConnection) => void;
  onReconnect?: () => void;
}

function isHostWatchTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const clientError = error as { name?: unknown; reason?: unknown; cause?: unknown };
  const cause = clientError.cause;
  return (
    clientError.name === "ClientError" &&
    clientError.reason === "Transport" &&
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "TimeoutError"
  );
}

export function createNativeDashboardClient(
  options: NativeDashboardClientOptions,
): NativeDashboardClient {
  const rpc = options.rpc;
  const listeners = new Set<(event: DashboardEvent) => void>();
  const stateListeners = new Set<(state: NativeDashboardConnection) => void>();
  const reconnectListeners = new Set<() => void>();
  interface Attempt {
    generation: number;
    controller: AbortController;
    scope: DashboardRpcViewScope;
    recovery: boolean;
    live: boolean;
    /** A Desktop watch deadline is being verified/reacquired in place. */
    renewing: boolean;
    promise: Promise<void>;
  }

  let viewScope: DashboardRpcViewScope = options.scope ?? "analytics";
  let state: NativeDashboardConnection = "connecting";
  let generation = 0;
  let closed = false;
  let hostAvailable = true;
  let recoveryRequired = false;
  let currentAttempt: Attempt | undefined;

  function setConnection(next: NativeDashboardConnection): void {
    if (state === next) return;
    state = next;
    try {
      options.onConnectionChange?.(next);
    } catch {
      // A connection observer never breaks the transport.
    }
    for (const listener of Array.from(stateListeners)) {
      try {
        listener(next);
      } catch {
        // A connection listener never breaks the transport.
      }
    }
  }

  function retireAttempt(): Attempt | undefined {
    const retired = currentAttempt;
    if (!retired) return undefined;
    // Remove ownership before aborting: abort listeners may settle RPC work
    // synchronously, but that work can no longer affect the next generation.
    currentAttempt = undefined;
    generation += 1;
    retired.controller.abort();
    return retired;
  }

  function eligible(): boolean {
    return !closed && hostAvailable && listeners.size > 0;
  }

  function isCurrent(attempt: Attempt): boolean {
    return (
      eligible() &&
      currentAttempt === attempt &&
      attempt.generation === generation &&
      !attempt.controller.signal.aborted
    );
  }

  function failAttempt(attempt: Attempt): void {
    if (!isCurrent(attempt)) return;
    recoveryRequired ||= attempt.recovery || attempt.live;
    retireAttempt();
    setConnection("reconnecting");
  }

  function notifyReconnect(): void {
    try {
      options.onReconnect?.();
    } catch {
      // A refetch observer never breaks recovery.
    }
    for (const listener of Array.from(reconnectListeners)) {
      try {
        listener();
      } catch {
        // A refetch listener failure never breaks recovery.
      }
    }
  }

  async function consumeEvents(attempt: Attempt): Promise<void> {
    const signal = attempt.controller.signal;
    try {
      for await (const event of rpc.events.subscribe("invalidated", { signal })) {
        if (!isCurrent(attempt)) return;
        const data = event.data;
        if (!isDashboardEvent(data)) continue;
        for (const listener of Array.from(listeners)) {
          try {
            listener(data);
          } catch {
            // A subscriber failure never breaks the event stream.
          }
        }
      }
    } catch {
      // A stream failure is a reconnect state, not an event.
    }
    if (isCurrent(attempt)) failAttempt(attempt);
  }

  async function acquireWatch(attempt: Attempt): Promise<void> {
    const signal = attempt.controller.signal;
    while (isCurrent(attempt)) {
      try {
        await rpc.watch({ scope: attempt.scope }, { signal });
        if (!isCurrent(attempt)) return;
        // The watch call is a held viewer; any unexpected completion means the
        // viewer was lost.
        failAttempt(attempt);
        return;
      } catch (error) {
        if (!isCurrent(attempt)) return;
        if (!attempt.live || !isHostWatchTimeout(error)) {
          failAttempt(attempt);
          return;
        }

        // Desktop's ordinary RPC deadline expires held watch requests. Check
        // that the host is still reachable, then reacquire only this viewer;
        // keep the live attempt and its event stream. Awaiting the rejected
        // watch before looping guarantees no overlapping held viewers.
        attempt.renewing = true;
        try {
          await rpc.health({}, { signal });
        } catch {
          if (isCurrent(attempt)) failAttempt(attempt);
          return;
        }
        attempt.renewing = false;
      }
    }
  }

  async function runAttempt(attempt: Attempt): Promise<void> {
    try {
      await rpc.health({}, { signal: attempt.controller.signal });
    } catch {
      failAttempt(attempt);
      return undefined;
    }

    if (!isCurrent(attempt)) return;
    void consumeEvents(attempt);
    void acquireWatch(attempt);

    // Surface an already-rejected event stream or watch before reporting a
    // successful opening. Opening failures never recursively retry.
    await Promise.resolve();
    if (!isCurrent(attempt)) return;

    attempt.live = true;
    if (attempt.recovery) {
      // Consumers invalidate/refetch while the transport still reports
      // reconnecting; live is observable only after those callbacks complete.
      notifyReconnect();
      if (!isCurrent(attempt)) return;
    }
    recoveryRequired = false;
    setConnection("live");
  }

  function startAttempt(recovery: boolean, preserveConnection = false): Promise<void> {
    if (!eligible()) return Promise.resolve();
    if (currentAttempt) retireAttempt();

    const attempt: Attempt = {
      generation: ++generation,
      controller: new AbortController(),
      scope: viewScope,
      recovery: recovery || recoveryRequired,
      live: false,
      renewing: false,
      promise: Promise.resolve(),
    };
    currentAttempt = attempt;
    attempt.promise = Promise.resolve().then(() => runAttempt(attempt));
    if (!preserveConnection) setConnection(attempt.recovery ? "reconnecting" : "connecting");
    return attempt.promise;
  }

  function reconnect(): Promise<void> {
    if (closed) return Promise.resolve();
    recoveryRequired = true;
    return startAttempt(true);
  }

  return {
    async health() {
      return rpc.health({});
    },
    async quota() {
      return rpc.quota({});
    },
    async home(input) {
      return rpc.home(input);
    },
    async groups(input) {
      return rpc.groups(input);
    },
    async project(input) {
      return rpc.project(input);
    },
    async session(input) {
      return rpc.session(input);
    },
    async settings() {
      return rpc.settings({});
    },
    async saveSettings(input) {
      return rpc.saveSettings(input);
    },
    async saveVisibility(input) {
      return rpc.saveVisibility(input);
    },
    async importPreview() {
      return rpc.importPreview({});
    },
    async importApply(input) {
      return rpc.importApply(input);
    },
    async openSettingsFile() {
      await rpc.openSettingsFile({});
    },

    connection: () => state,

    onConnectionChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },

    reconnect,

    suspend() {
      if (closed || !hostAvailable) return;
      hostAvailable = false;
      recoveryRequired = true;
      retireAttempt();
      setConnection("reconnecting");
    },

    async resume() {
      if (closed) return;
      hostAvailable = true;
      if (currentAttempt?.live) return;
      recoveryRequired = true;
      if (!eligible()) return;
      if (currentAttempt) {
        await currentAttempt.promise;
        return;
      }
      await startAttempt(true);
    },

    async setActiveView(scope) {
      if (closed || scope === viewScope) return;
      viewScope = scope;
      if (!eligible()) return;
      const previous = currentAttempt;
      // A deliberate scope change is a reconfiguration, not a connection loss.
      // While the transport is healthy, keep the visible live state and skip
      // the reconnect callback. The attempt is still replaced: the new scope
      // runs its own health probe, invalidation stream and watch. A watch being
      // renewed after a Desktop deadline is not healthy: that path keeps its
      // recovery/refetch semantics.
      const preserveConnection =
        previous?.live === true && !previous.renewing && !recoveryRequired && state === "live";
      const recovery =
        recoveryRequired ||
        previous?.recovery === true ||
        previous?.renewing === true ||
        state === "reconnecting";
      await startAttempt(recovery, preserveConnection);
    },

    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && eligible()) {
        void startAttempt(recoveryRequired).catch(() => undefined);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !closed) {
          retireAttempt();
          setConnection("reconnecting");
        }
      };
    },

    dispose() {
      if (closed) return;
      closed = true;
      retireAttempt();
      listeners.clear();
      stateListeners.clear();
      reconnectListeners.clear();
      setConnection("closed");
    },
  };
}
