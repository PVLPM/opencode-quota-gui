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
 * - `quota` loads config, filters the configured enabled/visible provider set,
 *   and runs one existing `collectQuotaDashboardProviderResults` cycle over the
 *   selected providers (existing quota-state cache/cooldowns). Per-provider
 *   last-good results survive a slow/empty/error cycle.
 *
 * `loadDataset`/`createAnalytics`/`collectProviderResults` remain plain
 * callback seams for synthetic tests; production uses the analytics service
 * and the real provider collector.
 */
import type {
  DashboardDataSource,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";
import { createLoadConfigMeta, loadConfig } from "../lib/config.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  collectQuotaDashboardProviderResults,
  type QuotaStatusLiveProbe,
} from "../lib/quota-render-data.js";
import type { QuotaToastConfig } from "../lib/types.js";
import { getProviders } from "../providers/registry.js";
import {
  AnalyticsNotFoundError,
  createUsageAnalytics,
  type UsageAnalytics,
  type UsageAnalyticsDataset,
} from "./aggregation.js";
import { type AnalyticsReadService, createAnalyticsReadService } from "./analytics-service.js";
import {
  buildCardId,
  buildProviderScopeCardId,
  hashQuotaCardIdentity,
  PROVIDER_SCOPE_IDENTITY_KEY,
} from "./identity.js";
import {
  buildProviderCards,
  openAiOptionalVisibilityRows,
  type ProviderCardPreferences,
} from "./provider-cards.js";
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
  "home" | "quota" | "project" | "session"
