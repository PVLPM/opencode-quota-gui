import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { fetchWithTimeout } from "./http.js";
import { getOpencodeRuntimeDirs, type OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getGuiPrivateCacheDir } from "./private-state-paths.js";
import type { PricingSnapshotSource } from "./types.js";

const SOURCE_URL = "https://models.dev/api.json";
const COST_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;
const RUNTIME_SNAPSHOT_FILENAME = "modelsdev-pricing.runtime.min.json";
const RUNTIME_REFRESH_STATE_FILENAME = "modelsdev-pricing.refresh-state.json";
const DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 6_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CostRates = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

/**
 * One models.dev context tier. `size` is the prompt/context token count at
 * which the tier starts; rates replace the base rates for that request.
 */
export type CostTier = CostRates & {
  tier: {
    type: "context";
    size: number;
  };
};

export type CostBuckets = CostRates & {
  /**
   * Explicit context tiers, ascending by `tier.size`. Present only when
   * models.dev publishes a supported tier; unsupported tier types are dropped.
   */
  tiers?: CostTier[];
};

/**
 * Authoritative model ids per provider from a successful models.dev response,
 * independent of whether a model had a usable cost. A provider missing from
 * this record has unknown catalog presence, not an empty catalog.
 */
export type PricingCatalog = Record<string, string[]>;

export type PricingSnapshot = {
  _meta: {
    source: string;
    generatedAt: number;
    providers: string[];
    units: string;
  };
  providers: Record<string, Record<string, CostBuckets>>;
  /**
   * Catalog presence from the last successful refresh. Runtime snapshots
   * persist it separately from priced entries so offline/304 reloads can tell
   * "retired" apart from "still listed but no longer priced".
   */
  catalog?: PricingCatalog;
};

export const DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type PricingSnapshotHealth = {
  generatedAt: number;
  ageMs: number;
  maxAgeMs: number;
  stale: boolean;
};

export interface PricingRefreshStateV1 {
  version: 1;
  updatedAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastResult?: "success" | "not_modified" | "skipped_fresh" | "skipped_throttled" | "failed";
  lastError?: string;
  etag?: string;
  lastModified?: string;
}

export interface PricingRefreshPolicy {
  enabled: boolean;
  maxAgeMs: number;
  minAttemptIntervalMs: number;
  timeoutMs: number;
}

export interface PricingRefreshOptions {
  reason?: "init" | "tokens" | "status" | "manual";
  force?: boolean;
  nowMs?: number;
  maxAgeMs?: number;
  minAttemptIntervalMs?: number;
  timeoutMs?: number;
  runtimeDirs?: OpencodeRuntimeDirs;
  fetchFn?: typeof fetch;
  bootstrapSnapshotOverride?: PricingSnapshot;
  /** Optional observed-provider scope; omitting refreshes every central provider. */
  providerAllowlist?: string[];
  snapshotSelection?: PricingSnapshotSource;
  allowRefreshWhenSelectionBundled?: boolean;
}

export interface PricingRefreshResult {
  attempted: boolean;
  updated: boolean;
  state: PricingRefreshStateV1;
  error?: string;
  reason?: string;
}

const EMPTY_SNAPSHOT: PricingSnapshot = {
  _meta: {
    source: "none",
    generatedAt: 0,
    providers: [],
    units: "USD per 1M tokens",
  },
  providers: {},
};

let SNAPSHOT: PricingSnapshot | null = null;
let SNAPSHOT_SOURCE: "runtime" | "bundled" | "empty" = "bundled";
let SNAPSHOT_SELECTION: PricingSnapshotSource = "auto";
let MODEL_INDEX: Map<string, string[]> | null = null;
let REFRESH_IN_FLIGHT: Promise<PricingRefreshResult> | null = null;
let PROCESS_REFRESH_CHECKED = false;
let CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function sortRecordByKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    out[key] = obj[key];
  }
  return out;
}

function sortCatalog(catalog: Readonly<Record<string, readonly string[]>>): PricingCatalog {
  const out: PricingCatalog = {};
  for (const providerID of Object.keys(catalog).sort((a, b) => a.localeCompare(b))) {
    const modelIDs = [...new Set(catalog[providerID])].sort((a, b) => a.localeCompare(b));
    out[providerID] = modelIDs;
  }
  return out;
}

function normalizeCatalog(raw: unknown): PricingCatalog | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;

  const catalog: Record<string, string[]> = {};
  for (const providerID of Object.keys(obj)) {
    const rawModelIDs = obj[providerID];
    if (!Array.isArray(rawModelIDs)) continue;
    catalog[providerID] = rawModelIDs.filter(
      (modelID): modelID is string => typeof modelID === "string" && modelID.length > 0,
    );
  }
  return sortCatalog(catalog);
}

