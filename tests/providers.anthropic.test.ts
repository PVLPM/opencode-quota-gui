import { beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: vi.fn(),
}));

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  // The real redaction helper stays in place so provider error text is checked end to end.
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  fingerprintAccessToken: vi.fn((token: string) => `fp:${token}`),
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuotaWithOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

describe("anthropic provider", () => {
  beforeEach(async () => {
    const {
      getAnthropicDiagnostics,
      hasAnthropicCredentialsConfigured,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockReset();
    (hasAnthropicCredentialsConfigured as any).mockReset();
    (queryAnthropicQuotaWithOAuth as any).mockReset();
    (readCredentialRows as any).mockReset().mockResolvedValue([]);
  });

  it("uses OpenCode login without launching the CLI, even when it is missing", async () => {
    const { execFile } = await import("child_process");
    const {
      queryAnthropicQuotaWithOAuth,
      getAnthropicDiagnostics,
      hasAnthropicCredentialsConfigured,
    } = await import("../src/lib/anthropic.js");
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    vi.mocked(readCredentialRows).mockResolvedValue([
      {
        id: "personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ] as never);
    vi.mocked(queryAnthropicQuotaWithOAuth).mockResolvedValue({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic"] });

    expect(await anthropicProvider.isAvailable(ctx)).toBe(true);
    expect((await anthropicProvider.fetch(ctx)).entries).toHaveLength(1);
    expect(execFile).not.toHaveBeenCalled();
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
    expect(hasAnthropicCredentialsConfigured).not.toHaveBeenCalled();
  });

  it("never includes a Claude CLI plan or account in an OpenCode login result", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    vi.mocked(readCredentialRows).mockResolvedValue([
      {
        id: "opencode-personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "opencode-token" },
      },
    ] as never);
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      planLabel: "CLI-private-plan",
      credentialFingerprint: "cli-private-account",
    } as never);
    vi.mocked(queryAnthropicQuotaWithOAuth).mockResolvedValue({
      success: true,
      five_hour: { percentRemaining: 80 },
    });

    const result = await anthropicProvider.fetch(
      createProviderAvailabilityContext({ providerIds: ["anthropic"] }),
    );
    expect(result.accounts?.map((account) => account.sourceId)).toEqual(["opencode-personal"]);
    expect(result.planLabel).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/CLI-private-plan|cli-private-account/);
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
  });

  it("matches only Anthropic model routes", () => {
    expect(anthropicProvider.matchesCurrentModel?.("ANTHROPIC/claude")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("claude-agent/claude")).toBe(false);
    expect(anthropicProvider.matchesCurrentModel?.("claude-code/claude")).toBe(false);
  });
  it("does not expose CLI quota anywhere on a selected OpenCode Anthropic route", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: {
        success: true,
        five_hour: { percentRemaining: 17 },
        seven_day: { percentRemaining: 23 },
      },
    });
    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
      }),
    );
    expect(JSON.stringify(out)).not.toMatch(/17%|23%|percentRemaining/);
    expect(out.errors).toHaveLength(1);
  });

  it("fans out to a valid inactive database credential when the active credential is expired", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "expired-active",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth", access: "expired", expires: 0 },
      },
      {
        id: "valid-inactive",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "valid" },
      },
    ]);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: {
        success: true,
        five_hour: { percentRemaining: 1 },
        seven_day: { percentRemaining: 1 },
      },
    });
    (queryAnthropicQuotaWithOAuth as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
      extra_usage: { percentRemaining: 60 },
      fable_weekly: { percentRemaining: 50 },
    });

    const out = await anthropicProvider.fetch({} as any);

    expect(queryAnthropicQuotaWithOAuth).toHaveBeenCalledWith("valid", undefined);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work] Usage Credits", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });
  it("shows a login OpenCode could not read as its own error row", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "failed-active",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 500",
      },
      {
        id: "valid-inactive",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "valid" },
      },
    ]);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (queryAnthropicQuotaWithOAuth as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
    });

    const out = await anthropicProvider.fetch({} as any);

    expect(queryAnthropicQuotaWithOAuth).toHaveBeenCalledOnce();
    expect(queryAnthropicQuotaWithOAuth).toHaveBeenCalledWith("valid", undefined);
    expect(out.errors).toEqual([
      {
        label: "[Claude] (active)",
        message: "Anthropic sign-in could not be used. Run `opencode auth login anthropic`.",
        sourceId: "failed-active",
        failureCategory: "credentials",
      },
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });
  it.each([
    "anthropic",
    "claude-code",
    "claude-agent",
  ])("preserves all Anthropic login accounts in all-provider collection for %s", async (runtimeProviderId) => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "anthropic-personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "personal-token" },
      },
      {
        id: "anthropic-work",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "work-token" },
      },
    ]);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (queryAnthropicQuotaWithOAuth as any)
      .mockResolvedValueOnce({ success: true, five_hour: { percentRemaining: 80 } })
      .mockResolvedValueOnce({ success: true, five_hour: { percentRemaining: 60 } });

    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic", runtimeProviderId],
      configOverrides: { currentProviderID: runtimeProviderId, onlyCurrentModel: false },
    });
    const out = await anthropicProvider.fetch(ctx);

    expect(readCredentialRows).toHaveBeenCalledWith(["anthropic"], { methods: ["oauth"] });
    expect(queryAnthropicQuotaWithOAuth).toHaveBeenCalledTimes(2);
    expect(out.accounts?.map((account) => account.sourceId)).toEqual([
      "anthropic-personal",
      "anthropic-work",
    ]);
    expect(visibleEntries(out.entries, "anthropic").map((entry) => entry.percentRemaining)).toEqual(
      [80, 60],
    );
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
  });

  it("keeps per-account OAuth failures and quota rows separate in Claude Code all-provider mode", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "anthropic-personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "personal-token" },
      },
      {
        id: "anthropic-work",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "work-token" },
      },
    ]);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (queryAnthropicQuotaWithOAuth as any)
      .mockResolvedValueOnce({
        success: false,
        error: "Anthropic OAuth usage probe paused after HTTP 429; retry in 900s.",
        failureCategory: "provider_api",
      })
      .mockResolvedValueOnce({
        success: true,
        five_hour: { percentRemaining: 60 },
      });

    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic", "claude-code"],
      configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: false },
    });
    const out = await anthropicProvider.fetch(ctx);

    expect(queryAnthropicQuotaWithOAuth).toHaveBeenNthCalledWith(1, "personal-token", undefined);
    expect(queryAnthropicQuotaWithOAuth).toHaveBeenNthCalledWith(2, "work-token", undefined);
    expect(out.accounts?.map((account) => account.sourceId)).toEqual([
      "anthropic-personal",
      "anthropic-work",
    ]);
    expect(out.errors).toEqual([
      expect.objectContaining({
        sourceId: "anthropic-personal",
        failureCategory: "provider_api",
        message: "Anthropic quota request failed.",
      }),
    ]);
    expect(out.entries.map((entry) => [entry.accounting.sourceId, entry.percentRemaining])).toEqual(
      [["anthropic-work", 60]],
    );
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
  });
  it("does not append the Claude Code account to the selected anthropic route under onlyCurrentModel", async () => {
    const { execFile } = await import("child_process");
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "anthropic-personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "personal-token" },
      },
    ]);
    (queryAnthropicQuotaWithOAuth as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
      }),
    );

    expect(execFile).not.toHaveBeenCalled();
    expect(out.entries.some((entry) => entry.percentRemaining === 80)).toBe(true);
    expect(out.entries.filter((entry) => entry.group === "Claude Code")).toEqual([]);
  });
  it("tells a selected anthropic route without OpenCode's login why it has no data", async () => {
    const { execFile } = await import("child_process");
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 70 } },
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(out.errors?.[0]).toMatchObject({
      message: expect.stringContaining("opencode auth login anthropic"),
      failureCategory: "credentials",
    });
    expect(out.entries).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
  it("keeps OpenCode account rows free of raw identities, paths, and fingerprints, but still distinct", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const customBinary = "C:\\Users\\alice\\tools\\claude-custom.exe";
    const fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "row-work",
        integrationId: "anthropic",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "work-access-token" },
      },
      {
        id: "row-home",
        integrationId: "anthropic",
        label: "Home",
        active: false,
        value: { type: "oauth", access: "home-access-token" },
      },
    ]);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: customBinary,
      checkedCommands: [`${customBinary} --version`],
      message: `Claude CLI for alice@example.com (org Acme Corp) failed; read C:\\Users\\alice\\.claude\\.credentials.json`,
      oauthCredentialSource: "claude-credentials",
      credentialFingerprint: fingerprint,
    });
    (queryAnthropicQuotaWithOAuth as any)
      .mockResolvedValueOnce({ success: true, five_hour: { percentRemaining: 80 } })
      .mockResolvedValueOnce({ success: true, five_hour: { percentRemaining: 40 } });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", anthropicBinaryPath: customBinary },
      }),
    );

    // Each OpenCode login stays its own account row, so the rows still tell accounts apart.
    expect(out.accounts?.map((account) => account.sourceId)).toEqual(["row-work", "row-home"]);
    expect(new Set(out.accounts?.map((account) => account.label)).size).toBe(2);

    const emitted = JSON.stringify({
      accounts: out.accounts,
      entries: out.entries,
      errors: out.errors,
      statusDetails: out.statusDetails,
    });
    for (const leaked of [
      customBinary,
      "claude-custom.exe",
      "alice",
      "example.com",
      "Acme",
      ".credentials.json",
      fingerprint,
      "work-access-token",
      "home-access-token",
    ]) {
      expect(emitted).not.toContain(leaked);
    }
  });
  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
