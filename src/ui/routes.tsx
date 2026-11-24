import type { JSX } from "solid-js";
import { createEffect, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
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
import type { AnalyticsPresentationStore } from "./analytics-cache";
import { BuildAbout } from "./components/build-info";
import { type BusyIndicator, BusyOverlay, createBusyIndicator } from "./components/busy";
import { QueryState, RetryAction } from "./components/states";
import type { Toaster } from "./components/toast";
import type { ConnectionState } from "./dashboard-client";
import { RANGE_LABELS } from "./format";
import { sameIdentity } from "./model-analytics";
import { createQuery, type Query } from "./query";
import { createQuotaQuery, type QuotaQuery } from "./quota-query";
import type { Route } from "./routing";
import type { displayPreferencesFromValues } from "./settings-model";
import {
  describeError,
  isRecoverableReadFailure,
  isStaleAfterReconnect,
  resolveLoadState,
  shouldProbeAnalyticsRead,
  shouldRejoinAnalyticsRead,
} from "./view-model";
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

/** One automatic retry per logical request; manual retries never expire. */
interface RetryBudget {
  available: () => boolean;
  consume: () => void;
  reset: () => void;
}

function createRetryBudget(logicalKey: () => string): RetryBudget {
  const [key, setKey] = createSignal(logicalKey());
  const [used, setUsed] = createSignal(false);
  createEffect(() => {
    const next = logicalKey();
    if (next === key()) return;
    setKey(next);
    setUsed(false);
  });
  return {
    available: () => !used(),
    consume: () => setUsed(true),
    reset: () => setUsed(false),
  };
}

async function runRetry<T>(query: Query<T>, budget: RetryBudget): Promise<boolean> {
  const applied = await query.run();
  if (applied) budget.reset();
  return applied;
}

/** Retry affordances shared by the analytics routes with one logical request. */
function createRouteRetry<T>(query: Query<T>, logicalKey: () => string) {
  const budget = createRetryBudget(logicalKey);
  const retry = () => void runRetry(query, budget);
  const autoRetry = () => {
    budget.consume();
    retry();
  };
  return { budget, retry, autoRetry };
}

/**
 * The load state, range-failure notice and delayed busy panel of a route whose
 * payload carries its range; `onScreen` says whether the payload is the scope
 * the route currently requests.
 */
function createRouteView<T extends { range: RangeKey }>(
  query: Query<T>,
  range: () => RangeKey,
  onScreen: (data: T) => boolean,
) {
  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });
  const rangeFailure = () =>
    describeRangeFailure(query.data(), range(), query.loading(), query.error() !== undefined);
  const busy: BusyIndicator = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active: query.loading() && (data === undefined || !onScreen(data)),
      hasData: data !== undefined,
    });
  });
  onCleanup(() => busy.dispose());
  return { state, rangeFailure, busy };
}

/**
 * Reports a data route's stale state to the shell: a failed read, a stale
 * payload, a recovery after the last fresh epoch, or a transport that is not
 * live. The route contributes only its own payload checks.
 */
function useReadStale(
  props: RouteLifecycleProps & { connection: RouteConnectionState },
  freshEpoch: () => number,
  stale: () => boolean,
): void {
  createEffect(() =>
    props.onStale(
      stale() ||
        isStaleAfterReconnect(props.reconnectEpoch, freshEpoch()) ||
        props.connection !== "live",
    ),
  );
}

function routeEnabled(props: RouteLifecycleProps): boolean {
  return props.enabled?.() !== false;
}

/**
 * The analytics transport's host RPC can time out while the single-flighted
 * server read keeps running for up to its 180 s budget. Re-join that read, then
 * probe once more at the deadline so a result committed there is still applied.
 */
function analyticsQuery<T>(fetcher: () => Promise<T>): Query<T> & {
  invalidate: () => void;
  set: (value: T) => void;
} {
  return createQuery(fetcher, shouldRejoinAnalyticsRead, shouldProbeAnalyticsRead);
}

/**
 * Paints a retained payload immediately, then revalidates it. `fresh` anchors
 * the reconnect epoch only after an applicable read is applied, so a cached
 * paint never certifies data as post-reconnect fresh.
 */
