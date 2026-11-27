/**
 * The existing quota cycle must carry genuine measurement identity out of the
 * snapshot without adding DTO fields: provider observation time when supplied,
 * otherwise the provider result's propagated fetch timestamp.
 */
import { describe, expect, it } from "vitest";
import { rowIdForEntry } from "../src/contracts/identity.js";
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
    expect(cycle?.attemptedAtMs).toBeTypeOf("number");
    expect(cycle?.measuredAtByCard.get(buildProviderScopeCardId("alpha"))).toBe(BASE);
  });

  it("prefers a provider-supplied accounting observation time", async () => {
    const observedAt = new Date(BASE - 5_000).toISOString();
    const cycle = await cycleFor(observedAt);
    expect(cycle?.measuredAtByCard.get(buildProviderScopeCardId("alpha"))).toBe(BASE - 5_000);
  });

  it("carries reset precision and percent-row capacity outside the DTO", async () => {
    const entry = {
      accounting: ACCOUNTING,
      semantic: {
        metric: { kind: "window" as const, window: "five_hour" as const },
        prominence: "primary" as const,
      },
      name: "5h",
      percentRemaining: 70,
      resetTimeIso: new Date(BASE + 60 * 60_000).toISOString(),
      resetPrecision: "estimated" as const,
      basis: {
        limit: {
          quantity: { decimal: "100", unit: { kind: "count" as const, unit: "request" as const } },
          authority: "provider_reported" as const,
        },
      },
    };
    const result = markQuotaResultMeasuredAt(
      { attempted: true, entries: [entry], errors: [] },
      BASE,
    );
    const source = createDashboardReadSource({
      client: {} as never,
      workspaceRoot: process.cwd(),
      loadConfig: async () => config(),
      providers: [provider],
      collectProviderResults: async () => [{ providerId: "alpha", result }],
    });
    const snapshot = await source.quota();
    const cycle = quotaObservationCycle(snapshot);
    const cardId = buildProviderScopeCardId("alpha");
    const rowId = rowIdForEntry(cardId, entry);
    expect(cycle?.resetPrecisionByRow?.get(rowId)).toBe("estimated");
    expect(cycle?.capacityKeyByRow?.get(rowId)).toContain(
      'limit:100:{"kind":"count","unit":"request"}',
    );
    // The projected row still carries no provider-specific evidence fields.
    const row = snapshot.providers.cards[0]?.rows[0];
    expect(row).not.toHaveProperty("resetPrecision");
    expect(row).not.toHaveProperty("basis");
  });
});
