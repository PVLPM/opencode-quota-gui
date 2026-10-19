import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type {
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard";
import { isRangeKey, RANGE_KEYS, type RangeKey } from "../contracts/ranges";
import { AnalyticsIcon, QuotaIcon } from "./components/icons";
import { inlineAccountLabel } from "./components/quota-card";
import { ProgressLine, QueryState, ReloadRequired } from "./components/states";
import { createToaster, type Toaster, ToastRegion } from "./components/toast";
import type { ActiveViewScope, ConnectionState, DashboardClient } from "./dashboard-client";
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
import { HomeView, QuotaLoading, QuotaView } from "./views/home";
import { ProjectView } from "./views/project";
import { SessionView } from "./views/session";
import { SettingsView } from "./views/settings";
import {
  mergeVisibilityCatalog,
  readVisibilityCatalog,
  type VisibilityCatalog,
  type VisibilityProvider,
  visibilityCatalogEquals,
  writeVisibilityCatalog,
} from "./visibility-catalog";

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

interface RangeTransition {
  from: RangeKey;
  to: RangeKey;
  failed: boolean;
}

function rangeLabel(range: RangeKey): string {
  return RANGE_LABELS[range] ?? range;
}

/**
 * A range change deliberately keeps the previous payload on screen while the
 * next one loads. That payload is only honest if the route says which range it
 * belongs to, so the notice covers exactly the two states where a request is
 * outstanding or failed — and disappears the moment the payload matches.
 */
function describeRangeTransition(
  data: { range: RangeKey } | undefined,
  requested: RangeKey,
  loading: boolean,
  failed: boolean,
): RangeTransition | undefined {
  if (data === undefined || data.range === requested) return undefined;
  if (loading) return { from: data.range, to: requested, failed: false };
  if (failed) return { from: data.range, to: requested, failed: true };
  return undefined;
}

/**
 * The notice is one row in both states, so a failed update replaces the status
 * in place rather than shifting the route output down.
 */
function RangeNotice(props: { transition: RangeTransition; onRetry: () => void }): JSX.Element {
  return (
    <Show
      when={props.transition.failed}
      fallback={
        <output class="qg-range-notice" aria-live="polite">
          <span>
            Showing {rangeLabel(props.transition.from)} while updating to{" "}
            {rangeLabel(props.transition.to)}…
          </span>
        </output>
      }
    >
      <div class="qg-range-notice" data-tone="error" role="alert">
        <span>
          Showing {rangeLabel(props.transition.from)}. Updating to {rangeLabel(props.transition.to)}{" "}
          failed.
        </span>
        <button
          type="button"
          class="qg-range-notice__retry"
          aria-label={`Retry updating to ${rangeLabel(props.transition.to)}`}
          onClick={() => props.onRetry()}
        >
          Retry
        </button>
      </div>
    </Show>
  );
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

/** Groups one quota snapshot's cards exactly as the Settings visibility section expects. */
function catalogFromSnapshot(snapshot: QuotaSnapshot | undefined): VisibilityCatalog {
  if (snapshot === undefined) return { providers: [] };
  const providers = new Map<string, VisibilityProvider>();
  for (const card of snapshot.providers.cards) {
    let provider = providers.get(card.providerId);
    if (provider === undefined) {
      provider = {
        providerId: card.providerId,
        providerLabel: card.providerLabel,
        accountLabels: [],
        cardIds: [],
        rows: [],
      };
      providers.set(card.providerId, provider);
    }
    if (!provider.cardIds.includes(card.cardId)) provider.cardIds.push(card.cardId);
    const account = card.accountLabel
      ? inlineAccountLabel(card.providerLabel, card.accountLabel)
      : undefined;
    if (account !== undefined && !provider.accountLabels.includes(account)) {
      provider.accountLabels.push(account);
    }
    for (const row of card.rows) {
      if (provider.rows.some((existing) => existing.id === row.rowId)) continue;
      provider.rows.push({ id: row.rowId, label: row.label, accountLabel: account });
    }
  }
  return { providers: [...providers.values()] };
}

export function App(props: { client: DashboardClient }): JSX.Element {
  const [location, setLocation] = createSignal<Location>(
    parseLocation(currentHash(), readStoredRange(browserStorage())),
  );
  const [connection, setConnection] = createSignal<ConnectionState>(props.client.connection());
  const [navTooltip, setNavTooltip] = createSignal<"home" | "analytics" | "settings" | undefined>();
  const [contractMismatch, setContractMismatch] = createSignal<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = createSignal(0);
  const [quotaReloadToken, setQuotaReloadToken] = createSignal(0);
  const [homeSnapshot, setHomeSnapshot] = createSignal<QuotaSnapshot | undefined>(undefined);
  const [routeStale, setRouteStale] = createSignal(false);
  /** Bumped on every reconnection: it refetches each route and anchors staleness. */
  const [reconnectEpoch, setReconnectEpoch] = createSignal(0);
  const [settingsFreshEpoch, setSettingsFreshEpoch] = createSignal(0);
  const toaster = createToaster();

  const range = () => location().range;
  const route = () => location().route;
  const activeScope = createMemo<ActiveViewScope>(() => {
    const name = route().name;
    return name === "analytics" || name === "project" || name === "session" ? "analytics" : "quota";
  });

  async function signalActiveView(scope: ActiveViewScope): Promise<void> {
    try {
      await props.client.setActiveView?.(scope);
    } catch {
      // Older servers may not expose this advisory endpoint; reads still work.
    }
  }

  createEffect(() => {
    const scope = activeScope();
    if (connection() !== "live") return;
    // Surface changes and each stream opening reassert interest; reads, range
    // updates and signal completion do not feed this effect or retry it.
    void signalActiveView(scope);
  });

  const settingsQuery = createQuery<SettingsSnapshot>(() => props.client.settings());
  const preferences = createMemo(() =>
    displayPreferencesFromValues(settingsQuery.data()?.values ?? {}),
  );

  createEffect(() => {
    if (route().name !== "settings" || homeSnapshot()) return;
    void props.client
      .quota()
      .then(setHomeSnapshot)
      .catch(() => {
        // Settings remain usable if the optional visibility catalog is unavailable.
      });
  });

  /**
   * The visibility section names what it hides. The catalog is grouped by
   * provider: ids are stored for stable configuration but never rendered. The
   * browser-local cache keeps providers the server has filtered out of quota
   * probes, so a hidden provider keeps its Settings card and can be shown again
   * after navigation or a reload; the section shows a plain empty state only
   * until either source has something to show.
   */
  const [catalogCache, setCatalogCache] = createSignal<VisibilityCatalog>(
    readVisibilityCatalog(browserStorage()),
  );
  const quotaCatalog = createMemo(() => catalogFromSnapshot(homeSnapshot()));
  const catalog = createMemo(() => mergeVisibilityCatalog(quotaCatalog(), catalogCache()));

  // Compare before writing: the cache signal feeds the merged catalog, so a
  // blind set would rerun this effect forever.
  createEffect(() => {
    const merged = catalog();
    if (visibilityCatalogEquals(merged, catalogCache())) return;
    setCatalogCache(merged);
    writeVisibilityCatalog(browserStorage(), merged);
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
    if (!shouldRefetchOnReconnect(previous, state)) return;
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
      if (event.topic === "quota.changed") {
        setQuotaReloadToken((token) => token + 1);
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
    onCleanup(() => {
      window.removeEventListener("hashchange", onHashChange);
      unsubscribeConnection();
      unsubscribeEvents();
    });
  });

  return (
    <div class="qg-app">
      <header class="qg-chrome">
        <nav class="qg-topbar__brand" aria-label="Views">
          <Tooltip value="Quota" forceOpen={navTooltip() === "home"}>
            <a
              class="qg-topbar__link qg-nav-icon"
              aria-label="Quota"
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
              <QuotaIcon />
            </a>
          </Tooltip>
          <Tooltip value="Analytics" forceOpen={navTooltip() === "analytics"}>
            <a
              class="qg-topbar__link qg-nav-icon"
              aria-label="Analytics"
              aria-current={
                route().name === "analytics" ||
                route().name === "project" ||
                route().name === "session"
                  ? "page"
                  : undefined
              }
              href={formatHash({ name: "analytics" }, range())}
              onFocus={() => setNavTooltip("analytics")}
              onBlur={() => setNavTooltip(undefined)}
              onPointerEnter={() => setNavTooltip("analytics")}
              onPointerLeave={() => setNavTooltip(undefined)}
              onClick={() => setNavTooltip(undefined)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNavTooltip(undefined);
              }}
            >
              <AnalyticsIcon />
            </a>
          </Tooltip>
        </nav>
        <div class="qg-topbar__actions">
          <Show
            when={
              connection() !== "live" ||
              (route().name === "settings"
                ? isStaleAfterReconnect(reconnectEpoch(), settingsFreshEpoch()) ||
                  settingsQuery.error() !== undefined
                : routeStale())
            }
          >
            <span class="qg-stale" aria-live="polite">
              {connection() === "connecting"
                ? "Connecting…"
                : connection() === "reconnecting"
                  ? "Reconnecting…"
                  : "Data may be stale"}
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
      <div class="qg-frame">
        <header class="qg-topbar">
          <span class="qg-frame-tab">
            {route().name === "home"
              ? "Quota"
              : route().name === "analytics"
                ? "Analytics"
                : route().name === "project"
                  ? "Project"
                  : route().name === "session"
                    ? "Session"
                    : route().name === "settings"
                      ? "Settings"
                      : "Dashboard"}
          </span>
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
        </header>

        <main class="qg-main" data-settings={route().name === "settings" ? "true" : undefined}>
          <Show
            when={contractMismatch() === undefined}
            fallback={<ReloadRequired message={contractMismatch() ?? ""} />}
          >
            <Switch>
              <Match when={route().name === "home"}>
                <QuotaRoute
                  client={props.client}
                  reloadToken={quotaReloadToken()}
                  reconnectEpoch={reconnectEpoch()}
                  preferences={preferences()}
                  hiddenCards={settingsQuery.data()?.visibility.hiddenCards ?? []}
                  hiddenRows={settingsQuery.data()?.visibility.hiddenRows ?? []}
                  onSnapshot={setHomeSnapshot}
                  onStale={setRouteStale}
                />
              </Match>
              <Match when={route().name === "analytics"}>
                <AnalyticsRoute
                  client={props.client}
                  range={range()}
                  reloadToken={reloadToken()}
                  reconnectEpoch={reconnectEpoch()}
                  connection={connection()}
                  onStale={setRouteStale}
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
                  onStale={setRouteStale}
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
                  onStale={setRouteStale}
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
      </div>

      <ToastRegion toaster={toaster} />
    </div>
  );
}

function QuotaRoute(props: {
  client: DashboardClient;
  reloadToken: number;
  reconnectEpoch: number;
  preferences: ReturnType<typeof displayPreferencesFromValues>;
  hiddenCards: string[];
  hiddenRows: string[];
  onSnapshot: (snapshot: QuotaSnapshot | undefined) => void;
  onStale: (stale: boolean) => void;
}): JSX.Element {
  const query = createQuery<QuotaSnapshot>(() => props.client.quota());
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    const epoch = props.reconnectEpoch;
    void props.reloadToken;
    void query.run().then((applied) => {
      if (applied) setFreshEpoch(epoch);
    });
  });
  createEffect(() => {
    if (query.data()) props.onSnapshot(query.data());
  });
  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });
  createEffect(() =>
    props.onStale(
      query.data()?.stale === true ||
        query.error() !== undefined ||
        isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()),
    ),
  );
  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <QueryState
        state={state()}
        label="Loading providers"
        skeleton={<QuotaLoading />}
        render={(snapshot, stale) => (
          <QuotaView
            snapshot={snapshot}
            preferences={props.preferences}
            hiddenCards={props.hiddenCards}
            hiddenRows={props.hiddenRows}
            stale={stale}
          />
        )}
      />
    </>
  );
}