function readRetained<T extends object>(input: {
  query: Query<T> & { set: (value: T) => void };
  store: AnalyticsPresentationStore;
  retentionKey: string;
  fresh: () => void;
  onFresh?: () => void;
  onApplied?: () => void;
}): void {
  const hit = input.store.take<T>(input.retentionKey);
  if (hit !== undefined) {
    input.query.set(hit);
  }
  void input.query.run().then((applied) => {
    if (!applied) return;
    input.onApplied?.();
    const data = input.query.data();
    if (data === undefined) return;
    input.store.remember(input.retentionKey, data);
    input.fresh();
    input.onFresh?.();
  });
}

/**
 * The retained-payload effect shared by Models, detail, Project, and Session
 * routes: paint a matching payload, revalidate it, then anchor the epoch.
 */
function useRetainedRoute<T extends object>(
  props: RouteLifecycleProps & { store: AnalyticsPresentationStore },
  query: Query<T> & { set: (value: T) => void; invalidate: () => void },
  retentionKey: () => string,
  budget: RetryBudget,
): () => number {
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    // Freshness still triggers revalidation; it is not part of the retained
    // payload's ownership key, so the old data paints before the read lands.
    void props.reloadToken;
    readRetained({
      query,
      store: props.store,
      retentionKey: retentionKey(),
      fresh: () => setFreshEpoch(epoch),
      onFresh: props.onFresh,
      onApplied: () => budget.reset(),
    });
  });
  onCleanup(() => query.invalidate());
  return freshEpoch;
}

function failureNotice(
  failure: RangeFailure,
  cause: unknown,
  retry: () => void,
  budget: RetryBudget,
): JSX.Element {
  return (
    <RangeFailureNotice
      failure={failure}
      recoverable={isRecoverableReadFailure(cause)}
      autoRetry={budget.available()}
      onAutoRetry={() => {
        budget.consume();
        retry();
      }}
      onRetry={retry}
    />
  );
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
function RangeFailureNotice(props: {
  failure: RangeFailure;
  recoverable: boolean;
  autoRetry: boolean;
  onAutoRetry: () => void;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div class="qg-range-failure" role="alert">
      <span>
        Showing {rangeLabel(props.failure.from)}. Updating to {rangeLabel(props.failure.to)} failed.
      </span>
      <RetryAction
        class="qg-range-failure__retry"
        label={`Retry updating to ${rangeLabel(props.failure.to)}`}
        recoverable={props.recoverable}
        autoRetry={props.autoRetry}
        onAutoRetry={props.onAutoRetry}
        onRetry={props.onRetry}
      />
    </div>
  );
}

/**
 * The chrome every analytics route shares: the delayed busy overlay, the
 * range-failure banner and its one retry entry point. The route supplies the
 * content below it.
 */
function AnalyticsFrame<T>(props: {
  busy: BusyIndicator;
  rangeFailure: () => RangeFailure | undefined;
  query: Query<T>;
  budget: RetryBudget;
  children: JSX.Element;
}): JSX.Element {
  return (
    <>
      <BusyOverlay indicator={props.busy} label="analytics" />
      <Show when={props.rangeFailure()}>
        {(failure) =>
          failureNotice(
            failure(),
            props.query.error(),
            () => void runRetry(props.query, props.budget),
            props.budget,
          )
        }
      </Show>
      {props.children}
    </>
  );
}

export interface QuotaRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  quotaQuery?: QuotaQuery;
  preferences: ReturnType<typeof displayPreferencesFromValues>;
  hiddenCards: string[];
  hiddenRows: string[];
  onSnapshot: (snapshot: QuotaSnapshot | undefined) => void;
  onRetryShell?: () => boolean | void;
}

