import { beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
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
      queryAnthropicQuota,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockReset();
    (hasAnthropicCredentialsConfigured as any).mockReset();
    (queryAnthropicQuota as any).mockReset();
    (queryAnthropicQuotaWithOAuth as any).mockReset();
    (readCredentialRows as any).mockReset().mockResolvedValue([]);
  });

  it("fans out to a valid inactive database credential when the active credential is expired", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota, queryAnthropicQuotaWithOAuth } =
      await import("../src/lib/anthropic.js");
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
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work] Usage Credits", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });

  it("forwards diagnostics failures without probing quota a second time", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: [],
      message: "Anthropic API returned 500",
      failureCategory: "provider_api",
    });

    const out = await anthropicProvider.fetch({} as any);

    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.errors[0]?.failureCategory).toBe("provider_api");
    expect(out.errors[0]?.message).toBe("Anthropic API returned 500");
  });

  it("does not repeat diagnostics after the initial probe throws", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(new Error("probe failed"));

    const out = await anthropicProvider.fetch({} as any);

    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.errors[0]?.message).toBe("Claude CLI probe failed: probe failed");
  });

  it("shows a login OpenCode could not read as its own error row", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota, queryAnthropicQuotaWithOAuth } =
      await import("../src/lib/anthropic.js");
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
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.errors).toEqual([
      {
        label: "[Claude] (active)",
        message:
          "Anthropic sign-in could not be read: refresh_failed: HTTP 500. Run `opencode auth login anthropic`.",
        sourceId: "failed-active",
        failureCategory: "credentials",
      },
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });

  it("reports the credential store that answered the usage probe", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      binaryPath: "/opt/homebrew/bin/claude",
      checkedCommands: ["claude --version", "/opt/homebrew/bin/claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 80 },
        seven_day: { percentRemaining: 70 },
      },
    });
    const out = await anthropicProvider.fetch({} as any);
    expect(out.statusDetails).toContainEqual({
      key: "oauth_credential_source",
      value: "opencode-auth",
    });
    expect(out.statusDetails).toContainEqual({
      key: "binary_path",
      value: "/opt/homebrew/bin/claude",
    });
    expect(out.statusDetails).toContainEqual({
      key: "quota_source",
      value: "opencode-auth-oauth-api",
    });
    expect(out.entries).toHaveLength(2);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "remote_api")).toBe(
      true,
    );
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("reports no credential store when the OAuth probe was never reached", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: ["claude --version"],
    });
    const out = await anthropicProvider.fetch({} as any);
    expect(out.statusDetails).toContainEqual({
      key: "oauth_credential_source",
      value: "(none)",
    });
    expect(out.statusDetails).toContainEqual({ key: "binary_path", value: "(none)" });
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("adds the Fable weekly row and diagnostic when the OAuth response reports it", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    const quota = {
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      fable_weekly: {
        percentRemaining: 98,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
    };
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota,
    });
    const out = await anthropicProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toContainEqual({
      key: "fable_weekly_remaining",
      value: "98% reset_at=2026-07-27T07:00:00.268Z",
    });
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 58,
        resetTimeIso: "2026-07-21T14:10:00.268Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 72,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
      {
        name: "Claude Fable Weekly",
        group: "Claude",
        label: "Fable:",
        semantic: {
          metric: { kind: "named", name: "Fable weekly" },
          prominence: "primary",
        },
        percentRemaining: 98,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting)).toEqual(
      Array.from({ length: 3 }, () => ({
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      })),
    );
  });

  it("returns attempted:false when Anthropic quota is unavailable locally", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: [],
      message: "Claude CLI is not installed.",
    });

    const out = await anthropicProvider.fetch({} as any);
    expectNotAttempted(out);
    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("maps local CLI quota windows into canonical grouped-capable rows", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 43 },
        seven_day: { percentRemaining: 88 },
      },
    });
    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 43,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 88,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "local_cli")).toBe(
      true,
    );
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.presentation).toBeUndefined();
  });

  it("uses quota from the current diagnostics probe instead of re-probing an unbound CLI", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    const quota = {
      success: true as const,
      five_hour: { percentRemaining: 43 },
      seven_day: { percentRemaining: 88 },
    };
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: ["claude auth status --json"],
      quota,
    });
    (queryAnthropicQuota as any).mockClear();

    const out = await anthropicProvider.fetch({} as any);

    expect(visibleEntries(out.entries, "anthropic").map((entry) => entry.percentRemaining)).toEqual(
      [43, 88],
    );
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("preserves all Anthropic login accounts in all-provider collection with Claude Code enabled", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota, queryAnthropicQuotaWithOAuth } =
      await import("../src/lib/anthropic.js");
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
      providerIds: ["anthropic", "claude-code"],
      configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: false },
    });
    const out = await anthropicProvider.fetch(ctx);

    expect(readCredentialRows).toHaveBeenCalledWith(["anthropic"], { methods: ["oauth"] });
    expect(queryAnthropicQuotaWithOAuth).toHaveBeenCalledTimes(2);
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.accounts?.map((account) => account.sourceId)).toEqual([
      "anthropic-personal",
      "anthropic-work",
    ]);
    expect(visibleEntries(out.entries, "anthropic").map((entry) => entry.percentRemaining)).toEqual(
      [80, 60],
    );
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: undefined,
      requestTimeoutMs: undefined,
    });
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
        message: "Anthropic OAuth usage probe paused after HTTP 429; retry in 900s.",
      }),
    ]);
    expect(out.entries.map((entry) => [entry.accounting.sourceId, entry.percentRemaining])).toEqual(
      [["anthropic-work", 60]],
    );
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: undefined,
      requestTimeoutMs: undefined,
    });
  });

  it("reports enabled Usage Credits as a third remote API quota row", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 43 },
        seven_day: { percentRemaining: 88 },
        extra_usage: { percentRemaining: 62 },
      },
    });
    const out = await anthropicProvider.fetch({} as any);

    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 43,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 88,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Usage Credits",
        group: "Claude Usage Credits",
        label: "Monthly:",
        rowKey: "window:month",
        percentRemaining: 62,
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "remote_api")).toBe(
      true,
    );
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("defaults to canonical grouped-capable rows when no style is specified", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      quota: {
        success: true,
        five_hour: { percentRemaining: 50, resetTimeIso: "2026-03-25T18:00:00.000Z" },
        seven_day: { percentRemaining: 70, resetTimeIso: "2026-04-01T00:00:00.000Z" },
      },
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 50,
        resetTimeIso: "2026-03-25T18:00:00.000Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 70,
        resetTimeIso: "2026-04-01T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      oauthCredentialSource: "claude-code-credentials",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      message:
        "Invalid or expired Anthropic token; re-authenticate Claude Code or update CLAUDE_CODE_OAUTH_TOKEN",
    });

    const out = await anthropicProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Claude");
  });

  it.each([
    "claude-agent",
    "claude-code",
  ])("uses the Claude Code credentials for the %s route without changing provider identity", async (runtimeProviderId) => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-code-credentials",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      quota: {
        success: true,
        five_hour: { percentRemaining: 75 },
      },
    });
    (readCredentialRows as any).mockClear();

    const ctx = createProviderAvailabilityContext({
      providerIds: [runtimeProviderId],
      configOverrides: { currentProviderID: runtimeProviderId, onlyCurrentModel: true },
    });
    const out = await anthropicProvider.fetch(ctx);

    expect(anthropicProvider.id).toBe("anthropic");
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: undefined,
      requestTimeoutMs: undefined,
      useClaudeCodeCredentials: true,
    });
    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(readCredentialRows).not.toHaveBeenCalled();
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 75,
        resetTimeIso: undefined,
      },
    ]);
  });

  it("matches anthropic/ model ids", () => {
    expect(anthropicProvider.matchesCurrentModel?.("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("anthropic/claude-opus-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("ANTHROPIC/claude-haiku-4-5")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("claude-agent/claude-sonnet-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("claude-code/claude-sonnet-4-6")).toBe(true);
    expect(anthropicProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
    expect(anthropicProvider.matchesCurrentModel?.("copilot/claude-sonnet-4-5")).toBe(false);
  });

  it("is available only when provider ids include anthropic and Claude CLI auth is ready", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);

    await expect(
      anthropicProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["anthropic"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["claude"] })),
    ).resolves.toBe(false);
    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
    await expect(
      anthropicProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["copilot", "anthropic"] }),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    "claude-agent",
    "claude-code",
  ])("is available for the selected %s runtime when Claude CLI auth is ready", async (runtimeProviderId) => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);
    const ctx = createProviderAvailabilityContext({
      providerIds: [runtimeProviderId],
      configOverrides: { currentProviderID: runtimeProviderId, onlyCurrentModel: true },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasAnthropicCredentialsConfigured).toHaveBeenCalledWith({
      binaryPath: undefined,
      useClaudeCodeCredentials: true,
    });
  });

  it("passes the configured Claude binary path through Anthropic probes", async () => {
    const { getAnthropicDiagnostics, hasAnthropicCredentialsConfigured, queryAnthropicQuota } =
      await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: [],
    });

    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic"],
      configOverrides: {
        anthropicBinaryPath: "/opt/claude/bin/claude",
      },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasAnthropicCredentialsConfigured).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });

    await anthropicProvider.fetch(ctx);
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
      requestTimeoutMs: undefined,
    });
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("is not available when Claude CLI auth is missing even if provider id exists", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic"] });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
