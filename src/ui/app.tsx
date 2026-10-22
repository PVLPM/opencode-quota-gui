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
  DashboardHealth,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard";
import { isRangeKey, RANGE_KEYS, type RangeKey } from "../contracts/ranges";
import { BuildMismatchStatus } from "./components/build-info";
import { BusyOverlay, createBusyIndicator } from "./components/busy";
import { AnalyticsIcon, QuotaIcon } from "./components/icons";
import { inlineAccountLabel } from "./components/quota-card";
import { QueryState, ReloadRequired } from "./components/states";
import { createToaster, type Toaster, ToastRegion } from "./components/toast";
import type { ActiveViewScope, ConnectionState, DashboardClient } from "./dashboard-client";
import { RANGE_LABELS } from "./format";
import { Icon, SegmentedControl, SegmentedControlItem, Tooltip } from "./opencode-ui";
import {
  canonicalizeLocation,
  formatPath,
  type Location,
  parseLocation,
  readStoredRange,
  routeShowsRangeSelector,
  writeStoredRange,
} from "./routing";
import { displayPreferencesFromValues } from "./settings-model";
import {
  buildMismatchMessage,
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
 * Owns the history route, the range (URL plus `localStorage`), the SSE connection
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

interface RangeFailure {
  from: RangeKey;
  to: RangeKey;
}

function rangeLabel(range: RangeKey): string {
  return RANGE_LABELS[range] ?? range;
}

/**
 * A range change keeps the previous payload on screen while the next one loads.
 * A failed update leaves that payload in place, so the failure is surfaced as a
 * fixed banner (never an inline row) naming what is still on screen and offering
 * a local retry.
 */
function describeRangeFailure(
  data: { range: RangeKey } | undefined,
  requested: RangeKey,
  loading: boolean,
  failed: boolean,
): RangeFailure | undefined {
  if (data === undefined || data.range === requested || loading || !failed) return undefined;
  return { from: data.range, to: requested };
}

/** Failure banner overlay: one fixed position, no document-flow row, no layout shift. */
function RangeFailureNotice(props: { failure: RangeFailure; onRetry: () => void }): JSX.Element {
  return (
    <div class="qg-range-failure" role="alert">
      <span>
        Showing {rangeLabel(props.failure.from)}. Updating to {rangeLabel(props.failure.to)} failed.
      </span>
      <button
        type="button"
        class="qg-range-failure__retry"
        aria-label={`Retry updating to ${rangeLabel(props.failure.to)}`}
        onClick={() => props.onRetry()}
      >
        Retry
      </button>
    </div>
  );
}

function initialLocation(): Location {
  const fallback = readStoredRange(browserStorage());
  if (typeof window === "undefined") return parseLocation("/quota", fallback);
  const initial = canonicalizeLocation(window.location, fallback);
  if (window.location.pathname + window.location.search + window.location.hash !== initial.path) {
    window.history.replaceState(null, "", initial.path);
  }
  writeStoredRange(browserStorage(), initial.location.range);
  return initial.location;
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
  const [location, setLocation] = createSignal<Location>(initialLocation());
  const [connection, setConnection] = createSignal<ConnectionState>(props.client.connection());
  const [navTooltip, setNavTooltip] = createSignal<"home" | "analytics" | "settings" | undefined>();
  const [health, setHealth] = createSignal<DashboardHealth | undefined>(undefined);
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
  // Diagnostic only: never the argument to the contract/load-state gate below.
  const buildWarning = createMemo(() => buildMismatchMessage(health()));
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
    navigate(formatPath(route(), next));
  }

  function navigate(path: string): void {
    const next = parseLocation(path, range());
    if (next.route.name === "not-found") return;
    const canonical = formatPath(next.route, next.range);
    if (window.location.pathname + window.location.search === canonical) return;
    window.history.pushState(null, "", canonical);
    writeStoredRange(browserStorage(), next.range);
    setLocation(next);
  }

  // One delegated listener also covers the presentational project/session links.
  // Preserve native new-tab, download, external and modifier-click behavior.
  function onNavigate(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element | null)?.closest?.("a");
    const href = anchor?.getAttribute("href");
    if (
      !anchor ||
      !href ||
      !href.startsWith("/") ||
      href.startsWith("//") ||
      anchor.hasAttribute("download") ||
      (anchor.getAttribute("target") && anchor.getAttribute("target") !== "_self") ||
      parseLocation(href, range()).route.name === "not-found"
    )
      return;
    event.preventDefault();
    navigate(href);
  }

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
    const onPopState = () => {
      const next = parseLocation(
        window.location.pathname + window.location.search,
        readStoredRange(browserStorage()),
      );
      writeStoredRange(browserStorage(), next.range);
      setLocation(next);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("click", onNavigate);
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
        const currentHealth = await props.client.health();
        setHealth(currentHealth);
        setContractMismatch(contractMismatchMessage(currentHealth.contractVersion));
      } catch {
        // A missing health endpoint is not fatal; route queries report failures.
      }
      await settingsQuery.run();
    })();
    onCleanup(() => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("click", onNavigate);
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
              href={formatPath({ name: "home" }, range())}
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
              href={formatPath({ name: "analytics" }, range())}
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
          <BuildMismatchStatus message={buildWarning()} />
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
              href={formatPath({ name: "settings" }, range())}
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
                  <a href={formatPath({ name: "home" }, range())}>Go home</a>
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
  const busy = createBusyIndicator();
  createEffect(() => {
    busy.update({
      active: query.loading() && query.data() === undefined,
      hasData: query.data() !== undefined,
    });
  });
  onCleanup(() => busy.dispose());
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
      <BusyOverlay indicator={busy} label="quota" />
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
  const rangeFailure = () =>
    describeRangeFailure(query.data(), props.range, query.loading(), query.error() !== undefined);
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active: query.loading() && (data === undefined || data.range !== props.range),
      hasData: data !== undefined,
    });
  });
  onCleanup(() => busy.dispose());
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
      <BusyOverlay indicator={busy} label="analytics" />
      <Show when={rangeFailure()}>
        {(failure) => <RangeFailureNotice failure={failure()} onRetry={() => void query.run()} />}
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
  const rangeFailure = () =>
    describeRangeFailure(query.data(), props.range, query.loading(), query.error() !== undefined);
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active:
        query.loading() &&
        (data === undefined || data.range !== props.range || data.projectId !== props.projectId),
      hasData: data !== undefined,
    });
  });
  onCleanup(() => busy.dispose());

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
      <BusyOverlay indicator={busy} label="analytics" />
      <Show when={rangeFailure()}>
        {(failure) => <RangeFailureNotice failure={failure()} onRetry={() => void query.run()} />}
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
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active: query.loading() && (data === undefined || data.focusSessionId !== props.sessionId),
      hasData: data !== undefined,
    });
  });
  onCleanup(() => busy.dispose());

  createEffect(() =>
    props.onStale(
      query.error() !== undefined || isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()),
    ),
  );

  return (
    <>
      <BusyOverlay indicator={busy} label="analytics" />
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
