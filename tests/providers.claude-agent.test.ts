import { beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";
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
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuotaWithOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

describe("claude agent provider", () => {
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

  it("passes the configured Claude binary path through Anthropic probes", async () => {
    const { hasAnthropicCredentialsConfigured, getAnthropicDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    vi.mocked(hasAnthropicCredentialsConfigured).mockResolvedValue(true);
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: false,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    } as never);
    const ctx = createProviderAvailabilityContext({
      providerIds: ["claude-agent"],
      configOverrides: { anthropicBinaryPath: "/custom/claude" },
    });
    expect(await claudeAgentProvider.isAvailable(ctx)).toBe(true);
    await claudeAgentProvider.fetch(ctx);
    expect(hasAnthropicCredentialsConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/claude" }),
    );
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/claude" }),
    );
  });

  it("shows a dashboard-detected Claude Code runtime with a missing CLI as a safe error row", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: false,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
      message: "private missing path",
    } as never);
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-code"] });
    expect(await claudeAgentProvider.isDiscovered?.(ctx)).toBe(true);
    const result = await claudeAgentProvider.fetch(ctx);
    expect(result.errors[0]?.message).toBe("Claude CLI is unavailable.");
    expect(JSON.stringify(result)).not.toContain("private missing path");
  });

  it("is not available when Claude CLI auth is missing even if provider id exists", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    vi.mocked(hasAnthropicCredentialsConfigured).mockResolvedValue(false);
    expect(
      await claudeAgentProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["claude-agent"] }),
      ),
    ).toBe(false);
  });

  it.each([
    [["anthropic"], false],
    [["claude-agent"], true],
    [["claude-code"], true],
  ])("requires a Claude Agent runtime with authenticated CLI: %j", async (providerIds, expected) => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    vi.mocked(hasAnthropicCredentialsConfigured).mockResolvedValue(true);
    await expect(
      claudeAgentProvider.isAvailable(createProviderAvailabilityContext({ providerIds })),
    ).resolves.toBe(expected);
  });

  it.each([
    [["anthropic", "claude-agent"], ["claude-agent"]],
    [["anthropic", "claude-code"], ["claude-code"]],
    [["claude-agent"], "auto"],
  ] as const)("keeps a matching CLI token when Anthropic is not shown", async (providerIds, enabledProviders) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    vi.mocked(readCredentialRows).mockResolvedValue([
      {
        id: "personal",
        integrationId: "anthropic",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ] as never);
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: [],
      credentialFingerprint: "fp:token",
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    } as never);
    const ctx = createProviderAvailabilityContext({
      providerIds: [...providerIds],
      configOverrides: {
        enabledProviders: enabledProviders === "auto" ? "auto" : [...enabledProviders],
      },
    });
    expect((await claudeAgentProvider.fetch(ctx)).entries).toHaveLength(1);
  });

  it("keeps the Claude CLI account row free of its identity, paths, and fingerprint", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: ["secret-path"],
      binaryPath: "secret-path",
      message: "secret identity",
      credentialFingerprint: "secret-fingerprint",
    } as never);
    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({ providerIds: ["claude-agent"] }),
    );
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out.errors[0]?.label).toBe("Claude Agent");
  });

  it("reports an error when an authenticated CLI has no quota", async () => {
    const { getAnthropicDiagnostics, hasAnthropicCredentialsConfigured } = await import(
      "../src/lib/anthropic.js"
    );
    vi.mocked(hasAnthropicCredentialsConfigured).mockResolvedValue(true);
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    } as never);
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-agent"] });
    expect(await claudeAgentProvider.isAvailable(ctx)).toBe(true);
    expectAttemptedWithErrorLabel(await claudeAgentProvider.fetch(ctx), "Claude Agent");
  });

  it("marks a rate-limited usage request retryable with its backoff deadline", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
      message: "Anthropic API returned 429",
      failureCategory: "provider_api",
      retryAtMs: 1_700_000_000_000,
    } as never);
    const result = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({ providerIds: ["claude-agent"] }),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        label: "Claude Agent",
        message: "Claude quota request failed.",
        failureCategory: "provider_api",
        retryable: true,
        retryAtMs: 1_700_000_000_000,
      }),
    ]);
  });

  it("keeps OpenCode account rows and CLI provider rows separate", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryAnthropicQuotaWithOAuth, getAnthropicDiagnostics } = await import(
      "../src/lib/anthropic.js"
    );
    vi.mocked(readCredentialRows).mockResolvedValue([
      {
        id: "personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "opencode-token" },
      },
    ] as never);
    vi.mocked(queryAnthropicQuotaWithOAuth).mockResolvedValue({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      credentialFingerprint: "fp:cli-token",
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    } as never);
    const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic", "claude-agent"] });
    const anthropic = await anthropicProvider.fetch(ctx);
    const agent = await claudeAgentProvider.fetch(ctx);
    expect(anthropic.accounts ?? []).toEqual([]);
    expect(anthropic.entries).toEqual([]);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(anthropic.entries.some((entry) => entry.group === "Claude Code")).toBe(false);
    expect(agent.accounts ?? []).toEqual([]);
    expect(
      agent.entries.map((entry) => [
        entry.group,
        entry.accounting.sourceId,
        entry.percentRemaining,
      ]),
    ).toEqual([["Claude Agent", undefined, 55]]);
  });

  it("keeps a selected Anthropic route visible without an OpenCode login", async () => {
    const ctx = createProviderAvailabilityContext({
      providerIds: [],
      configOverrides: { onlyCurrentModel: true, currentModel: "anthropic/sonnet" },
    });
    expect(await anthropicProvider.isAvailable(ctx)).toBe(true);
    expect((await anthropicProvider.fetch(ctx)).errors[0]?.message).toContain(
      "API quota is unavailable",
    );
  });

  it.each([
    [false, true, false, true],
    [true, false, false, false],
  ])("gates availability independently for OpenCode login=%s and CLI auth=%s", async (login, cli, expectedAnthropic, expectedAgent) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const {
      hasAnthropicCredentialsConfigured,
      queryAnthropicQuotaWithOAuth,
      getAnthropicDiagnostics,
    } = await import("../src/lib/anthropic.js");
    vi.mocked(readCredentialRows).mockResolvedValue(
      (login
        ? [
            {
              id: "personal",
              integrationId: "anthropic",
              label: "Personal",
              active: true,
              value: { type: "oauth", access: "token" },
            },
          ]
        : []) as never,
    );
    vi.mocked(hasAnthropicCredentialsConfigured).mockResolvedValue(cli);
    vi.mocked(queryAnthropicQuotaWithOAuth).mockResolvedValue({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    } as never);
    const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic", "claude-agent"] });
    expect(await anthropicProvider.isAvailable(ctx)).toBe(expectedAnthropic);
    expect(await claudeAgentProvider.isAvailable(ctx)).toBe(expectedAgent);
    if (login) expect((await anthropicProvider.fetch(ctx)).entries).toHaveLength(0);
    if (cli) expect((await claudeAgentProvider.fetch(ctx)).entries).toHaveLength(1);
  });

  it.each([
    ["token"],
    ["different"],
  ])("reports Claude Agent quota regardless of OpenCode token equality (%s)", async (cliToken) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
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
    vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
      installed: true,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      credentialFingerprint: `fp:${cliToken}`,
      quota: { success: true, five_hour: { percentRemaining: 55 } },
    } as never);
    const all = createProviderAvailabilityContext({ providerIds: ["anthropic", "claude-agent"] });
    expect((await anthropicProvider.fetch(all)).entries).toHaveLength(0);
    const agent = await claudeAgentProvider.fetch(all);
    expect(agent.entries).toHaveLength(1);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    const selected = createProviderAvailabilityContext({
      providerIds: ["claude-agent"],
      configOverrides: { onlyCurrentModel: true, currentProviderID: "claude-agent" },
    });
    expect((await claudeAgentProvider.fetch(selected)).entries).toHaveLength(1);
  });

  it.each([
    "cli",
    "opencode",
  ])("isolates a %s failure with the same operation cache", async (failure) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    vi.mocked(readCredentialRows).mockResolvedValue([
      {
        id: "personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ] as never);
    vi.mocked(queryAnthropicQuotaWithOAuth).mockResolvedValue(
      failure === "opencode"
        ? { success: false, error: "failed", failureCategory: "provider_api" }
        : { success: true, five_hour: { percentRemaining: 80 } },
    );
    if (failure === "cli")
      vi.mocked(getAnthropicDiagnostics).mockRejectedValue(new Error("failed"));
    else
      vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
        installed: true,
        authStatus: "authenticated",
        quotaSupported: true,
        quotaSource: "claude-auth-status-json",
        checkedCommands: [],
        credentialFingerprint: "fp:other",
        quota: { success: true, five_hour: { percentRemaining: 55 } },
      } as never);
    const ctx = {
      ...createProviderAvailabilityContext({ providerIds: ["anthropic", "claude-agent"] }),
      operationCache: new Map(),
    };
    const [anthropic, agent] = await Promise.all([
      anthropicProvider.fetch(ctx),
      claudeAgentProvider.fetch(ctx),
    ]);
    expect(anthropic.errors).toHaveLength(0);
    expect(agent.errors).toHaveLength(failure === "cli" ? 1 : 0);
    expect(anthropic.entries).toHaveLength(0);
    expect(agent.entries).toHaveLength(failure === "cli" ? 0 : 1);
  });
  it("does not repeat diagnostics after the initial probe throws", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const secret = "secret-token";
    const path = "C:\\Users\\Alice\\private\\claude.exe";
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(
      new Error(`probe failed ${path} ${secret}`),
    );

    const out = await claudeAgentProvider.fetch({} as any);

    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(out.errors[0]?.message).toBe("Claude CLI probe failed.");
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain(path);
    expect(JSON.stringify(out)).not.toMatch(/stack|Error:/);
  });
  it("adds the Fable weekly row and diagnostic when the OAuth response reports it", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
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
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: ["claude --version"],
      quota,
    });
    const out = await claudeAgentProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toContainEqual({
      key: "fable_weekly_remaining",
      value: "98% reset_at=2026-07-27T07:00:00.268Z",
    });
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([
      {
        name: "Claude Agent 5h",
        group: "Claude Agent",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 58,
        resetTimeIso: "2026-07-21T14:10:00.268Z",
      },
      {
        name: "Claude Agent Weekly",
        group: "Claude Agent",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 72,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
      {
        name: "Claude Agent Fable Weekly",
        group: "Claude Agent",
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
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
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
    const out = await claudeAgentProvider.fetch({} as any);

    expect(out.entries.map((entry) => (entry as any).fixedWindow)).toEqual([
      fixedWindow("2026-07-21T09:10:00.000Z", "2026-07-21T14:10:00.000Z"),
      fixedWindow("2026-07-20T07:00:00.000Z", "2026-07-27T07:00:00.000Z"),
      undefined,
    ]);
    expect(out.entries[2]).not.toHaveProperty("fixedWindow");
  });
  it("maps local CLI quota windows into canonical grouped-capable rows", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
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
    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([
      {
        name: "Claude Agent 5h",
        group: "Claude Agent",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 43,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Agent Weekly",
        group: "Claude Agent",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 88,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "local_cli")).toBe(
      true,
    );
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(out.presentation).toBeUndefined();
  });

  it("uses quota from the current diagnostics probe instead of re-probing an unbound CLI", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expect(
      visibleEntries(out.entries, "claude-agent").map((entry) => entry.percentRemaining),
    ).toEqual([43, 88]);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
  });
  it("reports enabled Usage Credits as a third remote API quota row", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "1.2.3",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: ["claude --version"],
      quota: {
        success: true,
        five_hour: { percentRemaining: 43 },
        seven_day: { percentRemaining: 88 },
        extra_usage: { percentRemaining: 62 },
      },
    });
    const out = await claudeAgentProvider.fetch({} as any);

    expect(visibleEntries(out.entries, "claude-agent")).toEqual([
      {
        name: "Claude Agent 5h",
        group: "Claude Agent",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 43,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Agent Weekly",
        group: "Claude Agent",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 88,
        resetTimeIso: undefined,
      },
      {
        name: "Claude Agent Usage Credits",
        group: "Claude Agent Usage Credits",
        label: "Monthly:",
        rowKey: "window:month",
        percentRemaining: 62,
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.acquisitionMethod === "remote_api")).toBe(
      true,
    );
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([
      {
        name: "Claude Agent 5h",
        group: "Claude Agent",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 50,
        resetTimeIso: "2026-03-25T18:00:00.000Z",
      },
      {
        name: "Claude Agent Weekly",
        group: "Claude Agent",
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
    const out = await claudeAgentProvider.fetch(
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
      oauthCredentialSource: "claude-credentials",
      binaryPath: "claude (PATH)",
      checkedCommands: [],
      message:
        "Invalid or expired Anthropic token; re-authenticate Claude Code or update CLAUDE_CODE_OAUTH_TOKEN",
    });

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );
    expectAttemptedWithErrorLabel(out, "Claude Agent");
  });

  it.each([
    "claude-agent",
    "claude-code",
  ])("uses Claude credentials for the %s route without a CLI version", async (runtimeProviderId) => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: false,
      version: null,
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
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
    const out = await claudeAgentProvider.fetch(ctx);

    expect(claudeAgentProvider.id).toBe("claude-agent");
    expect(getAnthropicDiagnostics).toHaveBeenCalledWith({
      binaryPath: undefined,
      requestTimeoutMs: undefined,
    });
    expect(getAnthropicDiagnostics).toHaveBeenCalledOnce();
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(readCredentialRows).not.toHaveBeenCalled();
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([
      {
        name: "Claude Agent 5h",
        group: "Claude Agent",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 75,
        resetTimeIso: undefined,
      },
    ]);
  });

  it.each([
    ["5-hour", { five_hour: { percentRemaining: 75 } }, "Claude Agent 5h"],
    ["weekly", { seven_day: { percentRemaining: 65 } }, "Claude Agent Weekly"],
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
    const out = await claudeAgentProvider.fetch(ctx);

    expect(out.entries.map((entry) => entry.name)).toEqual([name]);
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

    await expect(claudeAgentProvider.isAvailable(ctx)).resolves.toBe(true);
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

    expectAttemptedWithErrorLabel(await claudeAgentProvider.fetch(ctx), "Claude Agent");
    const second = await claudeAgentProvider.fetch(ctx);

    expect(
      visibleEntries(second.entries, "claude-agent").map((entry) => entry.percentRemaining),
    ).toEqual([70]);
    expect(getAnthropicDiagnostics).toHaveBeenNthCalledWith(2, {
      binaryPath: undefined,
      requestTimeoutMs: undefined,
    });
  });

  it("shows a Claude Code route rejected by the usage endpoint as a credentials error without an OpenCode fallback", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude Agent");
    expect(out.errors?.[0]).toMatchObject({ failureCategory: "credentials" });
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([]);
    expect(readCredentialRows).not.toHaveBeenCalled();
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
  });
  it("keeps a detected Claude Code route visible as an error when its usage probe fails", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude Agent");
    expect(visibleEntries(out.entries, "claude-agent")).toEqual([]);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude Agent");
    expect(out.errors?.[0]?.message).toContain("Claude is not authenticated");
  });

  it("reports a Claude Code route whose CLI probe throws as an error row instead of dropping it", async () => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockRejectedValueOnce(
      new Error(
        "Claude CLI path contains characters that cannot be passed safely through cmd.exe.",
      ),
    );

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-code"],
        configOverrides: { currentProviderID: "claude-code", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude Agent");
    expect(out.errors?.[0]?.message).toBe("Claude CLI probe failed.");
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expectAttemptedWithErrorLabel(out, "Claude Agent");
    expect(out.errors?.[0]?.message).toBe("Claude Agent usage is unavailable.");
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

    const out = await claudeAgentProvider.fetch(
      createProviderAvailabilityContext({
        providerIds: ["claude-agent"],
        configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
      }),
    );

    expect(out.entries.map((entry) => entry.name)).toEqual(["Claude Agent 5h"]);
    expect(out.planLabel).toBe(planLabel);
    if (planLabel === undefined) expect(out).not.toHaveProperty("planLabel");
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

    const out = await claudeAgentProvider.fetch(
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

    const out = await claudeAgentProvider.fetch(
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

    await expect(claudeAgentProvider.isAvailable(ctx)).resolves.toBe(false);
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(true);
  });

  it("does not discover a Claude Code runtime on a selected anthropic route", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(false);
    const ctx = createProviderAvailabilityContext({
      providerIds: ["claude-code"],
      configOverrides: { currentProviderID: "anthropic", onlyCurrentModel: true },
    });

    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(false);
  });

  it.each([
    { connections: [{ type: "credential", method: "external" }], discovered: true },
    {
      connections: [{ type: "credential", method: "external", status: { status: "needs_auth" } }],
      discovered: true,
    },
    { connections: [], discovered: false },
    { connections: [{ type: "credential", method: "oauth" }], discovered: false },
    { connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }], discovered: false },
  ])("uses the host's Claude Agent connections for discovery: $connections", async ({
    connections,
    discovered,
  }) => {
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-agent"] });
    Object.assign(ctx.client, {
      integration: { list: async () => ({ data: [{ id: "claude-agent", connections }] }) },
    });
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(discovered);
  });

  it("discovers a host-connected Claude Agent before provider models appear", async () => {
    const ctx = createProviderAvailabilityContext({ providerIds: [] });
    Object.assign(ctx.client, {
      integration: {
        list: async () => ({
          data: [{ id: "claude-agent", connections: [{ type: "credential", method: "external" }] }],
        }),
      },
    });
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(true);
  });

  it("falls back to provider detection when integration listing fails", async () => {
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-agent"] });
    Object.assign(ctx.client, {
      integration: {
        list: async () => {
          throw new Error("unavailable");
        },
      },
    });
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(true);
  });

  it("keeps a legacy Claude Code provider when the host's Claude Agent has no connection", async () => {
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-code"] });
    Object.assign(ctx.client, {
      integration: { list: async () => ({ data: [{ id: "claude-agent", connections: [] }] }) },
    });
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(true);
  });

  it("keeps a separately verified CLI login available without a host external connection", async () => {
    const { hasAnthropicCredentialsConfigured } = await import("../src/lib/anthropic.js");
    (hasAnthropicCredentialsConfigured as any).mockResolvedValue(true);
    const ctx = createProviderAvailabilityContext({ providerIds: ["claude-agent"] });
    Object.assign(ctx.client, {
      integration: { list: async () => ({ data: [{ id: "claude-agent", connections: [] }] }) },
    });
    await expect(claudeAgentProvider.isDiscovered?.(ctx)).resolves.toBe(false);
    await expect(claudeAgentProvider.isAvailable(ctx)).resolves.toBe(true);
  });
});
