import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsModel } from "../src/gui/analytics-model.js";
import { getAnalyticsPricingFingerprint } from "../src/gui/analytics-pricing-revision.js";
import {
  CLAUDE_AGENT_PRICING_ALIASES,
  getModelAliasEvidenceFingerprint,
  getRuntimeModelAliasEvidencePath,
  isClaudeAgentPricingAlias,
  readModelAliasEvidenceSync,
  recordClaudeAgentModelEvidence,
} from "../src/lib/model-alias-evidence.js";
import {
  __resetPricingSnapshotForTests,
  maybeRefreshPricingSnapshot,
} from "../src/lib/modelsdev-pricing.js";
import type { PricingResolution } from "../src/lib/quota-stats.js";
import {
  priceTokenBuckets,
  priceTokenBucketsWithRecordedCost,
  resolvePricingKey,
} from "../src/lib/quota-stats.js";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const TOKENS = { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
const TEMP_ROOTS: string[] = [];

async function loadSnapshot(params: {
  prices?: Record<string, { input?: number; output?: number }>;
  names?: Record<string, string>;
  catalog?: string[];
  legacy?: boolean;
}): Promise<void> {
  const prices = params.prices ?? {
    "claude-opus-5-5": { input: 1, output: 2 },
    "claude-opus-5-6": { input: 10, output: 20 },
  };
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
      providers: { anthropic: prices },
      catalog: { anthropic: params.catalog ?? Object.keys(prices) },
      ...(params.names ? { names: { anthropic: params.names } } : {}),
    },
  });
}

async function recordOpusEvidence(name: string): Promise<void> {
  await recordClaudeAgentModelEvidence([{ providerID: "claude-agent", id: "opus", name }]);
}

async function writeSidecar(raw: unknown): Promise<string> {
  const path = getRuntimeModelAliasEvidencePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(raw), "utf8");
  return path;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-alias-"));
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

