/**
 * Production dashboard read source (design spec §5.1/§6; plan P3 step 8).
 *
 * Composes the finished P3 analytics (`createUsageAnalytics` over the P1 raw
 * readers), the P2/shared config loader, and the P1b unprojected provider
 * collector into `Pick<DashboardDataSource, "home" | "project" | "session">`.
 * There is no new database, network, or provider implementation here: every
 * dependency is a plain callback with a real default, so synthetic tests
 * inject data without credentials, SQLite, or provider queries.
 *
 * `settings()` and the write surface are P2's store, wired separately by the
 * P4 lifecycle factory.
 */
import type {
  DashboardDataSource,
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";
import { createLoadConfigMeta, loadConfig } from "../lib/config.js";
import type { QuotaProviderContext } from "../lib/entries.js";
import {
  readAllSessionsIndex,
  readCompactionMarkers,
  readCompletedAssistantRows,
  readProjectsIndex,
} from "../lib/opencode-storage.js";
import {
  collectQuotaDashboardProviderResults,
  type QuotaStatusLiveProbe,
} from "../lib/quota-render-data.js";
import type { QuotaToastConfig } from "../lib/types.js";
import {
  AnalyticsNotFoundError,
  createUsageAnalytics,
  type UsageAnalytics,
  type UsageAnalyticsDataset,
} from "./aggregation.js";
import { buildProviderCards, type ProviderCardPreferences } from "./provider-cards.js";

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

export interface DashboardReadSourceOptions {
  /** Plugin client, exactly the core provider-context contract the collector takes. */
  client: QuotaProviderContext["client"];
  workspaceRoot: string;
  /** Explicit global config dir; defaults to the loader's OPENCODE_CONFIG_DIR/XDG resolution. */
  configDir?: string;
  /** Clock for one snapshot read; defaults to `Date.now`. */
  now?: () => number;
  loadConfig?: () => Promise<QuotaToastConfig>;
  loadDataset?: () => Promise<UsageAnalyticsDataset>;
  collectProviderResults?: (input: {
    config: QuotaToastConfig;
    nowMs: number;
  }) => Promise<QuotaStatusLiveProbe[]>;
  createAnalytics?: (dataset: UsageAnalyticsDataset) => UsageAnalytics;
  providerLabel?: (providerId: string) => string;
}

export type DashboardReadSource = Pick<DashboardDataSource, "home" | "project" | "session">;

/** Maps the analytics not-found error; anything else propagates unchanged. */
function notFoundSourceError(error: AnalyticsNotFoundError): DashboardSourceError {
  return new DashboardSourceError(
    error.resource === "project" ? "project-not-found" : "session-not-found",
  );
}

export function createDashboardReadSource(
  options: DashboardReadSourceOptions,
): DashboardReadSource {
  const now = options.now ?? Date.now;
  const createAnalytics = options.createAnalytics ?? createUsageAnalytics;

  async function loadDataset(): Promise<UsageAnalyticsDataset> {
    if (options.loadDataset) return options.loadDataset();
    const [sessions, projects, messages, compactions] = await Promise.all([
      readAllSessionsIndex(),
      readProjectsIndex(),
      readCompletedAssistantRows(),
      readCompactionMarkers(),
    ]);
    return { sessions, projects, messages, compactions };
  }

  async function loadDashboardConfig(): Promise<QuotaToastConfig> {
    if (options.loadConfig) return options.loadConfig();
    return loadConfig(undefined, createLoadConfigMeta(), {
      configRootDir: options.workspaceRoot,
      globalConfigDir: options.configDir,
    });
  }

  async function collect(config: QuotaToastConfig, nowMs: number): Promise<QuotaStatusLiveProbe[]> {
    if (options.collectProviderResults) {
      return options.collectProviderResults({ config, nowMs });
    }
    // Unprojected, all-windows, `onlyCurrentModel` off (P1b seam).
    return collectQuotaDashboardProviderResults({
      client: options.client,
      config,
      workspaceRoot: options.workspaceRoot,
    });
  }

  async function home(input: { range: RangeKey }): Promise<HomeSnapshot> {
    const nowMs = now();
    const config = await loadDashboardConfig();
    const [dataset, probes] = await Promise.all([loadDataset(), collect(config, nowMs)]);
    const analytics = createAnalytics(dataset);
    const { usage, projects } = analytics.home(input.range, nowMs);

    // formatStyle/onlyCurrentModel never select rows: the collector is
    // unprojected and card mapping maps every emitted entry. Hidden lists are
    // presentation state handled by the UI.
    const preferences: ProviderCardPreferences = {
      accountingDetail: config.accountingDetail,
    };
    if (config.quotaProjection !== undefined) preferences.quotaProjection = config.quotaProjection;
    if (config.resetTimeDecimals !== undefined) {
      preferences.resetTimeDecimals = config.resetTimeDecimals;
    }
    if (config.resetTimeSpaced !== undefined) preferences.resetTimeSpaced = config.resetTimeSpaced;
    const cards = buildProviderCards({
      probes,
      preferences,
      nowMs,
      providerLabel: options.providerLabel,
    });

    return {
      generatedAtMs: nowMs,
      range: input.range,
      stale: false,
      providers: { cards, enabledProviders: config.enabledProviders, polledAtMs: nowMs },
      usage,
      projects,
    };
  }

  async function project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot> {
    const nowMs = now();
    const analytics = createAnalytics(await loadDataset());
    try {
      return analytics.project(input.projectId, input.range, nowMs);
    } catch (error) {
      if (error instanceof AnalyticsNotFoundError) throw notFoundSourceError(error);
      throw error;
    }
  }

  async function session(input: { sessionId: string }): Promise<SessionSnapshot> {
    const analytics = createAnalytics(await loadDataset());
    try {
      return analytics.session(input.sessionId);
    } catch (error) {
      if (error instanceof AnalyticsNotFoundError) throw notFoundSourceError(error);
      throw error;
    }
  }

  return { home, project, session };
}
