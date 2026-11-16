import { afterEach, describe, expect, it, vi } from "vitest";

import { googleAgyProvider } from "../src/providers/google-agy.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-state-agy-scope-tests";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));
vi.mock("../src/lib/google-agy.js", () => ({
  AGY_AUTH_KEYS: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  queryGoogleAgyQuota: vi.fn(),
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "missing",
    sourceKey: null,
    accountCount: 0,
    validAccountCount: 0,
  })),
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(async () => ({ state: "missing", error: "unavailable" })),
}));

const bucket = (accountIndex: number, percentRemaining: number) => ({
  family: "Gemini Models",
  window: "weekly",
  windowLabel: "Weekly",
  bucketId: "gemini-weekly",
  percentRemaining,
  remainingFraction: percentRemaining / 100,
  accountEmail: accountIndex === 0 ? "a@example.com" : "b@example.com",
  accountIndex,
  sourceKey: "google-agy",
});

describe("AGY legacy multi-account Retry-After scoping through quota-state", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attributes a rate-limited account's error so only its previous rows are kept", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    const { fetchQuotaProviderResult } = await import("../src/lib/quota-state.js");
    const retryAtMs = Date.now() + 60_000;
    vi.mocked(queryGoogleAgyQuota)
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, 70), bucket(1, 40)],
      } as never)
      .mockResolvedValueOnce({
        success: true,
        buckets: [bucket(0, 65)],
        errors: [
          {
            email: "b@example.com",
            error: "Google AGY quota API error: 429",
            failureCategory: "provider_api",
            retryAtMs,
            accountIndex: 1,
          },
        ],
      } as never);
    const provider = {
      ...googleAgyProvider,
      id: "google-agy",
      cachePolicy: { kind: "resolved-auth", resolveIdentity: async () => "agy-scope-opaque" },
    } as never;
    const ctx = {
      client: { config: { providers: async () => ({ data: { providers: [] } }) } },
      config: {},
    } as never;

    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const stale = await fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
      forceRefresh: true,
    });

    expect(stale.errors).toMatchObject([{ sourceId: "account-2", retryAtMs }]);
    expect(
      stale.entries.map((entry) => [entry.accounting.sourceId, entry.percentRemaining]),
    ).toEqual([
      ["account-1", 65],
      ["account-2", 40],
    ]);
  });
});
