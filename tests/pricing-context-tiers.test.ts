import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPricingSnapshotForTests,
  listProviders,
  lookupCost,
  lookupCostAtContext,
  maybeRefreshPricingSnapshot,
  setPricingSnapshotSelection,
} from "../src/lib/modelsdev-pricing.js";
import { calculateCostUsd, priceTokenBuckets, resolvePricingKey } from "../src/lib/quota-stats.js";
import type { TokenBuckets } from "../src/lib/token-buckets.js";

const SNAPSHOT_URL = new URL("../src/data/modelsdev-pricing.min.json", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_ROOTS: string[] = [];

const GPT_61_TERRA_BASE = {
  input: 1,
  output: 5,
  cache_read: 0.05,
  cache_write: 1.25,
};

const GPT_61_TERRA_TIER = {
  tier: { type: "context" as const, size: 272_000 },
  input: 2,
  output: 7.5,
  cache_read: 0.1,
  cache_write: 2.5,
};

function runtimeDirs(root: string) {
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
}

async function tempRuntimeDirs() {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-tiers-"));
  TEMP_ROOTS.push(root);
  return runtimeDirs(root);
}

afterEach(async () => {
  __resetPricingSnapshotForTests();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("bundled pricing coverage and tiers", () => {
  beforeEach(() => {
    setPricingSnapshotSelection("bundled");
  });

  it("covers the centralized all-provider catalog without a hardcoded allowlist", () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(200);
    for (const providerID of [
      "anthropic",
      "github-copilot",
      "google",
      "moonshotai",
      "openai",
      "opencode",
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
    ]) {
      expect(providers, providerID).toContain(providerID);
    }

    const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, "utf8"));
    let modelCount = 0;
    let tieredCount = 0;
    let reasoningCount = 0;
    for (const models of Object.values(snapshot.providers) as Array<Record<string, unknown>>) {
      modelCount += Object.keys(models).length;
      for (const cost of Object.values(models) as Array<{
        reasoning?: unknown;
        tiers?: unknown[];
      }>) {
        if (typeof cost.reasoning === "number") reasoningCount += 1;
        if (Array.isArray(cost.tiers) && cost.tiers.length > 0) tieredCount += 1;
      }
    }

    // All-provider normalized data is ~1 MB pretty; the compact bundled file
    // keeps full coverage under 800 KB and offline behavior deterministic.
    expect(modelCount).toBeGreaterThan(8000);
    expect(Buffer.byteLength(readFileSync(SNAPSHOT_URL, "utf8"), "utf8")).toBeLessThan(800 * 1024);
    expect(tieredCount).toBeGreaterThan(800);
    expect(reasoningCount).toBeGreaterThan(0);
  });

  it("prices explicit reasoning rates from the bundled snapshot", () => {
    expect(lookupCost("openrouter", "perplexity/sonar-deep-research")).toEqual({
      input: 2,
      output: 8,
      reasoning: 3,
    });

    expect(
      calculateCostUsd({
        provider: "openrouter",
        model: "perplexity/sonar-deep-research",
        tokens: { input: 0, output: 0, reasoning: 1_000_000, cache_read: 0, cache_write: 0 },
      }),
    ).toEqual({ ok: true, costUsd: 3 });
  });

  it("stores gpt-6.1-terra base rates with its explicit context tier", () => {
    const cost = lookupCost("openai", "gpt-6.1-terra");
    expect(cost).toMatchObject(GPT_61_TERRA_BASE);
    expect(cost?.tiers).toEqual([GPT_61_TERRA_TIER]);
  });

  it("selects a tier only when a context size proves it applies", () => {
    const unknown = lookupCostAtContext("openai", "gpt-6.1-terra");
    expect(unknown).toMatchObject({
      basis: "base",
      tierSizes: [272_000],
      rates: GPT_61_TERRA_BASE,
    });
    expect(unknown?.tierSize).toBeUndefined();

    const below = lookupCostAtContext("openai", "gpt-6.1-terra", 271_999);
    expect(below).toMatchObject({ basis: "base", tierSizes: [272_000] });
    expect(below?.tierSize).toBeUndefined();

    const boundary = lookupCostAtContext("openai", "gpt-6.1-terra", 272_000);
    expect(boundary).toMatchObject({
      basis: "context_tier",
      tierSize: 272_000,
      tierSizes: [272_000],
      rates: { input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5 },
    });

    const beyond = lookupCostAtContext("openai", "gpt-6.1-terra", 999_999);
    expect(beyond).toMatchObject({ basis: "context_tier", tierSize: 272_000 });

    expect(lookupCostAtContext("openai", "gpt-6.1-terra", Number.NaN)?.basis).toBe("base");
    expect(lookupCostAtContext("openai", "gpt-6.1-terra", -1)?.basis).toBe("base");
  });

  it("prices opencode-go/deepseek-v4.1-flash from its actual source provider", () => {
    expect(lookupCost("opencode-go", "deepseek-v4.1-flash")).toEqual({
      input: 0.15,
      output: 0.6,
      cache_read: 0.003,
    });

    const resolved = resolvePricingKey({
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    expect(resolved).toMatchObject({
      ok: true,
      method: "source_provider",
      key: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    });

    const tokens = {
      input: 1_000_000,
      output: 1_000_000,
      reasoning: 0,
      cache_read: 1_000_000,
      cache_write: 0,
    };
    expect(
      calculateCostUsd({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        tokens,
      }),
    ).toEqual({ ok: true, costUsd: 0.753 });

    expect(
      priceTokenBuckets({
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        tokens,
      }),
    ).toMatchObject({
      status: "priced",
      key: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
      costUsd: 0.753,
    });

    expect(
      resolvePricingKey({
        providerID: "opencode-go-subscription",
        modelID: "deepseek-v4.1-flash",
      }),
    ).toMatchObject({
      ok: true,
      method: "source_provider",
      key: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    });
  });

  it("does not invent a cross-plan fallback for opencode-go", () => {
    const resolved = resolvePricingKey({
      providerID: "opencode-go",
      modelID: "not-a-model",
    });
    expect(resolved.ok).toBe(false);
  });

  it("uses base rates below the tier and applies published tiers from prompt token evidence", () => {
    const belowThreshold = {
      input: 50_000,
      output: 1_000_000,
      reasoning: 0,
      cache_read: 50_000,
      cache_write: 50_000,
    };
    expect(
      calculateCostUsd({ provider: "openai", model: "gpt-6.1-terra", tokens: belowThreshold }),
    ).toEqual({ ok: true, costUsd: 5.115 });

    // Observed OpenCode values are non-cached input plus cache read/write:
    // input stays small while cache.read carries the prompt context.
    const observedBelow = {
      input: 506,
      output: 56,
      reasoning: 13,
      cache_read: 159_360,
      cache_write: 0,
    };
    expect(
      calculateCostUsd({ provider: "openai", model: "gpt-6.1-terra", tokens: observedBelow }),
    ).not.toHaveProperty("contextTierSize");

    const observedAtBoundary = {
      input: 506,
      output: 56,
      reasoning: 13,
      cache_read: 271_494,
      cache_write: 0,
    };
    expect(
      calculateCostUsd({
        provider: "openai",
        model: "gpt-6.1-terra",
        tokens: observedAtBoundary,
      }),
    ).toMatchObject({ ok: true, contextTierSize: 272_000 });

    // Observed gpt-6.1-sol turn: 376,576 cached prompt tokens exceed 272k, so
    // the long-context tier applies to all token categories.
    const sol = priceTokenBuckets({
      providerID: "openai",
      modelID: "gpt-6.1-sol",
      tokens: {
        input: 342,
        output: 425,
        reasoning: 256,
        cache_read: 376_576,
        cache_write: 0,
      },
    });
    expect(sol).toMatchObject({ status: "priced", contextTierSize: 272_000 });
    if (sol.status === "priced") {
      expect(sol.costUsd).toBeCloseTo(0.0868982, 10);
    }

    const aboveThreshold = {
      input: 1_000_000,
      output: 1_000_000,
      reasoning: 0,
      cache_read: 1_000_000,
      cache_write: 1_000_000,
    };
    expect(
      calculateCostUsd({ provider: "openai", model: "gpt-6.1-terra", tokens: aboveThreshold }),
    ).toEqual({ ok: true, costUsd: 12.1, contextTierSize: 272_000 });

    expect(
      priceTokenBuckets({
        providerID: "openai",
        modelID: "gpt-6.1-terra",
        tokens: aboveThreshold,
      }),
    ).toMatchObject({ status: "priced", costUsd: 12.1, contextTierSize: 272_000 });

    // No prompt-side evidence means no tier is claimed, only base rates.
    expect(
      calculateCostUsd({
        provider: "openai",
        model: "gpt-6.1-terra",
        tokens: { input: 0, output: 1_000_000, reasoning: 0, cache_read: 0, cache_write: 0 },
      }),
    ).toEqual({ ok: true, costUsd: 5 });

    // An explicit context override wins over prompt-token inference.
    expect(
      calculateCostUsd({
        provider: "openai",
        model: "gpt-6.1-terra",
        tokens: aboveThreshold,
        contextTokens: 1_000,
      }),
    ).toEqual({ ok: true, costUsd: 7.3 });
  });
});

describe("catalog-aware pricing resolution", () => {
  it("blocks cross-provider fallback for a source catalog model without a cost", async () => {
    const nowMs = 1_800_000_000_000;
    const result = await maybeRefreshPricingSnapshot({
      nowMs,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: nowMs,
          providers: ["priced-source"],
          units: "USD per 1M tokens",
        },
        providers: {
          "priced-source": {
            "shared-model": { input: 10, output: 20 },
          },
        },
        catalog: {
          "priced-source": ["shared-model"],
          "unpriced-source": ["shared-model"],
        },
      },
    });

    expect(result.reason).toBe("selection_bundled");
    expect(resolvePricingKey({ providerID: "unpriced-source", modelID: "shared-model" })).toEqual({
      ok: true,
      method: "source_provider",
      key: { provider: "unpriced-source", model: "shared-model" },
    });

    expect(
      priceTokenBuckets({
        providerID: "unpriced-source",
        modelID: "shared-model",
        tokens: { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      }),
    ).toMatchObject({
      status: "unpriced",
      key: { provider: "unpriced-source", model: "shared-model" },
    });
  });

  it("still applies an explicit provider route alias for a catalog-present unpriced id", async () => {
    const nowMs = 1_800_000_000_000;
    await maybeRefreshPricingSnapshot({
      nowMs,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: nowMs,
          providers: ["opencode-go"],
          units: "USD per 1M tokens",
        },
        providers: {
          "opencode-go": {
            "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cache_read: 0.003 },
          },
        },
        catalog: {
          "opencode-go": ["deepseek-v4-flash", "deepseek-v4.1-flash"],
        },
      },
    });

    expect(resolvePricingKey({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })).toEqual({
      ok: true,
      method: "source_provider",
      key: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    });
  });

  it("keeps an unpriced vendor-prefixed source model out of priced provider heuristics", async () => {
    const nowMs = 1_800_000_000_000;
    await maybeRefreshPricingSnapshot({
      nowMs,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: nowMs,
          providers: ["google", "openrouter"],
          units: "USD per 1M tokens",
        },
        providers: {
          google: {
            "gemini-x": { input: 1.25, output: 10 },
          },
          openrouter: {
            "gemini-X": { input: 9, output: 11 },
            "some-priced-model": { input: 2, output: 4 },
          },
        },
        catalog: {
          google: ["gemini-x"],
          openrouter: ["gemini-X", "google/gemini-X", "some-priced-model"],
        },
      },
    });

    expect(resolvePricingKey({ providerID: "openrouter", modelID: "google/gemini-X" })).toEqual({
      ok: true,
      method: "source_provider",
      key: { provider: "openrouter", model: "google/gemini-X" },
    });

    expect(
      priceTokenBuckets({
        providerID: "openrouter",
        modelID: "google/gemini-X",
        tokens: { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      }),
    ).toMatchObject({
      status: "unpriced",
      key: { provider: "openrouter", model: "google/gemini-X" },
    });
  });

  it("keeps catalog-present unpriced variants out of free/thinking/preview heuristics", async () => {
    const nowMs = 1_800_000_000_000;
    await maybeRefreshPricingSnapshot({
      nowMs,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: nowMs,
          providers: ["google", "heuristic-labs"],
          units: "USD per 1M tokens",
        },
        providers: {
          google: {
            "gemini-3-pro-preview": { input: 5, output: 6 },
          },
          "heuristic-labs": {
            "base-model": { input: 1, output: 2 },
            reasoner: { input: 3, output: 4 },
          },
        },
        catalog: {
          google: ["gemini-3-pro", "gemini-3-pro-preview"],
          "heuristic-labs": ["base-model", "base-model-free", "reasoner", "reasoner-thinking"],
        },
      },
    });

    for (const [providerID, modelID] of [
      ["heuristic-labs", "base-model-free"],
      ["heuristic-labs", "reasoner-thinking"],
      ["google", "gemini-3-pro"],
    ] as const) {
      expect(resolvePricingKey({ providerID, modelID })).toEqual({
        ok: true,
        method: "source_provider",
        key: { provider: providerID, model: modelID },
      });

      expect(
        priceTokenBuckets({
          providerID,
          modelID,
          tokens: { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        }),
      ).toMatchObject({
        status: "unpriced",
        key: { provider: providerID, model: modelID },
      });
    }
  });
});

