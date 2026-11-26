import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeModelAliasEvidencePath,
  recordClaudeAgentModelEvidence,
} from "../src/lib/model-alias-evidence.js";
import {
  __resetPricingSnapshotForTests,
  maybeRefreshPricingSnapshot,
} from "../src/lib/modelsdev-pricing.js";
import {
  priceTokenBuckets,
  resolveAliasPricingProvenance,
  resolvePricingKey,
} from "../src/lib/quota-stats.js";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const TOKENS = { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
const TEMP_ROOTS: string[] = [];

const ALL_PRICES = {
  "claude-opus-5-5": { input: 1, output: 2 },
  "claude-opus-5-6": { input: 10, output: 20 },
  "claude-sonnet-5-5": { input: 3, output: 15 },
  "claude-sonnet-5-6": { input: 4, output: 16 },
  "claude-haiku-5-5": { input: 1, output: 5 },
  "claude-haiku-5-6": { input: 2, output: 6 },
  "claude-fable-5-2": { input: 8, output: 40 },
};
const ALL_NAMES = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-opus-5-6": "Claude Opus 5.6",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-sonnet-5-6": "Claude Sonnet 5.6",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-haiku-5-6": "Claude Haiku 5.6",
  "claude-fable-5-2": "Claude Fable 5.2",
};

async function loadSnapshot(params: {
  prices?: Record<string, { input?: number; output?: number }>;
  names?: Record<string, string>;
  catalog?: string[];
  legacy?: boolean;
}): Promise<void> {
  await maybeRefreshPricingSnapshot({
    nowMs: NOW,
    fetchFn: vi.fn(),
    snapshotSelection: "bundled",
    bootstrapSnapshotOverride: {
      _meta: {
        source: "test-bootstrap",
        generatedAt: NOW,
        providers: ["anthropic"],
        units: "USD per 1M tokens",
        ...(params.legacy ? {} : { namesVersion: 1 }),
      },
      providers: { anthropic: params.prices ?? ALL_PRICES },
      catalog: { anthropic: params.catalog ?? Object.keys(params.prices ?? ALL_PRICES) },
      ...(params.names ? { names: { anthropic: params.names } } : {}),
    },
  });
}

async function writeSidecar(aliases: unknown): Promise<void> {
  const path = getRuntimeModelAliasEvidencePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, updatedAt: NOW, aliases }), "utf8");
}

function provenance(providerID: string, modelID: string) {
  return resolvePricingKey({ providerID, modelID }).aliasPricing;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-alias-provenance-"));
  TEMP_ROOTS.push(root);
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});

