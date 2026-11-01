/**
 * SettingsPage data lifecycle (Stage 5).
 *
 * The official Desktop settings page reuses the browser's `SettingsRoute` and
 * `SettingsView`, so this controller only supplies the same reads and events
 * the browser shell gives them: settings, the quota snapshot behind the
 * visibility catalog and temporal section, live invalidation, per-read reconnect
 * freshness, and the first-load gate that keeps an empty catalog from appearing
 * before quota settles. A settled read failure ends the loading phase at once so
 * Retry stays reachable while the other first read is still pending. Mutations
 * still travel through the shared view to the same typed RPC/settings backend;
 * nothing is reimplemented here.
 */
import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { DashboardEvent, QuotaSnapshot, SettingsSnapshot } from "../contracts/dashboard.js";
import { createQuery, type Query } from "../ui/query.js";
import { isStaleAfterReconnect } from "../ui/view-model.js";
import {
  catalogFromQuotaSnapshot,
  mergeVisibilityCatalog,
  type VisibilityCatalog,
  visibilityCatalogEquals,
} from "../ui/visibility-catalog.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";

export interface SettingsPageClient {
  settings(): Promise<SettingsSnapshot>;
  quota(): Promise<QuotaSnapshot>;
  subscribe(listener: (event: DashboardEvent) => void): () => void;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  onReconnect(listener: () => void): () => void;
  connection(): NativeDashboardConnection;
  reconnect(): Promise<void>;
}

export interface SettingsPageState {
  query: Query<SettingsSnapshot>;
  quota: Accessor<QuotaSnapshot | undefined>;
  catalog: Accessor<VisibilityCatalog>;
  temporal: Accessor<QuotaSnapshot["temporal"] | undefined>;
  connection: Accessor<NativeDashboardConnection>;
  /** True when the host server dropped and no settings read has landed since. */
  hostStale: Accessor<boolean>;
  /**
   * True when the quota read failed or its payload is flagged stale. Quota feeds
   * Visibility, the catalog and the temporal rows, so this is page-level stale.
   */
  quotaStale: Accessor<boolean>;
  /**
   * True while no first read has failed and at least one first payload is still
   * pending. A settled failure is actionable, so it stops reading as a load.
   */
  loading: Accessor<boolean>;
  /**
   * True when Retry can make progress: a settled failure, stale retained data,
   * or a lost host/transport. False during a clean first load.
   */
  retryable: Accessor<boolean>;
  stale: Accessor<boolean>;
  /** Retries the failed reads, or reopens the transport when it is down. */
  retry: () => void;
}

export interface SettingsPageOptions {
  /** Live connection of the host server; absent or true means not known lost. */
  hostConnected?: Accessor<boolean>;
}

