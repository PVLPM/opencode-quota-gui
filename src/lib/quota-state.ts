import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import type {
  QuotaProvider,
  QuotaProviderCacheContext,
  QuotaProviderContext,
  QuotaProviderResult,
} from "./entries.js";
import { QUOTA_FORCE_REFRESH } from "./entries.js";

export { QUOTA_FORCE_REFRESH } from "./entries.js";

import { getGuiPrivateCacheDir } from "./private-state-paths.js";
import { getQuotaProviderDisplayLabel, isLiveLocalUsageProviderId } from "./provider-metadata.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "./quota-providers.js";
import type { PersistedQuotaProviderCacheEntry } from "./quota-state-codec.js";
import {
  cloneQuotaProviderResult,
  decodePersistedQuotaProviderCacheEntry,
  encodePersistedQuotaProviderCacheEntry,
  normalizeQuotaProviderResult,
} from "./quota-state-codec.js";
import { updateQuotaTelemetrySnapshot } from "./quota-telemetry.js";
import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import { getPackageVersion } from "./version.js";

const QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK = "unknown";
const QUOTA_PROVIDER_CACHE_DIRNAME = "quota-provider-state";
const QUOTA_PROVIDER_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const inMemoryCache = new Map<string, PersistedQuotaProviderCacheEntry & { stale?: boolean }>();
const inFlightByKey = new Map<string, Promise<QuotaProviderResult>>();
const refreshByKey = new Map<string, Promise<QuotaProviderResult>>();
type ProcessLocalLatestEntry = { result: QuotaProviderResult; timestamp: number };
let processLocalLatestByRuntime = new WeakMap<
  object,
  WeakMap<QuotaProvider, Map<string, ProcessLocalLatestEntry>>