> & {
  /** One shared analytics refresh per transport tick, if the service loaded. */
  refreshAnalytics?(): Promise<void>;
  /** Worker background-generation notifications (lazy; never starts analytics). */
  subscribeAnalytics?(listener: () => void): () => void;
  /** Final server dispose / bind-failure cleanup; closes the analytics worker. */
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
 * request (analytics-api contract).
 */
function createDefaultAnalyticsService(): DashboardAnalyticsService {
  return createAnalyticsReadService();
}

/**
 * A successful measurement is at least one quota entry. Discovered account
 * descriptors alone (an error-only account list) are not a measurement.
 */
function hasMeasurements(probe: QuotaStatusLiveProbe): boolean {
  return probe.result.entries.length > 0;
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
 * A provider is hidden before probing only by a provider-level id: its plain
 * id, its provider-scope card id, or the bare provider-scope hash. Account-level
 * card ids/hashes and hidden rows never remove the whole provider from the
 * probe set.
 */
function isProviderHidden(providerId: string, hiddenCards: readonly string[]): boolean {
  if (hiddenCards.length === 0) return false;
  if (hiddenCards.includes(providerId)) return true;
  if (hiddenCards.includes(buildProviderScopeCardId(providerId))) return true;
  const bareScopeHash = hashQuotaCardIdentity(providerId, PROVIDER_SCOPE_IDENTITY_KEY);
  return hiddenCards.includes(bareScopeHash);
}

/**
 * Host-side Resets visibility for one OpenAI account. It mirrors the same
 * hashed card id and stable row id the card projection emits, so a hidden
 * account/card/row suppresses the optional detail GET before it happens. The
 * callback never sees raw ids in the browser payload.
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
    const [resetsRow] = openAiOptionalVisibilityRows(cardId);
    return resetsRow !== undefined && !hiddenRows.has(resetsRow.rowId);
  };
}

/**
 * Configured enabled set and provider-level visibility, applied before any
 * `isAvailable`/`isDiscovered` probe. Account-level hidden entries are left for
 * the UI; they cannot be resolved to a provider without probing first.
 */
export function selectQuotaProviders(
  config: Pick<QuotaToastConfig, "enabledProviders" | "dashboard">,
  providers: readonly QuotaProvider[],
): QuotaProvider[] {
  const enabled = config.enabledProviders === "auto" ? undefined : new Set(config.enabledProviders);
  return providers.filter(
    (provider) =>
      (enabled === undefined || enabled.has(provider.id)) &&
      !isProviderHidden(provider.id, config.dashboard.hiddenCards),
  );
}

function cardPreferences(config: QuotaToastConfig): ProviderCardPreferences {
  const preferences: ProviderCardPreferences = {
    accountingDetail: config.accountingDetail,
    providerOrder: config.dashboard.providerOrder,
  };
  if (config.quotaProjection !== undefined) preferences.quotaProjection = config.quotaProjection;
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

    return {
      async home({ range }) {
        const analytics = createAnalytics(await loadDataset());
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
          return createAnalytics(await loadDataset()).project(projectId, range, now());
        } catch (error) {
          throw translateAnalyticsError(error);
        }
      },
      async session({ sessionId }) {
        try {
          return createAnalytics(await loadDataset()).session(sessionId);
        } catch (error) {
          throw translateAnalyticsError(error);
        }
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
        created = Promise.resolve(createDefaultAnalyticsService());
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
  const lastGoodProbes = new Map<string, QuotaStatusLiveProbe>();

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
      openaiResetDetailsVisible,
    });
  }

  interface MergedCycle {
    probes: QuotaStatusLiveProbe[];
    /** True when at least one provider served last-good rather than new data. */
    substituted: boolean;
  }

  /**
   * Merge one cycle with the per-provider last-good map (checkpoint review
   * finding 9):
   *
   * - New entries are the only successful measurement; refreshed accounts are
   *   taken from the measurement snapshot, never from a descriptor-only result.
   * - A provider without new measurements keeps its last-good entries/accounts
   *   but surfaces the *current* cycle's errors.
   * - A selected provider missing from the cycle (slow/unavailable probe) keeps
   *   its last-good probe.
   * - Any substitution is reported so the snapshot can be marked stale and the
   *   last successful poll timestamp is not advanced.
   */
  function mergeProviderResults(
    probes: readonly QuotaStatusLiveProbe[],
    selected: readonly QuotaProvider[],
  ): MergedCycle {
    const selectedIds = new Set(selected.map((provider) => provider.id));
    for (const providerId of lastGoodProbes.keys()) {
      if (!selectedIds.has(providerId)) lastGoodProbes.delete(providerId);
    }

    const merged: QuotaStatusLiveProbe[] = [];
    const seen = new Set<string>();
    let substituted = false;
    for (const probe of probes) {
      seen.add(probe.providerId);
      if (hasMeasurements(probe)) {
        lastGoodProbes.set(probe.providerId, probe);
        merged.push(probe);
        continue;
      }
      if (hasRevokedOpenCodeGoEntitlement(probe)) {
        // A revoked entitlement replaces the measurement instead of falling
        // back to it; the current result (possibly descriptor-only) is fresh.
        lastGoodProbes.delete(probe.providerId);
        merged.push(probe);
        continue;
      }
      const lastGood = lastGoodProbes.get(probe.providerId);
      if (!lastGood) {
        // Nothing was ever measured for this provider: expose the current
        // error/no-data result as-is.
        merged.push(probe);
        continue;
      }
      substituted = true;
      merged.push({
        providerId: probe.providerId,
        result: { ...lastGood.result, errors: probe.result.errors },
      });
    }
    for (const provider of selected) {
      if (seen.has(provider.id)) continue;
      const lastGood = lastGoodProbes.get(provider.id);
      if (!lastGood) continue;
      substituted = true;
      merged.push(lastGood);
    }
    return { probes: merged, substituted };
  }

  async function runQuotaCycle(): Promise<QuotaSnapshot> {
    const nowMs = now();
    try {
      const config = await loadDashboardConfig();
      const allProviders = options.providers ?? getProviders();
      const selected = selectQuotaProviders(config, allProviders);
      const probes = await collect(config, nowMs, selected);
      const merged = mergeProviderResults(probes, selected);
      const cards = buildProviderCards({
        probes: merged.probes,
        preferences: cardPreferences(config),
        nowMs,
        providerLabel: options.providerLabel,
      });
      // A substituted provider is cached data: mark the snapshot stale and do
      // not advance the successful poll timestamp (checkpoint review finding 9).
      const polledAtMs = merged.substituted
        ? (lastQuotaSnapshot?.providers.polledAtMs ?? nowMs)
        : nowMs;
      const snapshot: QuotaSnapshot = {
        generatedAtMs: nowMs,
        stale: merged.substituted,
        timeZone,
        providers: {
          cards,
          enabledProviders: config.enabledProviders,
          polledAtMs,
        },
      };
      lastQuotaSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (lastQuotaSnapshot) {
        return { ...lastQuotaSnapshot, generatedAtMs: nowMs, stale: true };
      }
      throw error;
    }
  }

  function quota(): Promise<QuotaSnapshot> {
    // Every selected provider starts in one cycle; concurrent readers share it.
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

  async function home(input: { range: RangeKey }): Promise<HomeSnapshot> {
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

  return { home, quota, project, session, refreshAnalytics, subscribeAnalytics, close };
}
