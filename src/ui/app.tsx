import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  DashboardHealth,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard";
import { isRangeKey, RANGE_KEYS, type RangeKey } from "../contracts/ranges";
import { AnalyticsTabs } from "./components/analytics-tabs";
import { BuildMismatchStatus } from "./components/build-info";
import { AnalyticsIcon, QuotaIcon } from "./components/icons";
import { ReloadRequired } from "./components/states";
import { TemporalStatusStrip } from "./components/temporal-status";
import { createToaster, ToastRegion } from "./components/toast";
import type { ActiveViewScope, ConnectionState, DashboardClient } from "./dashboard-client";
import { RANGE_LABELS } from "./format";
import { analyticsTabForRoute, viewScopeForRoute } from "./navigation-model";
import { Icon, SegmentedControl, SegmentedControlItem, Tooltip } from "./opencode-ui";
import { createQuery } from "./query";
import {
  AnalyticsRoute,
  GroupDetailRoute,
  ModelsRoute,
  ProjectRoute,
  QuotaRoute,
  SessionRoute,
  SettingsRoute,
} from "./routes";
import {
  canonicalizeLocation,
  formatPath,
  type Location,
  modelsGroupForRoute,
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
  shouldRefetchOnReconnect,
} from "./view-model";
import {
  catalogFromQuotaSnapshot,
  mergeVisibilityCatalog,
  readVisibilityCatalog,
  type VisibilityCatalog,
  visibilityCatalogEquals,
  writeVisibilityCatalog,
} from "./visibility-catalog";

export { SettingsRoute };

/**
 * Dashboard shell (design spec §10).
 *
 * Owns the history route, the range (URL plus `localStorage`), the SSE connection
 * state, and one settings read that supplies the visibility lists and display
 * preferences. Views stay presentational; each route container owns its own
 * fetch, so a range change refetches range-scoped queries only and the session
 * route never refetches on a range change at all.
 */

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
  const analyticsTab = (): "analytics" | "models" | undefined => analyticsTabForRoute(route());
  const modelsDimension = (): AnalyticsDimension | undefined => {
    return modelsGroupForRoute(route());
  };
  // Models links elsewhere in the Analytics section return to the last grouping
  // the user chose, while the URL remains the source of truth on Models itself.
  const [rememberedModelsDimension, setRememberedModelsDimension] =
    createSignal<AnalyticsDimension>("provider");
  createEffect(() => {
    const dimension = modelsDimension();
    if (dimension !== undefined) setRememberedModelsDimension(dimension);
  });
  const activeScope = createMemo<ActiveViewScope>(() => viewScopeForRoute(route()));

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

  createEffect(
    on([() => route().name, () => quotaReloadToken()], ([routeName, token], previous) => {
      if (routeName !== "settings") return;
      // Entry loads the optional catalog only when nothing is cached. A quota
      // tick while Settings is open refreshes it so temporal rows stay live.
      const tokenChanged = previous !== undefined && previous[1] !== token;
      if (!tokenChanged && homeSnapshot()) return;
      void props.client
        .quota()
        .then(setHomeSnapshot)
        .catch(() => {
          // Settings remain usable if the optional catalog or temporal status is unavailable.
        });
    }),
  );

  /**
   * The visibility section names individual cards, including cards hidden on
   * Quota. The bounded cache also remembers absent cards through failed or
   * incomplete reads, navigation and reload. Ids are configuration keys only,
   * never display labels; the empty state lasts until either source has cards.
   */
  const [catalogCache, setCatalogCache] = createSignal<VisibilityCatalog>(
    readVisibilityCatalog(browserStorage()),
  );
  const quotaCatalog = createMemo(() => catalogFromQuotaSnapshot(homeSnapshot()));
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

  /** Grouping is view state, so it replaces the current history entry, not adds one. */
  function replaceModelsDimension(dimension: AnalyticsDimension): void {
    const current = location();
    if (current.route.name !== "models") return;
    const next: Location = { ...current, route: { name: "models", dimension } };
    const path = formatPath(next.route, next.range);
    if (window.location.pathname + window.location.search === path) return;
    window.history.replaceState(null, "", path);
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
              data-section-active={analyticsTab() === undefined ? undefined : "true"}
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
          <div class="qg-topbar__left">
            <Show
              when={analyticsTab()}
              fallback={
                <span class="qg-frame-tab">
                  {route().name === "home"
                    ? "Quota"
                    : route().name === "settings"
                      ? "Settings"
                      : "Dashboard"}
                </span>
              }
            >
              {(tab) => (
                <AnalyticsTabs
                  active={tab()}
                  range={range()}
                  modelsDimension={modelsDimension() ?? rememberedModelsDimension()}
                />
              )}
            </Show>
          </div>
          <div class="qg-topbar__actions">
            <Show when={route().name === "home" ? homeSnapshot()?.temporal : undefined}>
              {(temporal) => (
                <TemporalStatusStrip
                  providers={temporal().providers}
                  overrides={preferences().temporalProviderOverrides}
                />
              )}
            </Show>
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
                  <SegmentedControlItem value={key}>
                    {RANGE_LABELS[key] ?? key}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Show>
          </div>
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

              <Match when={route().name === "models"}>
                <ModelsRoute
                  client={props.client}
                  dimension={(route() as { dimension: AnalyticsDimension }).dimension}
                  onDimensionChange={replaceModelsDimension}
                  range={range()}
                  reloadToken={reloadToken()}
                  reconnectEpoch={reconnectEpoch()}
                  connection={connection()}
                  onStale={setRouteStale}
                />
              </Match>

              <Match when={route().name === "model"}>
                <GroupDetailRoute
                  client={props.client}
                  entity="model"
                  identity={(route() as { identity: AnalyticsEntityIdentity }).identity}
                  modelsGroup={(route() as { modelsGroup?: AnalyticsDimension }).modelsGroup}
                  range={range()}
                  reloadToken={reloadToken()}
                  reconnectEpoch={reconnectEpoch()}
                  connection={connection()}
                  onStale={setRouteStale}
                />
              </Match>

              <Match when={route().name === "provider"}>
                <GroupDetailRoute
                  client={props.client}
                  entity="provider"
                  identity={(route() as { identity: AnalyticsEntityIdentity }).identity}
                  modelsGroup={(route() as { modelsGroup?: AnalyticsDimension }).modelsGroup}
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
                  temporal={homeSnapshot()?.temporal}
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