export function QuotaRoute(props: QuotaRouteProps): JSX.Element {
  const query =
    props.quotaQuery ??
    createQuotaQuery((refresh) => props.client.quota(refresh ? { refresh: true } : undefined));
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  let previousEpoch = props.reconnectEpoch;
  let previousToken = props.reloadToken;
  let initialRead = true;
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
    const token = props.reloadToken;
    const changed = token !== previousToken;
    previousToken = token;
    const reconnected = epoch !== previousEpoch;
    previousEpoch = epoch;
    if (reconnected && !props.quotaQuery) query.reconnected();
    if (initialRead && !reconnected && query.consumeRefresh()) {
      initialRead = false;
      setFreshEpoch(epoch);
      props.onFresh?.();
      return;
    }
    initialRead = false;
    void (reconnected ? query.afterReconnect() : query.read({ changed })).then((applied) => {
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
  const retryQuota = () => {
    if (query.isRefreshing()) return;
    if (props.onRetryShell?.() !== true) {
      const epoch = props.reconnectEpoch;
      void query.refresh().then((applied) => {
        if (!applied || epoch !== props.reconnectEpoch || query.data()?.stale !== false) return;
        setFreshEpoch(epoch);
        props.onFresh?.();
      });
    }
  };
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
        onRetry={retryQuota}
        render={(snapshot, stale) => (
          <QuotaView
            snapshot={snapshot}
            preferences={props.preferences}
            hiddenCards={props.hiddenCards}
            hiddenRows={props.hiddenRows}
            stale={stale}
            onRetry={retryQuota}
          />
        )}
      />
    </>
  );
}

interface AnalyticsRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  connection: RouteConnectionState;
  store: AnalyticsPresentationStore;
}

function AnalyticsRoute(props: AnalyticsRouteProps): JSX.Element {
  const query = analyticsQuery<HomeSnapshot>(() => props.client.home({ range: props.range }));
  const [freshEpoch, setFreshEpoch] = createSignal(0);
  const [exactFailure, setExactFailure] = createSignal<string>();
  const budget = createRetryBudget(() => `home:${props.range}`);
  const runExact = async (): Promise<void> => {
    const range = props.range;
    const token = props.store.beginRead();
    try {
      const data = await props.client.home({ range, exact: true });
      if (props.range !== range) return;
      if (data.provisional === true || data.exactError !== undefined) {
        query.set(data);
        props.store.clearProvisional(range, token);
        setExactFailure(
          data.exactError ?? "The exact analytics read failed. Retry to finish this range.",
        );
        return;
      }
      query.set(data);
      props.store.clearProvisional(range, token);
      props.store.remember(`home:${range}`, data);
      setExactFailure(undefined);
      budget.reset();
    } catch {
      // The terminal notice stays; a manual retry can ask again.
    }
  };
  const retry = () => {
    if (exactFailure() !== undefined) {
      void runExact();
      return;
    }
    void runRetry(query, budget);
  };
  const autoRetry = () => {
    budget.consume();
    retry();
  };

  createEffect(() => {
    if (!routeEnabled(props)) return;
    const epoch = props.reconnectEpoch;
    const range = props.range;
    // Invalidation revalidates the same owned payload; it never discards it.
    void props.reloadToken;
    const token = props.store.beginRead();
    const hit = props.store.take<HomeSnapshot>(`home:${range}`);
    if (hit !== undefined) {
      // Paint the retained payload now; the read below revalidates it without
      // blocking the route or flashing a skeleton. Freshness waits for that read.
      query.set(hit);
    }
    const endForeground = props.store.beginForeground(range);
    void query
      .run()
      .then((applied) => {
        if (!applied) {
          // A terminal failure ends this read's provisional marker; an older
          // superseded read cannot clear a newer read's marker.
          props.store.clearProvisional(range, token);
          return;
        }
        budget.reset();
        const data = query.data();
        if (data === undefined) return;
        if (data.exactError !== undefined) {
          // The exact replacement terminated in failure: keep the provisional
          // payload, but stop the ring and offer the exact retry.
          props.store.clearProvisional(range, token);
          setExactFailure(data.exactError);
          return;
        }
        setExactFailure(undefined);
        if (data.provisional === true) {
          // First useful paint; the worker's exact replacement is still running.
          props.store.noteProvisional(range, token);
        } else {
          props.store.clearProvisional(range, token);
          props.store.remember(`home:${range}`, data);
        }
        setFreshEpoch(epoch);
        props.onFresh?.();
      })
      .finally(endForeground);
    // Same tick as the foreground read, so the worker sees the whole batch.
    props.store.prefetch(range);
  });
  // Leaving Analytics stops this route's re-join loop; the shell store keeps
  // the retained payloads and the background prefetches.
  onCleanup(() => query.invalidate());

  const { state, rangeFailure, busy } = createRouteView(
    query,
    () => props.range,
    (data) => data.range === props.range,
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
    <AnalyticsFrame busy={busy} rangeFailure={rangeFailure} query={query} budget={budget}>
      <Show when={exactFailure()}>
        {(message) => (
          <div class="qg-range-failure" role="alert">
            <span>{message()}</span>
            <RetryAction
              class="qg-range-failure__retry"
              label={`Retry exact ${rangeLabel(props.range)} analytics`}
              recoverable
              autoRetry={budget.available()}
              onAutoRetry={autoRetry}
              onRetry={retry}
            />
          </div>
        )}
      </Show>
      <QueryState
        state={state()}
        label="Loading analytics"
        onRetry={retry}
        autoRetry={budget.available()}
        onAutoRetry={autoRetry}
        render={(snapshot) => <HomeView snapshot={snapshot} range={snapshot.range} />}
      />
    </AnalyticsFrame>
  );
}

