/**
 * `waitForQuotaReset` (on by default): when a model request hits a provider limit and the quota data
 * shows a used-up window for that model's provider, OpenCode retries once that window resets
 * instead of following its normal retry timing.
 *
 * `autoResumeOnQuotaRecovery` reuses the same window walk and probe: after a terminal quota failure
 * it waits for the failed route's verified identity to recover, then sends one continuation prompt.
 */
import { isPercentEntry, type QuotaPercentEntry, type QuotaProviderResult } from "./entries.js";
import { readCredentialRows } from "./opencode-auth.js";
import {
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRegistration,
} from "./provider-metadata.js";
import { collectQuotaRenderData, type QuotaStatusLiveProbe } from "./quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { QuotaSurfaceHost } from "./quota-surface-data.js";
import type { QuotaToastConfig } from "./types.js";

/** Extra wait after the reset time, so the provider has reset the window when the retry runs. */
export const QUOTA_RESET_RETRY_BUFFER_MS = 60_000;
/** Longest wait for a reset; the buffer is added after this cap so a retry never lands just before it. */
export const QUOTA_RESET_RETRY_MAX_DELAY_MS = 5 * 60 * 60 * 1000;

/** The parts of OpenCode's retry event this feature reads. */
export type QuotaRetryEvent = {
  readonly model: { readonly id: string; readonly providerID: string };
  readonly error: {
    readonly type: string;
    readonly status?: number;
    /** The provider asked to wait at least this long before the next request. */
    readonly retryAfterMs?: number;
  };
};

/**
 * OpenCode's error types for a provider limit, a used-up quota or a spent budget, or any HTTP 429.
 * A match only forces an early retry when a used-up window with a known reset is observed below.
 */
const QUOTA_LIMIT_ERROR_TYPES: ReadonlySet<string> = new Set([
  "provider.rate-limit",
  "provider.quota",
  "provider.free-limit",
  "provider.budget-limit",
  "provider.model-budget-limit",
  "provider.go-limit",
  "provider.chatgpt-limit",
  "provider.chatgpt-workspace-limit",
]);

export function isQuotaLimitError(error: QuotaRetryEvent["error"]): boolean {
  return QUOTA_LIMIT_ERROR_TYPES.has(error.type) || error.status === 429;
}

/** A percent row observed for the verified binding. */
type QuotaPercentWindow = {
  /** Stable row identity from `semantic` or `rowKey`; absent when the row has neither. */
  key?: string;
  percentRemaining: number;
  resetMs?: number;
};

/**
 * The verified identity every collected window belongs to. Auto-resume requires one; the row
 * walk for `waitForQuotaReset` can run without it.
 */
export type QuotaWindowBinding =
  | {
      /** An OpenCode credential row, matched against entry/result account ids. */
      readonly kind: "account";
      readonly sourceId: string;
    }
  | {
      /**
       * A provider-level identity from the provider cache scope. Only used for single-source
       * routes whose adapter result exposes no account ids of its own.
       */
      readonly kind: "provider-scope";
      readonly providerId: string;
      readonly scope: string;
    };

/** The percent rows of the active identity. */
export type QuotaWindowCollection = {
  /** The identity these rows belong to; absent when the observation is not attributable. */
  binding?: QuotaWindowBinding;
  windows: QuotaPercentWindow[];
};

export type QuotaWindowCollectionOptions = {
  /**
   * Auto-resume evidence only: require a verified binding and keep only primary provider route
   * windows. Supplementary, budget, value, named, code-review and MCP rows do not govern a failed
   * model request and are excluded.
   */
  primaryAccountOnly?: boolean;
};

const NON_ROUTE_WINDOW_KINDS: ReadonlySet<string> = new Set(["code_review", "mcp"]);

/** A primary quota/rate-limit window that can govern the model route that failed. */
function isPrimaryRouteWindow(entry: QuotaPercentEntry): boolean {
  const semantic = entry.semantic;
  if (!semantic || semantic.prominence !== "primary") return false;
  if (semantic.metric.kind !== "window") return false;
  if (NON_ROUTE_WINDOW_KINDS.has(semantic.metric.window)) return false;
  return entry.accounting.resultType === "quota" || entry.accounting.resultType === "rate_limit";
}

