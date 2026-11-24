import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RESET_ISO = "2030-01-02T00:00:00.000Z";
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;
const CLAUDE_SESSION_ID = "claude-session";
const CLAUDE_MODEL = { id: "claude-sonnet-4-5", providerID: "claude-agent" };

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(async () => null as unknown),
  readCredentialRows: vi.fn(async () => [] as unknown[]),
  querySyntheticQuota: vi.fn(),
  hasSyntheticApiKeyConfigured: vi.fn(),
  getSyntheticKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
  queryChutesQuota: vi.fn(),
  hasChutesApiKeyConfigured: vi.fn(),
  getChutesKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
  queryAlibabaCodingPlanQuota: vi.fn(),
  queryOpenAIQuota: vi.fn(),
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" as const })),
  hasOpenAIOAuthCached: vi.fn(async () => false),
  queryCopilotQuota: vi.fn(),
  hasCopilotQuotaRuntimeAvailable: vi.fn(async () => false),
  getAnthropicDiagnostics: vi.fn(),
  getCopilotQuotaAuthDiagnostics: vi.fn(() => ({
    pat: { state: "missing", checkedPaths: [] },
    oauth: {
      configured: true,
      keyName: "github-copilot",
      hasRefreshToken: true,
      hasAccessToken: true,
      hasEnterpriseUrl: false,
    },
    deployment: "github.com",
    apiHost: null,
    enterpriseHostSource: "none",
    effectiveSource: "oauth",
    override: "none",
    billingMode: "organization_usage",
    billingScope: "organization",
    quotaApi: "copilot_internal_user",
    budgetApi: "billing",
    oauthAccountingState: "available_via_copilot_internal_user",
    billingApiAccessLikely: true,
    remainingTotalsState: "reported_by_copilot_internal_user",
  })),
  queryGoogleAgyQuota: vi.fn(),
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-agy",
    accountCount: 1,
    validAccountCount: 1,
  })),
  inspectAgyCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
  queryGeminiCliQuota: vi.fn(),
  inspectGeminiCliAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-gemini-cli",
    accountCount: 1,
    validAccountCount: 1,
  })),
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
  queryKimiQuota: vi.fn(),
  resolveKimiGlobalAuthWithDiagnosticsCached: vi.fn(async () => ({
    auth: { state: "configured" as const, apiKey: "kimi-key", endpoint: "global" as const },
    diagnostics: {
      state: "configured" as const,
      source: "env:KIMI_GLOBAL_API_KEY",
      endpoint: "global" as const,
      checkedPaths: ["env:KIMI_GLOBAL_API_KEY"],
      credentialDatabasePaths: [],
    },
  })),
  queryOpenRouterQuota: vi.fn(),
  resolveOpenRouterAuth: vi.fn(),
  queryDeepSeekBalance: vi.fn(),
  getDeepSeekKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env:DEEPSEEK_API_KEY",
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  queryKiloQuota: vi.fn(),
  getKiloKeyDiagnostics: vi.fn(async () => ({
    configured: true,
    source: "env:KILO_API_KEY",
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  resolveMimoConfigCached: vi.fn(),
  getMimoConfigDiagnostics: vi.fn(async () => ({
    state: "configured",
    source: "env:MIMO_USAGE_COOKIE",
    error: null,
    checkedPaths: [],
  })),
  queryMimoDashboard: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readAuthFileCached: mocks.readAuthFileCached,
  readCredentialRows: mocks.readCredentialRows,
}));

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  getAnthropicDiagnostics: mocks.getAnthropicDiagnostics,
}));

vi.mock("../src/lib/synthetic.js", () => ({
  querySyntheticQuota: mocks.querySyntheticQuota,
  hasSyntheticApiKeyConfigured: mocks.hasSyntheticApiKeyConfigured,
  getSyntheticKeyDiagnostics: mocks.getSyntheticKeyDiagnostics,
}));

vi.mock("../src/lib/chutes.js", () => ({
  queryChutesQuota: mocks.queryChutesQuota,
  hasChutesApiKeyConfigured: mocks.hasChutesApiKeyConfigured,
  getChutesKeyDiagnostics: mocks.getChutesKeyDiagnostics,
}));

