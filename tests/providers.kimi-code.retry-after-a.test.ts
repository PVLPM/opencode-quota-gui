import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  resolveCn: vi.fn(),
  resolveCnWithDiagnostics: vi.fn(),
  parseCn: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  resolveKimiGlobalAuthCached: vi.fn(),
  resolveKimiCnAuthCached: authMocks.resolveCn,
  resolveKimiGlobalAuthWithDiagnosticsCached: vi.fn(),
  resolveKimiCnAuthWithDiagnosticsCached: authMocks.resolveCnWithDiagnostics,
  resolveKimiGlobalAuth: vi.fn(),
  resolveKimiCnAuth: authMocks.parseCn,
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));
vi.mock("../src/lib/kimi.js", () => ({ queryKimiQuota: vi.fn() }));
vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { queryKimiQuota } from "../src/lib/kimi.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { kimiCodePlanCnProvider } from "../src/providers/kimi-code.js";

const windows = [
  {
    technicalKey: "weekly",
    label: "Weekly limit",
    used: 250,
    limit: 1000,
    percentRemaining: 75,
  },
];
const retryAtMs = 1_800_000_000_000;

describe("Kimi provider Retry-After forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards sourceId and retryAtMs for a rate-limited stored account only", async () => {
    authMocks.resolveCnWithDiagnostics.mockResolvedValue({
      auth: { state: "configured", apiKey: "a", endpoint: "cn" },
      diagnostics: {
        state: "configured",
        source: "opencode.db",
        endpoint: "cn",
        checkedPaths: [],
        credentialDatabasePaths: [],
      },
    });
    authMocks.parseCn.mockImplementation((auth: Record<string, { key: string }>) => ({
      state: "configured",
      apiKey: Object.values(auth)[0]?.key,
      endpoint: "cn",
    }));
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "limited",
        integrationId: "kimi-code-plan-cn",
        label: "one",
        active: true,
        value: { type: "api", key: "limited-key" },
      },
      {
        id: "healthy",
        integrationId: "kimi-code-plan-cn",
        label: "two",
        active: false,
        value: { type: "api", key: "healthy-key" },
      },
    ] as never);
    vi.mocked(queryKimiQuota).mockImplementation((async (options: { apiKey: string }) =>
      options.apiKey === "limited-key"
        ? {
            success: false,
            error: "Kimi API error 429",
            failureCategory: "provider_api",
            retryAtMs,
          }
        : { success: true, label: "Kimi Code (CN)", windows }) as never);

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as never);

    expect(out.errors).toEqual([
      expect.objectContaining({ sourceId: "limited", retryAtMs, failureCategory: "provider_api" }),
    ]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(["healthy"]);
  });

  it("forwards retryAtMs for the single-credential path", async () => {
    authMocks.resolveCnWithDiagnostics.mockResolvedValue({
      auth: { state: "configured", apiKey: "env-key", endpoint: "cn" },
      diagnostics: {
        state: "configured",
        source: "env:KIMI_CN_API_KEY",
        endpoint: "cn",
        checkedPaths: [],
        credentialDatabasePaths: [],
      },
    });
    vi.mocked(queryKimiQuota).mockResolvedValue({
      success: false,
      error: "Kimi API error 429",
      failureCategory: "provider_api",
      retryAtMs,
    });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as never);

    expect(out.errors).toEqual([expect.objectContaining({ retryAtMs })]);
  });
});