afterEach(async () => {
  __resetPricingSnapshotForTests();
  vi.unstubAllEnvs();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Claude Agent alias pricing provenance", () => {
  it("labels a current catalog resolution for all four aliases", async () => {
    await loadSnapshot({ names: ALL_NAMES });
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
      { providerID: "claude-agent", id: "sonnet", name: "Sonnet 5.6" },
      { providerID: "claude-agent", id: "haiku", name: "Haiku 5.6" },
      { providerID: "claude-agent", id: "fable", name: "Fable 5.2" },
    ]);

    expect(provenance("claude-agent", "opus")).toEqual({
      alias: "opus",
      state: "catalog",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    });
    expect(provenance("claude-agent", "sonnet")).toMatchObject({
      state: "catalog",
      targetModelId: "claude-sonnet-5-6",
      targetName: "Sonnet 5.6",
      priced: true,
    });
    expect(provenance("claude-agent", "haiku")).toMatchObject({
      state: "catalog",
      targetModelId: "claude-haiku-5-6",
      targetName: "Haiku 5.6",
      priced: true,
    });
    expect(provenance("claude-agent", "fable")).toMatchObject({
      state: "catalog",
      targetModelId: "claude-fable-5-2",
      targetName: "Fable 5.2",
      priced: true,
    });
    expect(provenance("claude-agent", "opus")?.unavailableReason).toBeUndefined();
  });

  it("labels a persisted target without catalog coverage as last confirmed", async () => {
    await loadSnapshot({ legacy: true, names: ALL_NAMES });
    await writeSidecar({
      opus: { name: "Opus 5.6", resolvedModelID: "claude-opus-5-6", catalogObserved: false },
    });

    expect(provenance("claude-agent", "opus")).toEqual({
      alias: "opus",
      state: "last-confirmed",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    });
  });

  it("labels a target saved without a name but resolved as last confirmed", async () => {
    await loadSnapshot({ legacy: true, names: ALL_NAMES });
    await writeSidecar({
      sonnet: { resolvedModelID: "claude-sonnet-5-6", catalogObserved: false },
    });

    expect(provenance("claude-agent", "sonnet")).toEqual({
      alias: "sonnet",
      state: "last-confirmed",
      targetProviderId: "anthropic",
      targetModelId: "claude-sonnet-5-6",
      targetName: "Claude Sonnet 5.6",
      priced: true,
    });
  });

  it("keeps a saved target catalog-labeled only while the active catalog corroborates it", async () => {
    await loadSnapshot({ names: ALL_NAMES });
    await writeSidecar({
      opus: { name: "Opus 5.6", resolvedModelID: "claude-opus-5-6", catalogObserved: true },
    });

    expect(provenance("claude-agent", "opus")).toMatchObject({
      state: "catalog",
      targetModelId: "claude-opus-5-6",
      priced: true,
    });

    // The stored catalogObserved bit is not proof once the catalog moves away.
    await loadSnapshot({ names: { "claude-opus-5-5": "Claude Opus 5.5" } });
    expect(provenance("claude-agent", "opus")).toMatchObject({
      state: "last-confirmed",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    });
  });

  it("keeps a same-name observation last confirmed after coverage loss", async () => {
    await loadSnapshot({ names: ALL_NAMES });
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
    ]);

    await loadSnapshot({ legacy: true });
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
    ]);

    expect(provenance("claude-agent", "opus")).toEqual({
      alias: "opus",
      state: "last-confirmed",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
  });

  it("marks a resolved target without rates as not estimated", async () => {
    await loadSnapshot({
      prices: { "claude-opus-5-5": { input: 1, output: 2 } },
      catalog: ["claude-opus-5-5", "claude-opus-5-6"],
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await writeSidecar({
      opus: { name: "Opus 5.6", resolvedModelID: "claude-opus-5-6", catalogObserved: true },
    });

    const alias = provenance("claude-agent", "opus");
    expect(alias).toEqual({
      alias: "opus",
      state: "catalog",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: false,
    });
    expect(alias?.priced).not.toBe(true);
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "unpriced" });
  });

  it("labels the static fallback for opus, sonnet and haiku", async () => {
    await loadSnapshot({ names: ALL_NAMES });

    for (const [alias, target] of [
      ["opus", "claude-opus-5-5"],
      ["sonnet", "claude-sonnet-5-5"],
      ["haiku", "claude-haiku-5-5"],
    ] as const) {
      expect(provenance("claude-agent", alias)).toEqual({
        alias,
        state: "static-fallback",
        targetProviderId: "anthropic",
        targetModelId: target,
        priced: true,
      });
      expect(resolvePricingKey({ providerID: "claude-agent", modelID: alias })).toMatchObject({
        ok: true,
        method: "source_provider",
        key: { provider: "anthropic", model: target },
      });
    }
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "priced", costUsd: 1 });
  });

  it("labels fable unavailable with no static target or evidence", async () => {
    await loadSnapshot({ names: ALL_NAMES });

    expect(provenance("claude-agent", "fable")).toEqual({
      alias: "fable",
      state: "unavailable",
      unavailableReason: "missing",
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "fable" })).toMatchObject({
      ok: false,
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "fable", tokens: TOKENS }),
    ).toMatchObject({ status: "unknown" });
  });

  it("labels ambiguous native evidence unavailable when no static target exists", async () => {
    await loadSnapshot({ names: ALL_NAMES });
    await writeSidecar({ fable: { ambiguous: true, catalogObserved: true, observedAt: NOW } });

    expect(provenance("claude-agent", "fable")).toEqual({
      alias: "fable",
      state: "unavailable",
      unavailableReason: "ambiguous",
    });
  });

  it("labels an ambiguous catalog match unavailable when it excludes the static target", async () => {
    await loadSnapshot({
      prices: {
        "claude-opus-5-5": { input: 1, output: 2 },
        "claude-opus-5-6": { input: 10, output: 20 },
        "claude-opus-5-6-preview": { input: 30, output: 40 },
      },
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
        "claude-opus-5-6-preview": "Claude Opus 5.6",
      },
    });
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
    ]);

    expect(provenance("claude-agent", "opus")).toEqual({
      alias: "opus",
      state: "unavailable",
      unavailableReason: "ambiguous",
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: false,
    });
  });

  it("keeps the agreed static fallback for an ambiguous match that includes it", async () => {
    await loadSnapshot({
      prices: {
        "claude-opus-5-5": { input: 1, output: 2 },
        "claude-opus-5-5-preview": { input: 3, output: 4 },
      },
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-5-preview": "Claude Opus 5.5",
      },
    });
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.5" },
    ]);

    expect(provenance("claude-agent", "opus")).toEqual({
      alias: "opus",
      state: "static-fallback",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-5",
      priced: true,
    });
  });

  it("exposes the provenance helper only for raw claude-agent aliases", async () => {
    await loadSnapshot({ names: ALL_NAMES });

    expect(
      resolveAliasPricingProvenance({ providerID: "claude-agent", modelID: "opus" }),
    ).toMatchObject({ state: "static-fallback" });
    // Direct Anthropic aliases, concrete model ids and other providers keep the
    // generic resolver path with no alias provenance.
    expect(
      resolveAliasPricingProvenance({ providerID: "anthropic", modelID: "opus" }),
    ).toBeUndefined();
    expect(
      resolveAliasPricingProvenance({ providerID: "claude-agent", modelID: "claude-opus-5-5" }),
    ).toBeUndefined();
    expect(
      resolveAliasPricingProvenance({ providerID: "openai", modelID: "gpt-5" }),
    ).toBeUndefined();
  });
});