vi.mock("../src/lib/alibaba-coding-plan-cli.js", () => ({
  queryAlibabaCodingPlanQuota: mocks.queryAlibabaCodingPlanQuota,
}));

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  OPENAI_AUTH_SOURCE_KEYS: ["openai", "codex", "chatgpt"],
  hasOpenAIOAuthCached: mocks.hasOpenAIOAuthCached,
  resolveOpenAIOAuth: mocks.resolveOpenAIOAuth,
  queryOpenAIQuota: mocks.queryOpenAIQuota,
}));

vi.mock("../src/lib/copilot.js", () => ({
  COPILOT_AUTH_KEYS: ["github-copilot", "copilot", "copilot-chat", "github-copilot-chat"],
  hasCopilotQuotaRuntimeAvailable: mocks.hasCopilotQuotaRuntimeAvailable,
  getCopilotQuotaAuthDiagnostics: mocks.getCopilotQuotaAuthDiagnostics,
  queryCopilotQuota: mocks.queryCopilotQuota,
}));

vi.mock("../src/lib/google-agy.js", () => ({
  AGY_AUTH_KEYS: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  hasAgyQuotaRuntimeAvailable: vi.fn(async () => true),
  inspectAgyAuthPresence: mocks.inspectAgyAuthPresence,
  queryGoogleAgyQuota: mocks.queryGoogleAgyQuota,
}));

vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: mocks.inspectAgyCompanionPresence,
}));

vi.mock("../src/lib/google-gemini-cli.js", () => ({
  GEMINI_CLI_AUTH_KEYS: [
    "google-gemini-cli",
    "gemini-cli",
    "opencode-gemini-auth",
    "gemini",
    "google",
  ],
  hasGeminiCliQuotaRuntimeAvailable: vi.fn(async () => true),
  inspectGeminiCliAuthPresence: mocks.inspectGeminiCliAuthPresence,
  queryGeminiCliQuota: mocks.queryGeminiCliQuota,
}));

vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: mocks.inspectGeminiCliCompanionPresence,
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveKimiGlobalAuth: vi.fn(),
  resolveKimiCnAuth: vi.fn(),
  resolveKimiGlobalAuthCached: vi.fn(),
  resolveKimiCnAuthCached: vi.fn(),
  resolveKimiGlobalAuthWithDiagnosticsCached: mocks.resolveKimiGlobalAuthWithDiagnosticsCached,
  resolveKimiCnAuthWithDiagnosticsCached: vi.fn(),
}));

vi.mock("../src/lib/kimi.js", () => ({
  queryKimiQuota: mocks.queryKimiQuota,
}));

vi.mock("../src/lib/openrouter.js", () => ({
  hasOpenRouterApiKeyConfigured: vi.fn(async () => true),
  resolveOpenRouterAuth: mocks.resolveOpenRouterAuth,
  queryOpenRouterQuota: mocks.queryOpenRouterQuota,
  resolveOpenRouterApiKey: vi.fn(),
}));

vi.mock("../src/lib/deepseek.js", () => ({
  hasDeepSeekApiKeyConfigured: vi.fn(async () => true),
  getDeepSeekKeyDiagnostics: mocks.getDeepSeekKeyDiagnostics,
  queryDeepSeekBalance: mocks.queryDeepSeekBalance,
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  hasKiloApiKey: vi.fn(async () => true),
  getKiloKeyDiagnostics: mocks.getKiloKeyDiagnostics,
}));

vi.mock("../src/lib/kilo.js", () => ({
  queryKiloQuota: mocks.queryKiloQuota,
}));

vi.mock("../src/lib/mimo-config.js", () => ({
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  getMimoConfigDiagnostics: mocks.getMimoConfigDiagnostics,
  resolveMimoConfigCached: mocks.resolveMimoConfigCached,
}));

vi.mock("../src/lib/mimo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mimo.js")>()),
  queryMimoDashboard: mocks.queryMimoDashboard,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(async () => true),
}));

