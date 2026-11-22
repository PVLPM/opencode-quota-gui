import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAnthropicApiKey } from "../src/lib/anthropic-api-auth.js";
import {
  clearAnthropicApiObservations,
  digestAnthropicApiKey,
  observeAnthropicApiResponse,
} from "../src/lib/anthropic-api-rate-limits.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectNotAttempted,
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

vi.mock("../src/lib/anthropic-api-auth.js", () => ({
  resolveAnthropicApiKey: vi.fn().mockResolvedValue(null),
}));

describe("anthropic provider", () => {
  beforeEach(async () => {
    const { resolveAnthropicApiKey } = await import("../src/lib/anthropic-api-auth.js");
    vi.mocked(resolveAnthropicApiKey).mockReset().mockResolvedValue(null);
    clearAnthropicApiObservations();
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

  it("does not report OpenCode OAuth subscription quota or launch the CLI", async () => {
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

    expect(await anthropicProvider.isAvailable(ctx)).toBe(false);
    expect((await anthropicProvider.fetch(ctx)).entries).toHaveLength(0);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
    expect(hasAnthropicCredentialsConfigured).not.toHaveBeenCalled();
  });

  describe("API-key rate-limit observations", () => {
    const API_KEY = "sk-ant-api-key-one";
    const ctx = () => createProviderAvailabilityContext({ providerIds: ["anthropic"] });
    const observe = (
      headers: Record<string, string>,
      options: { key?: string; url?: string; status?: number } = {},
    ) =>
      observeAnthropicApiResponse({
        request: new Request(options.url ?? "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers:
            options.key === undefined ? { "x-api-key": API_KEY } : { "x-api-key": options.key },
        }),
        response: new Response(null, { status: options.status ?? 200, headers }),
        nowMs: Date.parse("2026-11-22T10:00:00Z"),
      });
    const RESET = "2026-11-22T10:01:00Z";
    const LIMITS = {
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-requests-remaining": "958",
      "anthropic-ratelimit-requests-reset": RESET,
      "anthropic-ratelimit-input-tokens-limit": "80000",
      "anthropic-ratelimit-input-tokens-remaining": "79000",
    };

    it("is available with a key, shows an honest empty state, and never calls Claude Agent paths", async () => {
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue(API_KEY);
      const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");

      expect(await anthropicProvider.isAvailable(ctx())).toBe(true);
      const out = await anthropicProvider.fetch(ctx());

      expect(out.errors).toEqual([]);
      expect(out.entries).toMatchObject([
        { kind: "value", value: "No rate-limit headers observed yet" },
      ]);
      expect(JSON.stringify(out)).not.toContain(API_KEY);
      expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
    });

    it("is unavailable without a key and reports only a selected route's missing key", async () => {
      expect(await anthropicProvider.isAvailable(ctx())).toBe(false);
      expectNotAttempted(await anthropicProvider.fetch(ctx()));
    });

    it("shows observed per-minute limits as rate-limit value rows with reset and observation time", async () => {
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue(API_KEY);
      expect(observe(LIMITS)).toBe(true);

      const out = await anthropicProvider.fetch(ctx());

      expect(out.entries).toMatchObject([
        {
          kind: "value",
          label: "Requests:",
          value: "958 of 1,000 remaining",
          resetTimeIso: "2026-11-22T10:01:00.000Z",
          accounting: { resultType: "rate_limit", observedAtIso: "2026-11-22T10:00:00.000Z" },
        },
        { kind: "value", label: "Input tokens:", value: "79,000 of 80,000 remaining" },
      ]);
      expect(out.entries.some((entry) => entry.kind !== "value")).toBe(false);
    });

    it("records a 429 retry-after and keeps missing headers from inventing values", async () => {
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue(API_KEY);
      expect(observe({ "retry-after": "30" }, { status: 429 })).toBe(true);

      const out = await anthropicProvider.fetch(ctx());

      expect(out.entries).toMatchObject([
        { label: "Retry after:", value: "30 s (last rate-limited response)" },
      ]);
      expect(observe({ unrelated: "1" })).toBe(false);
    });

    it("never shows the previous key's limits after a key change", async () => {
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue(API_KEY);
      observe(LIMITS);
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue("sk-ant-api-key-two");

      const out = await anthropicProvider.fetch(ctx());

      expect(out.entries).toMatchObject([{ value: "No rate-limit headers observed yet" }]);
      expect(JSON.stringify(out)).not.toMatch(/958|digest|sk-ant/);
      expect(digestAnthropicApiKey(API_KEY)).not.toBe(digestAnthropicApiKey("sk-ant-api-key-two"));
    });

    it("ignores OAuth traffic, other hosts, other paths and malformed values, and never throws", () => {
      const response = new Response(null, { headers: LIMITS });
      const oauth = new Request("https://api.anthropic.com/v1/messages", {
        headers: { authorization: "Bearer claude-subscription" },
      });
      expect(observeAnthropicApiResponse({ request: oauth, response })).toBe(false);
      expect(observe(LIMITS, { url: "https://example.com/v1/messages" })).toBe(false);
      expect(observe(LIMITS, { url: "https://api.anthropic.com/v1/messages/count_tokens" })).toBe(
        false,
      );
      expect(observe(LIMITS, { url: "http://api.anthropic.com/v1/messages" })).toBe(false);
      expect(observe({ "anthropic-ratelimit-requests-remaining": "-5" })).toBe(false);
      expect(
        observeAnthropicApiResponse({
          request: { url: "not a url", headers: { get: () => "k" } },
          response: {
            status: 200,
            headers: {
              get: () => {
                throw new Error("boom");
              },
            },
          },
        }),
      ).toBe(false);
    });

    it("keeps Claude Agent and the Anthropic API card independent when both are configured", async () => {
      vi.mocked(resolveAnthropicApiKey).mockResolvedValue(API_KEY);
      const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
      vi.mocked(getAnthropicDiagnostics).mockResolvedValue({
        installed: true,
        version: "2.1.123",
        authStatus: "authenticated",
        quotaSupported: true,
        quotaSource: "claude-auth-status-json",
        checkedCommands: [],
        quota: { success: true, five_hour: { percentRemaining: 42 } },
      } as never);
      observe(LIMITS);
      const { claudeAgentProvider } = await import("../src/providers/claude-agent.js");

      const agent = await claudeAgentProvider.fetch(
        createProviderAvailabilityContext({
          providerIds: ["claude-agent"],
          configOverrides: { currentProviderID: "claude-agent", onlyCurrentModel: true },
        }),
      );
      const api = await anthropicProvider.fetch(ctx());

      expect(JSON.stringify(agent)).not.toMatch(/958|rate_limit/);
      expect(JSON.stringify(api)).not.toMatch(/42%|five_hour|Claude Agent/);
    });
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
    expect(result.accounts ?? []).toEqual([]);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
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

  it("ignores active and inactive OAuth credentials, including expired credentials", async () => {
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

    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
    expectNotAttempted(out);
  });
  it("does not report unreadable or valid OAuth login rows as API quota", async () => {
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

    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
    expectNotAttempted(out);
  });
  it.each([
    "anthropic",
    "claude-code",
    "claude-agent",
  ])("does not report Anthropic OAuth accounts in all-provider collection for %s", async (runtimeProviderId) => {
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

    expect(readCredentialRows).not.toHaveBeenCalled();
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expectNotAttempted(out);
    expect(getAnthropicDiagnostics).not.toHaveBeenCalled();
  });

  it("does not query OAuth accounts in Claude Code all-provider mode", async () => {
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

    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expectNotAttempted(out);
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
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();
    expect(out.entries).toEqual([]);
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

    expectAttemptedWithErrorLabel(out, "Anthropic");
    expect(out.errors?.[0]).toMatchObject({
      message: "No Anthropic API key is configured.",
    });
    expect(out.entries).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
  it("keeps raw identities, paths, and fingerprints out of the unavailable result", async () => {
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

    expect(out.accounts ?? []).toEqual([]);
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();

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