export function createSettingsPageState(
  client: SettingsPageClient,
  options: SettingsPageOptions = {},
): SettingsPageState {
  const settingsQuery = createQuery<SettingsSnapshot>(() => client.settings());
  const quotaQuery = createQuery<QuotaSnapshot>(() => client.quota());
  const [connection, setConnection] = createSignal<NativeDashboardConnection>(client.connection());
  const [reconnectEpoch, setReconnectEpoch] = createSignal(0);
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  const [quotaFreshEpoch, setQuotaFreshEpoch] = createSignal(0);
  const [hostEpoch, setHostEpoch] = createSignal(0);
  const [freshHostEpoch, setFreshHostEpoch] = createSignal(0);
  const [recoveredHostEpoch, setRecoveredHostEpoch] = createSignal(0);
  const [catalogCache, setCatalogCache] = createSignal<VisibilityCatalog>({ cards: [] });

  function hostKnownDown(): boolean {
    return options.hostConnected?.() === false;
  }

  function refreshSettings(): Promise<boolean> {
    const epoch = reconnectEpoch();
    return settingsQuery.run().then((applied) => {
      if (!applied) return false;
      setFreshEpoch(epoch);
      // Only a read that lands after a successful reconnect for this host epoch
      // clears the host marker. A response already in flight when the host
      // dropped, or one that lands before the transport reopens, cannot.
      if (hostKnownDown() || hostEpoch() > recoveredHostEpoch()) return true;
      setFreshHostEpoch(hostEpoch());
      return true;
    });
  }

  function refreshQuota(): void {
    const epoch = reconnectEpoch();
    void quotaQuery.run().then((applied) => {
      if (!applied) return;
      // Settings and quota both feed the page; each anchors its own freshness,
      // so one landing early cannot clear the other's reconnect marker.
      setQuotaFreshEpoch(epoch);
    });
  }

  // The page's reload after a save conflict is a settings read too: route it
  // through the same freshness anchor instead of exposing the raw query.
  const query: Query<SettingsSnapshot> = {
    data: settingsQuery.data,
    error: settingsQuery.error,
    loading: settingsQuery.loading,
    run: refreshSettings,
  };

  const unsubscribeEvents = client.subscribe((event: DashboardEvent) => {
    if (event.topic === "settings.changed") {
      refreshSettings();
      return;
    }
    if (event.topic === "quota.changed") refreshQuota();
  });

  const unsubscribeConnection = client.onConnectionChange(setConnection);
  const unsubscribeReconnect = client.onReconnect(() => {
    setRecoveredHostEpoch(hostEpoch());
    setReconnectEpoch((epoch) => epoch + 1);
    refreshSettings();
    refreshQuota();
  });
  onCleanup(() => {
    unsubscribeEvents();
    unsubscribeConnection();
    unsubscribeReconnect();
  });

  // The host's built-in server ref follows restarts and dropped event streams.
  // A loss marks the page stale at once; its return reopens the transport once.
  // No timer, heartbeat or polling is involved.
  let hostWasConnected: boolean | undefined;
  createEffect(() => {
    const connected = options.hostConnected?.() ?? true;
    if (!connected) {
      hostWasConnected = false;
      setHostEpoch((epoch) => epoch + 1);
      return;
    }
    if (hostWasConnected === false) {
      hostWasConnected = true;
      void client.reconnect();
      return;
    }
    hostWasConnected = true;
  });

  // The page is mounted only while the host shows it, so the first read is the
  // page's own activation signal; no visibility polling is involved.
  refreshSettings();
  refreshQuota();

  const quotaCatalog = createMemo(() => catalogFromQuotaSnapshot(quotaQuery.data()));
  const catalog = createMemo(() => mergeVisibilityCatalog(quotaCatalog(), catalogCache()));

  // Keep identities and help text across refetches, in memory only: native
  // Settings holds no browser storage.
  createEffect(() => {
    const merged = catalog();
    if (visibilityCatalogEquals(merged, catalogCache())) return;
    setCatalogCache(merged);
  });

  const hostStale = () => hostEpoch() > freshHostEpoch();

  // A failed quota read keeps the previous snapshot through `createQuery`, and
  // `catalogFromQuotaSnapshot`/`mergeVisibilityCatalog` keep its identities, so
  // the cached catalog survives; the page just has to say it is stale and retry.
  const quotaStale = () => quotaQuery.error() !== undefined || quotaQuery.data()?.stale === true;

  // The first read has no previous payload to keep. While it is in flight and
  // no read has failed, the page is loading, not stale: a successful empty
  // snapshot is legitimate data. A settled failure must not hide Retry behind
  // the other read's pending state, so it ends the loading phase immediately.
  const settledError = () =>
    settingsQuery.error() !== undefined || quotaQuery.error() !== undefined;
  const loading = () =>
    !settledError() &&
    ((settingsQuery.loading() && settingsQuery.data() === undefined) ||
      (quotaQuery.loading() && quotaQuery.data() === undefined));

  const stale = createMemo(
    () =>
      connection() !== "live" ||
      hostStale() ||
      quotaStale() ||
      settingsQuery.error() !== undefined ||
      // A reconnect refetches both payloads. Each must land before the marker
      // clears, otherwise settings success would show an old or empty catalog.
      isStaleAfterReconnect(reconnectEpoch(), freshEpoch()) ||
      isStaleAfterReconnect(reconnectEpoch(), quotaFreshEpoch()),
  );

  const retryable = () => stale() && !loading();

  return {
    query,
    quota: quotaQuery.data,
    catalog,
    temporal: () => quotaQuery.data()?.temporal,
    connection,
    hostStale,
    quotaStale,
    loading,
    retryable,
    stale,
    retry: () => {
      // Host or transport loss needs the transport reopened; recovery then
      // re-reads both payloads through `onReconnect`. A live transport with a
      // failed read is retried locally.
      if (hostKnownDown() || connection() !== "live") {
        void client.reconnect();
        return;
      }
      refreshSettings();
      refreshQuota();
    },
  };
}
