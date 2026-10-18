import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, Match, onMount, Show, Switch } from "solid-js";
import type {
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard";
import { isRangeKey, RANGE_KEYS, type RangeKey } from "../contracts/ranges";
import { AnalyticsIcon } from "./components/icons";
import { ProgressLine, QueryState, ReloadRequired, StaleNotice } from "./components/states";
import { createToaster, type Toaster, ToastRegion } from "./components/toast";
import type { ConnectionState, DashboardClient } from "./dashboard-client";
import { RANGE_LABELS } from "./format";
import { Icon, SegmentedControl, SegmentedControlItem, Tooltip } from "./opencode-ui";
import {
  formatHash,
  type Location,
  parseLocation,
  readStoredRange,
  routeShowsRangeSelector,
  writeStoredRange,
} from "./routing";
import { displayPreferencesFromValues } from "./settings-model";
import {
  contractMismatchMessage,
  isStaleAfterReconnect,
  resolveLoadState,
  shouldRefetchOnReconnect,
} from "./view-model";
import { HomeView } from "./views/home";
import { ProjectView } from "./views/project";
import { SessionView } from "./views/session";
import { SettingsView, type VisibilityCatalog } from "./views/settings";

/**
 * Dashboard shell (design spec §10).
 *
 * Owns the hash route, the range (URL plus `localStorage`), the SSE connection
 * state, and one settings read that supplies the visibility lists and display
 * preferences. Views stay presentational; each route container owns its own
 * fetch, so a range change refetches range-scoped queries only and the session
 * route never refetches on a range change at all.
 */

interface Query<T> {
  data: () => T | undefined;
  error: () => unknown;
  loading: () => boolean;
  /** Resolves `true` when the fetched payload was applied (not superseded or failed). */
  run: () => Promise<boolean>;
}

/** One in-flight request wins; a superseded response is dropped. */
function createQuery<T>(fetcher: () => Promise<T>): Query<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  let requestId = 0;

  async function run(): Promise<boolean> {
    const id = ++requestId;
    setLoading(true);
    try {
      const value = await fetcher();
      if (id !== requestId) return false;
      setData(() => value);
      setError(undefined);
      return true;
    } catch (failure) {
      if (id !== requestId) return false;
      setError(failure);
      return false;
    } finally {
      if (id === requestId) setLoading(false);
    }
  }

  return { data, error, loading, run };
}

