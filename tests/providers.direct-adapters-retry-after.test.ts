import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveMimoConfigCached: vi.fn(),
  queryMimoDashboard: vi.fn(),
  queryOpenCodeZenQuota: vi.fn(),
  queryOpenCodeGoConsoleStatus: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
  resolveOpenCodeConsoleAuthAccounts: vi.fn(),
}));

vi.mock("../src/lib/mimo-config.js", () => ({
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  resolveMimoConfigCached: mocks.resolveMimoConfigCached,
  getMimoConfigDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    error: null,
    checkedPaths: [],
  })),
}));
vi.mock("../src/lib/mimo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mimo.js")>()),
  queryMimoDashboard: mocks.queryMimoDashboard,
}));
vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-zen.js")>()),
  queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
}));
vi.mock("../src/lib/opencode-go.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-go.js")>()),
  queryOpenCodeGoConsoleStatus: mocks.queryOpenCodeGoConsoleStatus,
  queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
}));
vi.mock("../src/lib/opencode-go-auth.js", () => ({
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS: 5_000,
  OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS: ["opencode-go", "opencode"],
  resolveOpenCodeGoAuthCached: vi.fn(async () => ({ state: "configured", apiKey: "legacy-key" })),
  getOpenCodeGoAuthDiagnostics: vi.fn(async () => ({
    state: "configured",
    source: "env",
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  resolveOpenCodeGoAuth: vi.fn(() => ({ state: "none" })),
}));
vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuthAccounts: mocks.resolveOpenCodeConsoleAuthAccounts,
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { xiaomiProvider } from "../src/providers/mimo.js";
import { opencodeGoProvider } from "../src/providers/opencode-go.js";
import { opencodeZenProvider } from "../src/providers/opencode-zen.js";

const retryAtMs = 1_800_000_000_000;
const ctx: any = { config: { requestTimeoutMs: 5_000 } };
const account = {
  state: "configured",
  sourceId: "cred_1",
  label: "Workspace",
  active: true,
  credential: { accessToken: "tok", orgId: "o" },
};

describe("direct adapter retryAtMs reaches provider errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([account]);
  });

  it("MiMo", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValue({
      state: "configured",
      source: "env",
      config: { cookie: "c=1" },
    });
    const limited = {
      state: "error",
      error: "limited",
      failureCategory: "provider_api",
      retryAtMs,
    };
    mocks.queryMimoDashboard.mockResolvedValue({
      usage: limited,
      detail: limited,
      balance: limited,
    });
    expect((await xiaomiProvider.fetch(ctx)).errors).toMatchObject([
      { retryAtMs },
      { retryAtMs },
      { retryAtMs },
    ]);
  });

  it("Zen failure and optional errors", async () => {
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: false, error: "x", retryAtMs });
    expect((await opencodeZenProvider.fetch(ctx)).errors).toMatchObject([
      { sourceId: "cred_1", retryAtMs },
    ]);
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: true,
      data: {
        balance: 100_000_000,
        monthlyLimit: null,
        monthlyUsage: null,
        lastPayment: null,
        reload: null,
        reloadAmount: null,
        reloadTrigger: null,
        budgetResetIso: null,
        budgetSource: "credit_limit",
        memberBudgetsSkipped: false,
      },
      errors: ["opt"],
      optionalErrors: [{ message: "opt", retryAtMs }],
    });
    expect((await opencodeZenProvider.fetch(ctx)).errors).toMatchObject([{ retryAtMs }]);
  });

  it("Go legacy single-key path", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([]);
    mocks.queryOpenCodeGoQuota.mockResolvedValue({
      success: false,
      error: "limited",
      retryable: true,
      retryAtMs,
    });
    expect((await opencodeGoProvider.fetch(ctx)).errors).toMatchObject([{ retryAtMs }]);
  });

  it("Go console path", async () => {
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValue({
      success: false,
      error: "limited",
      retryable: true,
      retryAtMs,
    });
    // A failed Console workspace also tries the legacy key, which is unconfigured here.
    mocks.queryOpenCodeGoQuota.mockResolvedValue({ success: false, error: "legacy" });
    expect((await opencodeGoProvider.fetch(ctx)).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: "cred_1", retryAtMs })]),
    );
  });
});