describe("retired union-alpha route pricing", () => {
  // models.dev added these two routes at zero rates and labeled them Free, then
  // removed them when the routes expired. Exact historical commits:
  // - https://github.com/sst/models.dev/commit/e3626b49388e2dbea382b91b81e9d4237c117402
  // - https://github.com/sst/models.dev/commit/75518776b9fb7e51d0de48b83469f6a6b4159415
  // - https://github.com/sst/models.dev/commit/14f892c0a44c0a0bcdf9805e7fd695402b4d4218
  const UNION_ALPHA_COST = { input: 0, output: 0, cache_read: 0 };
  const POSITIVE_TOKENS: TokenBuckets = {
    input: 1_000_000,
    output: 1_000_000,
    reasoning: 1_000_000,
    cache_read: 1_000_000,
    cache_write: 1_000_000,
  };

  it("prices both exact historical routes at zero for positive usage", () => {
    setPricingSnapshotSelection("bundled");

    for (const providerID of ["opencode", "opencode-go"] as const) {
      expect(lookupCost(providerID, "union-alpha")).toEqual(UNION_ALPHA_COST);
      expect(resolvePricingKey({ providerID, modelID: "union-alpha" })).toMatchObject({
        ok: true,
        method: "source_provider",
        key: { provider: providerID, model: "union-alpha" },
      });
      expect(
        calculateCostUsd({ provider: providerID, model: "union-alpha", tokens: POSITIVE_TOKENS }),
      ).toEqual({ ok: true, costUsd: 0 });
      expect(
        priceTokenBuckets({ providerID, modelID: "union-alpha", tokens: POSITIVE_TOKENS }),
      ).toEqual({
        status: "priced",
        key: { provider: providerID, model: "union-alpha" },
        costUsd: 0,
      });
    }
  });

  it("does not infer the retired route for other providers or ids", () => {
    setPricingSnapshotSelection("bundled");

    expect(lookupCost("openrouter", "union-alpha")).toBeNull();
    expect(
      priceTokenBuckets({
        providerID: "openrouter",
        modelID: "union-alpha",
        tokens: POSITIVE_TOKENS,
      }),
    ).toMatchObject({
      status: "unknown",
      unknown: {
        sourceProviderID: "openrouter",
        sourceModelID: "union-alpha",
        reason: "ambiguous_model",
      },
    });

    for (const providerID of ["opencode", "opencode-go"] as const) {
      expect(lookupCost(providerID, "union-alpha-old")).toBeNull();
      expect(resolvePricingKey({ providerID, modelID: "union-alpha-old" }).ok).toBe(false);
    }
  });

  it("keeps upstream present-unpriced precedence over the retired bundled route", async () => {
    const dirs = await tempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const bundled = JSON.parse(readFileSync(SNAPSHOT_URL, "utf8"));
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          opencode: { models: { "union-alpha": { cost: {} } } },
          "opencode-go": { models: { "union-alpha": { cost: {} } } },
        }),
        { status: 200 },
      ),
    );

    await maybeRefreshPricingSnapshot({
      nowMs,
      force: true,
      runtimeDirs: dirs,
      fetchFn,
      bootstrapSnapshotOverride: bundled,
    });

    expect(lookupCost("opencode", "union-alpha")).toBeNull();
    expect(lookupCost("opencode-go", "union-alpha")).toBeNull();
  });

  it("retains the retired route after an upstream removal and an offline refresh", async () => {
    const dirs = await tempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const bundled = JSON.parse(readFileSync(SNAPSHOT_URL, "utf8"));
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          opencode: {
            models: { "big-pickle": { cost: { input: 0, output: 0, cache_read: 0 } } },
          },
          "opencode-go": {
            models: { "beam-free": { cost: { input: 0, output: 0, cache_read: 0 } } },
          },
        }),
        { status: 200 },
      ),
    );

    await maybeRefreshPricingSnapshot({
      nowMs,
      force: true,
      runtimeDirs: dirs,
      fetchFn,
      bootstrapSnapshotOverride: bundled,
    });

    expect(lookupCost("opencode", "union-alpha")).toEqual(UNION_ALPHA_COST);
    expect(lookupCost("opencode-go", "union-alpha")).toEqual(UNION_ALPHA_COST);

    const offline = await maybeRefreshPricingSnapshot({
      nowMs: nowMs + 1,
      force: true,
      runtimeDirs: dirs,
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      bootstrapSnapshotOverride: bundled,
    });

    expect(offline).toMatchObject({ attempted: true, updated: false, error: "offline" });
    expect(lookupCost("opencode", "union-alpha")).toEqual(UNION_ALPHA_COST);
    expect(lookupCost("opencode-go", "union-alpha")).toEqual(UNION_ALPHA_COST);
  });
});

