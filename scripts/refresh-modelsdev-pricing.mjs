import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const COST_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"];
const FETCH_TIMEOUT_MS = 15_000;

/**
 * `--providers=` is an optional explicit dynamic scope. Without it the
 * centralized snapshot refreshes every provider models.dev returns, so no
 * source catalogue is omitted by a hardcoded allowlist.
 */
function parseProviderArgs(argv) {
  const providerArg = argv.find((arg) => arg.startsWith("--providers="));
  if (!providerArg) return undefined;

  const raw = providerArg.slice("--providers=".length).trim();
  if (!raw) return undefined;

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickRateBuckets(rawCost) {
  if (!rawCost || typeof rawCost !== "object") return null;
  const picked = {};

  for (const key of COST_KEYS) {
    const value = rawCost[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[key] = value;
    }
  }

  return hasRates(picked) ? picked : null;
}

function hasRates(rates) {
  return COST_KEYS.some((key) => Object.hasOwn(rates, key));
}

function pickContextTiers(rawCost) {
  if (!rawCost || typeof rawCost !== "object" || !Array.isArray(rawCost.tiers)) {
    return undefined;
  }

  const tiers = [];
  for (const rawTier of rawCost.tiers) {
    if (!rawTier || typeof rawTier !== "object") continue;
    const meta = rawTier.tier;
    if (!meta || typeof meta !== "object" || meta.type !== "context") continue;

    const size = Number(meta.size);
    if (!Number.isFinite(size) || size <= 0) continue;

    const rates = pickRateBuckets(rawTier);
    if (!rates || typeof rates.input !== "number" || typeof rates.output !== "number") continue;

    tiers.push({
      ...rates,
      tier: { type: "context", size: Math.trunc(size) },
    });
  }

  if (tiers.length === 0) return undefined;

  // Deterministic regardless of upstream order, then one tier per size.
  tiers.sort(
    (a, b) => a.tier.size - b.tier.size || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );

  const unique = [];
  const sizes = new Set();
  for (const tier of tiers) {
    if (sizes.has(tier.tier.size)) continue;
    sizes.add(tier.tier.size);
    unique.push(tier);
  }
  return unique;
}

function pickCostBuckets(rawCost) {
  if (!rawCost || typeof rawCost !== "object") return null;
  const picked = pickRateBuckets(rawCost);
  if (!picked) return null;

  const tiers = pickContextTiers(rawCost);
  return tiers ? { ...picked, tiers } : picked;
}

function sortObjectByKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = obj[key];
  }
  return sorted;
}

async function fetchModelsDevJson() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(SOURCE_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function writeFileAtomic(path, content) {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dir, { recursive: true });
  await writeFile(tmp, content, "utf8");

  const safeRm = async (target) => {
    try {
      await rm(target, { force: true });
    } catch {
      // best-effort cleanup
    }
  };

  try {
    await rename(tmp, path);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    const shouldRetryAsReplace =
      code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY";

    if (!shouldRetryAsReplace) {
      await safeRm(tmp);
      throw err;
    }

    await safeRm(path);
    await rename(tmp, path);
  }
}

function buildSnapshot(api, providerIDs) {
  const providers = {};
  const scopedProviderIDs = (providerIDs ?? Object.keys(api ?? {}))
    .slice()
    .sort((a, b) => a.localeCompare(b));

  for (const providerID of scopedProviderIDs) {
    const models = api?.[providerID]?.models;
    if (!models || typeof models !== "object") continue;

    const pricedModels = {};
    for (const modelID of Object.keys(models)) {
      const cost = pickCostBuckets(models[modelID]?.cost);
      if (cost) pricedModels[modelID] = cost;
    }

    if (Object.keys(pricedModels).length > 0) {
      providers[providerID] = sortObjectByKeys(pricedModels);
    }
  }

  const sortedProviders = sortObjectByKeys(providers);
  const providerList = Object.keys(sortedProviders).sort((a, b) => a.localeCompare(b));

  return {
    _meta: {
      generatedAt: Date.now(),
      providers: providerList,
      source: SOURCE_URL,
      units: "USD per 1M tokens",
    },
    providers: sortedProviders,
  };
}