>();
let lastPruneAtMs = 0;

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
  options: {
    runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
    resolvedAuthIdentity?: ResolvedAuthIdentity;
  } = {},
): string {
  const cursorPlan = ctx.config.cursorPlan;
  const cursorIncludedApiUsd = ctx.config.cursorIncludedApiUsd ?? "";
  const cursorBillingCycleStartDay = ctx.config.cursorBillingCycleStartDay ?? "";
  const opencodeGoWindows = ctx.config.opencodeGoWindows?.join(",") ?? "";
  const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
  const currentModel = ctx.config.currentModel ?? "";
  const currentProviderID = ctx.config.currentProviderID ?? "";
  const anthropicBinaryPath = ctx.config.anthropicBinaryPath ?? "";
  const isAggregateCache =
    providerId === QUOTA_PROVIDERS_AGGREGATE_ID ||
    providerId.startsWith(`${QUOTA_PROVIDERS_AGGREGATE_ID}:`);
  const relevantQuotaProviders = isAggregateCache
    ? (ctx.config.quotaProviders ?? [])
    : (ctx.config.quotaProviders ?? []).filter((definition) => definition.id === providerId);
  const quotaProvidersIdentity =
    relevantQuotaProviders.length > 0
      ? `|quotaProviders=${JSON.stringify(["quota-providers-cache-v1", relevantQuotaProviders])}`
      : "";
  const resolvedAuthIdentity = options.resolvedAuthIdentity
    ? `|resolvedAuthIdentity=${options.resolvedAuthIdentity}`
    : "";
  const runtimeEligibleIdentity = isAggregateCache
    ? `|runtimeEligibleQuotaProviders=${JSON.stringify([
        "quota-providers-runtime-eligible-v1",
        options.runtimeEligibleQuotaProviders ?? [],
      ])}`
    : "";

  return `${providerId}${quotaProvidersIdentity}${runtimeEligibleIdentity}|anthropicBinaryPath=${anthropicBinaryPath}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}${resolvedAuthIdentity}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getGuiPrivateCacheDir(), QUOTA_PROVIDER_CACHE_DIRNAME);
}

function getQuotaProviderStateCacheLocator(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function getQuotaProviderCacheFileStem(providerId: string): string {
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    providerId !== "." &&
    providerId !== ".." &&
    /^[A-Za-z0-9._-]+$/u.test(providerId) &&
    !windowsReserved.test(providerId)
  ) {
    return providerId;
  }
  return `provider-${createHash("sha256").update(providerId).digest("hex")}`;
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  return join(
    getQuotaProviderCacheDir(),
    `${getQuotaProviderCacheFileStem(providerId)}-${getQuotaProviderStateCacheLocator(key)}.json`,
  );
}

async function getQuotaProviderCachePackageVersion(): Promise<string> {
  return (await getPackageVersion()) ?? QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK;
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // best-effort cleanup
  }
}

async function maybePrunePersistedQuotaProviderCache(now: number): Promise<void> {
  if (now - lastPruneAtMs < QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastPruneAtMs = now;
  const cacheDir = getQuotaProviderCacheDir();

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }

        const path = join(cacheDir, entry.name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > QUOTA_PROVIDER_CACHE_RETENTION_MS) {
            await safeRm(path);
          }
        } catch {
          // ignore unreadable files during best-effort pruning
        }
      }),
    );
  } catch {
    // missing/unreadable cache dir is non-fatal
  }
}

async function readPersistedQuotaProviderCacheEntry(params: {
  key: string;
  providerId: string;
  packageVersion: string;
  ttlMs: number;
  now: number;
  ignoreExpiry?: boolean;
}): Promise<PersistedQuotaProviderCacheEntry | null> {
  if (params.ttlMs <= 0 && !params.ignoreExpiry) {
    return null;
  }

  const path = getQuotaProviderStateCacheFilePath(params.providerId, params.key);
  const cacheLocator = getQuotaProviderStateCacheLocator(params.key);

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const decoded = decodePersistedQuotaProviderCacheEntry(parsed, {
      key: cacheLocator,
      providerId: params.providerId,
      packageVersion: params.packageVersion,
    });
    if (!decoded) {
      await safeRm(path);
      return null;
    }
    if (!params.ignoreExpiry && params.now - decoded.timestamp >= params.ttlMs) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

async function writePersistedQuotaProviderCacheEntry(
  entry: PersistedQuotaProviderCacheEntry,
  logicalKey: string,
): Promise<void> {
  try {
    await writeJsonAtomic(getQuotaProviderStateCacheFilePath(entry.providerId, logicalKey), entry, {
      trailingNewline: true,
    });
  } catch {
    // persistence failures should not break quota fetches
  }
}

async function fetchValidatedProviderResult(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  cacheContext?: QuotaProviderCacheContext,
): Promise<QuotaProviderResult> {
  const fetched = await provider.fetch(ctx, cacheContext);
  const normalized = normalizeQuotaProviderResult(fetched);
  if (normalized) return normalized;

  return {
    attempted: true,
    entries: [],
    errors: [
      {
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Invalid normalized provider result",
      },
    ],
  };
}

async function resolveRuntimeEligibleQuotaProviders(
  providerId: string,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderDefinition[] | null | undefined> {
  if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID) {
    return undefined;
  }

  try {
    const availableProviderIds = await ctx.resolveRuntimeProviderIds();
    return selectEligibleQuotaProviderDefinitions({
      definitions: ctx.config.quotaProviders ?? [],
      availableProviderIds,
      onlyCurrentModel: ctx.config.onlyCurrentModel,
      currentModel: ctx.config.currentModel,
      currentProviderID: ctx.config.currentProviderID,
    });
  } catch {
    return null;
  }
}

type ProviderCacheScope = { resolvedAuthIdentity?: ResolvedAuthIdentity } | null;

async function resolveProviderCacheScope(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  cacheContext: QuotaProviderCacheContext,
): Promise<ProviderCacheScope> {
  const policy = provider.cachePolicy;
  if (!policy || policy.kind === "uncached") return null;
  if (policy.kind === "account-neutral") return {};

  try {
    const resolvedAuthIdentity = await policy.resolveIdentity(ctx, cacheContext);
    return resolvedAuthIdentity ? { resolvedAuthIdentity } : null;
  } catch {
    return null;
  }
}

/** Private, opaque identity for server-side last-good matching; never a DTO field. */
export async function getQuotaProviderResultScope(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<string | undefined> {
  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    provider.id,
    ctx,
  );
  if (runtimeEligibleQuotaProviders === null) return undefined;
  const scope = await resolveProviderCacheScope(provider, ctx, { runtimeEligibleQuotaProviders });
  if (!scope) return undefined;
  return getQuotaProviderStateCacheLocator(
    buildQuotaProviderStateCacheKey(provider.id, ctx, {
      runtimeEligibleQuotaProviders,
      resolvedAuthIdentity: scope.resolvedAuthIdentity,
    }),
  );
}

async function isProviderCacheScopeCurrent(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  scope: Exclude<ProviderCacheScope, null>,
): Promise<boolean> {
  if (provider.cachePolicy?.kind === "account-neutral") return true;
  if (provider.cachePolicy?.kind !== "resolved-auth") return false;
  try {
    const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
      provider.id,
      ctx,
    );
    if (runtimeEligibleQuotaProviders === null) return false;
    return (
      (await provider.cachePolicy.resolveIdentity(
        { ...ctx, operationCache: undefined },
        { runtimeEligibleQuotaProviders },
      )) === scope.resolvedAuthIdentity
    );
  } catch {
    return false;
  }
}

function getProcessLocalRuntimeOwner(ctx: QuotaProviderContext): object | null {
  const owner = ctx.client;
  return owner && (typeof owner === "object" || typeof owner === "function") ? owner : null;
}

function buildProcessLocalRouteKey(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
}): string {
  return buildQuotaProviderStateCacheKey(params.provider.id, params.ctx, {
    runtimeEligibleQuotaProviders: params.runtimeEligibleQuotaProviders,
  });
}

function rememberProcessLocalLatest(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  result: QuotaProviderResult;
  runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
}): void {
  const owner = getProcessLocalRuntimeOwner(params.ctx);
  if (!owner) return;
  let runtime = processLocalLatestByRuntime.get(owner);
  if (!runtime) {
    runtime = new WeakMap();
    processLocalLatestByRuntime.set(owner, runtime);
  }
  let routes = runtime.get(params.provider);
  if (!routes) {
    routes = new Map();
    runtime.set(params.provider, routes);
  }
  routes.set(buildProcessLocalRouteKey(params), {
    result: cloneQuotaProviderResult(params.result),
    timestamp: Date.now(),
  });
}

function readProcessLocalLatest(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
}): CachedProviderRead {
  const owner = getProcessLocalRuntimeOwner(params.ctx);
  if (!owner) return { hit: false };
  const entry = processLocalLatestByRuntime
    .get(owner)
    ?.get(params.provider)
    ?.get(buildProcessLocalRouteKey(params));
  return entry
    ? { hit: true, result: cloneQuotaProviderResult(entry.result), timestamp: entry.timestamp }
    : { hit: false };
}

function publishQuotaTelemetry(params: {
  ctx: QuotaProviderContext;
  providerId: string;
  snapshotId: string;
  result: QuotaProviderResult;
  cacheTimestamp?: number;
}): void {
  if (!params.ctx.config.telemetryToken) return;
  const uncachedSnapshotId = `uncached:${params.providerId}`;
  const cachedSnapshotId = `cached:${params.providerId}`;
  const isUncached = params.snapshotId.startsWith("uncached:");
  updateQuotaTelemetrySnapshot({
    token: params.ctx.config.telemetryToken,
    snapshotId: isUncached ? uncachedSnapshotId : cachedSnapshotId,
    supersededSnapshotIds: [isUncached ? cachedSnapshotId : uncachedSnapshotId],
    providerId: params.providerId,
    result: params.result,
    ...(params.cacheTimestamp !== undefined ? { cacheTimestamp: params.cacheTimestamp } : {}),
  });
}

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
  forceRefresh?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ttlMs, bypassCache = false } = params;
  const ctx = params.forceRefresh
    ? { ...params.ctx, operationCache: new Map(params.ctx.operationCache) }
    : params.ctx;
  if (params.forceRefresh) ctx.operationCache!.set(QUOTA_FORCE_REFRESH, true);

  const fetchUncached = async (
    cacheContext: QuotaProviderCacheContext = {},
  ): Promise<QuotaProviderResult> => {
    const snapshot = await fetchValidatedProviderResult(provider, ctx, cacheContext);
    rememberProcessLocalLatest({
      provider,
      ctx,
      result: snapshot,
      runtimeEligibleQuotaProviders: cacheContext.runtimeEligibleQuotaProviders,
    });
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  };

  if (bypassCache && !isLiveLocalUsageProviderId(provider.id)) return fetchUncached();

  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    provider.id,
    ctx,
  );
  if (runtimeEligibleQuotaProviders === null) return fetchUncached();

  const cacheContext: QuotaProviderCacheContext = { runtimeEligibleQuotaProviders };
  const scope = await resolveProviderCacheScope(provider, ctx, cacheContext);
  if (!scope) return fetchUncached(cacheContext);

  const key = buildQuotaProviderStateCacheKey(provider.id, ctx, {
    runtimeEligibleQuotaProviders,
    resolvedAuthIdentity: scope.resolvedAuthIdentity,
  });

  if (params.forceRefresh && !isLiveLocalUsageProviderId(provider.id)) {
    const existing = refreshByKey.get(key);
    if (existing) return cloneQuotaProviderResult(await existing);
    const refresh = (async () => {
      // An earlier ordinary request is not a refresh; wait for it to settle
      // before retrying so its result cannot overwrite the newer measurement.
      await inFlightByKey.get(key)?.catch(() => undefined);
      return fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    })();
    refreshByKey.set(key, refresh);
    try {
      return cloneQuotaProviderResult(await refresh);
    } finally {
      if (refreshByKey.get(key) === refresh) refreshByKey.delete(key);
    }
  }

  if (isLiveLocalUsageProviderId(provider.id)) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx, cacheContext);
    if (!(await isProviderCacheScopeCurrent(provider, ctx, scope))) {
      return snapshot;
    }
    const entry = encodePersistedQuotaProviderCacheEntry({
      packageVersion: await getQuotaProviderCachePackageVersion(),
      key: getQuotaProviderStateCacheLocator(key),
      providerId: provider.id,
      timestamp: Date.now(),
      result: snapshot,
    });
    inMemoryCache.set(key, {
      ...entry,
      result: cloneQuotaProviderResult(entry.result),
    });
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: entry.timestamp,
    });
    return snapshot;
  }

  const forceAggregateRefresh =
    provider.id === QUOTA_PROVIDERS_AGGREGATE_ID &&
    runtimeEligibleQuotaProviders?.some((definition) => definition.mode === "local-estimate") ===
      true;
  const now = Date.now();
  const packageVersion = await getQuotaProviderCachePackageVersion();
  await maybePrunePersistedQuotaProviderCache(now);

  const inMemory = forceAggregateRefresh ? undefined : inMemoryCache.get(key);
  if (
    inMemory &&
    !inMemory.stale &&
    inMemory.packageVersion === packageVersion &&
    ttlMs > 0 &&
    now - inMemory.timestamp < ttlMs
  ) {
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
    return cloneQuotaProviderResult(inMemory.result);
  }

  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    const snapshot = await inFlight;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
  }

  const persisted = forceAggregateRefresh
    ? null
    : await readPersistedQuotaProviderCacheEntry({
        key,
        providerId: provider.id,
        packageVersion,
        ttlMs,
        now,
      });
  if (persisted) {
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
    });
    return cloneQuotaProviderResult(persisted.result);
  }

  const inFlightAfterDiskRead = inFlightByKey.get(key);
  if (inFlightAfterDiskRead) {
    const snapshot = await inFlightAfterDiskRead;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
  }

  const fetchPromise = (async () => {
    let snapshot: QuotaProviderResult;
    try {
      snapshot = await fetchValidatedProviderResult(provider, ctx, cacheContext);
    } catch (error) {
      if (ctx.operationCache?.get(QUOTA_FORCE_REFRESH) === true) {
        inMemoryCache.delete(key);
        await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      }
      throw error;
    }

    const rateLimited = snapshot.errors.filter((error) => error.retryAtMs !== undefined);
    const previous = inMemoryCache.get(key);
    if (
      rateLimited.length > 0 &&
      previous &&
      (await isProviderCacheScopeCurrent(provider, ctx, scope))
    ) {
      const failedAccounts = new Set(
        rateLimited.map((error) => error.sourceId).filter((id) => id !== undefined),
      );
      const fallback =
        snapshot.entries.length === 0 && rateLimited.some((error) => error.sourceId === undefined)
          ? provider.id === "openrouter"
            ? previous.result.entries.filter((entry) => entry.accounting.sourceId === undefined)
            : previous.result.entries
          : previous.result.entries.filter(
              (entry) =>
                entry.accounting.sourceId !== undefined &&
                failedAccounts.has(entry.accounting.sourceId),
            );
      if (fallback.length > 0) {
        const stale = { ...snapshot, entries: [...snapshot.entries, ...fallback] };
        inMemoryCache.set(key, {
          ...previous,
          stale: true,
          result: cloneQuotaProviderResult(stale),
        });
        await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
        return stale;
      }
    }

    if (
      !snapshot.attempted ||
      snapshot.entries.length === 0 ||
      !(await isProviderCacheScopeCurrent(provider, ctx, scope))
    ) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    const entry = encodePersistedQuotaProviderCacheEntry({
      packageVersion,
      key: getQuotaProviderStateCacheLocator(key),
      providerId: provider.id,
      timestamp: Date.now(),
      result: snapshot,
    });

    if (rateLimited.length > 0) {
      inMemoryCache.set(key, { ...entry, stale: true, result: cloneQuotaProviderResult(snapshot) });
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    inMemoryCache.set(key, {
      ...entry,
      result: cloneQuotaProviderResult(entry.result),
    });
    await writePersistedQuotaProviderCacheEntry(entry, key);
    return snapshot;
  })().finally(() => {
    inFlightByKey.delete(key);
  });

  inFlightByKey.set(key, fetchPromise);
  const snapshot = await fetchPromise;
  publishQuotaTelemetry({
    ctx,
    providerId: provider.id,
    snapshotId: key,
    result: snapshot,
    cacheTimestamp: inMemoryCache.get(key)?.timestamp,
  });
  return cloneQuotaProviderResult(snapshot);
}

export type CachedProviderRead =
  | { hit: true; result: QuotaProviderResult; timestamp: number }
  | { hit: false };

export async function readCachedProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
}): Promise<CachedProviderRead> {
  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    params.provider.id,
    params.ctx,
  );
  if (runtimeEligibleQuotaProviders === null) return { hit: false };
  if (runtimeEligibleQuotaProviders?.length === 0) return { hit: false };

  const cacheContext: QuotaProviderCacheContext = { runtimeEligibleQuotaProviders };
  const scope = await resolveProviderCacheScope(params.provider, params.ctx, cacheContext);
  if (!scope) {
    if (params.provider.cachePolicy?.kind === "resolved-auth") return { hit: false };
    return readProcessLocalLatest({
      provider: params.provider,
      ctx: params.ctx,
      runtimeEligibleQuotaProviders,
    });
  }

  const key = buildQuotaProviderStateCacheKey(params.provider.id, params.ctx, {
    runtimeEligibleQuotaProviders,
    resolvedAuthIdentity: scope.resolvedAuthIdentity,
  });
  const now = Date.now();

  const inMemory = inMemoryCache.get(key);
  if (inMemory) {
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
    return {
      hit: true,
      result: cloneQuotaProviderResult(inMemory.result),
      timestamp: inMemory.timestamp,
    };
  }

  const packageVersion = await getQuotaProviderCachePackageVersion();
  const persisted = await readPersistedQuotaProviderCacheEntry({
    key,
    providerId: params.provider.id,
    packageVersion,
    ttlMs: params.ttlMs,
    now,
    ignoreExpiry: true,
  });

  if (persisted) {
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
    });
    return {
      hit: true,
      result: cloneQuotaProviderResult(persisted.result),
      timestamp: persisted.timestamp,
    };
  }

  return { hit: false };
}

export function __resetQuotaStateForTests(): void {
  inMemoryCache.clear();
  inFlightByKey.clear();
  refreshByKey.clear();
  processLocalLatestByRuntime = new WeakMap();
  lastPruneAtMs = 0;
}