interface ModelsRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  dimension: AnalyticsDimension;
  onDimensionChange: (dimension: AnalyticsDimension) => void;
  range: RangeKey;
  connection: RouteConnectionState;
  store: AnalyticsPresentationStore;
}

function ModelsRoute(props: ModelsRouteProps): JSX.Element {
  const query = analyticsQuery<AnalyticsGroupSnapshot>(() =>
    props.client.groups({ range: props.range, dimension: props.dimension }),
  );
  const retainedKey = () => `groups:${props.dimension}:${props.range}`;
  const { budget, retry, autoRetry } = createRouteRetry(query, retainedKey);
  const freshEpoch = useRetainedRoute(props, query, retainedKey, budget);

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
  useReadStale(
    props,
    freshEpoch,
    () => query.error() !== undefined || query.data()?.stale === true,
  );

  return (
    <AnalyticsFrame busy={busy} rangeFailure={rangeFailure} query={query} budget={budget}>
      <ModelsView
        snapshot={displayed()}
        dimension={props.dimension}
        loading={query.loading()}
        error={query.error() === undefined ? undefined : describeError(query.error())}
        errorRecoverable={isRecoverableReadFailure(query.error())}
        autoRetry={budget.available()}
        onAutoRetry={autoRetry}
        onRetry={retry}
        onDimensionChange={props.onDimensionChange}
      />
    </AnalyticsFrame>
  );
}

interface GroupDetailRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  entity: AnalyticsDimension;
  identity: AnalyticsEntityIdentity;
  modelsGroup?: AnalyticsDimension;
  range: RangeKey;
  connection: RouteConnectionState;
  store: AnalyticsPresentationStore;
}

function GroupDetailRoute(props: GroupDetailRouteProps): JSX.Element {
  const grouping = () => (props.entity === "model" ? "provider" : "model");
  const query = analyticsQuery<AnalyticsGroupSnapshot>(() =>
    props.client.groups({
      range: props.range,
      dimension: grouping(),
      filter: { dimension: props.entity, identity: props.identity },
    }),
  );
  const retainedKey = () => {
    const identityKey = props.identity.kind === "known" ? props.identity.id : "unknown";
    return `groups:${props.entity}:${identityKey}:${props.range}`;
  };
  const { budget, retry, autoRetry } = createRouteRetry(query, retainedKey);
  const freshEpoch = useRetainedRoute(props, query, retainedKey, budget);

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
  useReadStale(props, freshEpoch, () => query.error() !== undefined || displayed()?.stale === true);

  return (
    <AnalyticsFrame busy={busy} rangeFailure={rangeFailure} query={query} budget={budget}>
      <QueryState
        state={state()}
        label={`Loading ${props.entity}`}
        onRetry={retry}
        autoRetry={budget.available()}
        onAutoRetry={autoRetry}
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
    </AnalyticsFrame>
  );
}

interface ProjectRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  projectId: string;
  connection: RouteConnectionState;
  store: AnalyticsPresentationStore;
}

function ProjectRoute(props: ProjectRouteProps): JSX.Element {
  const query = analyticsQuery<ProjectSnapshot>(() =>
    props.client.project({ projectId: props.projectId, range: props.range }),
  );
  const retainedKey = () => `project:${props.projectId}:${props.range}`;
  const { budget, retry, autoRetry } = createRouteRetry(query, retainedKey);
  const freshEpoch = useRetainedRoute(props, query, retainedKey, budget);

  const { state, rangeFailure, busy } = createRouteView(
    query,
    () => props.range,
    (data) => data.range === props.range && data.projectId === props.projectId,
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
    <AnalyticsFrame busy={busy} rangeFailure={rangeFailure} query={query} budget={budget}>
      <QueryState
        state={state()}
        label="Loading project"
        onRetry={retry}
        autoRetry={budget.available()}
        onAutoRetry={autoRetry}
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
    </AnalyticsFrame>
  );
}

