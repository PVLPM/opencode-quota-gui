import { describe, expect, it } from "vitest";

import {
  getQuotaProviderIdsForRuntimeId,
  normalizeQuotaProviderId,
  QUOTA_PROVIDER_RUNTIME_IDS,
} from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { getProviders } from "../src/providers/registry.js";

const EXPECTED_PROVIDER_ORDER = [
  "anthropic",
  "claude-agent",
  "copilot",
  "openai",
  "openrouter",
  "kilo",
  "cursor",
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "synthetic",
  "chutes",
  "google-gemini-cli",
  "google-agy",
  "antigravity-cli",
  "zai",
  "zhipu",
  "nanogpt",
  "minimax-coding-plan",
  "minimax-china-coding-plan",
  "kimi-code-plan-global",
  "kimi-code-plan-cn",
  "deepseek",
  "mistral",
  "xai",
  "xiaomi",
  "opencode-go",
  "opencode",
  "ollama-cloud",
  "quota-providers",
] as const;

describe("provider registry", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["claude-agent", "claude-agent"],
    ["claude-code", "claude-agent"],
  ])("routes %s models and runtime IDs only to %s", (runtimeId, providerId) => {
    expect(getQuotaProviderIdsForRuntimeId(runtimeId)).toEqual([providerId]);
    expect(
      getProviders()
        .filter((provider) => provider.matchesCurrentModel(`${runtimeId}/model`))
        .map((provider) => provider.id),
    ).toEqual([providerId]);
    expect(normalizeQuotaProviderId(runtimeId)).toBe(providerId);
  });

  it("keeps every catalog provider exactly once in observable display order", () => {
    const first = getProviders();
    const second = getProviders();
    const ids = first.map((provider) => provider.id);

    expect(QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id)).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(ids).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(second.map((provider) => provider.id)).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(Object.keys(QUOTA_PROVIDER_RUNTIME_IDS)));
    expect(second).not.toBe(first);
    expect(second).toHaveLength(first.length);
    first.forEach((provider, index) => {
      expect(second[index]).toBe(provider);
    });
  });
});
