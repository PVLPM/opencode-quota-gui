import type { JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupSnapshot,
  DashboardDataSource,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard";
import type { RangeKey } from "../contracts/ranges";
import { BusyOverlay, createBusyIndicator } from "./components/busy";
import { QueryState } from "./components/states";
import type { Toaster } from "./components/toast";
import type { ConnectionState } from "./dashboard-client";
import { RANGE_LABELS } from "./format";
import { sameIdentity } from "./model-analytics";
import { createQuery, type Query } from "./query";
import type { displayPreferencesFromValues } from "./settings-model";
import { describeError, isStaleAfterReconnect, resolveLoadState } from "./view-model";
import { HomeView, QuotaLoading, QuotaView } from "./views/home";
import { ModelDetailView } from "./views/model";
import { ModelsView } from "./views/models";
import { ProjectView } from "./views/project";
import { ProviderDetailView } from "./views/provider";
import { SessionView } from "./views/session";
import { SettingsView } from "./views/settings";
import type { VisibilityCatalog } from "./visibility-catalog";

/**
 * The dashboard's route containers, shared by the browser shell and the native
 * Desktop panel (architecture §7 "separate browser shell from shared
 * composition").
 *
 * Each container owns one fetch, its retry/error/stale state and the feature
 * view for that route. Browser-only concerns stay in `app.tsx`; host-only
 * concerns stay in the native shell. `enabled` and `onFresh` are optional host
 * hooks: the browser omits them, while the native panel uses them to avoid
 * reading while its tab is hidden and to anchor stale data after host recovery.
 */

/** The native transport additionally reports its final closed state. */
type RouteConnectionState = ConnectionState | "closed";

interface RouteLifecycleProps {
  reloadToken: number;
  reconnectEpoch: number;
  onStale: (stale: boolean) => void;
  /** False keeps the route mounted but performs no read (a hidden native tab). */
  enabled?: () => boolean;
  /** Called after a response is applied; the native shell anchors freshness here. */
  onFresh?: () => void;
}

function routeEnabled(props: RouteLifecycleProps): boolean {
  return props.enabled?.() !== false;
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
export function describeRangeFailure(
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

export interface QuotaRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  preferences: ReturnType<typeof displayPreferencesFromValues>;
  hiddenCards: string[];
  hiddenRows: string[];
  onSnapshot: (snapshot: QuotaSnapshot | undefined) => void;
}

export function QuotaRoute(props: QuotaRouteProps): JSX.Element {
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
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    void props.reloadToken;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
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
        onRetry={() => void query.run()}
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

export interface AnalyticsRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  connection: RouteConnectionState;
}

export function AnalyticsRoute(props: AnalyticsRouteProps): JSX.Element {
  const query = createQuery<HomeSnapshot>(() => props.client.home({ range: props.range }));
  /**
   * The reconnect epoch this route's payload is known to be fresh for. A refetch
   * that only starts after a reconnect must land before the marker clears.
   */
  const [freshEpoch, setFreshEpoch] = createSignal(0);

  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const range = props.range;
    const token = props.reloadToken;
    void range;
    void token;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
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
        onRetry={() => void query.run()}
        render={(snapshot) => <HomeView snapshot={snapshot} range={snapshot.range} />}
      />
    </>
  );
}

export interface ModelsRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  dimension: AnalyticsDimension;
  onDimensionChange: (dimension: AnalyticsDimension) => void;
  range: RangeKey;
  connection: RouteConnectionState;
}

export function ModelsRoute(props: ModelsRouteProps): JSX.Element {
  const query = createQuery<AnalyticsGroupSnapshot>(() =>
    props.client.groups({ range: props.range, dimension: props.dimension }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);

  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const range = props.range;
    const dimension = props.dimension;
    const token = props.reloadToken;
    void range;
    void dimension;
    void token;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
    });
  });

  // A grouping change must never leave the previous dimension's rows under the
  // new heading. A range change keeps the old payload while it refreshes, as on
  // Analytics and Project.
  const displayed = () => {
    const data = query.data();
    return data !== undefined && data.dimension === props.dimension ? data : undefined;
  };
  const rangeFailure = () =>
    describeRangeFailure(displayed(), props.range, query.loading(), query.error() !== undefined);
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active:
        query.loading() &&
        (data === undefined || data.dimension !== props.dimension || data.range !== props.range),
      hasData: displayed() !== undefined,
    });
  });
  onCleanup(() => busy.dispose());
  createEffect(() => {
    props.onStale(
      query.error() !== undefined ||
        query.data()?.stale === true ||
        isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()) ||
        props.connection !== "live",
    );
  });

  return (
    <>
      <BusyOverlay indicator={busy} label="analytics" />
      <Show when={rangeFailure()}>
        {(failure) => <RangeFailureNotice failure={failure()} onRetry={() => void query.run()} />}
      </Show>
      <ModelsView
        snapshot={displayed()}
        dimension={props.dimension}
        loading={query.loading()}
        error={query.error() === undefined ? undefined : describeError(query.error())}
        onRetry={() => void query.run()}
        onDimensionChange={props.onDimensionChange}
      />
    </>
  );
}

