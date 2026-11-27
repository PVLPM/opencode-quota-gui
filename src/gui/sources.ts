/**
 * Production dashboard read source (design spec §5.1/§6; plan P3 step 8 and
 * the unified analytics/quota split).
 *
 * Analytics and quota are independent:
 *
 * - `home`/`project`/`session` delegate to one lazy `AnalyticsReadService`
 *   (`createAnalyticsReadService` from `./analytics-service.js`). No worker,
 *   database read, config read, or provider probe happens until the first
 *   analytics request, and the transport never loads a lifetime dataset by
 *   default. A quota viewer therefore never starts the analytics worker.
 * - `quota` loads config, selects the configured enabled provider set, and runs
 *   one existing `collectQuotaDashboardProviderResults` cycle over it (existing
 *   quota-state cache/cooldowns). Visibility is presentation-only: every
 *   selected provider is polled and its cards remain in the snapshot; the
 *   browser filters hidden cards. Per-provider last-good results survive a
 *   slow/empty/error cycle.
 *
 * `loadDataset`/`createAnalytics`/`collectProviderResults` remain plain
 * callback seams for synthetic tests; production uses the analytics service
 * and the real provider collector.
 */
import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
  DashboardDataSource,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import { OPENAI_RESETS_ROW_KEY, OPENAI_RESETS_ROW_RESULT_TYPE } from "../contracts/openai-quota.js";
import { isTransientProviderFailureCategory } from "../contracts/provider-failure.js";
import type { RangeKey } from "../contracts/ranges.js";
import { createLoadConfigMeta, loadConfig } from "../lib/config.js";
import type { QuotaProvider, QuotaProviderContext, QuotaToastEntry } from "../lib/entries.js";
import { rawAssistantRowHasTokenUsage } from "../lib/opencode-storage.js";
import {
  collectQuotaDashboardProviderResults,
  type QuotaStatusLiveProbe,
} from "../lib/quota-render-data.js";
import { quotaResultMeasuredAtMs, withoutClaudeAgentSavedResets } from "../lib/quota-state.js";
import type { QuotaToastConfig } from "../lib/types.js";
import { getProviders } from "../providers/registry.js";
import {
  AnalyticsNotFoundError,
  createUsageAnalytics,
  messagePositionMs,
  type UsageAnalytics,
  type UsageAnalyticsDataset,
} from "./aggregation.js";
import { createAnalyticsModel } from "./analytics-model.js";
import { type AnalyticsReadService, createAnalyticsReadService } from "./analytics-service.js";
import { buildCardId, hashQuotaCardIdentity } from "./identity.js";
import {
  buildProviderCards,
  cardSourceKey,
  type MergedProbe,
  optionalValueRowId,
  type ProviderCardPreferences,
  type SourceKey,
  UNSCOPED,
} from "./provider-cards.js";
import { markQuotaObservationCycle, markQuotaObservationLive } from "./quota-observation.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./snapshot-service.js";
import { TEMPORAL_QUOTA_POLICIES } from "./temporal-quota-policy-data.js";
import {
  buildTemporalStatus,
  listTemporalProviderSources,
  readBundledTemporalCatalog,
} from "./temporal-status.js";
import { resolveHostTimeZone } from "./time-zone.js";

/**
 * Controlled source error codes the HTTP layer maps to status codes
 * (spec §5.3): `project-not-found`/`session-not-found` → 404, `bad-request`
 * → 400. Messages are fixed generics; no path or provider body is carried.
 */
export type DashboardSourceErrorCode = "bad-request" | "project-not-found" | "session-not-found";

const SOURCE_ERROR_MESSAGES: Readonly<Record<DashboardSourceErrorCode, string>> = {
  "bad-request": "Bad request",
  "project-not-found": "Project not found",
  "session-not-found": "Session not found",
};

export class DashboardSourceError extends Error {
  readonly code: DashboardSourceErrorCode;

  constructor(code: DashboardSourceErrorCode) {
    super(SOURCE_ERROR_MESSAGES[code]);
    this.name = "DashboardSourceError";
    this.code = code;
  }
}

/**
 * The analytics read service contract, re-exported for the transport seams
 * (`./analytics-service.js`; see the analytics-api contract document).
 */
export type DashboardAnalyticsService = AnalyticsReadService;

