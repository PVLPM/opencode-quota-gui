import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pricingState = vi.hoisted(() => {
  type MockCost = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
  const makeMeta = () => ({
    source: "https://models.dev/api.json",
    generatedAt: 1_793_112_222_447,
    providers: ["rate-labs"],
    units: "USD per 1M tokens",
  });
  return {
    source: "bundled" as "runtime" | "bundled" | "empty",
    meta: makeMeta(),
    models: new Map<string, Map<string, MockCost>>([
      ["rate-labs", new Map([["rate-1", { input: 1 }]])],
    ]),
    lookupCostCalls: 0,
  };
});

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotMeta: () => pricingState.meta,
  getPricingSnapshotSource: () => pricingState.source,
  listProviders: () => [...pricingState.models.keys()],
  listModelsForProvider: (providerId: string) => [
    ...(pricingState.models.get(providerId)?.keys() ?? []),
  ],
  lookupCost: (providerId: string, modelId: string) => {
    pricingState.lookupCostCalls += 1;
    return pricingState.models.get(providerId)?.get(modelId) ?? null;
  },
}));

import {
  __resetAnalyticsPricingFingerprintCacheForTests,
  ANALYTICS_PRICING_FINGERPRINT_SCHEMA,
  type AnalyticsPricingFingerprintInput,
  buildAnalyticsPricingFingerprint,
  getAnalyticsPricingFingerprint,
  PRICING_SNAPSHOT_SCHEMA_VERSION,
  TEMPORAL_SNAPSHOT_SCHEMA_VERSION,
} from "../src/gui/analytics-pricing-revision.js";
import {
  __resetTemporalSnapshotForTests,
  normalizeTemporalSnapshot,
  setTemporalSnapshotForTests,
} from "../src/lib/modelsdev-temporal.js";

const TEMPORAL_REVISION = "a".repeat(40);
const CN_2026 = {
  timeZone: "Asia/Shanghai",
  source: "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  published: "2025-11-04",
  intervals: [
    {
      id: "new-year",
      localStart: "2026-01-01",
      localEnd: "2026-01-04",
      startMs: 1_767_196_800_000,
      endMs: 1_767_456_000_000,
    },
  ],
  makeupWorkdays: [],
};

function resetPricingState(): void {
  pricingState.source = "bundled";
  pricingState.meta = {
    source: "https://models.dev/api.json",
    generatedAt: 1_793_112_222_447,
    providers: ["rate-labs"],
    units: "USD per 1M tokens",
  };
  pricingState.models = new Map([["rate-labs", new Map([["rate-1", { input: 1 }]])]]);
  pricingState.lookupCostCalls = 0;
  __resetAnalyticsPricingFingerprintCacheForTests();
}

function temporalSnapshot(factor: number) {
  return {
    version: 1,
    revision: TEMPORAL_REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${TEMPORAL_REVISION}`,
    generatedAt: 1_793_377_482_000,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      alibaba: {
        "deepseek-v4.1-flash": {
          status: "supported",
          source: "providers/alibaba/models/deepseek-v4.1-flash.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: { type: "utc_hours", op: "gte", value: "14:00" },
              factor,
            },
          ],
        },
      },
    },
  };
}

function identity(
  overrides: {
    pricing?: Partial<AnalyticsPricingFingerprintInput["pricing"]>;
    pricingMeta?: Partial<AnalyticsPricingFingerprintInput["pricing"]["meta"]>;
    temporal?: Partial<AnalyticsPricingFingerprintInput["temporal"]>;
  } = {},
): AnalyticsPricingFingerprintInput {
  return {
    pricing: {
      schemaVersion: PRICING_SNAPSHOT_SCHEMA_VERSION,
      source: "bundled",
      meta: {
        source: "https://models.dev/api.json",
        generatedAt: 1_793_112_222_447,
        providers: ["openai", "deepseek"],
        units: "USD per 1M tokens",
        ...overrides.pricingMeta,
      },
      contentFingerprint: "pricing-content-a",
      ...overrides.pricing,
    },
    temporal: {
      schemaVersion: TEMPORAL_SNAPSHOT_SCHEMA_VERSION,
      revision: "a".repeat(40),
      source: `https://github.com/anomalyco/models.dev/tree/${"a".repeat(40)}`,
      generatedAt: 1_793_377_482_000,
      validationError: null,
      contentFingerprint: "temporal-content-a",
      ...overrides.temporal,
    },
  };
}

beforeEach(() => {
  resetPricingState();
  __resetTemporalSnapshotForTests();
});

afterEach(() => {
  __resetTemporalSnapshotForTests();
});