export interface GroupDetailRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  entity: AnalyticsDimension;
  identity: AnalyticsEntityIdentity;
  modelsGroup?: AnalyticsDimension;
  range: RangeKey;
  connection: RouteConnectionState;
}

export function GroupDetailRoute(props: GroupDetailRouteProps): JSX.Element {
  const grouping = () => (props.entity === "model" ? "provider" : "model");
  const query = createQuery<AnalyticsGroupSnapshot>(() =>
    props.client.groups({
      range: props.range,
      dimension: grouping(),
      filter: { dimension: props.entity, identity: props.identity },
    }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);

  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const range = props.range;
    const entity = props.entity;
    const kind = props.identity.kind;
    const id = props.identity.kind === "known" ? props.identity.id : "";
    const token = props.reloadToken;
    void range;
    void entity;
    void kind;
    void id;
    void token;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
    });
  });

  // The echoed filter proves the payload belongs to this exact raw identity.
  const displayed = () => {
    const data = query.data();
    if (data === undefined || data.dimension !== grouping()) return undefined;
    const filter = data.filter;
    if (
      filter === undefined ||
      filter.dimension !== props.entity ||
      !sameIdentity(filter.identity, props.identity)
    )
      return undefined;
    return data;
  };
  const state = () =>
    resolveLoadState({
      data: displayed(),
      error: query.error(),
      // A retained payload from another identity is not this route's data.
      // Keep the first-load skeleton during that hand-off, but once the
      // hand-off has failed, surface the error instead of spinning forever.
      loading:
        query.loading() ||
        (query.error() === undefined && query.data() !== undefined && displayed() === undefined),
    });
  const rangeFailure = () =>
    describeRangeFailure(displayed(), props.range, query.loading(), query.error() !== undefined);
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active:
        query.loading() &&
        (data === undefined ||
          data.dimension !== grouping() ||
          data.filter === undefined ||
          !sameIdentity(data.filter.identity, props.identity)),
      hasData: displayed() !== undefined,
    });
  });
  onCleanup(() => busy.dispose());
  createEffect(() => {
    props.onStale(
      query.error() !== undefined ||
        displayed()?.stale === true ||
        isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()) ||
        props.connection !== "live",
    );
  });

  return (
    <>
      <BusyOverlay indicator={busy} label="analytics" />
      <Show when={rangeFailure()}>
        {(failure) => <RangeFailureNotice failure={failure()} onRetry={() => void query.run()} />}
      </Show>
      <QueryState
        state={state()}
        label={`Loading ${props.entity}`}
        onRetry={() => void query.run()}
        render={(snapshot) =>
          props.entity === "model" ? (
            <ModelDetailView
              snapshot={snapshot}
              identity={props.identity}
              range={snapshot.range}
              modelsGroup={props.modelsGroup}
            />
          ) : (
            <ProviderDetailView
              snapshot={snapshot}
              identity={props.identity}
              range={snapshot.range}
              modelsGroup={props.modelsGroup}
            />
          )
        }
      />
    </>
  );
}

export interface ProjectRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  projectId: string;
  connection: RouteConnectionState;
}

export function ProjectRoute(props: ProjectRouteProps): JSX.Element {
  const query = createQuery<ProjectSnapshot>(() =>
    props.client.project({ projectId: props.projectId, range: props.range }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const projectId = props.projectId;
    const range = props.range;
    const token = props.reloadToken;
    void projectId;
    void range;
    void token;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
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
        onRetry={() => void query.run()}
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

export interface SessionRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  sessionId: string;
  connection: RouteConnectionState;
}

export function SessionRoute(props: SessionRouteProps): JSX.Element {
  // The session page ignores the range entirely: its graphs always cover the
  // opened session and every descendant (R25–R27).
  const query = createQuery<SessionSnapshot>(() =>
    props.client.session({ sessionId: props.sessionId }),
  );
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const sessionId = props.sessionId;
    const token = props.reloadToken;
    void sessionId;
    void token;
    void query.run().then((applied) => {
      if (!applied) return;
      setFreshEpoch(epoch);
      props.onFresh?.();
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
        onRetry={() => void query.run()}
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

export interface SettingsRouteProps {
  client: DashboardDataSource;
  query: Query<SettingsSnapshot>;
  catalog: VisibilityCatalog;
  temporal?: QuotaSnapshot["temporal"];
  toaster: Toaster;
  stale: boolean;
  /** Recovery for a first-read failure; the browser defaults to a page reload. */
  onRetry?: () => void;
  /** Native hosts expose the canonical Web dashboard switch; Web keeps it hidden. */
  webDashboardToggle?: boolean;
}

export function SettingsRoute(props: SettingsRouteProps): JSX.Element {
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
        fallback={
          <QueryState
            state={state()}
            label="Loading settings"
            render={() => null}
            onRetry={props.onRetry}
          />
        }
      >
        {(snapshot) => (
          <SettingsView
            snapshot={snapshot()}
            client={props.client}
            toaster={props.toaster}
            catalog={props.catalog}
            temporal={props.temporal}
            webDashboardToggle={props.webDashboardToggle}
            onReload={async () => {
              await props.query.run();
            }}
          />
        )}
      </Show>
    </>
  );
}