/** A provider result with no account identity of its own: exactly one source by construction. */
function hasNoAccountIdentity(result: QuotaProviderResult): boolean {
  return (
    (result.accounts === undefined || result.accounts.length === 0) &&
    result.entries.every((entry) => entry.accounting.sourceId === undefined)
  );
}

/** The row belongs to the known active account, directly or through a single result account. */
function isBoundToActiveAccount(
  result: QuotaProviderResult,
  entry: QuotaPercentEntry,
  activeSourceId: string,
): boolean {
  if (entry.accounting.sourceId !== undefined) {
    return entry.accounting.sourceId === activeSourceId;
  }
  const accounts = result.accounts;
  return accounts?.length === 1 && accounts[0]?.sourceId === activeSourceId;
}

export function sameQuotaWindowBinding(
  left: QuotaWindowBinding | undefined,
  right: QuotaWindowBinding | undefined,
): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  if (left.kind === "account") {
    return right.kind === "account" && left.sourceId === right.sourceId;
  }
  return (
    right.kind === "provider-scope" &&
    left.providerId === right.providerId &&
    left.scope === right.scope
  );
}

/** The row identity the Provider field contract allows: typed semantics or an explicit rowKey. */
function quotaWindowKey(entry: QuotaPercentEntry): string | undefined {
  if (entry.rowKey) return entry.rowKey;
  const metric = entry.semantic?.metric;
  if (!metric) return undefined;
  switch (metric.kind) {
    case "window":
      return `window:${metric.window}`;
    case "named":
      return `named:${metric.name}`;
    case "component":
      return `component:${metric.component}`;
    case "aggregate":
      return "aggregate";
  }
}

/**
 * Walks the percent rows for the verified binding. A window is exhausted when its percentage is
 * zero. `resetMs` is the parsed reset instant when the row carries one. A provider-scope binding
 * requires exactly one unaccounted provider result, so two sources can never be mixed.
 */
export function collectQuotaWindows(
  results: readonly QuotaProviderResult[],
  binding?: QuotaWindowBinding,
  options: QuotaWindowCollectionOptions = {},
): QuotaWindowCollection | undefined {
  const providerScope = binding?.kind === "provider-scope" ? binding : undefined;
  if (providerScope !== undefined && results.length !== 1) return undefined;
  const sources = new Set(
    results.flatMap((result) => [
      ...result.entries.flatMap((entry) =>
        entry.accounting.sourceId ? [entry.accounting.sourceId] : [],
      ),
      ...(result.accounts?.map((account) => account.sourceId) ?? []),
    ]),
  );
  const marked = new Set(
    results.flatMap(
      (result) =>
        result.accounts?.filter((account) => account.active).map((account) => account.sourceId) ??
        [],
    ),
  );
  const active =
    binding?.kind === "account" ? binding.sourceId : marked.size === 1 ? [...marked][0] : undefined;
  // Auto-resume has no safe account to bind a failure or a recovery to.
  if (options.primaryAccountOnly && providerScope === undefined && active === undefined) {
    return undefined;
  }
  if (providerScope === undefined) {
    // Several accounts and no known active one: leave the host decision as is.
    if (sources.size > 1 && !active) return undefined;
    if (active && sources.size > 0 && !sources.has(active)) return undefined;
  }
  const windows: QuotaPercentWindow[] = [];
  for (const result of results) {
    if (!result.attempted) return undefined;
    if (providerScope !== undefined) {
      if (result.errors.length > 0 || !hasNoAccountIdentity(result)) return undefined;
    } else if (
      result.errors.some((error) => !active || !error.sourceId || error.sourceId === active)
    ) {
      return undefined;
    }
    for (const entry of result.entries) {
      if (providerScope === undefined) {
        if (sources.size > 1 && !entry.accounting.sourceId) return undefined;
        if (active && entry.accounting.sourceId && entry.accounting.sourceId !== active) continue;
      }
      if (!isPercentEntry(entry)) continue;
      if (!Number.isFinite(entry.percentRemaining)) return undefined;
      if (options.primaryAccountOnly) {
        if (!isPrimaryRouteWindow(entry)) continue;
        if (
          providerScope === undefined &&
          (!active || !isBoundToActiveAccount(result, entry, active))
        ) {
          continue;
        }
      }
      const key = quotaWindowKey(entry);
      const resetMs = entry.resetTimeIso ? Date.parse(entry.resetTimeIso) : undefined;
      windows.push({
        ...(key !== undefined ? { key } : {}),
        percentRemaining: entry.percentRemaining,
        ...(resetMs !== undefined && Number.isFinite(resetMs) ? { resetMs } : {}),
      });
    }
  }
  const resolvedBinding: QuotaWindowBinding | undefined =
    providerScope ?? (active !== undefined ? { kind: "account", sourceId: active } : undefined);
  return {
    ...(resolvedBinding !== undefined ? { binding: resolvedBinding } : {}),
    windows,
  };
}