describe("analytics pricing revision fingerprint", () => {
  it("is deterministic and independent of provider catalog order", () => {
    const fingerprint = buildAnalyticsPricingFingerprint(identity());
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(buildAnalyticsPricingFingerprint(identity())).toBe(fingerprint);
    expect(
      buildAnalyticsPricingFingerprint(
        identity({ pricingMeta: { providers: ["deepseek", "openai"] } }),
      ),
    ).toBe(fingerprint);
    expect(ANALYTICS_PRICING_FINGERPRINT_SCHEMA).toBe(1);
  });

  it("changes when the stable v1 pricing identity or actual content changes", () => {
    const base = buildAnalyticsPricingFingerprint(identity());
    const changedGeneratedAt = buildAnalyticsPricingFingerprint(
      identity({ pricingMeta: { generatedAt: 1_793_112_222_448 } }),
    );
    const changedProviders = buildAnalyticsPricingFingerprint(
      identity({ pricingMeta: { providers: ["openai", "deepseek", "zai"] } }),
    );
    const changedSource = buildAnalyticsPricingFingerprint(
      identity({ pricing: { source: "runtime" } }),
    );
    const changedSchema = buildAnalyticsPricingFingerprint(
      identity({ pricing: { schemaVersion: PRICING_SNAPSHOT_SCHEMA_VERSION + 1 } }),
    );
    const changedRates = buildAnalyticsPricingFingerprint(
      identity({ pricing: { contentFingerprint: "pricing-content-b" } }),
    );

    expect(changedGeneratedAt).not.toBe(base);
    expect(changedProviders).not.toBe(base);
    expect(changedSource).not.toBe(base);
    expect(changedSchema).not.toBe(base);
    expect(changedRates).not.toBe(base);
  });

  it("changes when temporal identity, schema, or actual policy content changes", () => {
    const base = buildAnalyticsPricingFingerprint(identity());
    const changedRevision = buildAnalyticsPricingFingerprint(
      identity({
        temporal: {
          revision: "b".repeat(40),
          source: `https://github.com/anomalyco/models.dev/tree/${"b".repeat(40)}`,
        },
      }),
    );
    const changedGeneratedAt = buildAnalyticsPricingFingerprint(
      identity({ temporal: { generatedAt: 1_793_377_482_001 } }),
    );
    const changedSchema = buildAnalyticsPricingFingerprint(
      identity({ temporal: { schemaVersion: TEMPORAL_SNAPSHOT_SCHEMA_VERSION + 1 } }),
    );
    const invalid = buildAnalyticsPricingFingerprint(
      identity({ temporal: { validationError: "snapshot is invalid" } }),
    );
    const changedPolicies = buildAnalyticsPricingFingerprint(
      identity({ temporal: { contentFingerprint: "temporal-content-b" } }),
    );

    expect(changedRevision).not.toBe(base);
    expect(changedGeneratedAt).not.toBe(base);
    expect(changedSchema).not.toBe(base);
    expect(invalid).not.toBe(base);
    expect(changedPolicies).not.toBe(base);
  });

  it("caches content per loaded pricing snapshot and detects a same-metadata reload", () => {
    const first = getAnalyticsPricingFingerprint();
    const callsAfterFirstLoad = pricingState.lookupCostCalls;
    expect(callsAfterFirstLoad).toBeGreaterThan(0);

    expect(getAnalyticsPricingFingerprint()).toBe(first);
    expect(pricingState.lookupCostCalls).toBe(callsAfterFirstLoad);

    // A new loaded snapshot can carry identical metadata values while its
    // monetary rates differ; the new _meta object must miss the content cache.
    pricingState.meta = {
      source: "https://models.dev/api.json",
      generatedAt: 1_793_112_222_447,
      providers: ["rate-labs"],
      units: "USD per 1M tokens",
    };
    pricingState.models = new Map([["rate-labs", new Map([["rate-1", { input: 9 }]])]]);

    const second = getAnalyticsPricingFingerprint();
    expect(second).not.toBe(first);
    expect(pricingState.lookupCostCalls).toBeGreaterThan(callsAfterFirstLoad);
  });

  it("changes when the selected pricing source changes with identical content", () => {
    const bundled = getAnalyticsPricingFingerprint();
    const callsAfterBundled = pricingState.lookupCostCalls;
    pricingState.source = "runtime";
    const runtime = getAnalyticsPricingFingerprint();

    expect(runtime).not.toBe(bundled);
    expect(pricingState.lookupCostCalls).toBeGreaterThan(callsAfterBundled);
  });

  it("detects same-metadata temporal policy value changes", () => {
    try {
      setTemporalSnapshotForTests(normalizeTemporalSnapshot(temporalSnapshot(2)));
      const peak = getAnalyticsPricingFingerprint();
      expect(getAnalyticsPricingFingerprint()).toBe(peak);

      setTemporalSnapshotForTests(normalizeTemporalSnapshot(temporalSnapshot(3)));
      const repriced = getAnalyticsPricingFingerprint();
      expect(repriced).not.toBe(peak);
    } finally {
      __resetTemporalSnapshotForTests();
    }
  });

  it("exposes a stable runtime fingerprint", () => {
    const first = getAnalyticsPricingFingerprint();
    const second = getAnalyticsPricingFingerprint();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
