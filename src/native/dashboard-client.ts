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
  };
}

export interface NativeDashboardClient extends DashboardDataSource {
  /** Current transport state; last known product data remains usable as stale. */
  connection(): NativeDashboardConnection;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  /** Called after a successful explicit reconnect; consumers refetch here. */
  onReconnect(listener: () => void): () => void;
  /** Explicit recovery: re-subscribe, reacquire the viewer and refetch. */
  reconnect(): Promise<void>;
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

export function createNativeDashboardClient(
  options: NativeDashboardClientOptions,
): NativeDashboardClient {
  const rpc = options.rpc;
  const listeners = new Set<(event: DashboardEvent) => void>();
  const stateListeners = new Set<(state: NativeDashboardConnection) => void>();
  const reconnectListeners = new Set<() => void>();
  let viewScope: DashboardRpcViewScope = options.scope ?? "analytics";
  let state: NativeDashboardConnection = "connecting";
  let generation = 0;
  let closed = false;
  let eventController: AbortController | undefined;
  let watchController: AbortController | undefined;

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

  function abortControllers(): void {
    eventController?.abort();
    watchController?.abort();
    eventController = undefined;
    watchController = undefined;
  }

  function stop(): void {
    generation += 1;
    abortControllers();
  }

  function handleDisconnect(owner: number): void {
    if (closed || owner !== generation) return;
    abortControllers();
    setConnection("reconnecting");
  }

  async function consumeEvents(owner: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of rpc.events.subscribe("invalidated", { signal })) {
        if (closed || owner !== generation || signal.aborted) return;
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
    if (!signal.aborted && !closed && owner === generation) handleDisconnect(owner);
  }

  async function acquireWatch(owner: number, signal: AbortSignal): Promise<void> {
    try {
      await rpc.watch({ scope: viewScope }, { signal });
      if (closed || signal.aborted || owner !== generation) return;
      // The watch call is a held viewer; any unexpected completion means the
      // viewer was lost.
      handleDisconnect(owner);
    } catch {
      if (!signal.aborted && !closed && owner === generation) handleDisconnect(owner);
    }
  }

  /**
   * Returns the generation that established the live connection, or
   * `undefined` when this invocation did not. The token lets a caller reject a
   * reconnect whose live state was superseded or immediately lost.
   */
  async function open(): Promise<number | undefined> {
    if (closed || listeners.size === 0) return undefined;
    const owner = ++generation;
    abortControllers();
    setConnection("connecting");
    try {
      await rpc.health({});
    } catch {
      if (!closed && owner === generation) setConnection("reconnecting");
      return undefined;
    }
    if (closed || owner !== generation || listeners.size === 0) return undefined;

    const events = new AbortController();
    const watch = new AbortController();
    eventController = events;
    watchController = watch;
    void consumeEvents(owner, events.signal);
    void acquireWatch(owner, watch.signal);
    // A synchronously failed stream/watch already aborted the pair; do not
    // overwrite its reconnect state with an optimistic live state.
    if (eventController !== events || watchController !== watch || events.signal.aborted) {
      return undefined;
    }
    setConnection("live");
    // A connection observer may have superseded this attempt synchronously.
    return !closed && owner === generation && state === "live" ? owner : undefined;
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

    async reconnect() {
      if (closed) return;
      stop();
      const liveOwner = await open();
      // Only the attempt that still owns the current generation and live state
      // may notify: an immediate post-live disconnect or a newer reconnect
      // must not trigger listeners.
      if (liveOwner === undefined || liveOwner !== generation || state !== "live") return;
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
    },

    async setActiveView(scope) {
      if (closed || scope === viewScope) return;
      viewScope = scope;
      if (!eventController || !watchController) return;
      watchController.abort();
      const watch = new AbortController();
      watchController = watch;
      void acquireWatch(generation, watch.signal);
    },

    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void open().catch(() => undefined);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !closed) {
          stop();
          setConnection("reconnecting");
        }
      };
    },

    dispose() {
      if (closed) return;
      closed = true;
      stop();
      listeners.clear();
      stateListeners.clear();
      reconnectListeners.clear();
      setConnection("closed");
    },
  };
}