/**
 * Milliseconds until all used-up windows have reset, plus the buffer, with the reset wait at most
 * the cap. The buffer is added after the cap so the retry never lands just before a reset.
 */
export function getQuotaResetRetryDelayMs(
  results: readonly QuotaProviderResult[],
  nowMs: number,
  activeSourceId?: string,
): number | undefined {
  const collected = collectQuotaWindows(
    results,
    activeSourceId !== undefined ? { kind: "account", sourceId: activeSourceId } : undefined,
  );
  if (!collected) return undefined;
  let latestResetMs: number | undefined;
  for (const entry of collected.windows) {
    if (entry.percentRemaining > 0) continue;
    if (entry.resetMs === undefined || !(entry.resetMs > nowMs)) return undefined;
    if (latestResetMs === undefined || entry.resetMs > latestResetMs) latestResetMs = entry.resetMs;
  }
  if (latestResetMs === undefined) return undefined;
  return (
    Math.min(latestResetMs - nowMs, QUOTA_RESET_RETRY_MAX_DELAY_MS) + QUOTA_RESET_RETRY_BUFFER_MS
  );
}

/**
 * Picks the verified identity for auto-resume evidence. A single-source route uses the provider
 * cache scope of its unaccounted result (the Claude CLI login, one API key); everything else
 * needs an active OpenCode credential row. Ambiguous or missing evidence yields undefined.
 */
export function resolveQuotaEvidenceBinding(params: {
  readonly modelProviderID: string;
  readonly providerResults: readonly QuotaStatusLiveProbe[];
  readonly activeSourceId?: string;
}): QuotaWindowBinding | undefined {
  const eligibleProviderIds: ReadonlySet<string> = new Set(
    getQuotaProviderIdsForRuntimeId(params.modelProviderID).filter((providerId) => {
      return getQuotaProviderRegistration(providerId)?.autoResume !== undefined;
    }),
  );
  if (eligibleProviderIds.size === 0) return undefined;
  const routeResults = params.providerResults.filter((probe) =>
    eligibleProviderIds.has(probe.providerId),
  );
  const [routeResult] = routeResults;
  // A single-source adapter that exposes no account ids can only be bound by its cache scope.
  if (routeResults.length === 1 && routeResult && hasNoAccountIdentity(routeResult.result)) {
    const mode = getQuotaProviderRegistration(routeResult.providerId)?.autoResume;
    const singleSource = mode === "single-source" || mode === "account-or-single-source";
    if (singleSource) {
      return routeResult.cacheScope !== undefined
        ? {
            kind: "provider-scope",
            providerId: routeResult.providerId,
            scope: routeResult.cacheScope,
          }
        : undefined;
    }
  }
  return params.activeSourceId !== undefined
    ? { kind: "account", sourceId: params.activeSourceId }
    : undefined;
}

export type QuotaModelProbe = {
  config: QuotaToastConfig;
  providerResults: QuotaStatusLiveProbe[];
  /** The active OpenCode credential row, used by the reset-retry path. */
  activeSourceId?: string;
  /** Verified identity for auto-resume evidence. */
  binding?: QuotaWindowBinding;
};