function AnalyticsRoute(props: {
  client: DashboardClient;
  range: RangeKey;
  reloadToken: number;
  reconnectEpoch: number;
  connection: ConnectionState;
  onStale: (stale: boolean) => void;
}): JSX.Element {
  const query = createQuery<HomeSnapshot>(() => props.client.home({ range: props.range }));
  /**
   * The reconnect epoch this route's payload is known to be fresh for. A refetch
   * that only starts after a reconnect must land before the marker clears.
   */
  const [freshEpoch, setFreshEpoch] = createSignal(0);

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

  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });
  const rangeTransition = () =>
    describeRangeTransition(
      query.data(),
      props.range,
      query.loading(),
      query.error() !== undefined,
    );
  const staleNow = () => {
    const current = state();
    if (current.kind === "ready" && current.stale) return true;
    if (isStaleAfterReconnect(props.reconnectEpoch, freshEpoch())) return true;
    return props.connection !== "live";
  };
  createEffect(() =>
    props.onStale(staleNow() || query.data()?.stale === true || query.data()?.usage.stale === true),
  );

  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <Show when={rangeTransition()}>
        {(notice) => <RangeNotice transition={notice()} onRetry={() => void query.run()} />}
      </Show>
      <QueryState
        state={state()}
        label="Loading analytics"
        render={(snapshot) => <HomeView snapshot={snapshot} range={snapshot.range} />}
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
  onStale: (stale: boolean) => void;
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
  const rangeTransition = () =>
    describeRangeTransition(
      query.data(),
      props.range,
      query.loading(),
      query.error() !== undefined,
    );

  createEffect(() =>
    props.onStale(
      query.error() !== undefined ||
        query.data()?.stale === true ||
        query.data()?.usage.stale === true ||
        isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()),
    ),
  );

  return (
    <>
      <ProgressLine active={query.loading() && query.data() !== undefined} />
      <Show when={rangeTransition()}>
        {(notice) => <RangeNotice transition={notice()} onRetry={() => void query.run()} />}
      </Show>
      <QueryState
        state={state()}
        label="Loading project"
        render={(snapshot, stale) => (
          <ProjectView
            snapshot={snapshot}
            range={snapshot.range}
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
  onStale: (stale: boolean) => void;
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

  createEffect(() =>
    props.onStale(
      query.error() !== undefined || isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()),
    ),
  );

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

export function SettingsRoute(props: {
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
      {/*
        The editor owns an unsaved draft, so — unlike the read-only sections — it
        stays mounted for as long as a snapshot exists. Every refetch (a
        `settings.changed` event, a reconnect, or the reload after a 409) flips
        the query's `loading`, and a `QueryState` ready branch is keyed on that
        state object: it would unmount this editor at the start and the end of
        every refresh and silently drop the draft. The snapshot itself stays
        reactive, so a fresh payload updates the mounted editor in place; the
        fallback only ever renders the first-load skeleton or first-load error.
      */}
      <Show
        when={props.query.data()}
        fallback={<QueryState state={state()} label="Loading settings" render={() => null} />}
      >
        {(snapshot) => (
          <SettingsView
            snapshot={snapshot()}
            client={props.client}
            toaster={props.toaster}
            catalog={props.catalog}
            onReload={async () => {
              await props.query.run();
            }}
          />
        )}
      </Show>
    </>
  );
}