async function readPreviousSnapshot(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function buildCatalog(api, providerIDs) {
  const catalog = {};
  for (const providerID of providerIDs) {
    const models = api?.[providerID]?.models;
    if (!models || typeof models !== "object") continue;
    catalog[providerID] = Object.keys(models).sort((a, b) => a.localeCompare(b));
  }
  return catalog;
}

// models.dev drops retired models from its list. Keep their last known price so
// older usage still gets a cost. Prices from models.dev always win.
//
// `catalog` is the authoritative model presence from the API response. A model
// that is present in the catalog but has no usable cost was delisted from
// pricing and must not be restored from `previous`. Providers missing from
// `catalog` are unknown (for example a scoped refresh), so their historical
// models are still kept.
export function keepRetiredModels(snapshot, previous, providerIDs, catalog) {
  const previousProviders = previous?.providers ?? {};
  const catalogByProvider = catalog
    ? new Map(
        Object.entries(catalog).map(([providerID, modelIDs]) => [providerID, new Set(modelIDs)]),
      )
    : null;
  const keptModelIDs = [];

  for (const providerID of providerIDs) {
    const models = { ...(snapshot.providers[providerID] ?? {}) };
    const presentModelIDs = catalogByProvider?.get(providerID);
    for (const [modelID, rawCost] of Object.entries(previousProviders[providerID] ?? {})) {
      const cost = pickCostBuckets(rawCost);
      if (models[modelID] || presentModelIDs?.has(modelID) || !cost) continue;
      models[modelID] = cost;
      keptModelIDs.push(`${providerID}/${modelID}`);
    }
    if (Object.keys(models).length > 0) {
      snapshot.providers[providerID] = sortObjectByKeys(models);
    }
  }

  snapshot.providers = sortObjectByKeys(snapshot.providers);
  snapshot._meta.providers = Object.keys(snapshot.providers);
  return keptModelIDs;
}

export function buildRefreshedSnapshot(api, previous, providerIDs) {
  // Without an explicit dynamic scope, refresh and retain every provider the
  // central catalog returned plus every provider already in the previous
  // snapshot, so a dropped provider is not lost on the next refresh.
  const scope = providerIDs ?? [
    ...new Set([...Object.keys(api ?? {}), ...Object.keys(previous?.providers ?? {})]),
  ];
  const snapshot = buildSnapshot(api, scope);
  if (Object.keys(snapshot.providers).length === 0) {
    throw new Error(
      `Refusing to write a pricing snapshot: ${SOURCE_URL} returned no priced models.`,
    );
  }
  // The bundled file stays compact: catalog presence is applied during
  // generation and only persisted in runtime snapshots, where offline retention
  // needs it.
  const catalog = buildCatalog(api, scope);
  const keptModelIDs = keepRetiredModels(snapshot, previous, scope, catalog);
  return { snapshot, keptModelIDs };
}

async function main() {
  const providerIDs = parseProviderArgs(process.argv.slice(2));
  const outPath = fileURLToPath(new URL("../src/data/modelsdev-pricing.min.json", import.meta.url));
  const previous = await readPreviousSnapshot(outPath);
  const api = await fetchModelsDevJson();
  const { snapshot, keptModelIDs } = buildRefreshedSnapshot(api, previous, providerIDs);

  // The catalog is intentionally stored compact: all-provider coverage is
  // ~675 KB here versus ~1 MB pretty-printed, with identical parsed content.
  await writeFileAtomic(outPath, `${JSON.stringify(snapshot)}\n`);

  console.log(
    `Wrote ${outPath} with ${snapshot._meta.providers.length} providers and ${Object.values(snapshot.providers).reduce((sum, models) => sum + Object.keys(models).length, 0)} priced models.`,
  );
  if (keptModelIDs.length > 0) {
    console.log(
      `Kept ${keptModelIDs.length} models that models.dev no longer lists: ${keptModelIDs.join(", ")}`,
    );
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