export interface DashboardReadSourceOptions {
  /** Plugin client, exactly the core provider-context contract the collector takes. */
  client: QuotaProviderContext["client"];
  workspaceRoot: string;
  /** Explicit global config dir; defaults to the loader's OPENCODE_CONFIG_DIR/XDG resolution. */
  configDir?: string;
  /** Clock for one snapshot read; defaults to `Date.now`. */
  now?: () => number;
  /** Host calendar zone for DTO formatting; defaults to the machine zone. */
  timeZone?: string;
  loadConfig?: () => Promise<QuotaToastConfig>;
  /** Test seam: per-request in-memory dataset (never the production default). */
  loadDataset?: () => Promise<UsageAnalyticsDataset>;
  /** Test seam: analytics factory over `loadDataset`. */
  createAnalytics?: (dataset: UsageAnalyticsDataset) => UsageAnalytics;
  /** Test/embedding seam: a ready analytics service. */
  analyticsService?: DashboardAnalyticsService;
  /** Test/embedding seam: lazy analytics service factory. */
  createAnalyticsService?: () => DashboardAnalyticsService | Promise<DashboardAnalyticsService>;
  /** Test seam for provider collection; receives the filtered provider list. */
  collectProviderResults?: (input: {
    config: QuotaToastConfig;
    nowMs: number;
    providers: QuotaProvider[];
    openaiResetDetailsVisible: (sourceId?: string) => boolean;
  }) => Promise<QuotaStatusLiveProbe[]>;
  /** Test/embedding seam for the provider registry; defaults to `getProviders()`. */
  providers?: QuotaProvider[];
  providerLabel?: (providerId: string) => string;
}

export type DashboardReadSource = Pick<
  DashboardDataSource,
  "home" | "quota" | "project" | "session" | "groups"
> & {
  /** One shared analytics refresh per transport tick, if the service loaded. */
  refreshAnalytics?(): Promise<void>;
  /** Worker background-generation notifications (lazy; never starts analytics). */
  subscribeAnalytics?(listener: () => void): () => void;
  /** Final host-dispose cleanup; closes the analytics worker. */
  close?(): Promise<void>;
};

/** Maps the analytics not-found error; anything else propagates unchanged. */
function notFoundSourceError(error: AnalyticsNotFoundError): DashboardSourceError {
  return new DashboardSourceError(
    error.resource === "project" ? "project-not-found" : "session-not-found",
  );
}

function translateAnalyticsError(error: unknown): unknown {
  return error instanceof AnalyticsNotFoundError ? notFoundSourceError(error) : error;
}

/**
 * The production default. Creating the service starts no worker and performs
 * no read; the worker is built lazily by the service on the first analytics
 * request (analytics-api contract). The worker receives the owner's pricing
 * snapshot policy; a config read failure keeps safe defaults.
 */
async function createDefaultAnalyticsService(
  loadConfigForService: () => Promise<QuotaToastConfig>,
): Promise<DashboardAnalyticsService> {
  try {
    const config = await loadConfigForService();
    return createAnalyticsReadService({ pricingSnapshot: config.pricingSnapshot });
  } catch {
    return createAnalyticsReadService();
  }
}

/**
 * A readable Console login whose workspace has no Go entitlement is a valid
 * current result, not a transient failure. Keeping the previous measurement in
 * that case would leave a revoked subscription visible as a stale Go card.
 */
function hasRevokedOpenCodeGoEntitlement(probe: QuotaStatusLiveProbe): boolean {
  return (
    probe.providerId === "opencode-go" &&
    probe.result.errors.length === 0 &&
    (probe.result.statusDetails ?? []).some(
      (detail) => detail.key === "opencode_go_state" && detail.value === "not_subscribed",
    )
  );
}

/**
 * Host-side Resets visibility for one OpenAI account. It mirrors the same
 * hashed card id and stable row id the card projection emits, so a hidden
 * account/card/row suppresses the optional detail GET before it happens. The
 * callback never sees raw ids in the browser payload.
 *
 * This is a separate optional-metadata gate: quota polling and the collected
 * snapshot are unaffected by it.
 */