interface SessionRouteProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  range: RangeKey;
  /** The parsed session route, including the explicit individual-view flag. */
  route: Extract<Route, { name: "session" }>;
  connection: RouteConnectionState;
  store: AnalyticsPresentationStore;
}

function SessionRoute(props: SessionRouteProps): JSX.Element {
  const sessionId = () => props.route.sessionId;
  // The session page ignores the range entirely: its graphs always cover the
  // opened session and every descendant (R25-R27).
  const query = analyticsQuery<SessionSnapshot>(() =>
    props.client.session({ sessionId: sessionId() }),
  );
  const budget = createRetryBudget(() => `session:${sessionId()}`);
  const retry = () => void runRetry(query, budget);
  const autoRetry = () => {
    budget.consume();
    retry();
  };
  const freshEpoch = useRetainedRoute(props, query, () => `session:${sessionId()}`, budget);

  const state = () =>
    resolveLoadState({ data: query.data(), error: query.error(), loading: query.loading() });
  const busy = createBusyIndicator();
  createEffect(() => {
    const data = query.data();
    busy.update({
      active: query.loading() && (data === undefined || data.focusSessionId !== sessionId()),
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
        onRetry={retry}
        autoRetry={budget.available()}
        onAutoRetry={autoRetry}
        render={(snapshot, stale) => (
          <SessionView
            snapshot={snapshot}
            range={props.range}
            individual={props.route.individual === true}
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

export interface AnalyticsViewsProps extends RouteLifecycleProps {
  client: DashboardDataSource;
  store: AnalyticsPresentationStore;
  connection: RouteConnectionState;
  route: Route;
  range: RangeKey;
  onModelsDimensionChange: (dimension: AnalyticsDimension) => void;
}

/**
 * The analytics-backed routes, mounted identically by the browser shell and the
 * native panel. A shell supplies its client, retained store, current location
 * and grouping handler; each route reads its own slice of the route, and the
 * spread keeps the shared lifecycle props reactive.
 */
export function AnalyticsViews(props: AnalyticsViewsProps): JSX.Element {
  const detail = () => {
    const route = props.route;
    return route.name === "model" || route.name === "provider" ? route : undefined;
  };
  return (
    <Switch>
      <Match when={props.route.name === "analytics"}>
        <AnalyticsRoute {...props} />
      </Match>
      <Match when={props.route.name === "models" ? props.route : undefined}>
        {(route) => (
          <ModelsRoute
            {...props}
            dimension={route().dimension}
            onDimensionChange={props.onModelsDimensionChange}
          />
        )}
      </Match>
      <Match when={detail()}>
        {(route) => (
          <GroupDetailRoute
            {...props}
            entity={route().name}
            identity={route().identity}
            modelsGroup={route().modelsGroup}
          />
        )}
      </Match>
      <Match when={props.route.name === "project" ? props.route : undefined}>
        {(route) => <ProjectRoute {...props} projectId={route().projectId} />}
      </Match>
      <Match when={props.route.name === "session" ? props.route : undefined}>
        {(route) => <SessionRoute {...props} route={route()} />}
      </Match>
    </Switch>
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
  /** Native hosts expose the quota alert threshold and cooldown controls. */
  nativeQuotaAlerts?: boolean;
  /** Optional host-provided About action. */
  aboutAction?: JSX.Element;
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
          <>
            <QueryState
              state={state()}
              label="Loading settings"
              render={() => null}
              onRetry={props.onRetry}
            />
            <Show when={props.aboutAction}>
              <BuildAbout>{props.aboutAction}</BuildAbout>
            </Show>
          </>
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
            nativeQuotaAlerts={props.nativeQuotaAlerts}
            aboutAction={props.aboutAction}
            onReload={async () => {
              await props.query.run();
            }}
          />
        )}
      </Show>
    </>
  );
}