function pricingSnapshotDaysToMs(days: number | undefined): number {
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    return DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  }
  return Math.floor(days * MS_PER_DAY);
}

export function getPricingRefreshPolicy(): PricingRefreshPolicy {
  return {
    enabled: true,
    maxAgeMs: CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS,
    minAttemptIntervalMs: DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS,
    timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
  };
}

export function setPricingSnapshotAutoRefresh(days: number): void {
  CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = pricingSnapshotDaysToMs(days);
}

function normalizeSnapshot(raw: unknown): PricingSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;

  const metaRaw = asRecord(root._meta);
  const providersRaw = asRecord(root.providers);
  if (!metaRaw || !providersRaw) return null;

  const generatedAt = Number(metaRaw.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return null;

  const providers: Record<string, Record<string, CostBuckets>> = {};

  for (const providerId of Object.keys(providersRaw)) {
    const modelsRaw = asRecord(providersRaw[providerId]);
    if (!modelsRaw) continue;

    const models: Record<string, CostBuckets> = {};
    for (const modelId of Object.keys(modelsRaw)) {
      const buckets = pickCostBuckets(modelsRaw[modelId]);
      if (buckets) {
        models[modelId] = buckets;
      }
    }

    if (Object.keys(models).length > 0) {
      providers[providerId] = sortRecordByKeys(models);
    }
  }

  const providerList = Object.keys(providers).sort((a, b) => a.localeCompare(b));
  const catalog = normalizeCatalog(root.catalog);

  return {
    ...(catalog ? { catalog } : {}),
    _meta: {
      source: typeof metaRaw.source === "string" && metaRaw.source ? metaRaw.source : SOURCE_URL,
      generatedAt: Math.trunc(generatedAt),
      providers: providerList,
      units:
        typeof metaRaw.units === "string" && metaRaw.units ? metaRaw.units : "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  };
}

function loadBundledSnapshotSync(override?: PricingSnapshot): PricingSnapshot {
  if (override) {
    return normalizeSnapshot(override) ?? EMPTY_SNAPSHOT;
  }

  try {
    const url = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
    const raw = readFileSync(url, "utf-8");
    return normalizeSnapshot(JSON.parse(raw)) ?? EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

export function getRuntimePricingSnapshotPath(runtimeDirs?: OpencodeRuntimeDirs): string {
  return join(
    getGuiPrivateCacheDir(runtimeDirs ?? getOpencodeRuntimeDirs()),
    RUNTIME_SNAPSHOT_FILENAME,
  );
}

export function getRuntimePricingRefreshStatePath(runtimeDirs?: OpencodeRuntimeDirs): string {
  return join(
    getGuiPrivateCacheDir(runtimeDirs ?? getOpencodeRuntimeDirs()),
    RUNTIME_REFRESH_STATE_FILENAME,
  );
}

function loadRuntimeSnapshotSync(runtimeDirs?: OpencodeRuntimeDirs): PricingSnapshot | null {
  const path = getRuntimePricingSnapshotPath(runtimeDirs);
  try {
    const raw = readFileSync(path, "utf-8");
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function hasSnapshotData(snapshot: PricingSnapshot): boolean {
  return snapshot._meta.generatedAt > 0;
}

function countCatalogModels(snapshot: PricingSnapshot | null | undefined): number {
  if (!snapshot?.catalog) return 0;
  let total = 0;
  for (const modelIDs of Object.values(snapshot.catalog)) total += modelIDs.length;
  return total;
}

function hasAuthoritativeCatalog(snapshot: PricingSnapshot | null): boolean {
  return countCatalogModels(snapshot) > 0;
}

function unionProviderIDs(snapshots: Array<PricingSnapshot | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    for (const providerID of Object.keys(snapshot.providers)) ids.add(providerID);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// A runtime snapshot saved by an older version may lack providers or models
// that models.dev stopped listing. Fill them from the bundled file on every
// load, so a fresh runtime snapshot doesn't hide offline coverage until its
// next refresh.
function withBundledRetiredModels(
  runtime: PricingSnapshot,
  bundled: PricingSnapshot,
): PricingSnapshot {
  return keepRetiredModels({
    current: runtime,
    previous: [bundled],
    providerIDs: unionProviderIDs([runtime, bundled]),
    catalog: runtime.catalog,
  });
}

function chooseSnapshot(params?: {
  runtimeDirs?: OpencodeRuntimeDirs;
  bootstrapSnapshotOverride?: PricingSnapshot;
  selection?: PricingSnapshotSource;
}): { snapshot: PricingSnapshot; source: "runtime" | "bundled" | "empty" } {
  const bundled = loadBundledSnapshotSync(params?.bootstrapSnapshotOverride);
  const runtime = loadRuntimeSnapshotSync(params?.runtimeDirs);
  const selection = params?.selection ?? SNAPSHOT_SELECTION;

  if (selection === "bundled") {
    if (hasSnapshotData(bundled)) {
      return { snapshot: bundled, source: "bundled" };
    }
    return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
  }

  if (selection === "runtime") {
    if (runtime) {
      return { snapshot: withBundledRetiredModels(runtime, bundled), source: "runtime" };
    }
    if (hasSnapshotData(bundled)) {
      return { snapshot: bundled, source: "bundled" };
    }
    return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
  }

  if (runtime && runtime._meta.generatedAt >= bundled._meta.generatedAt) {
    return { snapshot: withBundledRetiredModels(runtime, bundled), source: "runtime" };
  }

  if (hasSnapshotData(bundled)) {
    return { snapshot: bundled, source: "bundled" };
  }

  return { snapshot: EMPTY_SNAPSHOT, source: "empty" };
}

function setSnapshot(snapshot: PricingSnapshot, source: "runtime" | "bundled" | "empty"): void {
  SNAPSHOT = snapshot;
  SNAPSHOT_SOURCE = source;
  MODEL_INDEX = null;
}

function applySnapshotSelection(params?: {
  runtimeDirs?: OpencodeRuntimeDirs;
  bootstrapSnapshotOverride?: PricingSnapshot;
  selection?: PricingSnapshotSource;
}): { snapshot: PricingSnapshot; source: "runtime" | "bundled" | "empty" } {
  const selected = chooseSnapshot(params);
  setSnapshot(selected.snapshot, selected.source);
  return selected;
}

function ensureLoaded(): PricingSnapshot {
  if (SNAPSHOT) return SNAPSHOT;
  const selected = applySnapshotSelection();
  return selected.snapshot;
}

function ensureModelIndex(): Map<string, string[]> {
  if (MODEL_INDEX) return MODEL_INDEX;
  const snap = ensureLoaded();
  const idx = new Map<string, string[]>();

  for (const providerId of Object.keys(snap.providers)) {
    const models = snap.providers[providerId] ?? {};
    for (const modelId of Object.keys(models)) {
      const existing = idx.get(modelId);
      if (existing) existing.push(providerId);
      else idx.set(modelId, [providerId]);
    }
  }

  MODEL_INDEX = idx;
  return idx;
}

function normalizeRefreshState(raw: unknown): PricingRefreshStateV1 | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const version = Number(obj.version);
  const updatedAt = Number(obj.updatedAt);
  if (version !== 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;

  const out: PricingRefreshStateV1 = {
    version: 1,
    updatedAt: Math.trunc(updatedAt),
  };

  const lastAttemptAt = Number(obj.lastAttemptAt);
  const lastSuccessAt = Number(obj.lastSuccessAt);
  const lastFailureAt = Number(obj.lastFailureAt);

  if (Number.isFinite(lastAttemptAt) && lastAttemptAt > 0)
    out.lastAttemptAt = Math.trunc(lastAttemptAt);
  if (Number.isFinite(lastSuccessAt) && lastSuccessAt > 0)
    out.lastSuccessAt = Math.trunc(lastSuccessAt);
  if (Number.isFinite(lastFailureAt) && lastFailureAt > 0)
    out.lastFailureAt = Math.trunc(lastFailureAt);

  if (typeof obj.lastResult === "string") {
    const allowed = new Set([
      "success",
      "not_modified",
      "skipped_fresh",
      "skipped_throttled",
      "failed",
    ]);
    if (allowed.has(obj.lastResult)) {
      out.lastResult = obj.lastResult as PricingRefreshStateV1["lastResult"];
    }
  }

  if (typeof obj.lastError === "string" && obj.lastError) out.lastError = obj.lastError;
  if (typeof obj.etag === "string" && obj.etag) out.etag = obj.etag;
  if (typeof obj.lastModified === "string" && obj.lastModified) out.lastModified = obj.lastModified;

  return out;
}

async function readRefreshState(path: string): Promise<PricingRefreshStateV1 | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeRefreshState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readPricingRefreshState(
  runtimeDirs?: OpencodeRuntimeDirs,
): Promise<PricingRefreshStateV1 | null> {
  return await readRefreshState(getRuntimePricingRefreshStatePath(runtimeDirs));
}

function makeDefaultRefreshState(nowMs: number): PricingRefreshStateV1 {
  return {
    version: 1,
    updatedAt: nowMs,
  };
}

function pickRateBuckets(rawCost: unknown): CostRates | null {
  const obj = asRecord(rawCost);
  if (!obj) return null;

  const picked: CostRates = {};
  for (const key of COST_KEYS) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[key] = value;
    }
  }

  return Object.keys(picked).length > 0 ? picked : null;
}

/**
 * Keep only explicit context tiers this code can apply. Unknown tier types,
 * non-positive sizes, and tiers without numeric input/output are dropped
 * rather than being presented as an exact published rate.
 */
function pickCostTiers(rawCost: unknown): CostTier[] | undefined {
  const obj = asRecord(rawCost);
  if (!Array.isArray(obj?.tiers)) return undefined;

  const tiers: CostTier[] = [];
  for (const rawTier of obj.tiers) {
    const tierNode = asRecord(rawTier);
    const tierMeta = asRecord(tierNode?.tier);
    if (!tierMeta || tierMeta.type !== "context") continue;

    const size = Number(tierMeta.size);
    if (!Number.isFinite(size) || size <= 0) continue;

    const rates = pickRateBuckets(tierNode);
    if (typeof rates?.input !== "number" || typeof rates.output !== "number") continue;

    tiers.push({
      ...rates,
      tier: { type: "context", size: Math.trunc(size) },
    });
  }

  if (tiers.length === 0) return undefined;

  // Deterministic regardless of upstream array order, then one tier per size.
  tiers.sort(
    (a, b) => a.tier.size - b.tier.size || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );

  const unique: CostTier[] = [];
  const sizes = new Set<number>();
  for (const tier of tiers) {
    if (sizes.has(tier.tier.size)) continue;
    sizes.add(tier.tier.size);
    unique.push(tier);
  }
  return unique;
}

function pickCostBuckets(rawCost: unknown): CostBuckets | null {
  const rates = pickRateBuckets(rawCost);
  if (!rates) return null;

  const tiers = pickCostTiers(rawCost);
  return tiers ? { ...rates, tiers } : rates;
}

function buildSnapshotFromApi(
  apiRaw: unknown,
  providerIDs: readonly string[] | undefined,
  generatedAt: number,
): PricingSnapshot {
  const api = asRecord(apiRaw) ?? {};
  const apiProviderIDs = Object.keys(api).sort((a, b) => a.localeCompare(b));
  const scopedProviderIDs = (providerIDs ?? apiProviderIDs)
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const providers: Record<string, Record<string, CostBuckets>> = {};
  const catalog: PricingCatalog = {};

  // Catalog presence is authoritative only for the providers this refresh
  // actually replaced. Providers outside the scope stay catalog-unknown so
  // their prior or bundled prices remain restorable.
  for (const providerID of scopedProviderIDs) {
    const providerNode = asRecord(api[providerID]);
    const models = asRecord(providerNode?.models);
    if (!models) continue;

    catalog[providerID] = Object.keys(models);

    const pricedModels: Record<string, CostBuckets> = {};
    for (const modelID of Object.keys(models)) {
      const modelNode = asRecord(models[modelID]);
      const cost = pickCostBuckets(modelNode?.cost);
      if (cost) {
        pricedModels[modelID] = cost;
      }
    }

    if (Object.keys(pricedModels).length > 0) {
      providers[providerID] = sortRecordByKeys(pricedModels);
    }
  }

  const providerList = Object.keys(providers).sort((a, b) => a.localeCompare(b));

  return {
    catalog: sortCatalog(catalog),
    _meta: {
      generatedAt,
      providers: providerList,
      source: SOURCE_URL,
      units: "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  };
}

/**
 * models.dev drops retired models from its list. Keep their last known price so
 * older usage still gets a cost. `current` wins, then `previous` in the order given.
 * Callers list the user's runtime snapshot before the bundled one: its prices come
 * from the user's own last download, while the bundled file's date only says when
 * the file was rewritten, not when a kept model's price was last seen.
 *
 * `catalog` is the authoritative model presence from the API response. A model
 * that is present in the catalog but has no priced entry in `current` was
 * delisted from pricing and must not be restored from `previous`. Providers
 * missing from `catalog` are unknown (for example a scoped refresh or a 304),
 * so their historical models are still kept.
 */
function keepRetiredModels(params: {
  current: PricingSnapshot;
  previous: Array<PricingSnapshot | null>;
  providerIDs: readonly string[];
  catalog?: Readonly<Record<string, readonly string[]>>;
}): PricingSnapshot {
  const previous = params.previous.filter(
    (snapshot): snapshot is PricingSnapshot => snapshot !== null,
  );
  const catalog = params.catalog ?? params.current.catalog;
  const catalogByProvider = catalog
    ? new Map(
        Object.entries(catalog).map(([providerID, modelIDs]) => [providerID, new Set(modelIDs)]),
      )
    : null;
  const providers = { ...params.current.providers };

  for (const providerID of params.providerIDs) {
    const models = { ...(providers[providerID] ?? {}) };
    const presentModelIDs = catalogByProvider?.get(providerID);
    for (const snapshot of previous) {
      for (const [modelID, cost] of Object.entries(snapshot.providers[providerID] ?? {})) {
        if (models[modelID] || presentModelIDs?.has(modelID)) continue;
        models[modelID] = cost;
      }
    }
    if (Object.keys(models).length > 0) {
      providers[providerID] = sortRecordByKeys(models);
    }
  }

  const sortedProviders = sortRecordByKeys(providers);
  return {
    ...(catalog ? { catalog: sortCatalog(catalog) } : {}),
    _meta: { ...params.current._meta, providers: Object.keys(sortedProviders) },
    providers: sortedProviders,
  };
}

function countPricedModels(snapshot: PricingSnapshot): number {
  let total = 0;
  for (const models of Object.values(snapshot.providers)) {
    total += Object.keys(models).length;
  }
  return total;
}

/**
 * A scoped refresh only replaces catalog presence for the providers it
 * fetched. Providers outside the scope keep their prior authoritative catalog;
 * dropping it would make a known present-but-unpriced model catalog-unknown,
 * letting `keepRetiredModels` restore its stale bundled price.
 */
function mergeScopedCatalog(params: {
  previous: PricingCatalog | undefined;
  fetched: PricingCatalog;
  scoped: boolean;
}): PricingCatalog {
  if (!params.scoped || !params.previous) return params.fetched;
  return sortCatalog({ ...params.previous, ...params.fetched });
}

/**
 * Prices for providers that were not actually replaced by this response stay
 * in the starting snapshot. `keepRetiredModels` then only uses the merged
 * catalog to block stale bundled prices for models the prior catalog already
 * marked present-but-unpriced.
 */
function retainPriorPricesForUnrefreshedProviders(params: {
  current: PricingSnapshot;
  previous: PricingSnapshot | null;
  replacedProviderIDs: ReadonlySet<string>;
}): PricingSnapshot {
  if (!params.previous) return params.current;
  const providers = { ...params.current.providers };
  for (const [providerID, models] of Object.entries(params.previous.providers)) {
    if (params.replacedProviderIDs.has(providerID)) continue;
    providers[providerID] = sortRecordByKeys({
      ...models,
      ...(providers[providerID] ?? {}),
    });
  }
  const sortedProviders = sortRecordByKeys(providers);
  return {
    ...params.current,
    _meta: { ...params.current._meta, providers: Object.keys(sortedProviders) },
    providers: sortedProviders,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ModelsDevFetchResult =
  | {
      kind: "not_modified";
      etag?: string;
      lastModified?: string;
    }
  | {
      kind: "success";
      api: unknown;
      etag?: string;
      lastModified?: string;
    };

async function fetchModelsDevSnapshot(params: {
  timeoutMs: number;
  state: PricingRefreshStateV1;
  fetchFn?: typeof fetch;
  /** Legacy snapshots must bypass validators so a 304 cannot keep them catalog-less. */
  conditional?: boolean;
}): Promise<ModelsDevFetchResult> {
  const headers = new Headers();
  if (params.conditional !== false) {
    if (params.state.etag) headers.set("If-None-Match", params.state.etag);
    if (params.state.lastModified) headers.set("If-Modified-Since", params.state.lastModified);
  }

  return await fetchWithTimeout(SOURCE_URL, {
    request: { headers },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    consume: async (response) => {
      const responseMetadata = {
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
      };

      if (response.status === 304) {
        return { kind: "not_modified" as const, ...responseMetadata };
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
      }

      return {
        kind: "success" as const,
        api: await response.json(),
        ...responseMetadata,
      };
    },
  });
}

export async function maybeRefreshPricingSnapshot(
  opts: PricingRefreshOptions = {},
): Promise<PricingRefreshResult> {
  if (REFRESH_IN_FLIGHT) return REFRESH_IN_FLIGHT;

  REFRESH_IN_FLIGHT = (async (): Promise<PricingRefreshResult> => {
    const nowMs = opts.nowMs ?? Date.now();
    const policy = getPricingRefreshPolicy();
    const maxAgeMs = opts.maxAgeMs ?? policy.maxAgeMs;
    const minAttemptIntervalMs = opts.minAttemptIntervalMs ?? policy.minAttemptIntervalMs;
    const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
    const runtimeDirs = opts.runtimeDirs;
    const snapshotPath = getRuntimePricingSnapshotPath(runtimeDirs);
    const statePath = getRuntimePricingRefreshStatePath(runtimeDirs);
    const force = opts.force === true;
    const selection = opts.snapshotSelection ?? SNAPSHOT_SELECTION;
    const allowRefreshWhenSelectionBundled = opts.allowRefreshWhenSelectionBundled === true;

    const requestedProviderIDs = opts.providerAllowlist;
    const previousState = (await readRefreshState(statePath)) ?? makeDefaultRefreshState(nowMs);
    const runtimeSnapshotBeforeRefresh = loadRuntimeSnapshotSync(runtimeDirs);
    const bundledSnapshot = loadBundledSnapshotSync(opts.bootstrapSnapshotOverride);
    // Without a persisted catalog, matching validators can pin a legacy
    // snapshot to a permanent 304 and keep present-but-unpriced prices forever.
    const runtimeHasAuthoritativeCatalog = hasAuthoritativeCatalog(runtimeSnapshotBeforeRefresh);
    const legacyRuntimePinnedByValidators =
      runtimeSnapshotBeforeRefresh !== null &&
      !runtimeHasAuthoritativeCatalog &&
      !!(previousState.etag || previousState.lastModified);

    applySnapshotSelection({
      runtimeDirs,
      bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
      selection,
    });

    if (selection === "bundled" && !allowRefreshWhenSelectionBundled) {
      return {
        attempted: false,
        updated: false,
        reason: "selection_bundled",
        state: {
          ...previousState,
          updatedAt: nowMs,
        },
      };
    }

    if (!force && PROCESS_REFRESH_CHECKED) {
      return {
        attempted: false,
        updated: false,
        reason: "already_checked_this_process",
        state: previousState,
      };
    }

    PROCESS_REFRESH_CHECKED = true;

    const health = getPricingSnapshotHealth({ nowMs, maxAgeMs });

    if (!force && !policy.enabled) {
      return {
        attempted: false,
        updated: false,
        reason: "disabled",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_fresh",
        },
      };
    }

    if (!force && !health.stale && !legacyRuntimePinnedByValidators) {
      return {
        attempted: false,
        updated: false,
        reason: "fresh",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_fresh",
        },
      };
    }

    if (
      !force &&
      previousState.lastAttemptAt &&
      nowMs - previousState.lastAttemptAt < minAttemptIntervalMs
    ) {
      return {
        attempted: false,
        updated: false,
        reason: "throttled",
        state: {
          ...previousState,
          updatedAt: nowMs,
          lastResult: "skipped_throttled",
        },
      };
    }

    const attemptingState: PricingRefreshStateV1 = {
      ...previousState,
      version: 1,
      updatedAt: nowMs,
      lastAttemptAt: nowMs,
    };

    try {
      let fetchResult = await fetchModelsDevSnapshot({
        timeoutMs,
        state: attemptingState,
        fetchFn: opts.fetchFn,
        conditional: runtimeHasAuthoritativeCatalog,
      });

      if (fetchResult.kind === "not_modified" && !runtimeHasAuthoritativeCatalog) {
        // An unconditional request must not answer 304. Retry once without
        // validators; a second 304 still cannot establish catalog presence, so
        // fail the refresh instead of persisting a fresh catalog-less snapshot.
        const retry = await fetchModelsDevSnapshot({
          timeoutMs,
          state: attemptingState,
          fetchFn: opts.fetchFn,
          conditional: false,
        });
        if (retry.kind === "not_modified") {
          throw new Error(
            "models.dev returned not modified while an authoritative catalog refresh was required",
          );
        }
        fetchResult = retry;
      }

      if (fetchResult.kind === "not_modified") {
        const baseSnapshot = runtimeSnapshotBeforeRefresh ?? ensureLoaded();
        // Also heals runtime snapshots written before retired models were kept.
        const refreshedSnapshot = keepRetiredModels({
          current: {
            _meta: {
              ...baseSnapshot._meta,
              generatedAt: nowMs,
            },
            providers: baseSnapshot.providers,
          },
          previous: [bundledSnapshot],
          // A 304 refreshes no provider prices, so retain every provider from
          // either the prior snapshot or the bundled file.
          providerIDs: unionProviderIDs([baseSnapshot, bundledSnapshot]),
          catalog: baseSnapshot.catalog,
        });
        await writeJsonAtomic(snapshotPath, refreshedSnapshot, { trailingNewline: true });
        applySnapshotSelection({
          runtimeDirs,
          bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
          selection,
        });

        const nextState: PricingRefreshStateV1 = {
          ...attemptingState,
          updatedAt: nowMs,
          lastSuccessAt: nowMs,
          lastResult: "not_modified",
          lastError: undefined,
          etag: fetchResult.etag ?? attemptingState.etag,
          lastModified: fetchResult.lastModified ?? attemptingState.lastModified,
        };
        try {
          await writeJsonAtomic(statePath, nextState, { trailingNewline: true });
        } catch {
          // best effort; keep refreshed in-memory/runtime snapshot active
        }
        return {
          attempted: true,
          updated: true,
          state: nextState,
        };
      }

      const fetchedSnapshot = buildSnapshotFromApi(fetchResult.api, requestedProviderIDs, nowMs);
      // An all-unpriced response is still authoritative when its catalog lists
      // models: those models must be treated as present without a cost, not as
      // an empty/failed refresh. Only reject responses with neither prices nor
      // catalog entries.
      if (countPricedModels(fetchedSnapshot) === 0 && countCatalogModels(fetchedSnapshot) === 0) {
        throw new Error("Refusing to persist empty pricing snapshot from models.dev");
      }
      const replacedProviderIDs = new Set(Object.keys(fetchedSnapshot.catalog ?? {}));
      const refreshCatalog = mergeScopedCatalog({
        previous: runtimeSnapshotBeforeRefresh?.catalog,
        fetched: fetchedSnapshot.catalog ?? {},
        scoped: requestedProviderIDs !== undefined,
      });
      const currentSnapshot =
        requestedProviderIDs !== undefined
          ? retainPriorPricesForUnrefreshedProviders({
              current: fetchedSnapshot,
              previous: runtimeSnapshotBeforeRefresh,
              replacedProviderIDs,
            })
          : fetchedSnapshot;
      const snapshot = keepRetiredModels({
        current: currentSnapshot,
        previous: [runtimeSnapshotBeforeRefresh, bundledSnapshot],
        // Only providers in the refresh scope were replaced. Keep prior/bundled
        // prices for every other provider instead of dropping them.
        providerIDs: unionProviderIDs([
          currentSnapshot,
          runtimeSnapshotBeforeRefresh,
          bundledSnapshot,
        ]),
        catalog: refreshCatalog,
      });

      await writeJsonAtomic(snapshotPath, snapshot, { trailingNewline: true });
      applySnapshotSelection({
        runtimeDirs,
        bootstrapSnapshotOverride: opts.bootstrapSnapshotOverride,
        selection,
      });

      const nextState: PricingRefreshStateV1 = {
        ...attemptingState,
        updatedAt: nowMs,
        lastSuccessAt: nowMs,
        lastResult: "success",
        lastError: undefined,
        etag: fetchResult.etag ?? attemptingState.etag,
        lastModified: fetchResult.lastModified ?? attemptingState.lastModified,
      };

      try {
        await writeJsonAtomic(statePath, nextState, { trailingNewline: true });
      } catch {
        // best effort; snapshot has already been updated
      }

      return {
        attempted: true,
        updated: true,
        state: nextState,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const nextState: PricingRefreshStateV1 = {
        ...attemptingState,
        updatedAt: nowMs,
        lastFailureAt: nowMs,
        lastResult: "failed",
        lastError: errorMessage,
      };

      try {
        await writeJsonAtomic(statePath, nextState, { trailingNewline: true });
      } catch {
        // best effort; report original fetch/refresh error
      }

      return {
        attempted: true,
        updated: false,
        error: errorMessage,
        state: nextState,
      };
    }
  })().finally(() => {
    REFRESH_IN_FLIGHT = null;
  });

  return REFRESH_IN_FLIGHT;
}

export function setPricingSnapshotSelection(selection: PricingSnapshotSource): void {
  if (SNAPSHOT_SELECTION === selection) return;
  SNAPSHOT_SELECTION = selection;
  SNAPSHOT = null;
  MODEL_INDEX = null;
}

export function getPricingSnapshotSelection(): PricingSnapshotSource {
  return SNAPSHOT_SELECTION;
}

export function getPricingSnapshotMeta(): PricingSnapshot["_meta"] {
  return ensureLoaded()._meta;
}

export function getPricingSnapshotSource(): "runtime" | "bundled" | "empty" {
  ensureLoaded();
  return SNAPSHOT_SOURCE;
}

export function getPricingSnapshotHealth(opts?: {
  nowMs?: number;
  maxAgeMs?: number;
}): PricingSnapshotHealth {
  const generatedAt = getPricingSnapshotMeta().generatedAt;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  const ageMs = Math.max(0, nowMs - generatedAt);
  return {
    generatedAt,
    ageMs,
    maxAgeMs,
    stale: ageMs > maxAgeMs,
  };
}

export function hasProvider(providerId: string): boolean {
  return !!ensureLoaded().providers[providerId];
}

export function isModelsDevProviderId(providerId: string): boolean {
  return hasProvider(providerId);
}

export function hasModel(providerId: string, modelId: string): boolean {
  const p = ensureLoaded().providers[providerId];
  if (!p) return false;
  return !!p[modelId];
}

/**
 * True when the source catalog lists the exact model, even if the model has no
 * usable cost. Catalog providers may be absent from `providers`.
 */
export function hasCatalogModel(providerId: string, modelId: string): boolean {
  const models = ensureLoaded().catalog?.[providerId];
  return Array.isArray(models) && models.includes(modelId);
}

/**
 * Infer the snapshot provider that owns a modelId.
 * Returns null when model is not found or is ambiguous across providers.
 */
export function inferProviderForModelId(modelId: string): string | null {
  const providers = listProvidersForModelId(modelId);
  if (!providers || providers.length !== 1) return null;
  return providers[0] ?? null;
}

export function getProviderModelCount(providerId: string): number {
  return Object.keys(ensureLoaded().providers[providerId] || {}).length;
}

export function listProviders(): string[] {
  return Object.keys(ensureLoaded().providers);
}

export function listModelsForProvider(providerId: string): string[] {
  return Object.keys(ensureLoaded().providers[providerId] ?? {});
}

export function listProvidersForModelId(modelId: string): string[] {
  const providers = ensureModelIndex().get(modelId) ?? [];
  return [...providers].sort((a, b) => a.localeCompare(b));
}

export type CostAtContext = {
  /** Base rates, or the selected tier's rates when `basis` is `context_tier`. */
  rates: CostRates;
  basis: "base" | "context_tier";
  /** Explicit tier thresholds published for the model, ascending. */
  tierSizes: number[];
  /** Selected threshold when `basis` is `context_tier`. */
  tierSize?: number;
};

function withoutTiers(cost: CostBuckets): CostRates {
  const { tiers: _tiers, ...rates } = cost;
  return rates;
}

/**
 * Select base or context-tier rates from one cost entry. Without a
 * `contextTokens` value the base rates are returned and no tier is claimed as
 * applied. A tier is selected only when the caller can prove the request
 * context reached its threshold; malformed or unsupported tiers never
 * participate.
 */
export function selectCostAtContext(cost: CostBuckets, contextTokens?: number): CostAtContext {
  const tiers = cost.tiers ?? [];
  const tierSizes = tiers.map((tier) => tier.tier.size);

  if (
    tiers.length === 0 ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens < 0
  ) {
    return { rates: withoutTiers(cost), basis: "base", tierSizes };
  }

  let selected: CostTier | undefined;
  for (const tier of tiers) {
    if (contextTokens >= tier.tier.size) selected = tier;
  }
  if (!selected) return { rates: withoutTiers(cost), basis: "base", tierSizes };

  const { tier: _tier, ...rates } = selected;
  return {
    rates,
    basis: "context_tier",
    tierSizes,
    tierSize: selected.tier.size,
  };
}

export function lookupCostAtContext(
  providerId: string,
  modelId: string,
  contextTokens?: number,
): CostAtContext | null {
  const cost = lookupCost(providerId, modelId);
  return cost ? selectCostAtContext(cost, contextTokens) : null;
}

export function lookupCost(providerId: string, modelId: string): CostBuckets | null {
  const p = ensureLoaded().providers[providerId];
  if (!p) return null;
  const c = p[modelId];
  if (!c) return null;
  return c;
}

export function hasCost(providerId: string, modelId: string): boolean {
  return lookupCost(providerId, modelId) != null;
}

export function __resetPricingSnapshotForTests(): void {
  SNAPSHOT = null;
  SNAPSHOT_SOURCE = "bundled";
  SNAPSHOT_SELECTION = "auto";
  CONFIGURED_PRICING_SNAPSHOT_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
  MODEL_INDEX = null;
  REFRESH_IN_FLIGHT = null;
  PROCESS_REFRESH_CHECKED = false;
}