function currentHash(): string {
  return typeof window === "undefined" ? "#/" : window.location.hash || "#/";
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function App(props: { client: DashboardClient }): JSX.Element {
  const [location, setLocation] = createSignal<Location>(
    parseLocation(currentHash(), readStoredRange(browserStorage())),
  );
  const [connection, setConnection] = createSignal<ConnectionState>(props.client.connection());
  const [navTooltip, setNavTooltip] = createSignal<"home" | "settings" | undefined>();
  const [contractMismatch, setContractMismatch] = createSignal<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = createSignal(0);
  const [homeSnapshot, setHomeSnapshot] = createSignal<HomeSnapshot | undefined>(undefined);
  /** Bumped on every reconnection: it refetches each route and anchors staleness. */
  const [reconnectEpoch, setReconnectEpoch] = createSignal(0);
  const [settingsFreshEpoch, setSettingsFreshEpoch] = createSignal(0);
  const toaster = createToaster();

  const range = () => location().range;
  const route = () => location().route;

  const settingsQuery = createQuery<SettingsSnapshot>(() => props.client.settings());
  const preferences = createMemo(() =>
    displayPreferencesFromValues(settingsQuery.data()?.values ?? {}),
  );

  createEffect(() => {
    if (route().name !== "settings" || homeSnapshot()) return;
    void props.client
      .home({ range: range() })
      .then(setHomeSnapshot)
      .catch(() => {
        // Settings remain usable if the optional visibility catalog is unavailable.
      });
  });

  /**
   * The visibility lists name what they hide. The home snapshot carries the
   * labels; before it loads the lists fall back to the opaque ids, which are
   * still safe to show (they never contain a credential, spec §8).
   */
  const catalog = createMemo<VisibilityCatalog>(() => {
    const home = homeSnapshot();
    if (!home) return { cards: [], rows: [] };
    return {
      cards: home.providers.cards.map((card) => ({
        id: card.cardId,
        label: card.accountLabel
          ? `${card.providerLabel} · ${card.accountLabel}`
          : card.providerLabel,
      })),
      rows: home.providers.cards.flatMap((card) =>
        card.rows.map((row) => ({ id: row.rowId, label: `${card.providerLabel} · ${row.label}` })),
      ),
    };
  });

  function updateRange(next: RangeKey): void {
    writeStoredRange(browserStorage(), next);
    setLocation((current) => ({ range: next, route: current.route }));
  }

  // The range travels in the URL for every route; the session route keeps it in
  // the address bar but its queries ignore it (R25–R27).
  createEffect(() => {
    const next = formatHash(route(), range());
    if (typeof window !== "undefined" && currentHash() !== next) window.location.hash = next;
  });

  /**
   * Connection transitions (spec §10 States). Returning from a drop is the one
   * transition that lost data — the server keeps no replay — so it refetches
   * every route and the settings read, and the stale marker stays up until those
   * refetches actually land (`settingsFreshEpoch` here, a fresh epoch inside each
   * route container). The first connect is deliberately excluded: the initial
   * load is already fetching, and both toasting and refetching there would be a
   * spurious duplicate.
   */
  let previousConnection: ConnectionState | undefined;
  createEffect(() => {
    const state = connection();
    if (previousConnection === state) return;
    const previous = previousConnection;
    previousConnection = state;
    if (state === "reconnecting") {
      toaster.push("info", "Lost the live update stream — retrying.");
      return;
    }
    if (!shouldRefetchOnReconnect(previous, state)) return;
    toaster.push("success", "Live updates restored.");
    const epoch = reconnectEpoch() + 1;
    setReconnectEpoch(epoch);
    void settingsQuery.run().then((applied) => {
      if (applied) setSettingsFreshEpoch(epoch);
    });
  });

  onMount(() => {
    const onHashChange = () => {
      setLocation(parseLocation(currentHash(), readStoredRange(browserStorage())));
    };
    window.addEventListener("hashchange", onHashChange);
    const unsubscribeConnection = props.client.onConnectionChange(setConnection);
    const unsubscribeEvents = props.client.subscribe((event) => {
      // Invalidation is silent by design: only meaningful events toast.
      if (event.topic === "settings.changed") {
        void settingsQuery.run();
        return;
      }
      setReloadToken((token) => token + 1);
    });
    void (async () => {
      try {
        const health = await props.client.health();
        setContractMismatch(contractMismatchMessage(health.contractVersion));
      } catch {
        // A missing health endpoint is not fatal; route queries report failures.
      }
      await settingsQuery.run();
    })();
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      unsubscribeConnection();
      unsubscribeEvents();
    };
  });

  return (
    <div class="qg-app">
      <header class="qg-topbar">
        <div class="qg-topbar__brand">
          <Tooltip value="Home" forceOpen={navTooltip() === "home"}>
            <a
              class="qg-topbar__link qg-nav-icon"
              aria-label="Home"
              onFocus={() => setNavTooltip("home")}
              onBlur={() => setNavTooltip(undefined)}
              onPointerEnter={() => setNavTooltip("home")}
              onPointerLeave={() => setNavTooltip(undefined)}
              onClick={() => setNavTooltip(undefined)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNavTooltip(undefined);
              }}
              aria-current={route().name === "home" ? "page" : undefined}
              href={formatHash({ name: "home" }, range())}
            >
              <AnalyticsIcon />
            </a>
          </Tooltip>
        </div>
        <div class="qg-topbar__actions">
          <Show when={routeShowsRangeSelector(route())}>
            <SegmentedControl
              class="qg-range"
              aria-label="Time range"
              value={range()}
              onChange={(value) => {
                if (isRangeKey(value)) updateRange(value);
              }}
            >
              {RANGE_KEYS.map((key) => (
                <SegmentedControlItem value={key}>{RANGE_LABELS[key] ?? key}</SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Show>
          <Show when={connection() !== "live"}>
            <span class="qg-stale" aria-live="polite">
              {connection() === "connecting" ? "Connecting…" : "Reconnecting — data may be stale"}
            </span>
          </Show>
          <Tooltip value="Settings" forceOpen={navTooltip() === "settings"}>
            <a
              class="qg-topbar__link"
              aria-label="Settings"
              onFocus={() => setNavTooltip("settings")}
              onBlur={() => setNavTooltip(undefined)}
              onPointerEnter={() => setNavTooltip("settings")}
              onPointerLeave={() => setNavTooltip(undefined)}
              onClick={() => setNavTooltip(undefined)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNavTooltip(undefined);
              }}
              aria-current={route().name === "settings" ? "page" : undefined}
              href={formatHash({ name: "settings" }, range())}
            >
              <Icon name="settings-gear" />
            </a>
          </Tooltip>
        </div>
      </header>

      <main class="qg-main">
        <Show
          when={contractMismatch() === undefined}
          fallback={<ReloadRequired message={contractMismatch() ?? ""} />}
        >
          <Switch>
            <Match when={route().name === "home"}>
              <HomeRoute
                client={props.client}
                range={range()}
                reloadToken={reloadToken()}
                reconnectEpoch={reconnectEpoch()}
                peek={{
                  preferences: preferences(),
                  hiddenCards: settingsQuery.data()?.visibility.hiddenCards ?? [],
                  hiddenRows: settingsQuery.data()?.visibility.hiddenRows ?? [],
                }}
                connection={connection()}
                onSnapshot={setHomeSnapshot}
              />
            </Match>

            <Match when={route().name === "project"}>
              <ProjectRoute
                client={props.client}
                range={range()}
                projectId={(route() as { projectId: string }).projectId}
                reloadToken={reloadToken()}
                reconnectEpoch={reconnectEpoch()}
                connection={connection()}
              />
            </Match>

            <Match when={route().name === "session"}>
              <SessionRoute
                client={props.client}
                range={range()}
                sessionId={(route() as { sessionId: string }).sessionId}
                reloadToken={reloadToken()}
                reconnectEpoch={reconnectEpoch()}
                connection={connection()}
              />
            </Match>

            <Match when={route().name === "settings"}>
              <SettingsRoute
                client={props.client}
                query={settingsQuery}
                catalog={catalog()}
                toaster={toaster}
                stale={
                  connection() !== "live" ||
                  isStaleAfterReconnect(reconnectEpoch(), settingsFreshEpoch())
                }
              />
            </Match>

            <Match when={true}>
              <div class="qg-error-card" role="alert">
                <span>That address does not match a dashboard page.</span>
                <a href={formatHash({ name: "home" }, range())}>Go home</a>
              </div>
            </Match>
          </Switch>
        </Show>
      </main>

      <ToastRegion toaster={toaster} />
    </div>
  );
}

function HomeRoute(props: {
  client: DashboardClient;
  range: RangeKey;
  reloadToken: number;
  reconnectEpoch: number;
  peek: {
    preferences: ReturnType<typeof displayPreferencesFromValues>;
    hiddenCards: string[];
    hiddenRows: string[];
  };
  connection: ConnectionState;
  onSnapshot: (snapshot: HomeSnapshot | undefined) => void;
}): JSX.Element {
  const query = createQuery<HomeSnapshot>(() => props.client.home({ range: props.range }));
  /**
   * The reconnect epoch this route's payload is known to be fresh for. A refetch
   * that only starts after a reconnect must land before the marker clears.
   */
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  const hiddenCards = () => props.peek.hiddenCards;
  const hiddenRows = () => props.peek.hiddenRows;

  createEffect(() => {
    const epoch = props.reconnectEpoch;
    const range = props.range;
    const token = props.reloadToken;
    void range;
    void token;
    void query.run().then((applied) => {
      if (applied) setFreshEpoch(epoch);
    });
  });

  createEffect(() => {
    props.onSnapshot(query.data());
  });

  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });
  const staleNow = () => {
    const current = state();
    if (current.kind === "ready" && current.stale) return true;
    if (isStaleAfterReconnect(props.reconnectEpoch, freshEpoch())) return true;
    return props.connection !== "live";
  };
  const hasPayload = () => query.data() !== undefined;

  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <Show when={hasPayload() && staleNow()}>
        <StaleNotice message="Showing the last good snapshot — the dashboard has not refreshed it." />
      </Show>
      <QueryState
        state={state()}
        label="Loading quota"
        render={(snapshot, stale) => (
          <HomeView
            snapshot={snapshot}
            preferences={props.peek.preferences}
            hiddenCards={hiddenCards()}
            hiddenRows={hiddenRows()}
            stale={stale || staleNow()}
            range={props.range}
          />
        )}
      />
    </>
  );
}

