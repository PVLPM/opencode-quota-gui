import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import {
  type CostBuckets,
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  listModelsForProvider,
  listProviders,
  lookupCost,
} from "../lib/modelsdev-pricing.js";
import {
  getTemporalPolicy,
  getTemporalSnapshotMeta,
  getTemporalSnapshotValidationError,
} from "../lib/modelsdev-temporal.js";

/**
 * Fingerprint format version. Bump whenever the covered inputs or their
 * canonical encoding change, so derived presentation caches are rebuilt.
 */
export const ANALYTICS_PRICING_FINGERPRINT_SCHEMA = 1;
/** Stable v1 models.dev pricing snapshot schema this fingerprint understands. */
export const PRICING_SNAPSHOT_SCHEMA_VERSION = 1;
/** Temporal snapshot schema this fingerprint understands. */
export const TEMPORAL_SNAPSHOT_SCHEMA_VERSION = 1;

export type AnalyticsPricingFingerprintInput = {
  pricing: {
    schemaVersion: number;
    source: "runtime" | "bundled" | "empty";
    meta: {
      source: string;
      generatedAt: number;
      providers: readonly string[];
      units: string;
    };
    /** Hash of the selected snapshot's actual provider/model rates and tiers. */
    contentFingerprint: string;
  };
  temporal: {
    schemaVersion: number;
    revision: string;
    source: string;
    generatedAt: number;
    validationError: string | null;
    /** Hash of the actual temporal policy values and bundled calendar content. */
    contentFingerprint: string;
  };
};

const TEMPORAL_SNAPSHOT_URL = new URL("../data/modelsdev-temporal.min.json", import.meta.url);

/**
 * Content hashes are keyed by the loaded snapshot's `_meta` object. A reload
 * or selection change installs a new object, so identical metadata values still
 * invalidate while repeated requests reuse the already-computed content hash.
 */
let pricingContentCache = new WeakMap<object, Map<string, string>>();

type TemporalSourceIdentity = {
  cacheKey: string;
  fileFingerprint: string;
  routes: Array<[providerId: string, modelId: string]>;
};
let temporalSourceCache: TemporalSourceIdentity | undefined;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable representation of every monetary field, including context tiers. */
function canonicalCost(cost: CostBuckets | null): unknown {
  if (!cost) return null;
  return [
    cost.input ?? null,
    cost.output ?? null,
    cost.cache_read ?? null,
    cost.cache_write ?? null,
    cost.reasoning ?? null,
    (cost.tiers ?? []).map((tier) => [
      tier.tier.size,
      tier.input ?? null,
      tier.output ?? null,
      tier.cache_read ?? null,
      tier.cache_write ?? null,
      tier.reasoning ?? null,
    ]),
  ];
}

/** Hash the selected snapshot's actual priced content, not its metadata. */
function getPricingContentFingerprint(meta: object, source: string): string {
  let bySource = pricingContentCache.get(meta);
  if (!bySource) {
    bySource = new Map();
    pricingContentCache.set(meta, bySource);
  }
  const cached = bySource.get(source);
  if (cached !== undefined) return cached;

  const hash = createHash("sha256");
  for (const providerId of [...listProviders()].sort(compareIds)) {
    for (const modelId of [...listModelsForProvider(providerId)].sort(compareIds)) {
      hash.update(
        JSON.stringify([providerId, modelId, canonicalCost(lookupCost(providerId, modelId))]),
      );
      hash.update("\n");
    }
  }
  const fingerprint = hash.digest("hex");
  bySource.set(source, fingerprint);
  return fingerprint;
}

/**
 * Bundled temporal content identity. The file hash covers calendars and any
 * routes this process cannot enumerate from the public runtime API; the route
 * list lets policy-value changes made to the loaded snapshot participate too.
 */
function getTemporalSourceIdentity(): TemporalSourceIdentity {
  try {
    const stat = statSync(TEMPORAL_SNAPSHOT_URL);
    const cacheKey = `${stat.mtimeMs}:${stat.size}`;
    if (temporalSourceCache?.cacheKey === cacheKey) return temporalSourceCache;

    const text = readFileSync(TEMPORAL_SNAPSHOT_URL, "utf8");
    const raw = JSON.parse(text) as {
      providers?: Record<string, Record<string, unknown>>;
    };
    const routes: Array<[string, string]> = [];
    const providers = raw.providers ?? {};
    for (const providerId of Object.keys(providers).sort(compareIds)) {
      const models = providers[providerId];
      if (!models || typeof models !== "object") continue;
      for (const modelId of Object.keys(models).sort(compareIds)) {
        routes.push([providerId, modelId]);
      }
    }
    temporalSourceCache = { cacheKey, fileFingerprint: sha256(text), routes };
  } catch {
    temporalSourceCache = { cacheKey: "missing", fileFingerprint: "", routes: [] };
  }
  return temporalSourceCache;
}

/** Hash the actual temporal policy values for every canonical bundled route. */
function getTemporalContentFingerprint(): string {
  const source = getTemporalSourceIdentity();
  const hash = createHash("sha256");
  hash.update(source.fileFingerprint);
  hash.update("\n");
  for (const [providerId, modelId] of source.routes) {
    hash.update(JSON.stringify([providerId, modelId, getTemporalPolicy(providerId, modelId)]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Canonical SHA-256 over both pricing inputs that can change a derived cost:
 * the selected stable v1 pricing snapshot identity/content and the temporal
 * snapshot identity/content/schema.
 */
export function buildAnalyticsPricingFingerprint(
  identity: AnalyticsPricingFingerprintInput,
): string {
  const providers = [...identity.pricing.meta.providers].sort(compareIds);
  const payload = JSON.stringify([
    ANALYTICS_PRICING_FINGERPRINT_SCHEMA,
    identity.pricing.schemaVersion,
    identity.pricing.source,
    identity.pricing.meta.source,
    identity.pricing.meta.generatedAt,
    identity.pricing.meta.units,
    providers,
    identity.pricing.contentFingerprint,
    identity.temporal.schemaVersion,
    identity.temporal.revision,
    identity.temporal.source,
    identity.temporal.generatedAt,
    identity.temporal.validationError,
    identity.temporal.contentFingerprint,
  ]);
  return sha256(payload);
}

/** Current combined pricing fingerprint for derived analytics presentation. */
export function getAnalyticsPricingFingerprint(): string {
  const pricingMeta = getPricingSnapshotMeta();
  const pricingSource = getPricingSnapshotSource();
  return buildAnalyticsPricingFingerprint({
    pricing: {
      schemaVersion: PRICING_SNAPSHOT_SCHEMA_VERSION,
      source: pricingSource,
      meta: pricingMeta,
      contentFingerprint: getPricingContentFingerprint(pricingMeta, pricingSource),
    },
    temporal: {
      schemaVersion: TEMPORAL_SNAPSHOT_SCHEMA_VERSION,
      ...getTemporalSnapshotMeta(),
      validationError: getTemporalSnapshotValidationError(),
      contentFingerprint: getTemporalContentFingerprint(),
    },
  });
}

/** Test seam: force the next request to reread snapshot content. */
export function __resetAnalyticsPricingFingerprintCacheForTests(): void {
  pricingContentCache = new WeakMap();
  temporalSourceCache = undefined;
}