export function createOpenAiResetDetailsVisibility(
  config: Pick<QuotaToastConfig, "dashboard">,
): (sourceId?: string) => boolean {
  const hiddenCards = new Set(config.dashboard.hiddenCards);
  const hiddenRows = new Set(config.dashboard.hiddenRows);
  return (sourceId?: string): boolean => {
    if (!sourceId) return false;
    if (
      hiddenCards.has("openai") ||
      hiddenCards.has(sourceId) ||
      hiddenCards.has(hashQuotaCardIdentity("openai", sourceId))
    ) {
      return false;
    }
    const cardId = buildCardId("openai", sourceId);
    if (hiddenCards.has(cardId)) return false;
    const resetsRowId = optionalValueRowId(
      cardId,
      OPENAI_RESETS_ROW_KEY,
      OPENAI_RESETS_ROW_RESULT_TYPE,
    );
    return !hiddenRows.has(resetsRowId);
  };
}

/**
 * Configured enabled set, applied before any `isAvailable`/`isDiscovered`
 * probe. Hidden cards are presentation-only: no hidden-card id removes a
 * provider from polling or from the collected snapshot.
 */
export function selectQuotaProviders(
  config: Pick<QuotaToastConfig, "enabledProviders">,
  providers: readonly QuotaProvider[],
): QuotaProvider[] {
  const enabled = config.enabledProviders === "auto" ? undefined : new Set(config.enabledProviders);
  return providers.filter((provider) => enabled === undefined || enabled.has(provider.id));
}

/**
 * Live temporal status is additive: a missing or invalid snapshot must never
 * fail quota reads. All temporal-capable providers are projected, including
 * those without an account; discovery only sets the default visibility.
 */
function temporalStatusForCards(
  cards: QuotaSnapshot["providers"]["cards"],
  nowMs: number,
): QuotaSnapshot["temporal"] | undefined {
  try {
    const catalog = readBundledTemporalCatalog();
    const providers = listTemporalProviderSources(catalog, TEMPORAL_QUOTA_POLICIES, cards);
    if (providers.length === 0) return undefined;
    return buildTemporalStatus({
      providers,
      nowMs,
      routes: catalog.routes,
      holidays: catalog.holidays,
      quotaPolicies: TEMPORAL_QUOTA_POLICIES,
    });
  } catch {
    return undefined;
  }
}

function cardPreferences(config: QuotaToastConfig): ProviderCardPreferences {
  const preferences: ProviderCardPreferences = {
    accountingDetail: config.accountingDetail,
    providerOrder: config.dashboard.providerOrder,
    cardOrder: config.dashboard.cardOrder,
    rowOrder: config.dashboard.rowOrder,
  };
  if (config.resetTimeDecimals !== undefined) {
    preferences.resetTimeDecimals = config.resetTimeDecimals;
  }
  if (config.resetTimeSpaced !== undefined) preferences.resetTimeSpaced = config.resetTimeSpaced;
  return preferences;
}