/** Resolves after `promise` or `fallback` when the deadline passes first. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type QuotaModelProbeState =
  | { readonly state: "disabled" }
  | { readonly state: "unavailable" }
  | { readonly state: "probe"; readonly probe: QuotaModelProbe };

/**
 * One live quota probe for the model's provider, keeping "the feature is off" distinct from
 * "the evidence is temporarily unavailable". Native retry treats both as no delay; auto-resume
 * must keep polling the latter and stop immediately on the former.
 */
export async function probeQuotaForModelState(
  host: Pick<QuotaSurfaceHost, "client" | "roots">,
  model: { readonly id: string; readonly providerID: string },
  isEnabled: (config: QuotaToastConfig) => boolean,
  options: { includeProviderScope?: boolean } = {},
): Promise<QuotaModelProbeState> {
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    sessionMeta: { modelID: model.id, providerID: model.providerID },
  });
  if (!isEnabled(runtime.config)) return { state: "disabled" };
  const probed = await withTimeout(
    (async () => {
      const collected = await collectQuotaRenderData({
        client: runtime.client,
        resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
        // Only the provider of the model that hit the limit counts, whatever onlyCurrentModel says.
        config: {
          ...runtime.config,
          onlyCurrentModel: true,
          opencodeGoWindows: ["rolling", "weekly", "monthly"],
        },
        configMeta: runtime.configMeta,
        request: createQuotaRuntimeRequestContext(runtime),
        workspaceRoot: runtime.roots.workspaceRoot,
        surfaceExplicitProviderIssues: false,
        bypassProviderCache: true,
        includeProviderScope: options.includeProviderScope === true,
        providers: runtime.providers,
      });
      const rows = await readCredentialRows([model.providerID], { firstOnly: true });
      if (rows.some((row) => row.resolveError !== undefined)) return undefined;
      return {
        collected,
        activeSourceId: rows.find((row) => row.active)?.id,
      };
    })(),
    runtime.config.requestTimeoutMs,
  );
  if (!probed) return { state: "unavailable" };
  const binding = options.includeProviderScope
    ? resolveQuotaEvidenceBinding({
        modelProviderID: model.providerID,
        providerResults: probed.collected.providerResults,
        ...(probed.activeSourceId !== undefined ? { activeSourceId: probed.activeSourceId } : {}),
      })
    : undefined;
  // A provider-scope binding is only meaningful for its own provider result.
  const providerResults =
    binding?.kind === "provider-scope"
      ? probed.collected.providerResults.filter((entry) => entry.providerId === binding.providerId)
      : probed.collected.providerResults;
  return {
    state: "probe",
    probe: {
      config: runtime.config,
      providerResults,
      ...(probed.activeSourceId !== undefined ? { activeSourceId: probed.activeSourceId } : {}),
      ...(binding !== undefined ? { binding } : {}),
    },
  };
}

/** One live quota probe for the model's provider. `undefined` when disabled or unavailable. */
export async function probeQuotaForModel(
  ...args: Parameters<typeof probeQuotaForModelState>
): Promise<QuotaModelProbe | undefined> {
  const result = await probeQuotaForModelState(...args);
  return result.state === "probe" ? result.probe : undefined;
}

/**
 * The retry delay for a limit error on `event.model`, or undefined to keep OpenCode's decision.
 * Quota comes from the same provider refresh path as the sidebar and toasts, but skips the cache:
 * the limit error itself shows the quota changed, so the provider is asked once for fresh data.
 */
export async function resolveQuotaResetRetryDelayMs(
  host: Pick<QuotaSurfaceHost, "client" | "roots">,
  event: QuotaRetryEvent,
): Promise<number | undefined> {
  if (!isQuotaLimitError(event.error)) return undefined;
  const probe = await probeQuotaForModel(host, event.model, (config) => config.waitForQuotaReset);
  if (!probe) return undefined;
  const delay = getQuotaResetRetryDelayMs(
    probe.providerResults.map((entry) => entry.result),
    Date.now(),
    probe.activeSourceId,
  );
  if (delay === undefined) return undefined;
  // The provider's requested wait is a floor: never retry earlier than it asked.
  const retryAfterMs = event.error.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > delay
    ? retryAfterMs
    : delay;
}