describe("dynamic Claude Agent alias pricing", () => {
  it("persists the resolved target and moves an unversioned alias", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });

    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });

    await recordOpusEvidence("Opus 5.6");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      name: "Opus 5.6",
      resolvedModelID: "claude-opus-5-6",
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "priced", costUsd: 10 });
  });

  it("keeps concrete ids and direct Anthropic aliases out of the dynamic step", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    expect(
      resolvePricingKey({ providerID: "claude-agent", modelID: "claude-opus-5-5" }),
    ).toMatchObject({
      ok: true,
      method: "source_provider",
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(resolvePricingKey({ providerID: "anthropic", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(CLAUDE_AGENT_PRICING_ALIASES).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(isClaudeAgentPricingAlias("fable")).toBe(true);
  });

  it("uses the static fallback when an ambiguous catalog match includes the static target", async () => {
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
    await recordOpusEvidence("Opus 5.5");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      resolvedModelID: null,
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "priced", costUsd: 1 });
  });

  it("does not use an older static price when an ambiguous match establishes a new generation", async () => {
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
    await recordOpusEvidence("Opus 5.6");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      resolvedModelID: null,
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: false,
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "unknown" });
    expect(
      priceTokenBucketsWithRecordedCost({
        providerID: "claude-agent",
        modelID: "opus",
        tokens: TOKENS,
        recordedCostUsd: 0.42,
      }),
    ).toEqual({ status: "recorded_cost", costUsd: 0.42, recordedTokens: 1_000_000 });
  });

  it("persists an explicit ambiguous marker instead of keeping the previous dynamic price", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.5" },
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
    ]);

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({ ambiguous: true });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });
  });

  it("keeps last confirmed resolution for later runs after the catalog moves", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    await loadSnapshot({
      prices: { "claude-opus-5-5": { input: 1, output: 2 } },
      names: { "claude-opus-5-5": "Claude Opus 5.5" },
    });

    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({ status: "unknown" });
  });

  it("keeps the static fallback when the snapshot has no name coverage", async () => {
    await loadSnapshot({
      legacy: true,
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      name: "Opus 5.6",
      catalogObserved: false,
    });
    expect(readModelAliasEvidenceSync()?.aliases.opus?.resolvedModelID).toBeUndefined();
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-5" },
    });
  });

  it("keeps a last confirmed resolution when a later observation has no catalog coverage", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");
    const fingerprint = getModelAliasEvidenceFingerprint();

    await loadSnapshot({
      legacy: true,
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    expect(getModelAliasEvidenceFingerprint()).toBe(fingerprint);
    expect(readModelAliasEvidenceSync()?.aliases.opus?.resolvedModelID).toBe("claude-opus-5-6");
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
  });

  it("reads version 1 name-only evidence and resolves it against a covered catalog", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await writeSidecar({
      version: 1,
      updatedAt: NOW,
      aliases: { opus: { name: "Opus 5.6" } },
    });

    expect(readModelAliasEvidenceSync()?.version).toBe(2);
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
  });

  it("reads version 2 evidence that carries only a resolved target", async () => {
    await loadSnapshot({ legacy: true });
    await writeSidecar({
      version: 2,
      updatedAt: NOW,
      aliases: {
        opus: { resolvedModelID: "claude-opus-5-7", catalogObserved: true },
      },
    });

    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-7" },
    });
  });

  it("leaves a matched target unpriced instead of using an older static price", async () => {
    await loadSnapshot({
      prices: { "claude-opus-5-5": { input: 1, output: 2 } },
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-7": "Claude Opus 5.7",
      },
      catalog: ["claude-opus-5-5", "claude-opus-5-7"],
    });
    await recordOpusEvidence("Opus 5.7");

    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      key: { provider: "anthropic", model: "claude-opus-5-7" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "opus", tokens: TOKENS }),
    ).toMatchObject({
      status: "unpriced",
      key: { provider: "anthropic", model: "claude-opus-5-7" },
    });
    expect(
      priceTokenBucketsWithRecordedCost({
        providerID: "claude-agent",
        modelID: "opus",
        tokens: TOKENS,
        recordedCostUsd: 0.42,
      }),
    ).toEqual({ status: "recorded_cost", costUsd: 0.42, recordedTokens: 1_000_000 });
  });

  it("returns unknown when current evidence names a target the covered catalog lacks", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.8");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      resolvedModelID: null,
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: false,
    });
    expect(
      priceTokenBucketsWithRecordedCost({
        providerID: "claude-agent",
        modelID: "opus",
        tokens: TOKENS,
        recordedCostUsd: 0.42,
      }),
    ).toEqual({ status: "recorded_cost", costUsd: 0.42, recordedTokens: 1_000_000 });
  });

  it("writes version 2 evidence atomically and ignores malformed files", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    const path = getRuntimeModelAliasEvidencePath();
    expect(path).toContain(join("opencode", "opencode-quota-gui"));
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      aliases: {
        opus: {
          name: "Opus 5.6",
          resolvedModelID: "claude-opus-5-6",
          catalogObserved: true,
        },
      },
    });

    await writeFile(path, "{not json", "utf8");
    expect(readModelAliasEvidenceSync()).toBeNull();
  });

  it("does not write evidence when an in-flight observation is aborted", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });

    let checks = 0;
    await recordClaudeAgentModelEvidence(
      [{ providerID: "claude-agent", id: "opus", name: "Opus 5.6" }],
      {
        // First check passes; disposal during observation must block the write.
        shouldAbort: () => checks++ > 0,
      },
    );

    expect(checks).toBeGreaterThanOrEqual(2);
    expect(existsSync(getRuntimeModelAliasEvidencePath())).toBe(false);
  });

  it("rebuilds cached analytics when resolved or ambiguous sidecar evidence changes", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    const sessions = {
      ses_alias: { id: "ses_alias", projectID: "p_alias", time: { created: NOW - 1_000 } },
    };
    const projects = { p_alias: { id: "p_alias", directories: [], worktrees: [] } };
    const row = {
      sessionID: "ses_alias",
      messageID: "msg_alias",
      createdAtMs: NOW - 2_000,
      completedAtMs: NOW - 1_000,
      providerID: "claude-agent",
      modelID: "opus",
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const model = createAnalyticsModel();
    const applyWorker = () => {
      model.clear();
      model.setMetadata(sessions, projects);
      model.apply([row], []);
      return model.home("24h", NOW).usage.totals.apiEquivalentCostUsd;
    };

    const initialFingerprint = getAnalyticsPricingFingerprint();
    expect(applyWorker()).toBe(1);

    await recordOpusEvidence("Opus 5.6");
    const resolvedFingerprint = getAnalyticsPricingFingerprint();
    expect(resolvedFingerprint).toBe(getAnalyticsPricingFingerprint());
    expect(resolvedFingerprint).not.toBe(initialFingerprint);
    expect(applyWorker()).toBe(10);

    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "opus", name: "Opus 5.5" },
      { providerID: "claude-agent", id: "opus", name: "Opus 5.6" },
    ]);
    expect(getAnalyticsPricingFingerprint()).not.toBe(resolvedFingerprint);
    expect(getModelAliasEvidenceFingerprint()).not.toBe("");
    expect(applyWorker()).toBe(1);
  });

  it("keeps the raw source identity while applying the resolved price", async () => {
    await loadSnapshot({
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    await recordOpusEvidence("Opus 5.6");

    const cache = new Map<string, PricingResolution>();
    const priced = priceTokenBuckets({
      providerID: "claude-agent",
      modelID: "opus",
      tokens: TOKENS,
      cache,
    });
    expect(priced).toMatchObject({
      status: "priced",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
    expect(priced.status === "priced" ? priced.key : null).not.toEqual({
      provider: "claude-agent",
      model: "opus",
    });
  });

  it("recovers an unresolved alias after the catalog gains its target, repricing cached analytics", async () => {
    await loadSnapshot({
      prices: { "claude-opus-5-5": { input: 1, output: 2 } },
      names: { "claude-opus-5-5": "Claude Opus 5.5" },
      catalog: ["claude-opus-5-5"],
    });
    await recordOpusEvidence("Opus 5.6");

    expect(readModelAliasEvidenceSync()?.aliases.opus).toMatchObject({
      name: "Opus 5.6",
      resolvedModelID: null,
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: false,
    });

    const sessions = {
      ses_alias: { id: "ses_alias", projectID: "p_alias", time: { created: NOW - 1_000 } },
    };
    const projects = { p_alias: { id: "p_alias", directories: [], worktrees: [] } };
    const row = {
      sessionID: "ses_alias",
      messageID: "msg_alias",
      createdAtMs: NOW - 2_000,
      completedAtMs: NOW - 1_000,
      providerID: "claude-agent",
      modelID: "opus",
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const model = createAnalyticsModel();
    const applyWorker = () => {
      model.clear();
      model.setMetadata(sessions, projects);
      model.apply([row], []);
      return model.home("24h", NOW).usage.totals.apiEquivalentCostUsd;
    };

    const initialFingerprint = getAnalyticsPricingFingerprint();
    expect(applyWorker()).toBeNull();

    // A later catalog refresh supplies the target name and tariff. No new
    // Claude Agent observation is recorded.
    await loadSnapshot({
      prices: {
        "claude-opus-5-5": { input: 1, output: 2 },
        "claude-opus-5-6": { input: 10, output: 20 },
      },
      names: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
      catalog: ["claude-opus-5-5", "claude-opus-5-6"],
    });

    expect(getAnalyticsPricingFingerprint()).not.toBe(initialFingerprint);
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "opus" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-opus-5-6" },
    });
    expect(applyWorker()).toBe(10);
    // Recovery is resolver-side; the last observation stays last-confirmed.
    expect(readModelAliasEvidenceSync()?.aliases.opus?.resolvedModelID).toBeNull();
  });

  it("prices fable from unique native evidence without inventing a static fallback", async () => {
    await loadSnapshot({
      prices: {
        "claude-fable-5-1": { input: 10, output: 50 },
        "claude-fable-5-2": { input: 8, output: 40 },
      },
      names: {
        "claude-fable-5-1": "Claude Fable 5.1",
        "claude-fable-5-2": "Claude Fable 5.2",
      },
      catalog: ["claude-fable-5-1", "claude-fable-5-2"],
    });

    // Without native evidence there is no declared static fable target, so the
    // route stays unpriced rather than guessing a generation.
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "fable" })).toMatchObject({
      ok: false,
    });
    expect(
      priceTokenBucketsWithRecordedCost({
        providerID: "claude-agent",
        modelID: "fable",
        tokens: TOKENS,
        recordedCostUsd: 0.42,
      }),
    ).toEqual({ status: "recorded_cost", costUsd: 0.42, recordedTokens: 1_000_000 });

    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "fable", name: "Fable 5.2" },
    ]);
    expect(readModelAliasEvidenceSync()?.aliases.fable).toMatchObject({
      name: "Fable 5.2",
      resolvedModelID: "claude-fable-5-2",
      catalogObserved: true,
    });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "fable" })).toMatchObject({
      ok: true,
      method: "alias_evidence",
      key: { provider: "anthropic", model: "claude-fable-5-2" },
    });
    expect(
      priceTokenBuckets({ providerID: "claude-agent", modelID: "fable", tokens: TOKENS }),
    ).toMatchObject({ status: "priced", costUsd: 8 });

    // Native ambiguity has no static fable value to fall back to.
    await recordClaudeAgentModelEvidence([
      { providerID: "claude-agent", id: "fable", name: "Fable 5.1" },
      { providerID: "claude-agent", id: "fable", name: "Fable 5.2" },
    ]);
    expect(readModelAliasEvidenceSync()?.aliases.fable).toMatchObject({ ambiguous: true });
    expect(resolvePricingKey({ providerID: "claude-agent", modelID: "fable" })).toMatchObject({
      ok: false,
    });
  });
});