export function createDashboardReadSource(
  options: DashboardReadSourceOptions,
): DashboardReadSource {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? resolveHostTimeZone();

  // -------------------------------------------------------------------------
  // Lazy analytics service
  // -------------------------------------------------------------------------

  let analyticsPromise: Promise<DashboardAnalyticsService> | undefined;
  const analyticsEventListeners = new Set<() => void>();
  let analyticsUnsubscribe: (() => void) | undefined;

  function attachAnalyticsEvents(service: DashboardAnalyticsService): void {
    if (analyticsUnsubscribe || !service.subscribe) return;
    try {
      analyticsUnsubscribe = service.subscribe(() => {
        for (const listener of Array.from(analyticsEventListeners)) {
          try {
            listener();
          } catch {
            // A subscriber failure never breaks delivery.
          }
        }
      });
    } catch {
      analyticsUnsubscribe = undefined;
    }
  }

  function createLegacyAnalyticsService(): DashboardAnalyticsService {
    const createAnalytics =
      options.createAnalytics ??
      ((dataset: UsageAnalyticsDataset) => createUsageAnalytics(dataset, { timeZone }));
    const loadDataset = options.loadDataset;
    if (!loadDataset) throw new Error("Analytics dataset seam unavailable");

    /**
     * Parity with the worker model: zero-token rows are metadata/activity only
     * and stay out of usage rollups, steps, and pricing. Session/project
     * metadata is left intact so zero-token-only scopes remain visible.
     */
    const usageDataset = (dataset: UsageAnalyticsDataset): UsageAnalyticsDataset => ({
      ...dataset,
      messages: dataset.messages.filter(rawAssistantRowHasTokenUsage),
      excluded: dataset.messages
        .filter((row) => !rawAssistantRowHasTokenUsage(row))
        .map((row) => ({ sessionId: row.sessionID, atMs: messagePositionMs(row) })),
    });

    return {
      async home({ range }) {
        const analytics = createAnalytics(usageDataset(await loadDataset()));
        const nowMs = now();
        const { usage, projects } = analytics.home(range, nowMs);
        return {
          generatedAtMs: nowMs,
          range,
          stale: false,
          // Analytics never waits on providers; quota is a separate read.
          providers: { cards: [], enabledProviders: [], polledAtMs: nowMs },
          usage,
          projects,
        };
      },
      async project({ projectId, range }) {
        try {
          return createAnalytics(usageDataset(await loadDataset())).project(
            projectId,
            range,
            now(),
          );
        } catch (error) {
          throw translateAnalyticsError(error);
        }
      },
      async session({ sessionId }) {
        try {
          return createAnalytics(usageDataset(await loadDataset())).session(sessionId);
        } catch (error) {
          throw translateAnalyticsError(error);
        }
      },
      async groups(query) {
        const dataset = await loadDataset();
        const model = createAnalyticsModel({ timeZone });
        model.setMetadata(dataset.sessions, dataset.projects);
        model.apply(dataset.messages, []);
        return model.groups(query, now());
      },
      // The in-memory dataset is rebuilt per request; there is no worker.
      async refresh() {},
      subscribe() {
        return () => {};
      },
      async close() {},
    };
  }

  function getAnalyticsService(): Promise<DashboardAnalyticsService> {
    if (analyticsPromise) return analyticsPromise;
    let created: Promise<DashboardAnalyticsService>;
    try {
      if (options.analyticsService) {
        created = Promise.resolve(options.analyticsService);
      } else if (options.createAnalyticsService) {
        created = Promise.resolve(options.createAnalyticsService());
      } else if (options.loadDataset) {
        created = Promise.resolve(createLegacyAnalyticsService());
      } else {
        created = createDefaultAnalyticsService(loadDashboardConfig);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    analyticsPromise = created.then((service) => {
      attachAnalyticsEvents(service);
      return service;
    });
    return analyticsPromise;
  }

  // -------------------------------------------------------------------------
  // Independent quota cycle
  // -------------------------------------------------------------------------

  let lastQuotaSnapshot: QuotaSnapshot | undefined;
  let quotaCycle: Promise<QuotaSnapshot> | undefined;
  const lastGoodProbes = new Map<
    string,
    { cacheScope: string; bySource: Map<SourceKey, QuotaToastEntry[]> }
  >();

  async function loadDashboardConfig(): Promise<QuotaToastConfig> {
    if (options.loadConfig) return options.loadConfig();
    return loadConfig(undefined, createLoadConfigMeta(), {
      configRootDir: options.workspaceRoot,
      globalConfigDir: options.configDir,
    });
  }

  async function collect(
    config: QuotaToastConfig,
    nowMs: number,
    providers: QuotaProvider[],
    refresh = false,
  ): Promise<QuotaStatusLiveProbe[]> {
    const openaiResetDetailsVisible = createOpenAiResetDetailsVisibility(config);
    if (options.collectProviderResults) {
      return options.collectProviderResults({
        config,
        nowMs,
        providers,
        openaiResetDetailsVisible,
      });
    }
    // Unprojected, all-windows, `onlyCurrentModel` off (P1b seam). The existing
    // quota-state cache/cooldowns are used unchanged (no bypass).
    return collectQuotaDashboardProviderResults({
      client: options.client,
      config,
      workspaceRoot: options.workspaceRoot,
      providers,
      forceProviderRefresh: refresh,
      openaiResetDetailsVisible,
    });
  }

  interface MergedCycle {
    probes: MergedProbe[];
    /** No fresh measurement was available and data failed or was retained. */
    substituted: boolean;
  }

  /** Keep last-good entries scoped to the current credential and card identity. */
  function mergeProviderResults(
    probes: readonly QuotaStatusLiveProbe[],
    selected: readonly QuotaProvider[],
  ): MergedCycle {
    const selectedIds = new Set(selected.map((provider) => provider.id));
    for (const providerId of lastGoodProbes.keys()) {
      if (!selectedIds.has(providerId)) lastGoodProbes.delete(providerId);
    }

    const merged: MergedProbe[] = [];
    const seen = new Set<string>();
    let anyFresh = false;
    let anyError = false;
    let dropped = false;
    let anyRetained = false;
    for (const probe of probes) {
      seen.add(probe.providerId);
      if (hasRevokedOpenCodeGoEntitlement(probe)) {
        // A revoked entitlement replaces the measurement instead of falling
        // back to it; the current result (possibly descriptor-only) is fresh.
        lastGoodProbes.delete(probe.providerId);
        anyFresh = true;
        merged.push(probe);
        continue;
      }
      let store = lastGoodProbes.get(probe.providerId);
      if (!probe.cacheScope || store?.cacheScope !== probe.cacheScope) {
        lastGoodProbes.delete(probe.providerId);
        store = undefined;
      }
      const accountIds = new Set((probe.result.accounts ?? []).map((account) => account.sourceId));
      const entries = new Map<SourceKey, QuotaToastEntry[]>();
      for (const entry of probe.result.entries) {
        const key = cardSourceKey(entry.accounting.sourceId, accountIds);
        const group = entries.get(key) ?? [];
        group.push(entry);
        entries.set(key, group);
      }
      const errors = probe.result.errors.filter((error) => error.kind !== "intentional-filter");
      anyError ||= errors.length > 0;
      const failed = new Set(errors.map((error) => cardSourceKey(error.sourceId, accountIds)));
      const rateLimited = new Set(
        errors
          .filter((error) => error.retryAtMs !== undefined)
          .map((error) => cardSourceKey(error.sourceId, accountIds)),
      );
      // A transient failure key that still carries entries is treated as a quota-state last-good
      // snapshot: those rows were measured before the failure, so they are retained and marked
      // stale, never fresh. Other errors can accompany genuinely fresh entries and do not imply
      // retention.
      const keyHasLastGood = (key: SourceKey) => (store?.bySource.get(key)?.length ?? 0) > 0;
      const explicitTransientKeys = new Set(
        errors
          .filter(
            (error) =>
              isTransientProviderFailureCategory(error.failureCategory) ||
              error.attemptOutcome === "transient" ||
              error.attemptOutcome === "cooldown",
          )
          .map((error) => cardSourceKey(error.sourceId, accountIds)),
      );
      // A provider that previously produced rows for this key keeps them when a later attempt
      // fails in an unclassified way: an unknown category is treated as transient instead of
      // purging a valid measurement, and is normalized so the card mutes it. If this probe also
      // carries entries for the key, those are the measurement; the error stays visible. Credential
      // rejections still prove the account changed and never retain.
      const unknownRetainedKeys = new Set(
        errors
          .filter((error) => {
            const key = cardSourceKey(error.sourceId, accountIds);
            if (entries.has(key) || rateLimited.has(key) || explicitTransientKeys.has(key))
              return false;
            if (error.failureCategory === "credentials" || error.attemptOutcome === "credentials")
              return false;
            return keyHasLastGood(key);
          })
          .map((error) => cardSourceKey(error.sourceId, accountIds)),
      );
      const transientKeys = new Set([...explicitTransientKeys, ...unknownRetainedKeys]);
      const retainedEntryKeys = [...entries.keys()].filter(
        (key) => transientKeys.has(key) && !rateLimited.has(key),
      );
      const freshKeys = [...entries.keys()].filter(
        (key) => !rateLimited.has(key) && !transientKeys.has(key),
      );
      anyFresh ||= freshKeys.length > 0;
      const next = new Map<SourceKey, QuotaToastEntry[]>();
      const retained = new Set<SourceKey>();
      for (const key of freshKeys) next.set(key, entries.get(key)!);
      for (const key of retainedEntryKeys) {
        const safe = withoutClaudeAgentSavedResets(entries.get(key)!);
        entries.set(key, safe);
        next.set(key, safe);
        retained.add(key);
      }
      for (const key of rateLimited)
        if (entries.has(key)) {
          retained.add(key);
          // A failed refresh proves neither eligibility nor expiry, so retained rows drop saved resets.
          const old = withoutClaudeAgentSavedResets(store?.bySource.get(key) ?? []);
          if (old.length > 0) next.set(key, old);
        }
      // A failure that is neither transient nor rate-limited (a credential rejection) proves the
      // account may have changed. It must not reattach the old measurement, and the stored copy is
      // purged so a later empty result cannot bring it back.
      for (const key of failed) {
        if (!transientKeys.has(key) && !rateLimited.has(key)) store?.bySource.delete(key);
      }
      for (const [key, old] of store?.bySource ?? []) {
        if (entries.has(key) || (freshKeys.length > 0 && !failed.has(key))) continue;
        if (key !== UNSCOPED && !accountIds.has(key)) continue;
        const safe = withoutClaudeAgentSavedResets(old).filter(
          (entry) => cardSourceKey(entry.accounting.sourceId, accountIds) === key,
        );
        if (safe.length === 0) continue;
        entries.set(key, safe);
        next.set(key, safe);
        retained.add(key);
      }
      if (probe.cacheScope)
        lastGoodProbes.set(probe.providerId, { cacheScope: probe.cacheScope, bySource: next });
      anyRetained ||= retained.size > 0;
      const normalizedErrors = errors.map((error) => {
        const key = cardSourceKey(error.sourceId, accountIds);
        const normalized = unknownRetainedKeys.has(key)
          ? { ...error, failureCategory: "provider_api" as const }
          : error;
        // A retained non-credential failure is a last-good measurement with a
        // recoverable error. Mark an unspecified outcome so the card mutes it
        // instead of leaving a red provider error over valid retained rows.
        if (
          retained.has(key) &&
          normalized.failureCategory !== "credentials" &&
          normalized.attemptOutcome === undefined
        ) {
          return { ...normalized, attemptOutcome: "transient" as const };
        }
        return normalized;
      });
      merged.push({
        ...probe,
        result: {
          ...probe.result,
          errors: normalizedErrors,
          entries: [...entries.values()].flat(),
        },
        retainedSourceIds: new Set([...retained].filter((key): key is string => key !== UNSCOPED)),
        retainedUnscoped: retained.has(UNSCOPED),
      });
    }
    for (const provider of selected) {
      if (seen.has(provider.id)) continue;
      lastGoodProbes.delete(provider.id);
      dropped = true;
    }
    return { probes: merged, substituted: !anyFresh && (anyRetained || anyError || dropped) };
  }

  async function runQuotaCycle(refresh = false): Promise<QuotaSnapshot> {
    const nowMs = now();
    try {
      const config = await loadDashboardConfig();
      const allProviders = options.providers ?? getProviders();
      const selected = selectQuotaProviders(config, allProviders);
      const probes = await collect(config, nowMs, selected, refresh);
      const merged = mergeProviderResults(probes, selected);
      // OpenAI's observation timestamp is captured after its usage body is
      // consumed. Project and timestamp the completed collection together.
      const projectionNowMs = now();
      // No hidden-card id filters this list: hidden cards remain collected and
      // are hidden by the browser. Ordering is still applied to assembled cards.
      const cards = buildProviderCards({
        probes: merged.probes,
        preferences: cardPreferences(config),
        nowMs: projectionNowMs,
        providerLabel: options.providerLabel,
      });
      const snapshot: QuotaSnapshot = {
        generatedAtMs: nowMs,
        stale: merged.substituted,
        timeZone,
        providers: {
          cards,
          enabledProviders: config.enabledProviders,
          polledAtMs: projectionNowMs,
        },
      };
      const temporal = temporalStatusForCards(cards, nowMs);
      if (temporal) snapshot.temporal = temporal;
      // Genuine measurement identity per card, never part of the DTO: the
      // provider's own accounting time when supplied, else the fetch/cache
      // timestamp propagated through `fetchQuotaProviderResult`.
      const measuredAtByProvider = new Map<string, number>();
      for (const probe of probes) {
        const measuredAt = quotaResultMeasuredAtMs(probe.result);
        if (measuredAt !== undefined) measuredAtByProvider.set(probe.providerId, measuredAt);
      }
      const measuredAtByCard = new Map<string, number>();
      for (const card of cards) {
        const observedAtMs =
          card.observedAtIso === undefined ? undefined : Date.parse(card.observedAtIso);
        const measuredAt =
          observedAtMs !== undefined && Number.isFinite(observedAtMs)
            ? observedAtMs
            : measuredAtByProvider.get(card.providerId);
        if (measuredAt !== undefined) measuredAtByCard.set(card.cardId, measuredAt);
      }
      const configuredInterval = config.minIntervalMs;
      markQuotaObservationCycle(snapshot, {
        measuredAtByCard,
        intervalMs:
          typeof configuredInterval === "number" &&
          Number.isFinite(configuredInterval) &&
          configuredInterval > 0
            ? configuredInterval
            : DEFAULT_POLL_INTERVAL_MS,
        providerIds: selected.map((provider) => provider.id),
      });
      lastQuotaSnapshot = snapshot;
      return markQuotaObservationLive(snapshot);
    } catch (error) {
      if (lastQuotaSnapshot) {
        return {
          ...lastQuotaSnapshot,
          generatedAtMs: nowMs,
          stale: true,
          temporal: undefined,
          providers: { ...lastQuotaSnapshot.providers, cards: [] },
        };
      }
      throw error;
    }
  }

  let quotaRefresh: Promise<QuotaSnapshot> | undefined;
  function quota(input?: { refresh?: boolean }): Promise<QuotaSnapshot> {
    if (input?.refresh) {
      if (quotaRefresh) return quotaRefresh;
      const refresh = (async () => {
        await quotaCycle?.catch(() => undefined);
        return runQuotaCycle(true);
      })();
      quotaRefresh = refresh;
      void refresh
        .finally(() => {
          if (quotaRefresh === refresh) quotaRefresh = undefined;
        })
        .catch(() => undefined);
      return refresh;
    }
    // Every selected provider starts in one cycle; concurrent readers share it.
    if (quotaRefresh) return quotaRefresh;
    if (quotaCycle) return quotaCycle;
    const cycle = runQuotaCycle().finally(() => {
      if (quotaCycle === cycle) quotaCycle = undefined;
    });
    quotaCycle = cycle;
    return cycle;
  }

  // -------------------------------------------------------------------------
  // Read surface
  // -------------------------------------------------------------------------

  async function home(input: {
    range: RangeKey;
    exact?: boolean;
    background?: boolean;
  }): Promise<HomeSnapshot> {
    return (await getAnalyticsService()).home(input);
  }

  async function project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot> {
    try {
      return await (await getAnalyticsService()).project(input);
    } catch (error) {
      throw translateAnalyticsError(error);
    }
  }

  async function session(input: { sessionId: string }): Promise<SessionSnapshot> {
    try {
      return await (await getAnalyticsService()).session(input);
    } catch (error) {
      throw translateAnalyticsError(error);
    }
  }

  async function groups(query: AnalyticsGroupQuery): Promise<AnalyticsGroupSnapshot> {
    return (await getAnalyticsService()).groups(query);
  }

  async function refreshAnalytics(): Promise<void> {
    // A quota-only dashboard never loaded analytics, so never start the worker.
    if (!analyticsPromise) return;
    const service = await analyticsPromise;
    await service.refresh?.();
  }

  function subscribeAnalytics(listener: () => void): () => void {
    analyticsEventListeners.add(listener);
    // If the service is already loaded, re-attach idempotently; subscribing
    // alone must never create the worker or start analytics work.
    if (analyticsPromise) {
      void analyticsPromise.then(attachAnalyticsEvents, () => undefined);
    }
    return () => {
      analyticsEventListeners.delete(listener);
      if (analyticsEventListeners.size === 0 && analyticsUnsubscribe) {
        analyticsUnsubscribe();
        analyticsUnsubscribe = undefined;
      }
    };
  }

  async function close(): Promise<void> {
    const pending = analyticsPromise;
    analyticsPromise = undefined;
    analyticsEventListeners.clear();
    if (analyticsUnsubscribe) {
      analyticsUnsubscribe();
      analyticsUnsubscribe = undefined;
    }
    if (!pending) return;
    const service = await pending.catch(() => undefined);
    await service?.close?.();
  }

  return { home, quota, project, session, groups, refreshAnalytics, subscribeAnalytics, close };
}
