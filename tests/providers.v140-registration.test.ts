/**
 * Registration wiring for the two v1.4.0 subscription-quota providers.
 *
 * These assertions cover the places a new provider must be visible: the
 * implementation registry, the shared-cache classification, the provider
 * metadata catalog and the presentation catalog.
 */
import { describe, expect, it } from "vitest";

import { buildProviderCards } from "../src/gui/provider-cards.js";
import { detectQuotaNotifications } from "../src/gui/quota-notification-detector.js";
import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRuntimeIds,
  normalizeQuotaProviderId,
} from "../src/lib/provider-metadata.js";
import { DEFAULT_NATIVE_QUOTA_NOTIFICATION_POLICY } from "../src/lib/types.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";
import { resolveProviderPresentation } from "../src/ui/provider-catalog.js";

const NOW = Date.UTC(2026, 11, 2, 12, 0, 0);

describe("v1.4.0 provider registration", () => {
  it("binds both providers in the implementation registry", () => {
    const ids = getProviders().map((provider) => provider.id);
    expect(ids).toContain("mistral");
    expect(ids).toContain("antigravity-cli");
    for (const provider of getProviders()) {
      expect(provider.cachePolicy, provider.id).toBeDefined();
    }
  });

  it("classifies cache identity for each provider", () => {
    expect(PROVIDER_CACHE_POLICIES.mistral.kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES["antigravity-cli"]).toEqual({ kind: "uncached" });
  });

  it("exposes the catalog, labels and synonyms", () => {
    expect(getQuotaProviderDisplayLabel("mistral")).toBe("Mistral Vibe");
    expect(getQuotaProviderDisplayLabel("antigravity-cli")).toBe("Antigravity CLI");
    expect(normalizeQuotaProviderId("vibe")).toBe("mistral");
    expect(normalizeQuotaProviderId("mistral-vibe")).toBe("mistral");
    expect(normalizeQuotaProviderId("agy")).toBe("antigravity-cli");
    expect(normalizeQuotaProviderId("antigravity")).toBe("antigravity-cli");
  });

  it("claims only its own runtime ids", () => {
    expect(getQuotaProviderIdsForRuntimeId("mistral")).toEqual(["mistral"]);
    // The CLI has no OpenCode runtime id: nothing else may route through it.
    expect(getQuotaProviderIdsForRuntimeId("agy")).toEqual([]);
    expect(getQuotaProviderIdsForRuntimeId("antigravity-cli")).toEqual([]);
    expect(getQuotaProviderRuntimeIds("antigravity-cli")).toEqual([]);
  });

  it("resolves presentation without inventing a logo path", () => {
    // Mistral API models keep the upstream catalog label; the quota card's own
    // name comes from provider registration.
    expect(resolveProviderPresentation("mistral").label).toBe("Mistral");
    expect(resolveProviderPresentation("mistral-vibe").label).toBe("Mistral Vibe");
    expect(resolveProviderPresentation("mistral-vibe").logoSrc).toBe(
      "/assets/providers/mistral.svg",
    );

    const cli = resolveProviderPresentation("antigravity-cli");
    expect(cli.label).toBe("Antigravity CLI");
    expect(cli.logoSrc).toMatch(/^\/assets\/providers\/[a-z0-9][a-z0-9.-]*\.svg$/u);
  });
});

describe("v1.4.0 provider notification policy", () => {
  it("keeps budget-meter rows out of low and exhausted notifications", () => {
    const budgetCard = (percentRemaining: number) =>
      buildProviderCards({
        probes: [
          {
            providerId: "mistral",
            result: {
              attempted: true,
              errors: [],
              entries: [
                {
                  accounting: {
                    resultType: "budget",
                    acquisitionMethod: "remote_api",
                    ownership: "maintained",
                    authority: "provider_reported",
                    observedAtIso: "2026-12-02T12:00:00.000Z",
                  },
                  name: "Mistral Vibe Vibe budget",
                  label: "Vibe budget:",
                  percentRemaining,
                  semantic: {
                    metric: { kind: "named", name: "Vibe budget" },
                    prominence: "primary",
                  },
                },
              ],
            },
          },
        ],
        preferences: { accountingDetail: "summary" },
        nowMs: NOW,
      })[0];

    // Same policy outcome as OpenCode Zen's monthly budget row: only `quota`
    // and `rate_limit` percent rows alarm.
    const policy = { ...DEFAULT_NATIVE_QUOTA_NOTIFICATION_POLICY, duplicateCooldownMinutes: 0 };
    const first = detectQuotaNotifications({ cards: [budgetCard(100)!], policy, nowMs: NOW });
    expect(first.notifications).toEqual([]);
    const second = detectQuotaNotifications({
      cards: [budgetCard(0)!],
      policy,
      state: first.state,
      cooldowns: first.cooldowns,
      nowMs: NOW + 60_000,
    });
    expect(second.notifications).toEqual([]);
  });
});