import type { QuotaProviderResult } from "../src/lib/entries.js";
import {
  createQuotaAutoResumption,
  QUOTA_AUTO_RESUME_GRACE_MS,
} from "../src/lib/quota-auto-resume.js";
import {
  collectQuotaWindows,
  type QuotaWindowBinding,
  type QuotaWindowCollection,
  resolveQuotaEvidenceBinding,
} from "../src/lib/quota-retry-wait.js";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";
import { anthropicQuotaEntries } from "../src/providers/anthropic.js";
import { chutesProvider } from "../src/providers/chutes.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";
import { copilotProvider } from "../src/providers/copilot.js";
import { deepseekProvider } from "../src/providers/deepseek.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";
import { kiloProvider } from "../src/providers/kilo.js";
import { kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";
import { xiaomiProvider } from "../src/providers/mimo.js";
import { openaiProvider } from "../src/providers/openai.js";
import { openRouterProvider } from "../src/providers/openrouter.js";
import { syntheticProvider } from "../src/providers/synthetic.js";

function keys(collection: ReturnType<typeof collectQuotaWindows>): string[] {
  return (collection?.windows ?? []).map((window) => window.key ?? "missing");
}

function hasPrimaryWindow(result: QuotaProviderResult): boolean {
  return result.entries.some(
    (entry) => entry.semantic?.prominence === "primary" && entry.semantic.metric.kind === "window",
  );
}

function providerScope(providerId: string, scope: string): QuotaWindowBinding {
  return { kind: "provider-scope", providerId, scope };
}

function claudeDiagnostics(fiveHour: number, weekly: number, resetTimeIso: string) {
  return {
    installed: true,
    version: "1.2.3",
    authStatus: "authenticated",
    quotaSupported: true,
    quotaSource: "claude-credentials-oauth-api",
    checkedCommands: [],
    quota: {
      success: true,
      five_hour: { percentRemaining: fiveHour, resetTimeIso },
      seven_day: { percentRemaining: weekly, resetTimeIso },
    },
  };
}

async function claudeAgentResult(fiveHour: number, weekly: number, resetTimeIso: string) {
  mocks.getAnthropicDiagnostics.mockResolvedValueOnce(
    claudeDiagnostics(fiveHour, weekly, resetTimeIso) as never,
  );
  return claudeAgentProvider.fetch({ config: {} } as never);
}

describe("auto-resume provider evidence", () => {
  it("accepts Synthetic windows only through a provider-scope binding", async () => {
    mocks.querySyntheticQuota.mockResolvedValueOnce({
      success: true,
      windows: {
        fiveHour: { limit: 100, used: 100, percentRemaining: 0, resetTimeIso: RESET_ISO },
        weekly: { limit: 24, used: 12, percentRemaining: 50, resetTimeIso: RESET_ISO },
      },
    });

    const result = await syntheticProvider.fetch({ config: {} } as never);

    expect(result.accounts).toBeUndefined();
    expect(result.entries.some((entry) => entry.accounting.sourceId !== undefined)).toBe(false);
    // Without a verified binding there is nothing to attribute a failure or a recovery to.
    expect(collectQuotaWindows([result], undefined, { primaryAccountOnly: true })).toBeUndefined();
    // An OpenCode account id cannot bind rows the adapter does not attribute.
    expect(
      keys(
        collectQuotaWindows(
          [result],
          { kind: "account", sourceId: "synthetic-account" },
          {
            primaryAccountOnly: true,
          },
        ),
      ),
    ).toEqual([]);
    expect(
      keys(
        collectQuotaWindows([result], providerScope("synthetic", "scope-synthetic"), {
          primaryAccountOnly: true,
        }),
      ),
    ).toEqual(["window:five_hour", "window:week"]);
    // The single-source cache scope wins over an unrelated account row.
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "synthetic",
        providerResults: [{ providerId: "synthetic", result, cacheScope: "scope-synthetic" }],
        activeSourceId: "synthetic-account",
      }),
    ).toEqual(providerScope("synthetic", "scope-synthetic"));
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "synthetic",
        providerResults: [{ providerId: "synthetic", result }],
        activeSourceId: "synthetic-account",
      }),
    ).toBeUndefined();
  });

  it("accepts Chutes windows only through a provider-scope binding", async () => {
    mocks.queryChutesQuota.mockResolvedValueOnce({
      success: true,
      percentRemaining: 0,
      resetTimeIso: RESET_ISO,
    });

    const result = await chutesProvider.fetch({ config: {} } as never);

    expect(result.accounts).toBeUndefined();
    expect(result.entries.some((entry) => entry.accounting.sourceId !== undefined)).toBe(false);
    expect(
      keys(
        collectQuotaWindows(
          [result],
          { kind: "account", sourceId: "chutes-account" },
          {
            primaryAccountOnly: true,
          },
        ),
      ),
    ).toEqual([]);
    expect(
      keys(
        collectQuotaWindows([result], providerScope("chutes", "scope-chutes"), {
          primaryAccountOnly: true,
        }),
      ),
    ).toEqual(["window:day"]);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "chutes",
        providerResults: [{ providerId: "chutes", result, cacheScope: "scope-chutes" }],
      }),
    ).toEqual(providerScope("chutes", "scope-chutes"));
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "chutes",
        providerResults: [{ providerId: "chutes", result }],
        activeSourceId: "chutes-account",
      }),
    ).toBeUndefined();
  });

  it("never derives a provider-scope binding for Alibaba CLI rows", async () => {
    mocks.queryAlibabaCodingPlanQuota.mockResolvedValueOnce({
      state: "success",
      usage: {
        instanceType: "lite",
        fiveHour: {
          used: 200,
          total: 200,
          percentage: 1,
          resetTimeIso: RESET_ISO,
        },
        weekly: { used: 40, total: 500, percentage: 0.08 },
        monthly: { used: 60, total: 900, percentage: 0.2 },
      },
    });

    const result = await alibabaCodingPlanProvider.fetch({
      config: {},
      workspaceRoot: "/workspace",
    } as never);

    expect(result.accounts).toBeUndefined();
    expect(result.entries.some((entry) => entry.accounting.sourceId !== undefined)).toBe(false);
    // The Alibaba CLI quota has no provider cache scope, so no binding can be verified.
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "alibaba-coding-plan",
        providerResults: [
          { providerId: "alibaba-coding-plan", result, cacheScope: "scope-alibaba" },
        ],
      }),
    ).toBeUndefined();
    expect(
      keys(
        collectQuotaWindows([result], undefined, {
          primaryAccountOnly: true,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps OpenAI primary route windows and excludes Code Review", async () => {
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "openai-account",
        integrationId: "openai",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    mocks.resolveOpenAIOAuth.mockReturnValueOnce({
      state: "configured",
      sourceKey: "openai",
      accessToken: "token",
    });
    mocks.queryOpenAIQuota.mockResolvedValueOnce({
      success: true,
      label: "OpenAI",
      windows: {
        hourly: { percentRemaining: 0, resetTimeIso: RESET_ISO },
        weekly: { percentRemaining: 50, resetTimeIso: RESET_ISO },
        monthly: { percentRemaining: 50, resetTimeIso: RESET_ISO },
        codeReview: { percentRemaining: 0, resetTimeIso: RESET_ISO },
      },
    });

    const result = await openaiProvider.fetch({ config: {} } as never);

    expect(result.accounts?.map((account) => account.sourceId)).toEqual(["openai-account"]);
    expect(result.entries.some((entry) => entry.accounting.sourceId !== "openai-account")).toBe(
      false,
    );
    // OpenAI is a multi-account provider: the account row, not a cache scope, is the binding.
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "openai",
        providerResults: [{ providerId: "openai", result, cacheScope: "ignored-scope" }],
        activeSourceId: "openai-account",
      }),
    ).toEqual({ kind: "account", sourceId: "openai-account" });

    const unfiltered = collectQuotaWindows([result], {
      kind: "account",
      sourceId: "openai-account",
    });
    expect(keys(unfiltered)).toContain("window:code_review");

    const collection = collectQuotaWindows(
      [result],
      { kind: "account", sourceId: "openai-account" },
      { primaryAccountOnly: true },
    );
    expect(keys(collection)).toEqual(["window:five_hour", "window:week", "window:month"]);
    expect(
      collection?.windows
        .filter((window) => window.percentRemaining <= 0)
        .map((window) => window.key),
    ).toEqual(["window:five_hour"]);
  });

  it("excludes a named Anthropic window from auto-resume evidence", () => {
    const entries = anthropicQuotaEntries(
      {
        success: true,
        five_hour: { percentRemaining: 0, resetTimeIso: RESET_ISO },
        fable_weekly: { percentRemaining: 0, resetTimeIso: RESET_ISO },
      },
      { group: "Claude", acquisitionMethod: "local_cli", sourceId: "claude-account" },
    );

    const collection = collectQuotaWindows(
      [{ attempted: true, entries, errors: [] }],
      { kind: "account", sourceId: "claude-account" },
      {
        primaryAccountOnly: true,
      },
    );
    expect(keys(collection)).toEqual(["window:five_hour"]);
  });

  it("excludes a Copilot additional-usage budget row", async () => {
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "copilot-account",
        integrationId: "github-copilot",
        label: "alice",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    mocks.queryCopilotQuota.mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      username: "alice",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 100,
      authority: "provider_reported",
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      budget: {
        amountUsd: 1,
        spentUsd: 1,
        scope: "user",
        percentRemaining: 0,
        authority: "provider_reported",
      },
    });

    const result = await copilotProvider.fetch({ config: {} } as never);

    expect(
      result.entries.some(
        (entry) =>
          entry.accounting.resultType === "budget" &&
          "percentRemaining" in entry &&
          entry.percentRemaining === 0,
      ),
    ).toBe(true);
    expect(
      keys(
        collectQuotaWindows(
          [result],
          { kind: "account", sourceId: "copilot-account" },
          {
            primaryAccountOnly: true,
          },
        ),
      ),
    ).toEqual([]);
  });

  it("binds Claude Agent through the provider cache scope and refuses unknown scopes", async () => {
    const result = await claudeAgentResult(0, 50, RESET_ISO);

    expect(result.accounts).toBeUndefined();
    expect(result.entries.some((entry) => entry.accounting.sourceId !== undefined)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "claude-agent",
        providerResults: [{ providerId: "claude-agent", result, cacheScope: "rai1_claude_a" }],
        activeSourceId: "unrelated-row",
      }),
    ).toEqual(providerScope("claude-agent", "rai1_claude_a"));
    // The legacy claude-code runtime alias maps to the same route provider.
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "claude-code",
        providerResults: [{ providerId: "claude-agent", result, cacheScope: "rai1_claude_a" }],
      }),
    ).toEqual(providerScope("claude-agent", "rai1_claude_a"));
    // No cache scope (no user-specific Claude identity this cycle) means no binding.
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "claude-agent",
        providerResults: [{ providerId: "claude-agent", result }],
      }),
    ).toBeUndefined();
    expect(collectQuotaWindows([result], undefined, { primaryAccountOnly: true })).toBeUndefined();
    expect(
      keys(
        collectQuotaWindows([result], providerScope("claude-agent", "rai1_claude_a"), {
          primaryAccountOnly: true,
        }),
      ),
    ).toEqual(["window:five_hour", "window:week"]);
  });

  it("never binds adapters with no primary window row even when they have an account scope", async () => {
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "agy-account",
        integrationId: "google-agy",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          family: "Gemini Models",
          window: "weekly",
          windowLabel: "Weekly",
          bucketId: "gemini-weekly",
          percentRemaining: 0,
          resetTimeIso: RESET_ISO,
          accountEmail: "alice@example.com",
          accountIndex: 0,
          sourceKey: "google-agy",
        },
      ],
      errors: [],
    });
    const agy = await googleAgyProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(agy)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "google-agy",
        providerResults: [{ providerId: "google-agy", result: agy, cacheScope: "agy-scope" }],
        activeSourceId: "agy-account",
      }),
    ).toBeUndefined();
    expect(
      keys(
        collectQuotaWindows(
          [agy],
          { kind: "account", sourceId: "agy-account" },
          {
            primaryAccountOnly: true,
          },
        ),
      ),
    ).toEqual([]);

    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "gemini-account",
        integrationId: "google-gemini-cli",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    mocks.queryGeminiCliQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          displayName: "Gemini Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 0,
          resetTimeIso: RESET_ISO,
          remainingAmount: "0",
          tokenType: "REQUESTS",
        },
      ],
      errors: [],
    });
    const gemini = await googleGeminiCliProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(gemini)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "google-gemini-cli",
        providerResults: [
          { providerId: "google-gemini-cli", result: gemini, cacheScope: "gemini-scope" },
        ],
        activeSourceId: "gemini-account",
      }),
    ).toBeUndefined();

    mocks.queryKimiQuota.mockResolvedValueOnce({
      success: true,
      label: "Kimi Code",
      windows: [
        {
          technicalKey: "weekly",
          label: "Weekly limit",
          used: 1000,
          limit: 1000,
          percentRemaining: 0,
          resetTimeIso: RESET_ISO,
        },
      ],
    });
    const kimi = await kimiCodePlanGlobalProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(kimi)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "kimi-code-plan-global",
        providerResults: [
          { providerId: "kimi-code-plan-global", result: kimi, cacheScope: "kimi-scope" },
        ],
        activeSourceId: "kimi-account",
      }),
    ).toBeUndefined();

    mocks.resolveOpenRouterAuth.mockResolvedValueOnce({
      accounts: [
        {
          sourceId: "openrouter-account",
          label: "Work",
          active: true,
          resolved: {
            key: "or-key",
            source: "opencode.db",
            checkedPaths: [],
            credentialDatabasePaths: [],
          },
        },
      ],
      checkedPaths: [],
      credentialDatabasePaths: [],
      source: "opencode.db",
    });
    mocks.queryOpenRouterQuota.mockResolvedValueOnce({
      success: true,
      entries: [
        {
          kind: "percent",
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          name: "OpenRouter key limit",
          group: "OpenRouter",
          label: "Key limit:",
          metricLabel: "Key limit",
          right: "$0.00/$1.00",
          percentRemaining: 0,
        },
      ],
    });
    const openrouter = await openRouterProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(openrouter)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "openrouter",
        providerResults: [
          { providerId: "openrouter", result: openrouter, cacheScope: "openrouter-scope" },
        ],
        activeSourceId: "openrouter-account",
      }),
    ).toBeUndefined();

    mocks.queryDeepSeekBalance.mockResolvedValueOnce({
      success: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "0",
          grantedBalance: "0",
          toppedUpBalance: "0",
        },
      ],
      parseIssues: [],
    });
    const deepseek = await deepseekProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(deepseek)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "deepseek",
        providerResults: [
          { providerId: "deepseek", result: deepseek, cacheScope: "deepseek-scope" },
        ],
        activeSourceId: "deepseek-account",
      }),
    ).toBeUndefined();

    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "kilo_pass",
      baseCreditsUsd: 10,
      usageUsd: 10,
      bonusCreditsUsd: 0,
      remainingUsd: 0,
      overageUsd: 0,
      resetTimeIso: RESET_ISO,
    });
    const kilo = await kiloProvider.fetch({ config: {} } as never);
    expect(hasPrimaryWindow(kilo)).toBe(false);
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "kilo",
        providerResults: [{ providerId: "kilo", result: kilo, cacheScope: "kilo-scope" }],
        activeSourceId: "kilo-account",
      }),
    ).toBeUndefined();
  });

  it("records Xiaomi MiMo's primary month window as ineligible without a reset", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      config: { cookie: "api-platform_serviceToken=x; userId=y" },
    });
    mocks.queryMimoDashboard.mockResolvedValueOnce({
      usage: { state: "success", data: { used: 100, limit: 100 } },
      detail: {
        state: "success",
        data: { planName: "Standard", planCode: "standard_monthly", expired: false },
      },
      balance: { state: "success", data: { total: 0, cash: 0, gift: 0, currency: "USD" } },
    });

    const result = await xiaomiProvider.fetch({ config: {} } as never);
    const month = result.entries.find(
      (entry) =>
        entry.semantic?.metric.kind === "window" && entry.semantic.prominence === "primary",
    );

    expect(month).toMatchObject({
      percentRemaining: 0,
      semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
    });
    expect(month).not.toHaveProperty("resetTimeIso");
    expect(
      resolveQuotaEvidenceBinding({
        modelProviderID: "xiaomi",
        providerResults: [{ providerId: "xiaomi", result, cacheScope: "mimo-scope" }],
        activeSourceId: "mimo-account",
      }),
    ).toBeUndefined();
  });
});

