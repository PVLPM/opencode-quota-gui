import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProvider } from "../src/lib/entries.js";

import {
  assertPhase5CanariesRedacted,
  PHASE5_ACCOUNTING_RESPONSE,
  PHASE5_OPENROUTER_RESPONSE,
  PHASE5_QUOTA_PROVIDERS,
  PHASE5_RUNTIME_PROVIDER_IDS,
  PHASE5_SECRET_CANARIES,
  phase5JsonResponse,
} from "./fixtures/v4-phase5-integration.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-v4-phase5-cross-surface";
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";
const MINIMAX_QUOTA_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_CHINA_QUOTA_URL = "https://api.minimaxi.com/v1/token_plan/remains";
const MINIMAX_API_KEY = "minimax-test-key";
const MINIMAX_CHINA_API_KEY = "minimax-china-test-key";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  resolveMiniMaxAuthCached: vi.fn(),
  getMiniMaxAuthDiagnostics: vi.fn(),
  resolveMiniMaxChinaAuthCached: vi.fn(),
  getMiniMaxChinaAuthDiagnostics: vi.fn(),
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
}));

const otel = vi.hoisted(() => {
  const callbacks = new Map<
    string,
    (result: { observe(value: number, attributes?: Record<string, unknown>): void }) => void
  >();
  return {
    callbacks,
    getMeter: vi.fn(() => ({
      createObservableGauge: vi.fn((name: string) => ({
        addCallback: (
          callback: (result: {
            observe(value: number, attributes?: Record<string, unknown>): void;
          }) => void,
        ) => callbacks.set(name, callback),
        removeCallback: () => callbacks.delete(name),
      })),
    })),
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: otel.getMeter },
}));
vi.mock("../src/lib/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/config.js")>()),
  ...createConfigModuleMock(mocks.loadConfig),
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/minimax-auth.js", () => ({
  resolveMiniMaxAuth: vi.fn(),
  resolveMiniMaxChinaAuth: vi.fn(),
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  getMiniMaxAuthDiagnostics: mocks.getMiniMaxAuthDiagnostics,
  resolveMiniMaxChinaAuthCached: mocks.resolveMiniMaxChinaAuthCached,
  getMiniMaxChinaAuthDiagnostics: mocks.getMiniMaxChinaAuthDiagnostics,
}));
vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: mocks.getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured: mocks.hasAnthropicCredentialsConfigured,
  queryAnthropicQuota: mocks.queryAnthropicQuota,
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);

function configForQuotaProviders(formatStyle: "allWindows" | "singleWindow" = "allWindows") {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["quota-providers"],
    quotaProviders: PHASE5_QUOTA_PROVIDERS.map((source) => ({ ...source })),
    formatStyle,
    minIntervalMs: 60_000,
    showSessionTokens: true,
    sessionTokenScope: "tree",
    maintainerAnnouncements: {
      enabled: false,
      home: false,
    },
    telemetry: {
      enabled: true,
    },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle,
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle,
    },
  });
}

function configForSingleProvider(providerId = "minimax-coding-plan") {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: [providerId],
    formatStyle: "allWindows",
    minIntervalMs: 60_000,
    showSessionTokens: false,
    maintainerAnnouncements: {
      enabled: false,
      home: false,
    },
    telemetry: {
      enabled: false,
    },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle: "allWindows",
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle: "allWindows",
    },
  });
}

function createClient() {
  const client = createPluginTestClient({
    modelID: "team-gateway/model-one",
    providerID: "team-gateway",
  });
  client.config.providers.mockResolvedValue({
    data: {
      providers: PHASE5_RUNTIME_PROVIDER_IDS.map((id) => ({ id })),
    },
  });
  return client;
}

async function collectFor(options: {
  client: ReturnType<typeof createHostClient>;
  config: ReturnType<typeof makeQuotaToastTestConfig>;
  providers: QuotaProvider[];
  formatStyle?: "allWindows" | "singleWindow";
  sessionID?: string;
}) {
  const { collectQuotaRenderData } = await import("../src/lib/quota-render-data.js");
  return await collectQuotaRenderData({
    client: options.client,
    config: options.config,
    request: options.sessionID ? { sessionID: options.sessionID } : {},
    workspaceRoot: process.cwd(),
    providers: options.providers,
    surfaceExplicitProviderIssues: true,
    ...(options.formatStyle ? { formatStyle: options.formatStyle } : {}),
  });
}

