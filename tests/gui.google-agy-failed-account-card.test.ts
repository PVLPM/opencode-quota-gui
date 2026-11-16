import { afterEach, describe, expect, it, vi } from "vitest";

import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaProvider } from "../src/lib/entries.js";
import { queryGoogleAgyQuota } from "../src/lib/google-agy.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG, type GoogleAgyQuotaBucket } from "../src/lib/types.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-state-agy-dashboard-tests";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

vi.mock("../src/lib/google-agy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/google-agy.js")>();
  return {
    ...actual,
    hasAgyQuotaRuntimeAvailable: vi.fn(async () => true),
    inspectAgyAuthPresence: vi.fn(async () => ({
      state: "present",
      sourceKey: "google-agy",
      accountCount: 2,
      validAccountCount: 2,
    })),
    queryGoogleAgyQuota: vi.fn(),
  };
});

vi.mock("../src/lib/google-agy-companion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/google-agy-companion.js")>();
  return {
    ...actual,
    inspectAgyCompanionPresence: vi.fn(async () => ({
      state: "missing",
      error: "not installed",
    })),
  };
});

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-auth.js")>();
  return {
    ...actual,
    readCredentialRows: vi.fn(async () => []),
  };
});

function bucket(
  accountIndex: number,
  accountEmail: string | undefined,
  percentRemaining: number,
): GoogleAgyQuotaBucket {
  return {
    family: "Gemini Models",
    window: "weekly",
    windowLabel: "Weekly",
    bucketId: "gemini-weekly",
    remainingFraction: percentRemaining / 100,
    percentRemaining,
    ...(accountEmail ? { accountEmail } : {}),
    accountIndex,
    sourceKey: "google-agy",
  };
}

function dashboardSource(cacheIdentity: string) {
  const provider: QuotaProvider = {
    ...googleAgyProvider,
    cachePolicy: {
      kind: "resolved-auth",
      resolveIdentity: async () => cacheIdentity as never,
    },
  };
  return createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "/synthetic-workspace",
    configDir: "/synthetic-config",
    timeZone: "UTC",
    loadConfig: async () => ({ ...DEFAULT_CONFIG, enabledProviders: ["google-agy"] }),
    providers: [provider],
    now: () => Date.parse("2026-11-13T12:00:00.000Z"),
  });
}

describe("legacy AGY failed-account dashboard cards", () => {
  afterEach(() => {
    __resetQuotaStateForTests();
    vi.mocked(queryGoogleAgyQuota).mockReset();
  });

  it("keeps quota-state fallback rows and errors on the same stable account card", async () => {
    const retryAtMs = Date.now() + 60_000;
    vi.mocked(queryGoogleAgyQuota)
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, "alice@example.com", 70), bucket(1, "bob@example.com", 40)],
      })
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, "alice@example.com", 65)],
        errors: [
          {
            email: "bob@example.com",
            accountIndex: 1,
            error: "Google AGY quota API error: 429",
            failureCategory: "provider_api",
            retryAtMs,
          },
        ],
      });

    const source = dashboardSource("agy-dashboard-test");
    const first = await source.quota();
    const refreshed = await source.quota({ refresh: true });

    expect(first.providers.cards.map((card) => card.accountLabel)).toEqual(["ali…", "bob…"]);
    expect(refreshed.providers.cards).toHaveLength(2);
    expect(refreshed.providers.cards.map((card) => card.accountLabel)).toEqual(["ali…", "bob…"]);
    expect(refreshed.providers.cards.map((card) => card.cardId)).toEqual(
      first.providers.cards.map((card) => card.cardId),
    );
    expect(
      refreshed.providers.cards.map((card) => ({
        percentRemaining: card.rows.map((row) => row.percentRemaining),
        errors: card.errors.map((error) => error.message),
      })),
    ).toEqual([
      { percentRemaining: [65], errors: [] },
      {
        percentRemaining: [40],
        errors: ["Google AGY quota API error: 429"],
      },
    ]);
  });

  it("keeps the source-id card identity when an account has no email", async () => {
    const retryAtMs = Date.now() + 60_000;
    vi.mocked(queryGoogleAgyQuota)
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, "alice@example.com", 70), bucket(1, undefined, 40)],
      })
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, "alice@example.com", 65)],
        errors: [
          {
            email: "opencode-agy-auth",
            accountIndex: 1,
            error: "Google AGY quota API error: 429",
            failureCategory: "provider_api",
            retryAtMs,
          },
        ],
      });

    const source = dashboardSource("agy-dashboard-no-email-test");
    const first = await source.quota();
    const refreshed = await source.quota({ refresh: true });

    expect(refreshed.providers.cards.map((card) => card.cardId)).toEqual(
      first.providers.cards.map((card) => card.cardId),
    );
    expect(first.providers.cards.map((card) => card.accountLabel)).toEqual(["ali…", "Account 2"]);
    expect(refreshed.providers.cards.map((card) => card.accountLabel)).toEqual([
      "ali…",
      "Account 2",
    ]);
  });
});