describe("Claude Agent auto-resume identity", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function collectionFor(
    result: Awaited<ReturnType<typeof claudeAgentResult>>,
    scope: string,
  ): QuotaWindowCollection {
    const collection = collectQuotaWindows([result], providerScope("claude-agent", scope), {
      primaryAccountOnly: true,
    });
    if (!collection) throw new Error("expected a bound Claude Agent collection");
    return collection;
  }

  function harness() {
    const get = vi.fn(async () => ({
      model: CLAUDE_MODEL,
      outcome: "failed" as const,
      time: { idle: NOW_MS - 1_000 },
    }));
    const prompt = vi.fn(async () => ({}));
    return { get, prompt };
  }

  it("arms with a stable Claude identity and sends one continue", async () => {
    const resetIso = new Date(NOW_MS + 10 * MINUTE_MS).toISOString();
    const exhausted = collectionFor(await claudeAgentResult(0, 50, resetIso), "clip-account-a");
    const recovered = collectionFor(
      await claudeAgentResult(100, 100, new Date(NOW_MS + 60 * MINUTE_MS).toISOString()),
      "clip-account-a",
    );
    const { get, prompt } = harness();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ kind: "collection", collection: exhausted })
      .mockResolvedValueOnce({ kind: "collection", collection: recovered })
      .mockResolvedValueOnce({ kind: "collection", collection: recovered });
    const controller = createQuotaAutoResumption({
      probe,
      session: { get, prompt },
    });

    controller.handleEvent({
      type: "session.execution.failed",
      created: NOW_MS,
      data: { sessionID: CLAUDE_SESSION_ID, error: { type: "provider.quota" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(QUOTA_AUTO_RESUME_GRACE_MS);

    expect(prompt).toHaveBeenCalledOnce();
  });

  it("cancels when the Claude identity changes before recovery", async () => {
    const resetIso = new Date(NOW_MS + 10 * MINUTE_MS).toISOString();
    const exhausted = collectionFor(await claudeAgentResult(0, 50, resetIso), "clip-account-a");
    const recovered = collectionFor(
      await claudeAgentResult(100, 100, new Date(NOW_MS + 60 * MINUTE_MS).toISOString()),
      "clip-account-b",
    );
    const { get, prompt } = harness();
    const controller = createQuotaAutoResumption({
      probe: vi
        .fn()
        .mockResolvedValueOnce({ kind: "collection", collection: exhausted })
        .mockResolvedValue({ kind: "collection", collection: recovered }),
      session: { get, prompt },
    });

    controller.handleEvent({
      type: "session.execution.failed",
      created: NOW_MS,
      data: { sessionID: CLAUDE_SESSION_ID, error: { type: "provider.quota" } },
    });
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS + QUOTA_AUTO_RESUME_GRACE_MS);

    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps polling while the Claude identity is unknown", async () => {
    const bound = collectionFor(
      await claudeAgentResult(0, 50, new Date(NOW_MS + 10 * MINUTE_MS).toISOString()),
      "clip-account-a",
    );
    // A real observation with no verified identity cannot arm a baseline.
    const unbound: QuotaWindowCollection = { windows: bound.windows };
    const { get, prompt } = harness();
    const probe = vi.fn().mockResolvedValue({ kind: "collection", collection: unbound });
    const controller = createQuotaAutoResumption({
      probe,
      session: { get, prompt },
    });

    controller.handleEvent({
      type: "session.execution.failed",
      created: NOW_MS,
      data: { sessionID: CLAUDE_SESSION_ID, error: { type: "provider.quota" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    // No verified identity means no baseline and no proof, so the pending resume polls.
    expect(probe.mock.calls.length).toBeGreaterThan(1);
    expect(prompt).not.toHaveBeenCalled();
  });
});