function ProjectRoute(props: {
  client: DashboardClient;
  range: RangeKey;
  projectId: string;
  reloadToken: number;
  reconnectEpoch: number;
  connection: ConnectionState;
}): JSX.Element {
  const query = createQuery<ProjectSnapshot>(() =>
    props.client.project({ projectId: props.projectId, range: props.range }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    const epoch = props.reconnectEpoch;
    const projectId = props.projectId;
    const range = props.range;
    const token = props.reloadToken;
    void projectId;
    void range;
    void token;
    void query.run().then((applied) => {
      if (applied) setFreshEpoch(epoch);
    });
  });

  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });

  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <QueryState
        state={state()}
        label="Loading project"
        render={(snapshot, stale) => (
          <ProjectView
            snapshot={snapshot}
            range={props.range}
            stale={
              stale ||
              props.connection !== "live" ||
              isStaleAfterReconnect(props.reconnectEpoch, freshEpoch())
            }
          />
        )}
      />
    </>
  );
}

function SessionRoute(props: {
  client: DashboardClient;
  range: RangeKey;
  sessionId: string;
  reloadToken: number;
  reconnectEpoch: number;
  connection: ConnectionState;
}): JSX.Element {
  // The session page ignores the range entirely: its graphs always cover the
  // opened session and every descendant (R25–R27).
  const query = createQuery<SessionSnapshot>(() =>
    props.client.session({ sessionId: props.sessionId }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    const epoch = props.reconnectEpoch;
    const sessionId = props.sessionId;
    const token = props.reloadToken;
    void sessionId;
    void token;
    void query.run().then((applied) => {
      if (applied) setFreshEpoch(epoch);
    });
  });

  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });

  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <QueryState
        state={state()}
        label="Loading session"
        render={(snapshot, stale) => (
          <SessionView
            snapshot={snapshot}
            range={props.range}
            stale={
              stale ||
              props.connection !== "live" ||
              isStaleAfterReconnect(props.reconnectEpoch, freshEpoch())
            }
          />
        )}
      />
    </>
  );
}

function SettingsRoute(props: {
  client: DashboardClient;
  query: Query<SettingsSnapshot>;
  catalog: VisibilityCatalog;
  toaster: Toaster;
  stale: boolean;
}): JSX.Element {
  const state = () =>
    resolveLoadState({
      data: props.query.data(),
      error: props.query.error(),
      loading: props.query.loading(),
    });

  return (
    <>
      <Show when={props.query.data() !== undefined && props.stale}>
        <StaleNotice message="Showing the last good settings — the dashboard has not refreshed them." />
      </Show>
      <QueryState
        state={state()}
        label="Loading settings"
        render={(snapshot) => (
          <SettingsView
            snapshot={snapshot}
            client={props.client}
            toaster={props.toaster}
            catalog={props.catalog}
            onReload={async () => {
              await props.query.run();
            }}
          />
        )}
      />
    </>
  );
}