describe("models.dev refresh context tiers", () => {
  it("parses explicit context tiers, drops unsupported tiers, and makes one central request", async () => {
    vi.resetModules();
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    const dirs = await tempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://models.dev/api.json");
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-6.1-terra": {
                cost: {
                  ...GPT_61_TERRA_BASE,
                  reasoning: 1.5,
                  tiers: [
                    { ...GPT_61_TERRA_TIER, reasoning: 2.25 },
                    {
                      tier: { type: "batch", size: 1_000 },
                      input: 9,
                      output: 9,
                    },
                  ],
                  context_over_200k: {
                    input: 2,
                    output: 7.5,
                    cache_read: 0.1,
                    cache_write: 2.5,
                  },
                },
              },
              "malformed-tier": {
                cost: {
                  input: 1,
                  output: 2,
                  tiers: [
                    { tier: { type: "context", size: 0 }, input: 3, output: 4 },
                    { tier: { type: "context", size: 1_000 }, input: "3", output: 4 },
                  ],
                },
              },
            },
          },
          "opencode-go": {
            models: {
              "deepseek-v4.1-flash": {
                cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
              },
            },
          },
        }),
        { status: 200 },
      );
    });

    try {
      const result = await pricing.maybeRefreshPricingSnapshot({
        nowMs,
        force: true,
        runtimeDirs: dirs,
        fetchFn,
        maxAgeMs: 3 * DAY_MS,
        providerAllowlist: ["openai", "opencode-go"],
        bootstrapSnapshotOverride: {
          _meta: {
            source: "test",
            generatedAt: nowMs - 10 * DAY_MS,
            providers: [],
            units: "USD per 1M tokens",
          },
          providers: {},
        },
      });

      expect(result).toMatchObject({ attempted: true, updated: true });
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const persisted = JSON.parse(
        await readFile(pricing.getRuntimePricingSnapshotPath(dirs), "utf8"),
      );
      expect(persisted.providers.openai["gpt-6.1-terra"]).toEqual({
        ...GPT_61_TERRA_BASE,
        reasoning: 1.5,
        tiers: [{ ...GPT_61_TERRA_TIER, reasoning: 2.25 }],
      });
      expect(persisted.providers.openai["malformed-tier"]).toEqual({ input: 1, output: 2 });
      expect(persisted.providers["opencode-go"]["deepseek-v4.1-flash"]).toEqual({
        input: 0.15,
        output: 0.6,
        cache_read: 0.003,
      });

      // The refresh already applied the temp runtime selection in memory.
      expect(pricing.lookupCostAtContext("openai", "gpt-6.1-terra", 272_000)).toMatchObject({
        basis: "context_tier",
        tierSize: 272_000,
      });
      expect(pricing.lookupCost("openai", "gpt-6.1-terra")?.reasoning).toBe(1.5);
      expect(pricing.lookupCost("openai", "gpt-6.1-terra")?.tiers).toEqual([
        { ...GPT_61_TERRA_TIER, reasoning: 2.25 },
      ]);
      expect(pricing.lookupCostAtContext("openai", "gpt-6.1-terra", 272_000)?.rates).toEqual({
        input: 2,
        output: 7.5,
        cache_read: 0.1,
        cache_write: 2.5,
        reasoning: 2.25,
      });
      expect(pricing.lookupCost("openai", "malformed-tier")?.tiers).toBeUndefined();
    } finally {
      pricing.__resetPricingSnapshotForTests();
    }
  });
});

