/**
 * The existing quota cycle must carry genuine measurement identity out of the
 * snapshot without adding DTO fields: provider observation time when supplied,
 * otherwise the provider result's propagated fetch timestamp.
 */
import { describe, expect, it } from "vitest";

import { buildProviderScopeCardId } from "../src/gui/identity.js";
import { quotaObservationCycle } from "../src/gui/quota-observation.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaProvider } from "../src/lib/entries.js";
import { markQuotaResultMeasuredAt } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function config(): QuotaToastConfig {
  return { ...DEFAULT_CONFIG, enabledProviders: ["alpha"] };
}

const provider = {
  id: "alpha",
  cachePolicy: { kind: "account-neutral" },
  isAvailable: async () => true,
  fetch: async () => ({ attempted: true, entries: [], errors: [] }),
} as unknown as QuotaProvider;

async function cycleFor(observedAtIso?: string) {
  const entry = {
    accounting: { ...ACCOUNTING, ...(observedAtIso !== undefined ? { observedAtIso } : {}) },
    semantic: { metric: { kind: "window", window: "five_hour" }, prominence: "primary" },
    name: "5h",
    percentRemaining: 70,
  };
  const result = markQuotaResultMeasuredAt({ attempted: true, entries: [entry], errors: [] }, BASE);
  const source = createDashboardReadSource({
    client: {} as never,
    workspaceRoot: process.cwd(),
    loadConfig: async () => config(),
    providers: [provider],
    collectProviderResults: async () => [{ providerId: "alpha", result }],
  });
  const snapshot = await source.quota();
  return quotaObservationCycle(snapshot);
}

describe("quota cycle measurement identity", () => {
  it("maps the provider result fetch timestamp to the card", async () => {
    const cycle = await cycleFor();
    expect(cycle?.providerIds).toEqual(["alpha"]);
    expect(cycle?.intervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(cycle?.measuredAtByCard.get(buildProviderScopeCardId("alpha"))).toBe(BASE);
  });

  it("prefers a provider-supplied accounting observation time", async () => {
    const observedAt = new Date(BASE - 5_000).toISOString();
    const cycle = await cycleFor(observedAt);
    expect(cycle?.measuredAtByCard.get(buildProviderScopeCardId("alpha"))).toBe(BASE - 5_000);
  });
});
