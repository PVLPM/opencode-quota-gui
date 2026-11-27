/**
 * The shared cache must expose the genuine measurement time of a provider
 * result: a replay inside the TTL is the same observation, not a new one.
 */
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-usage-measurement-tests";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function createTestContext() {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    config: {
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
  } as never;
}

afterEach(async () => {
  const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
  __resetQuotaStateForTests();
});

beforeEach(async () => {
  await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
});

describe("quota result measurement time", () => {
  it("keeps the fetch timestamp across an in-memory replay", async () => {
    const { fetchQuotaProviderResult, quotaResultMeasuredAtMs, __resetQuotaStateForTests } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    const entry = { accounting: TEST_ACCOUNTING, name: "Quota", percentRemaining: 55 };
    const fetch = vi.fn(async () => ({ attempted: true, entries: [entry], errors: [] }));
    const provider = {
      id: "usage-measurement-test",
      cachePolicy: { kind: "account-neutral" },
      fetch,
    } as never;
    const ctx = createTestContext();

    const before = Date.now();
    const fresh = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const replayed = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const measuredAt = quotaResultMeasuredAtMs(fresh);
    expect(measuredAt).toBeTypeOf("number");
    expect(measuredAt).toBeGreaterThanOrEqual(before);
    expect(quotaResultMeasuredAtMs(replayed)).toBe(measuredAt);
  });

  it("marks an uncached fetch with its completion time", async () => {
    const { fetchQuotaProviderResult, quotaResultMeasuredAtMs, __resetQuotaStateForTests } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    const entry = { accounting: TEST_ACCOUNTING, name: "Quota", percentRemaining: 42 };
    const provider = {
      id: "usage-measurement-bypass-test",
      cachePolicy: { kind: "uncached" },
      fetch: vi.fn(async () => ({ attempted: true, entries: [entry], errors: [] })),
    } as never;
    const ctx = createTestContext();

    const result = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(quotaResultMeasuredAtMs(result)).toBeTypeOf("number");
  });
});
