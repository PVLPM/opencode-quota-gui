import { beforeEach, describe, expect, it, vi } from "vitest";
import { getQuotaProviderIdsForRuntimeId } from "../src/lib/provider-metadata.js";
import { matchesQuotaProviderCurrentSelection } from "../src/lib/quota-render-data.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  // The real redaction helper stays in place so provider error text is checked end to end.
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  fingerprintAccessToken: vi.fn((token: string) => `fp:${token}`),
  getAnthropicDiagnostics: vi.fn(),
  getClaudeCodeAccountDiagnostics: vi.fn(),
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
      getClaudeCodeAccountDiagnostics,
      hasAnthropicCredentialsConfigured,
      queryAnthropicQuota,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockReset();
    (getClaudeCodeAccountDiagnostics as any).mockReset();
    (hasAnthropicCredentialsConfigured as any).mockReset();
    (queryAnthropicQuota as any).mockReset();
    (queryAnthropicQuotaWithOAuth as any).mockReset();
    (readCredentialRows as any).mockReset().mockResolvedValue([]);
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
      oauthCredentialSource: "opencode-auth",
      failureCategory: "provider_api",
    });

    const out = await anthropicProvider.fetch({} as any);

    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.errors[0]?.failureCategory).toBe("provider_api");
    expect(out.errors[0]?.message).toBe("Anthropic quota request failed.");
  });

  it("does not repeat diagnostics after the initial probe throws", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(new Error("probe failed"));

    const out = await anthropicProvider.fetch({} as any);

    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
    expect(out.errors[0]?.message).toBe("Claude CLI probe failed.");
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
      value: "(detected)",
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

  it("carries fixed-window evidence onto the 5h and weekly rows, never the Fable row", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    const fixedWindow = (startedAtIso: string, endsAtIso: string) => ({
      kind: "fixed_window",
      startedAtIso,
      observedAtIso: "2026-07-21T10:00:00.000Z",
      endsAtIso,
      fullReset: true,
    });
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: {
          percentRemaining: 58,
          resetTimeIso: "2026-07-21T14:10:00.000Z",
          fixedWindow: fixedWindow("2026-07-21T09:10:00.000Z", "2026-07-21T14:10:00.000Z"),
        },
        seven_day: {
          percentRemaining: 72,
          resetTimeIso: "2026-07-27T07:00:00.000Z",
          fixedWindow: fixedWindow("2026-07-20T07:00:00.000Z", "2026-07-27T07:00:00.000Z"),
        },
        fable_weekly: {
          percentRemaining: 98,
          resetTimeIso: "2026-07-27T07:00:00.000Z",
        },
      },
    });
    const out = await anthropicProvider.fetch({} as any);

    expect(out.entries.map((entry) => (entry as any).fixedWindow)).toEqual([
      fixedWindow("2026-07-21T09:10:00.000Z", "2026-07-21T14:10:00.000Z"),
      fixedWindow("2026-07-20T07:00:00.000Z", "2026-07-27T07:00:00.000Z"),
      undefined,
    ]);
    expect(out.entries[2]).not.toHaveProperty("fixedWindow");
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
    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
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

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expect(visibleEntries(out.entries, "anthropic").map((entry) => entry.percentRemaining)).toEqual(
      [43, 88],
    );
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it.each([
    "anthropic",
    "claude-code",
    "claude-agent",
  ])("preserves all Anthropic login accounts in all-provider collection for %s", async (runtimeProviderId) => {
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
      providerIds: ["anthropic", runtimeProviderId],
      configOverrides: { currentProviderID: runtimeProviderId, onlyCurrentModel: false },
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
        message: "Anthropic quota request failed.",
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

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
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

  it("does not emit private diagnostic free text or paths with spaces", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: "C:\\Users\\Alice Smith\\secret.exe",
      checkedCommands: ["/home/Alice Smith/private credentials --version"],
      message:
        "Alice Smith secret-token C:\\Users\\Alice Smith\\private credentials /home/Alice Smith/private credentials",
    });
    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
    const emitted = JSON.stringify({ errors: out.errors, statusDetails: out.statusDetails });
    expect(emitted).not.toContain("Alice");
    expect(emitted).not.toContain("secret");
    expect(emitted).not.toContain("private");
    expect(out.errors.length).toBeGreaterThan(0);
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

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
    expectAttemptedWithErrorLabel(out, "Claude");
  });

  it.each([
    "claude-agent",
    "claude-code",
  ])("uses Claude credentials for the %s route without a CLI version", async (runtimeProviderId) => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
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

  it.each([
    ["5-hour", { five_hour: { percentRemaining: 75 } }, "Claude 5h"],
    ["weekly", { seven_day: { percentRemaining: 65 } }, "Claude Weekly"],
  ])("maps a reported %s window without requiring its counterpart", async (_window, quota, name) => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: [],
      quota: { success: true, ...quota },
    });

    const ctx = createProviderAvailabilityContext({
      providerIds: ["claude-agent"],
      configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
    });
    const out = await anthropicProvider.fetch(ctx);

    expect(out.entries.map((entry) => entry.name)).toEqual([name]);
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
  ])("keeps the selected %s route available so a failed CLI probe is shown as an error", async (runtimeProviderId) => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);
    const ctx = createProviderAvailabilityContext({
      providerIds: [],
      configOverrides: { currentProviderID: runtimeProviderId, onlyCurrentModel: true },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
  });

  it("re-reads the Claude CLI on every refresh so a new connection replaces an earlier error", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any)
      .mockResolvedValueOnce({
        installed: true,
        version: "2.1.123",
        authStatus: "unauthenticated",
        quotaSupported: false,
        quotaSource: "none",
        checkedCommands: [],
        message: "Claude is not authenticated. Run `claude auth login` and try again.",
      })
      .mockResolvedValueOnce({
        installed: true,
        version: "2.1.123",
        authStatus: "authenticated",
        quotaSupported: true,
        quotaSource: "claude-credentials-oauth-api",
        oauthCredentialSource: "claude-credentials",
        checkedCommands: [],
        quota: { success: true, five_hour: { percentRemaining: 70 } },
      });
    const ctx = createProviderAvailabilityContext({
      providerIds: [],
      configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
    });

    expectAttemptedWithErrorLabel(await anthropicProvider.fetch(ctx), "Claude");
    const second = await anthropicProvider.fetch(ctx);

    expect(
      visibleEntries(second.entries, "anthropic").map((entry) => entry.percentRemaining),
    ).toEqual([70]);
    expect(getAnthropicDiagnostics).toHaveBeenNthCalledWith(2, {
      binaryPath: undefined,
      requestTimeoutMs: undefined,
      useClaudeCodeCredentials: true,
    });
  });

  it("shows a Claude Code route rejected by the usage endpoint as a credentials error without an OpenCode fallback", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: [],
      message: "Claude Code sign-in was rejected by the usage endpoint; run `claude auth login`.",
      failureCategory: "credentials",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(out.errors?.[0]).toMatchObject({ failureCategory: "credentials" });
    expect(visibleEntries(out.entries, "anthropic")).toEqual([]);
    expect(readCredentialRows).not.toHaveBeenCalled();
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("presents a reliably connected Claude Code account beside OpenCode's Anthropic account", async () => {
    const {
      getAnthropicDiagnostics,
      getClaudeCodeAccountDiagnostics,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
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
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (queryAnthropicQuotaWithOAuth as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(getClaudeCodeAccountDiagnostics).toHaveBeenCalledWith(
      expect.anything(),
      ["fp:personal-token"],
      { reportUnready: false },
    );
    expect(out.accounts?.map((account) => account.sourceId)).toEqual([
      "anthropic-personal",
      "claude-code-cli",
    ]);
    expect(out.entries.filter((entry) => entry.group === "Claude Code")).toEqual([
      expect.objectContaining({
        name: "Claude Code 5h",
        percentRemaining: 55,
        accounting: expect.objectContaining({ sourceId: "claude-code-cli" }),
      }),
    ]);
    expect(out.entries.some((entry) => entry.percentRemaining === 80)).toBe(true);
  });

  it("keeps a detected Claude Code route visible as an error when its usage probe fails", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuota } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      message: "Claude Code usage request failed with HTTP 500.",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(visibleEntries(out.entries, "anthropic")).toEqual([]);
    expect(queryAnthropicQuota).not.toHaveBeenCalled();
  });

  it("keeps a Claude Code route that lost its CLI login visible with the CLI's status message", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "unauthenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(out.errors?.[0]?.message).toContain("Claude is not authenticated");
  });

  it("reports a Claude Code route whose CLI probe throws as an error row instead of dropping it", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(
      new Error(
        "Claude CLI path contains characters that cannot be passed safely through cmd.exe.",
      ),
    );

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(out.errors?.[0]?.message).toBe("Claude CLI probe failed.");
  });

  it("does not append the Claude Code account to the selected anthropic route under onlyCurrentModel", async () => {
    const {
      getAnthropicDiagnostics,
      getClaudeCodeAccountDiagnostics,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
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

    expect(getClaudeCodeAccountDiagnostics).not.toHaveBeenCalled();
    expect(out.entries.some((entry) => entry.percentRemaining === 80)).toBe(true);
    expect(out.entries.filter((entry) => entry.group === "Claude Code")).toEqual([]);
  });

  it("does not present a Claude CLI login without OpenCode's login as the anthropic route", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
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
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(out.entries.some((entry) => entry.percentRemaining === 70)).toBe(false);
    expect(out.entries.filter((entry) => entry.group === "Claude")).toEqual([]);
    expect(out.entries.filter((entry) => entry.group === "Claude Code")).toEqual([
      expect.objectContaining({
        name: "Claude Code 5h",
        percentRemaining: 55,
        accounting: expect.objectContaining({ sourceId: "claude-code-cli" }),
      }),
    ]);
    expect(getClaudeCodeAccountDiagnostics).toHaveBeenCalledWith(expect.anything(), [], {
      reportUnready: false,
    });
    expect(out.errors ?? []).toEqual([]);
  });

  it("tells a selected anthropic route without OpenCode's login why it has no data", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
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
    expect(getClaudeCodeAccountDiagnostics).not.toHaveBeenCalled();
  });

  it("shows a selected Claude Code route with no probe message as an error row", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude");
    expect(out.errors?.[0]?.message).toBe("Claude Code usage is unavailable.");
  });

  it("keeps OpenCode's rows when the separate Claude Code account probe throws", async () => {
    const {
      getAnthropicDiagnostics,
      getClaudeCodeAccountDiagnostics,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
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
    (getClaudeCodeAccountDiagnostics as any).mockRejectedValueOnce(new Error("spawn failed"));

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(out.entries.some((entry) => entry.percentRemaining === 80)).toBe(true);
    expect(out.errors).toEqual([
      expect.objectContaining({
        label: "Claude Code",
        sourceId: "claude-code-cli",
        message: "Claude CLI probe failed.",
      }),
    ]);
  });

  it.each([
    ["a known plan", "Max"],
    ["no plan", undefined],
  ])("puts the Claude CLI plan on the Claude Code row only, with %s", async (_case, planLabel) => {
    const {
      getAnthropicDiagnostics,
      getClaudeCodeAccountDiagnostics,
      queryAnthropicQuotaWithOAuth,
    } = await import("../src/lib/anthropic.js");
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
      oauthCredentialSource: "opencode-auth",
      checkedCommands: [],
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: [],
      quota: { five_hour: { percentRemaining: 50 } },
      credentialFingerprint: "claude-cli-fingerprint",
      ...(planLabel === undefined ? {} : { planLabel }),
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    const [personal, claudeCode] = out.accounts ?? [];
    expect(personal).toEqual(expect.objectContaining({ sourceId: "anthropic-personal" }));
    expect(personal).not.toHaveProperty("planLabel");
    expect(claudeCode).toEqual({
      sourceId: "claude-code-cli",
      label: "Claude Code",
      active: false,
      ...(planLabel === undefined ? {} : { planLabel }),
    });
    if (planLabel === undefined) expect(claudeCode).not.toHaveProperty("planLabel");
  });

  it.each([
    ["a known plan", "Max"],
    ["no plan", undefined],
  ])("forwards the CLI plan on a selected Claude Code route, with %s", async (_case, planLabel) => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 75 } },
      ...(planLabel === undefined ? {} : { planLabel }),
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expect(out.entries.map((entry) => entry.name)).toEqual(["Claude 5h"]);
    expect(out.planLabel).toBe(planLabel);
    if (planLabel === undefined) expect(out).not.toHaveProperty("planLabel");
  });

  it("shows the Claude CLI plan on the provider result when the CLI login is the only account", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: { five_hour: { percentRemaining: 50 } },
      planLabel: "Max",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(out.planLabel).toBe("Max");
    expect(out.accounts ?? []).toEqual([]);
    expect(out.entries.map((entry) => entry.name)).toEqual(["Claude Code 5h"]);
  });

  it("never forwards a CLI plan on an onlyCurrentModel OpenCode route", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 50 } },
      planLabel: "Max",
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: { five_hour: { percentRemaining: 50 } },
      planLabel: "Max",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
      }),
    );

    expect(out).not.toHaveProperty("planLabel");
    expect(getClaudeCodeAccountDiagnostics).not.toHaveBeenCalled();
  });

  it("never forwards a plan from the probe while OpenCode's login is the route's account", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "opencode-auth",
      credentialFingerprint: "opencode-fingerprint",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 60 } },
      planLabel: "Max",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(out).not.toHaveProperty("planLabel");
  });

  it("keeps the custom Claude binary path, the username, and credential paths out of errors and statusDetails", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    const customBinary = "C:\\Users\\alice\\tools\\claude-custom.exe";
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: customBinary,
      checkedCommands: [`${customBinary} --version`],
      message: `Claude CLI (\`${customBinary}\`) failed; credentials read from C:\\Users\\alice\\.claude\\.credentials.json`,
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: {
          currentProviderID: "claude-code",
          onlyCurrentModel: true,
          anthropicBinaryPath: customBinary,
        },
      }),
    );

    const emitted = JSON.stringify({ errors: out.errors, statusDetails: out.statusDetails });
    expect(emitted).toContain("(detected)");
    expect(emitted).not.toContain("alice");
    expect(emitted).not.toContain("claude-custom.exe");
    expect(emitted).not.toContain(".credentials.json");
  });

  it("redacts a probe exception that names the custom binary", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    const customBinary = "C:\\Users\\alice\\tools\\claude-custom.exe";
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(
      new Error(`spawn ${customBinary} /home/Alice Smith/private key secret-token ENOENT`),
    );

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: {
          currentProviderID: "claude-code",
          onlyCurrentModel: true,
          anthropicBinaryPath: customBinary,
        },
      }),
    );

    const emitted = JSON.stringify({ errors: out.errors, statusDetails: out.statusDetails });
    expect(emitted).toContain("Claude CLI probe failed.");
    expect(emitted).not.toContain("alice");
    expect(emitted).not.toContain("Alice");
    expect(emitted).not.toContain("secret-token");
    expect(emitted).not.toContain("private key");
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
      oauthCredentialSource: "opencode-auth",
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
    expect(emitted).toContain("(detected)");
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

  it("keeps the Claude CLI account row free of its identity, paths, and fingerprint", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    const customBinary = "C:\\Users\\alice\\tools\\claude-custom.exe";
    const fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: customBinary,
      checkedCommands: [],
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.123",
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: customBinary,
      checkedCommands: [`${customBinary} --version`],
      message: `Claude CLI for alice@example.com (org Acme Corp) failed; read C:\\Users\\alice\\.claude\\.credentials.json`,
      credentialFingerprint: fingerprint,
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["anthropic"],
        configOverrides: { currentProviderID: "anthropic", anthropicBinaryPath: customBinary },
      }),
    );

    expect(out.errors).toEqual([
      expect.objectContaining({
        label: "Claude Code",
        sourceId: "claude-code-cli",
        message:
          "Claude authentication could not be verified. Run `claude auth login` and try again.",
      }),
    ]);
    const emitted = JSON.stringify({ errors: out.errors, statusDetails: out.statusDetails });
    expect(emitted).toContain("(detected)");
    for (const leaked of [
      customBinary,
      "claude-custom.exe",
      "alice",
      "example.com",
      "Acme",
      ".credentials.json",
      fingerprint,
    ]) {
      expect(emitted).not.toContain(leaked);
    }
  });

  it.each([
    "anthropic",
    "claude-agent",
    "claude-code",
  ])("selects the Anthropic provider for the %s runtime id under onlyCurrentModel", (runtimeId) => {
    expect(getQuotaProviderIdsForRuntimeId(runtimeId)).toEqual(["anthropic"]);
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: anthropicProvider,
        currentModel: `${runtimeId}/claude-sonnet-4-6`,
        currentProviderID: runtimeId,
      }),
    ).toBe(true);
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

  it.each([
    "claude-agent",
    "claude-code",
  ])("keeps a dashboard-detected %s runtime discovered while its CLI is not ready", async (runtimeProviderId) => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);
    const ctx = createProviderAvailabilityContext({
      providerIds: [runtimeProviderId],
      configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
    await expect(anthropicProvider.isDiscovered?.(ctx)).resolves.toBe(true);
  });

  it("does not discover a Claude Code runtime on a selected anthropic route", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);
    const ctx = createProviderAvailabilityContext({
      providerIds: ["claude-code"],
      configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
    });

    await expect(anthropicProvider.isDiscovered?.(ctx)).resolves.toBe(false);
  });

  it("shows a dashboard-detected Claude Code runtime with a missing CLI as a safe error row", async () => {
    const { getAnthropicDiagnostics, getClaudeCodeAccountDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    (getClaudeCodeAccountDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: [],
      message: "Claude CLI (`claude`) is not installed or not on PATH.",
    });

    const out = await anthropicProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: false },
      }),
    );

    expect(getClaudeCodeAccountDiagnostics).toHaveBeenCalledWith(expect.anything(), [], {
      reportUnready: true,
    });
    expect(out.errors).toEqual([
      expect.objectContaining({
        label: "Claude Code",
        sourceId: "claude-code-cli",
        message: "Claude CLI is unavailable.",
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain("not installed or not on PATH");
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
