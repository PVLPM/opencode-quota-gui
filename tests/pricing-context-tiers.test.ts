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
  setPricingSnapshotSelection,
} from "../src/lib/modelsdev-pricing.js";
import { calculateCostUsd, priceTokenBuckets, resolvePricingKey } from "../src/lib/quota-stats.js";

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