describe("partially known token rates", () => {
  const NOW_MS = 1_800_000_000_000;
  const tokens = (overrides: Partial<TokenBuckets> = {}): TokenBuckets => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    ...overrides,
  });

  beforeEach(async () => {
    await maybeRefreshPricingSnapshot({
      nowMs: NOW_MS,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: NOW_MS,
          providers: ["partial-labs"],
          units: "USD per 1M tokens",
        },
        providers: {
          "partial-labs": {
            "input-only": { input: 2 },
            "output-only": { output: 4 },
            "cache-only": { cache_read: 1 },
            "reasoning-only": { reasoning: 6 },
            "zero-cost": { input: 0, output: 0 },
            "zero-input-only": { input: 0 },
            complete: { input: 2, output: 4 },
          },
        },
      },
    });
  });

  it("retains known bucket cost and marks only the missing buckets unpriced", () => {
    const mixed = tokens({ input: 1_000_000, output: 1_000_000 });

    expect(
      priceTokenBuckets({ providerID: "partial-labs", modelID: "input-only", tokens: mixed }),
    ).toEqual({
      status: "partial",
      key: { provider: "partial-labs", model: "input-only" },
      costUsd: 2,
      unpricedTokens: 1_000_000,
    });
    expect(
      priceTokenBuckets({ providerID: "partial-labs", modelID: "output-only", tokens: mixed }),
    ).toEqual({
      status: "partial",
      key: { provider: "partial-labs", model: "output-only" },
      costUsd: 4,
      unpricedTokens: 1_000_000,
    });
    expect(
      calculateCostUsd({ provider: "partial-labs", model: "input-only", tokens: mixed }),
    ).toEqual({
      ok: true,
      costUsd: 2,
      unpricedTokens: 1_000_000,
    });
  });

  it("prices only mixes whose positive buckets have applicable rates", () => {
    const cases = [
      ["input-only", { input: 1_000_000 }, 2],
      ["output-only", { output: 1_000_000 }, 4],
      ["cache-only", { cache_read: 1_000_000 }, 1],
      ["reasoning-only", { reasoning: 1_000_000 }, 6],
      ["input-only", { cache_read: 1_000_000 }, 2],
      ["output-only", { reasoning: 1_000_000 }, 4],
      ["complete", { input: 1_000_000, output: 1_000_000 }, 6],
    ] as const;

    for (const [modelID, overrides, costUsd] of cases) {
      expect(
        priceTokenBuckets({ providerID: "partial-labs", modelID, tokens: tokens(overrides) }),
        `${modelID} ${JSON.stringify(overrides)}`,
      ).toEqual({
        status: "priced",
        key: { provider: "partial-labs", model: modelID },
        costUsd,
      });
    }
  });

  it("keeps explicit zero rates priced at zero", () => {
    expect(
      priceTokenBuckets({
        providerID: "partial-labs",
        modelID: "zero-cost",
        tokens: tokens({ input: 1_000_000, output: 1_000_000 }),
      }),
    ).toEqual({
      status: "priced",
      key: { provider: "partial-labs", model: "zero-cost" },
      costUsd: 0,
    });
  });

  it("marks a zero known cost partial when another bucket has no rate", () => {
    expect(
      priceTokenBuckets({
        providerID: "partial-labs",
        modelID: "zero-input-only",
        tokens: tokens({ input: 1_000_000, output: 1_000_000 }),
      }),
    ).toEqual({
      status: "partial",
      key: { provider: "partial-labs", model: "zero-input-only" },
      costUsd: 0,
      unpricedTokens: 1_000_000,
    });
  });

  it("does not invent cache or reasoning rates from a missing base rate", () => {
    const cases = [
      ["output-only", { cache_read: 1_000_000 }],
      ["input-only", { reasoning: 1_000_000 }],
      ["cache-only", { input: 1_000_000 }],
      ["reasoning-only", { output: 1_000_000 }],
    ] as const;

    for (const [modelID, overrides] of cases) {
      expect(
        priceTokenBuckets({ providerID: "partial-labs", modelID, tokens: tokens(overrides) }),
        `${modelID} ${JSON.stringify(overrides)}`,
      ).toMatchObject({
        status: "unpriced",
        key: { provider: "partial-labs", model: modelID },
      });
    }
  });
});