type createHostClient = typeof createClient;

async function exportFor(options: {
  client: ReturnType<typeof createHostClient>;
  config: ReturnType<typeof makeQuotaToastTestConfig>;
  providers: QuotaProvider[];
}) {
  const { createExportProviderContext, buildQuotaExport } = await import(
    "../src/lib/quota-export.js"
  );
  const { resolveQuotaRuntimeContext } = await import("../src/lib/quota-runtime-context.js");
  const runtime = await resolveQuotaRuntimeContext({
    client: options.client,
    roots: { workspaceRoot: process.cwd() },
    config: options.config,
    providers: options.providers,
    configureTelemetry: false,
  });
  return await buildQuotaExport({
    providers: options.providers,
    ctx: createExportProviderContext(runtime),
    ttlMs: options.config.minIntervalMs,
    fromCache: true,
  });
}

describe("v1 supported backend release evidence", () => {
  let currentConfig = configForQuotaProviders();

  beforeEach(async () => {
    const { __resetQuotaTelemetryForTests } = await import("../src/lib/quota-telemetry.js");
    __resetQuotaTelemetryForTests();
    otel.callbacks.clear();
    otel.getMeter.mockClear();
    process.env.PHASE5_TEAM_ACCOUNTING_KEY = PHASE5_SECRET_CANARIES.accountingKey;
    process.env.PHASE5_OPENROUTER_KEY = PHASE5_SECRET_CANARIES.openRouterKey;
    process.env.PHASE5_FAILING_KEY = PHASE5_SECRET_CANARIES.failingKey;

    currentConfig = configForQuotaProviders();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: currentConfig,
      resetPluginState: true,
    });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: {
        models: [
          {
            modelID: "tree-model",
            input: 1200,
            cachedInput: 300,
            totalInput: 1500,
            output: 45,
          },
        ],
        totalInput: 1200,
        totalCachedInput: 300,
        totalCombinedInput: 1500,
        totalOutput: 45,
      },
    });
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    mocks.resolveMiniMaxAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: MINIMAX_API_KEY,
      endpoint: "international",
    });
    mocks.getMiniMaxAuthDiagnostics.mockResolvedValue({
      state: "configured",
      source: "opencode.db",
      endpoint: "international",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    mocks.resolveMiniMaxChinaAuthCached.mockResolvedValue({ state: "none" });
    mocks.getMiniMaxChinaAuthDiagnostics.mockResolvedValue({
      state: "none",
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    });

    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([quotaProvidersProvider]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (url === PHASE5_QUOTA_PROVIDERS[0].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.accountingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 8));
        return phase5JsonResponse(PHASE5_ACCOUNTING_RESPONSE);
      }
      if (url === PHASE5_QUOTA_PROVIDERS[1].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.openRouterKey}`);
        return phase5JsonResponse(PHASE5_OPENROUTER_RESPONSE);
      }
      if (url === PHASE5_QUOTA_PROVIDERS[2].url) {
        expect(authorization).toBe(`Bearer ${PHASE5_SECRET_CANARIES.failingKey}`);
        await new Promise((resolve) => setTimeout(resolve, 3));
        return new Response(PHASE5_SECRET_CANARIES.failureBody, {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === MINIMAX_QUOTA_URL) {
        expect(authorization).toBe(`Bearer ${MINIMAX_API_KEY}`);
        return phase5JsonResponse({
          model_remains: [
            {
              model_name: "MiniMax-M*",
              current_interval_total_count: 100,
              current_interval_usage_count: -5,
              remains_time: 3_600_000,
              current_weekly_total_count: 200,
              current_weekly_usage_count: -20,
              weekly_remains_time: 86_400_000,
            },
          ],
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      if (url === MINIMAX_CHINA_QUOTA_URL) {
        expect(authorization).toBe(`Bearer ${MINIMAX_CHINA_API_KEY}`);
        return phase5JsonResponse({
          model_remains: [
            {
              model_name: "general",
              current_interval_total_count: 0,
              current_interval_usage_count: 0,
              remains_time: 3_600_000,
              current_weekly_total_count: 0,
              current_weekly_usage_count: 0,
              weekly_remains_time: 86_400_000,
              current_interval_remaining_percent: 33,
              current_weekly_remaining_percent: 46,
            },
            {
              model_name: "video",
              current_interval_total_count: 100,
              current_interval_usage_count: 99,
              remains_time: 3_600_000,
            },
          ],
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      throw new Error(`unexpected fixture URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    const { __resetQuotaTelemetryForTests } = await import("../src/lib/quota-telemetry.js");
    __resetQuotaTelemetryForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("aggregates custom sources into cached export, session tokens, telemetry, and redaction", async () => {
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    const client = createClient();

    const collected = await collectFor({
      client,
      config: currentConfig,
      providers: [quotaProvidersProvider],
      sessionID: "phase5-session",
    });
    expect(collected.data).not.toBeNull();
    const entries = collected.data?.entries ?? [];
    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["Team Accounting Monthly", "OpenRouter Primary budget"]),
    );
    expect(entries.some((entry) => entry.percentRemaining === 64)).toBe(true);
    expect(
      entries.some((entry) => entry.name === "Team Accounting Balance" && entry.value === "$12.34"),
    ).toBe(true);
    expect(entries.some((entry) => entry.percentRemaining === 80)).toBe(true);
    expect(collected.data?.errors.map((error) => error.message)).toContain("HTTP 503");
    expect(collected.data?.sessionTokens).toMatchObject({
      totalCombinedInput: 1500,
      totalOutput: 45,
    });
    expect(mocks.fetchSessionTokensForDisplay).toHaveBeenCalledWith({
      enabled: true,
      sessionID: "phase5-session",
      scope: "tree",
    });

    const fetchCallsBeforeExport = vi.mocked(globalThis.fetch).mock.calls.length;
    const exported = await exportFor({
      client,
      config: currentConfig,
      providers: [quotaProvidersProvider],
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(fetchCallsBeforeExport);
    expect(exported.version).toBe(2);
    const provider = exported.providers["quota-providers"];
    expect(provider?.status).toBe("partial");
    if (!provider || !("entries" in provider)) {
      throw new Error("Expected cached quota-provider export entries");
    }
    expect(provider.sources).toEqual([
      { id: "team-accounting", providerId: "team-gateway", status: "ok", entryCount: 2 },
      { id: "openrouter-primary", providerId: "openrouter", status: "ok", entryCount: 1 },
      {
        id: "failing-accounting",
        providerId: "failing-gateway",
        status: "error",
        entryCount: 0,
      },
    ]);
    expect(
      provider.entries.map((entry) =>
        entry.renderType === "percent" ? entry.percentRemaining : entry.value,
      ),
    ).toEqual([64, "$12.34", 80]);

    const { __flushQuotaTelemetryInitializationForTests } = await import(
      "../src/lib/quota-telemetry.js"
    );
    const fetchCallsBeforeMetrics = vi.mocked(globalThis.fetch).mock.calls.length;
    const providerDiscoveryCallsBeforeMetrics = client.config.providers.mock.calls.length;
    const metricObservedAt = Date.now();
    await __flushQuotaTelemetryInitializationForTests();
    const observations: Array<{
      metric: string;
      value: number;
      attributes?: Record<string, unknown>;
    }> = [];
    for (const [metric, callback] of otel.callbacks) {
      callback({
        observe: (value, attributes) => {
          observations.push({ metric, value, attributes });
        },
      });
    }
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(fetchCallsBeforeMetrics);
    expect(client.config.providers).toHaveBeenCalledTimes(providerDiscoveryCallsBeforeMetrics);
    expect(otel.getMeter).toHaveBeenCalledOnce();
    expect(new Set(observations.map(({ metric }) => metric))).toEqual(
      new Set([
        "opencode.quota.consumed",
        ...(POSIX_IDENTITY_STORAGE ? ["opencode.quota.cache.age"] : []),
      ]),
    );
    const { classifyQuotaWindowText } = await import("../src/lib/quota-entry-display.js");
    const expectedConsumed = new Map<string, number>();
    for (const entry of provider.entries) {
      if (entry.renderType !== "percent" || !Number.isFinite(entry.percentRemaining)) continue;
      const attributes = {
        "quota.provider": "custom",
        "quota.window": classifyQuotaWindowText(entry.window ?? "") ?? "unknown",
        "quota.result_type": entry.resultType,
      };
      const key = JSON.stringify(attributes);
      const consumed = Math.min(1, Math.max(0, (100 - entry.percentRemaining) / 100));
      expectedConsumed.set(key, Math.max(expectedConsumed.get(key) ?? 0, consumed));
    }
    const actualConsumed = new Map(
      observations
        .filter(({ metric }) => metric === "opencode.quota.consumed")
        .map(({ attributes, value }) => [JSON.stringify(attributes), value]),
    );
    expect(actualConsumed).toEqual(expectedConsumed);
    expect(
      observations
        .filter(({ metric }) => metric === "opencode.quota.consumed")
        .every(
          ({ attributes }) =>
            attributes?.["quota.provider"] === "custom" &&
            JSON.stringify(Object.keys(attributes).sort()) ===
              JSON.stringify(["quota.provider", "quota.result_type", "quota.window"]),
        ),
    ).toBe(true);
    const cacheAgeObservations = observations.filter(
      ({ metric }) => metric === "opencode.quota.cache.age",
    );
    expect(
      cacheAgeObservations.every(
        ({ attributes }) =>
          JSON.stringify(attributes) === JSON.stringify({ "quota.provider": "custom" }),
      ),
    ).toBe(true);
    expect(cacheAgeObservations).toHaveLength(POSIX_IDENTITY_STORAGE ? 1 : 0);
    if (POSIX_IDENTITY_STORAGE) {
      const oldestFetchedAt = Math.min(
        ...Object.values(exported.providers)
          .filter((entry) => "fetchedAt" in entry)
          .map((entry) => entry.fetchedAt),
      );
      expect(
        Math.abs(cacheAgeObservations[0].value - (metricObservedAt / 1000 - oldestFetchedAt)),
      ).toBeLessThanOrEqual(2);
    }

    const userFacingOutput = JSON.stringify({ data: collected.data, exported });
    const telemetryOutput = JSON.stringify(observations);
    assertPhase5CanariesRedacted(telemetryOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(telemetryOutput).not.toContain(source.id);
      expect(telemetryOutput).not.toContain(source.label);
      expect(telemetryOutput).not.toContain(source.url);
    }
    const allOutput = JSON.stringify({
      data: collected.data,
      exported,
      observations,
    });
    assertPhase5CanariesRedacted(allOutput);
    for (const source of PHASE5_QUOTA_PROVIDERS) {
      expect(userFacingOutput).not.toContain(source.url);
    }
    expect(userFacingOutput).not.toMatch(/telemetryToken|opencode\.quota\./u);
  });

  it("keeps over-quota MiniMax results in cache and export", async () => {
    currentConfig = configForSingleProvider();
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    const { minimaxCodingPlanProvider } = await import("../src/providers/minimax-coding-plan.js");
    minimaxCodingPlanProvider.cachePolicy = { kind: "account-neutral" };
    mocks.getProviders.mockReturnValue([minimaxCodingPlanProvider]);

    const client = createClient();
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "minimax-coding-plan" }] },
    });

    const collected = await collectFor({
      client,
      config: currentConfig,
      providers: [minimaxCodingPlanProvider],
    });
    expect(JSON.stringify(collected.data)).toContain("MiniMax Token Plan");
    expect(JSON.stringify(collected.data)).not.toContain("Invalid normalized provider result");

    const exported = await exportFor({
      client,
      config: currentConfig,
      providers: [minimaxCodingPlanProvider],
    });
    const provider = exported.providers["minimax-coding-plan"];
    expect(provider?.status).toBe("ok");
    if (!provider || !("entries" in provider)) {
      throw new Error("Expected cached MiniMax export entries");
    }
    expect(
      provider.entries.map((entry) =>
        entry.renderType === "percent" ? entry.percentRemaining : entry.value,
      ),
    ).toEqual([-5, -10]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("keeps the optional Anthropic Fable weekly row", async () => {
    currentConfig = configForSingleProvider("anthropic");
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    mocks.hasAnthropicCredentialsConfigured.mockResolvedValue(true);
    const quota = {
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      fable_weekly: {
        percentRemaining: 98,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
    };
    mocks.getAnthropicDiagnostics.mockResolvedValue({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      checkedCommands: ["claude --version"],
      quota,
    });
    mocks.queryAnthropicQuota.mockResolvedValue(quota);

    const { anthropicProvider } = await import("../src/providers/anthropic.js");
    anthropicProvider.cachePolicy = { kind: "account-neutral" };
    mocks.getProviders.mockReturnValue([anthropicProvider]);

    const client = createClient();
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "anthropic" }] },
    });

    const collected = await collectFor({
      client,
      config: currentConfig,
      providers: [anthropicProvider],
    });
    const fable = collected.data?.entries.find((entry) => entry.name === "Claude Fable Weekly");
    expect(fable?.percentRemaining).toBe(98);
  });

  it("renders CN general percentage quota and excludes video", async () => {
    currentConfig = configForSingleProvider("minimax-china-coding-plan");
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    mocks.resolveMiniMaxChinaAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: MINIMAX_CHINA_API_KEY,
      endpoint: "china",
    });
    mocks.getMiniMaxChinaAuthDiagnostics.mockResolvedValue({
      state: "configured",
      source: "opencode.db",
      endpoint: "china",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    const { minimaxChinaCodingPlanProvider } = await import(
      "../src/providers/minimax-coding-plan.js"
    );
    minimaxChinaCodingPlanProvider.cachePolicy = { kind: "account-neutral" };
    mocks.getProviders.mockReturnValue([minimaxChinaCodingPlanProvider]);

    const client = createClient();
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "minimax-china-coding-plan" }] },
    });

    const collected = await collectFor({
      client,
      config: currentConfig,
      providers: [minimaxChinaCodingPlanProvider],
    });
    const entries = collected.data?.entries ?? [];
    expect(entries.map((entry) => entry.percentRemaining)).toEqual(
      expect.arrayContaining([33, 46]),
    );
    expect(JSON.stringify(entries)).not.toContain("video");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("honors single-window projection without losing the alternate backend data", async () => {
    currentConfig = configForSingleProvider("minimax-china-coding-plan");
    mocks.loadConfig.mockImplementation(async () => currentConfig);
    mocks.resolveMiniMaxChinaAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: MINIMAX_CHINA_API_KEY,
      endpoint: "china",
    });
    mocks.getMiniMaxChinaAuthDiagnostics.mockResolvedValue({
      state: "configured",
      source: "opencode.db",
      endpoint: "china",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    const { minimaxChinaCodingPlanProvider } = await import(
      "../src/providers/minimax-coding-plan.js"
    );
    minimaxChinaCodingPlanProvider.cachePolicy = { kind: "account-neutral" };
    mocks.getProviders.mockReturnValue([minimaxChinaCodingPlanProvider]);

    const client = createClient();
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "minimax-china-coding-plan" }] },
    });

    const singleWindow = await collectFor({
      client,
      config: currentConfig,
      providers: [minimaxChinaCodingPlanProvider],
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries.map((entry) => entry.percentRemaining)).toEqual([33]);

    const allWindows = await collectFor({
      client,
      config: currentConfig,
      providers: [minimaxChinaCodingPlanProvider],
      formatStyle: "allWindows",
    });
    expect(allWindows.data?.entries.map((entry) => entry.percentRemaining)).toEqual(
      expect.arrayContaining([33, 46]),
    );
  });
});
