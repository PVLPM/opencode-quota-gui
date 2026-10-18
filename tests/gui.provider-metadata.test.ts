/**
 * P1b — account metadata (design spec R17–R20/R46, plan P1b).
 *
 * Real provider fixtures through the existing DI seams only: credentials come
 * from the fake `ctx.integration` source (no real credentials or database) and
 * every network call is stubbed (`vi.stubGlobal("fetch", …)`). No module
 * mocking.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../src/contracts/dashboard.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
} from "../src/lib/entries.js";
import { deriveStableAccountIdentityKey } from "../src/lib/entries.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  collectQuotaDashboardProviderResults,
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
} from "../src/lib/quota-render-data.js";
import {
  cloneQuotaProviderResult,
  decodePersistedQuotaProviderCacheEntry,
  encodePersistedQuotaProviderCacheEntry,
  normalizeQuotaProviderResult,
} from "../src/lib/quota-state-codec.js";
import type { GeminiCliQuotaBucket, GoogleAgyQuotaBucket } from "../src/lib/types.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { copilotProvider } from "../src/providers/copilot.js";
import {
  agyBucketRowKey,
  buildAgyLegacyAccounts,
  googleAgyProvider,
} from "../src/providers/google-agy.js";
import {
  buildGeminiCliLegacyAccounts,
  geminiCliBucketRowKey,
  googleGeminiCliProvider,
} from "../src/providers/google-gemini-cli.js";
import { kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";
import { minimaxCodingPlanProvider } from "../src/providers/minimax-coding-plan.js";
import { openaiProvider } from "../src/providers/openai.js";
import { opencodeGoProvider } from "../src/providers/opencode-go.js";
import { xaiProvider } from "../src/providers/xai.js";
import { zaiProvider } from "../src/providers/zai.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const TEST_ACCOUNTING = {
  resultType: "quota" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const XAI_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const KIMI_QUOTA_URL = "https://api.kimi.ai/coding/v1/usages";
const MINIMAX_QUOTA_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

let tempRoot = "";
const unbinds: Array<() => void> = [];

function renderConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, showSessionTokens: false, ...overrides };
}

function context(config: Partial<QuotaProviderContext["config"]> = {}): QuotaProviderContext {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    resolveRuntimeProviderIds: async () => [],
    workspaceRoot: tempRoot,
    config: { cursorPlan: "none", enabledProviders: "auto", ...config },
  };
}

function bindCredentials(credentials: FakeCredential[]): void {
  const integration = createFakeIntegration(credentials);
  // SAFETY: `createFakeIntegration` supplies exactly the credential-source surface
  // `createIntegrationCredentialSource` consumes; the cast matches it to the core API.
  const unbind = bindCredentialSource(
    createIntegrationCredentialSource(
      integration as Parameters<typeof createIntegrationCredentialSource>[0],
    ),
  );
  unbinds.push(unbind);
}

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function oauthCredential(params: {
  integrationId: string;
  id: string;
  label: string;
  value?: Record<string, JsonValue>;
  resolveError?: string;
}): FakeCredential {
  const credential: FakeCredential = {
    integrationId: params.integrationId,
    id: params.id,
    label: params.label,
    registered: true,
    method: "oauth",
    value: { type: "oauth", ...params.value },
  };
  if (params.resolveError !== undefined) credential.resolveError = params.resolveError;
  return credential;
}

function keyCredential(params: {
  integrationId: string;
  id: string;
  label: string;
  key: string;
}): FakeCredential {
  return {
    integrationId: params.integrationId,
    id: params.id,
    label: params.label,
    registered: true,
    method: "key",
    value: { type: "key", key: params.key },
  };
}

function findAccount(output: QuotaProviderResult, sourceId: string) {
  return output.accounts?.find((account) => account.sourceId === sourceId);
}

function testProvider(
  id: string,
  result: Partial<QuotaProviderResult> = {},
  availability = true,
): QuotaProvider {
  return {
    id,
    isAvailable: vi.fn(async () => availability),
    fetch: vi.fn(async () => ({ attempted: true, entries: [], errors: [], ...result })),
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "opencode-quota-p1b-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(tempRoot, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(tempRoot, "cache"));
  vi.stubEnv("XDG_DATA_HOME", join(tempRoot, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(tempRoot, "state"));
  vi.stubEnv("XDG_CONFIG_HOME", join(tempRoot, "xdg-config"));
  vi.stubEnv("OPENCODE_DB", join(tempRoot, "missing-opencode.db"));
  for (const name of [
    "ZAI_API_KEY",
    "ZAI_CODING_PLAN_API_KEY",
    "KIMI_GLOBAL_API_KEY",
    "KIMI_CN_API_KEY",
    "KIMI_API_KEY",
    "KIMI_CODE_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CODING_PLAN_API_KEY",
    "MINIMAX_CHINA_CODING_PLAN_API_KEY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "OPENCODE_GEMINI_PROJECT_ID",
    "OPENCODE_AGY_PROJECT_ID",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("provider account metadata contract", () => {
  it("round-trips accounts, error sourceId, and rowKey through the cache codec", () => {
    const result: QuotaProviderResult = {
      attempted: true,
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "cred-a" },
          name: "Window",
          rowKey: "window:week",
          percentRemaining: 50,
        },
      ],
      errors: [{ label: "[Provider A]", message: "boom", sourceId: "cred-a" }],
      accounts: [
        { sourceId: "cred-a", label: "[Provider A]", active: true },
        { sourceId: "cred-b", identityKey: "digest-b" },
      ],
    };

    const encoded = encodePersistedQuotaProviderCacheEntry({
      packageVersion: "5.0.3",
      key: "key",
      providerId: "provider",
      timestamp: 1,
      result,
    });
    const decoded = decodePersistedQuotaProviderCacheEntry(encoded, {
      packageVersion: "5.0.3",
      key: "key",
      providerId: "provider",
    });

    expect(decoded?.result.accounts).toEqual(result.accounts);
    expect(decoded?.result.errors).toEqual(result.errors);
    expect(decoded?.result.entries[0]?.rowKey).toBe("window:week");
    expect(cloneQuotaProviderResult(result)).toEqual(result);
  });

  it("keeps old payloads without account metadata decodable (optional absence)", () => {
    const legacy: QuotaProviderResult = {
      attempted: true,
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Legacy",
          percentRemaining: 10,
        },
      ],
      errors: [{ label: "Legacy", message: "old" }],
    };

    const normalized = normalizeQuotaProviderResult(legacy);

    expect(normalized).not.toBeNull();
    expect(normalized?.accounts).toBeUndefined();
    expect(normalized?.errors[0]?.sourceId).toBeUndefined();
    expect(normalized?.entries[0]?.rowKey).toBeUndefined();
    expect(normalized).toEqual(legacy);
  });

  it("strictly rejects malformed account descriptors and unknown entry keys", () => {
    const valid = {
      attempted: true,
      entries: [],
      errors: [],
      accounts: [{ sourceId: "cred-a" }],
    };
    expect(normalizeQuotaProviderResult(valid)?.accounts).toEqual([{ sourceId: "cred-a" }]);
    expect(
      normalizeQuotaProviderResult({
        ...valid,
        accounts: [{ sourceId: "cred-a", extra: true }],
      }),
    ).toBeNull();
    expect(
      normalizeQuotaProviderResult({
        ...valid,
        accounts: [{ label: "no id" }],
      }),
    ).toBeNull();
    expect(
      normalizeQuotaProviderResult({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
            name: "Row",
            percentRemaining: 1,
            rowKey: 7,
          },
        ],
        errors: [],
      }),
    ).toBeNull();
  });

  it("preserves the metadata through the live-probe clone", async () => {
    const provider = testProvider("metadata-probe", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "cred-a" },
          name: "Probe row",
          rowKey: "window:week",
          percentRemaining: 50,
        },
      ],
      errors: [{ label: "[Probe A]", message: "boom", sourceId: "cred-a" }],
      accounts: [{ sourceId: "cred-a", label: "[Probe A]", active: true }],
    });

    const probes = await collectQuotaStatusLiveProbes({
      client: context().client,
      config: renderConfig(),
      workspaceRoot: tempRoot,
      providers: [provider],
    });

    expect(probes).toHaveLength(1);
    expect(probes[0]?.result.accounts).toEqual([
      { sourceId: "cred-a", label: "[Probe A]", active: true },
    ]);
    expect(probes[0]?.result.errors[0]?.sourceId).toBe("cred-a");
    expect(probes[0]?.result.entries[0]?.rowKey).toBe("window:week");
  });

  it("exposes the unprojected dashboard collector seam for every provider", async () => {
    const providerA = testProvider("dashboard-a", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "cred-a" },
          name: "A weekly",
          rowKey: "window:week",
          percentRemaining: 50,
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "cred-a" },
          name: "A monthly",
          rowKey: "window:month",
          percentRemaining: 80,
        },
      ],
      accounts: [{ sourceId: "cred-a", label: "[A]", active: true }],
    });
    const providerB = testProvider("dashboard-b", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "cred-b" },
          name: "B weekly",
          rowKey: "window:week",
          percentRemaining: 10,
        },
      ],
      accounts: [{ sourceId: "cred-b", label: "[B]" }],
    });

    const probes = await collectQuotaDashboardProviderResults({
      client: context().client,
      config: renderConfig({ onlyCurrentModel: true, formatStyle: "singleWindow" }),
      workspaceRoot: tempRoot,
      providers: [providerA, providerB],
    });

    // Unprojected: both providers and both rows of A survive; no singleWindow collapse.
    expect(probes.map((probe) => probe.providerId)).toEqual(["dashboard-a", "dashboard-b"]);
    expect(probes[0]?.result.entries).toHaveLength(2);
    expect(probes[1]?.result.entries).toHaveLength(1);
    expect(probes[0]?.result.accounts?.[0]?.sourceId).toBe("cred-a");
  });
});

describe("multi-account provider loops", () => {
  it("anthropic: describes both logins and associates the known failure", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "anthropic",
        id: "cred-claude-work",
        label: "Work",
        value: { access: "claude-work-token", refresh: "r", expires: Date.now() + 3_600_000 },
      }),
      oauthCredential({
        integrationId: "anthropic",
        id: "cred-claude-home",
        label: "Home",
        resolveError: "refresh_failed: HTTP 401",
      }),
    ]);
    stubFetch((url, init) => {
      expect(String(url)).toBe(ANTHROPIC_USAGE_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer claude-work-token");
      return jsonResponse({
        five_hour: { utilization: 20, resets_at: "2026-10-18T20:00:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-10-25T00:00:00.000Z" },
      });
    });

    const output = await anthropicProvider.fetch(context());

    expect(output.attempted).toBe(true);
    expect(output.entries).toEqual([
      expect.objectContaining({
        name: "[Claude Work] (active) 5h",
        rowKey: "window:five_hour",
        accounting: expect.objectContaining({ sourceId: "cred-claude-work" }),
      }),
      expect.objectContaining({
        name: "[Claude Work] (active) Weekly",
        rowKey: "window:week",
        accounting: expect.objectContaining({ sourceId: "cred-claude-work" }),
      }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[Claude Home]", sourceId: "cred-claude-home" }),
    ]);
    expect(output.accounts).toEqual([
      { sourceId: "cred-claude-work", label: "[Claude Work] (active)", active: true },
      { sourceId: "cred-claude-home", label: "[Claude Home]", active: false },
    ]);
  });

  it("xai: keeps row keys stable across a credential label rename", async () => {
    const run = async (workLabel: string) => {
      bindCredentials([
        oauthCredential({
          integrationId: "xai",
          id: "cred-xai-work",
          label: workLabel,
          value: { access: "xai-work-token", expires: Date.now() + 3_600_000 },
        }),
        oauthCredential({
          integrationId: "xai",
          id: "cred-xai-home",
          label: "Home",
          resolveError: "refresh_failed: HTTP 401",
        }),
      ]);
      stubFetch((url) =>
        String(url) === XAI_CREDITS_URL
          ? jsonResponse({
              config: {
                creditUsagePercent: 20,
                currentPeriod: {
                  type: "WEEKLY",
                  start: "2026-10-11T00:00:00.000Z",
                  end: "2026-10-18T00:00:00.000Z",
                },
              },
            })
          : new Response("", { status: 404 }),
      );
      return await xaiProvider.fetch(context());
    };

    const first = await run("Work");
    const second = await run("Renamed");

    expect(first.entries.map((entry) => entry.rowKey)).toEqual(["window:week"]);
    expect(second.entries.map((entry) => entry.rowKey)).toEqual(
      first.entries.map((entry) => entry.rowKey),
    );
    expect(second.entries[0]?.percentRemaining).toBe(80);
    expect(findAccount(first, "cred-xai-work")?.label).toBe("[xAI Work] (SuperGrok) (active)");
    expect(findAccount(second, "cred-xai-work")?.label).toBe("[xAI Renamed] (SuperGrok) (active)");
    expect(second.errors).toEqual([
      expect.objectContaining({ label: "[xAI Home]", sourceId: "cred-xai-home" }),
    ]);
    expect(second.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-xai-work",
      "cred-xai-home",
    ]);
  });

  it("copilot: describes both OAuth logins and associates the known failure", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "github-copilot",
        id: "cred-copilot-work",
        label: "Work",
        value: { access: "copilot-work-token", expires: Date.now() + 3_600_000 },
      }),
      oauthCredential({
        integrationId: "github-copilot",
        id: "cred-copilot-home",
        label: "Home",
        resolveError: "refresh_failed: HTTP 401",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(COPILOT_USER_URL);
      return jsonResponse({
        copilot_plan: "individual",
        quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75 } },
        quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      });
    });

    const output = await copilotProvider.fetch(context());

    expect(output.entries).toEqual([
      expect.objectContaining({
        name: "Copilot Premium Interactions",
        group: "[Copilot Work] (individual) (active)",
        rowKey: "window:month",
        percentRemaining: 75,
        accounting: expect.objectContaining({ sourceId: "cred-copilot-work" }),
      }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[Copilot Home]", sourceId: "cred-copilot-home" }),
    ]);
    expect(output.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-copilot-work",
      "cred-copilot-home",
    ]);
  });

  it("zai: maps windows with row keys and describes the invalid login", async () => {
    bindCredentials([
      keyCredential({
        integrationId: "zai-coding-plan",
        id: "cred-zai-work",
        label: "Work",
        key: "zai-work-key",
      }),
      keyCredential({
        integrationId: "zai-coding-plan",
        id: "cred-zai-home",
        label: "Home",
        key: "",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(ZAI_QUOTA_URL);
      return jsonResponse({
        code: 0,
        msg: "ok",
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 20, nextResetTime: 1_797_000_000_000 },
            { type: "TOKENS_LIMIT", unit: 6, percentage: 10, nextResetTime: 1_797_000_000_000 },
          ],
        },
      });
    });

    const output = await zaiProvider.fetch(context());

    expect(output.entries).toEqual([
      expect.objectContaining({
        group: "[Z.ai Work] (active)",
        rowKey: "window:five_hour",
        percentRemaining: 80,
        accounting: expect.objectContaining({ sourceId: "cred-zai-work" }),
      }),
      expect.objectContaining({
        group: "[Z.ai Work] (active)",
        rowKey: "window:week",
        percentRemaining: 90,
        accounting: expect.objectContaining({ sourceId: "cred-zai-work" }),
      }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[Z.ai Home]", sourceId: "cred-zai-home" }),
    ]);
    expect(output.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-zai-work",
      "cred-zai-home",
    ]);
  });

  it("kimi code: maps windows with named row keys and describes the invalid login", async () => {
    bindCredentials([
      keyCredential({
        integrationId: "kimi-code-plan-global",
        id: "cred-kimi-work",
        label: "Work",
        key: "kimi-work-key",
      }),
      keyCredential({
        integrationId: "kimi-code-plan-global",
        id: "cred-kimi-home",
        label: "Home",
        key: "",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(KIMI_QUOTA_URL);
      return jsonResponse({ usage: { limit: 100, used: 25, resetTime: 3_600 } });
    });

    const output = await kimiCodePlanGlobalProvider.fetch(context());

    expect(output.entries).toEqual([
      expect.objectContaining({
        group: "[Kimi Code Work] (active)",
        label: "Weekly limit:",
        rowKey: "named:weekly",
        percentRemaining: 75,
        accounting: expect.objectContaining({ sourceId: "cred-kimi-work" }),
      }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[Kimi Code Home]", sourceId: "cred-kimi-home" }),
    ]);
    expect(output.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-kimi-work",
      "cred-kimi-home",
    ]);
  });

  it("kimi code: keeps the technical row key when the API renames the window label", async () => {
    const run = async (apiLabel: string) => {
      bindCredentials([
        keyCredential({
          integrationId: "kimi-code-plan-global",
          id: "cred-kimi-work",
          label: "Work",
          key: "kimi-work-key",
        }),
      ]);
      stubFetch((url) => {
        expect(String(url)).toBe(KIMI_QUOTA_URL);
        return jsonResponse({ usage: { name: apiLabel, limit: 100, used: 25 } });
      });
      return await kimiCodePlanGlobalProvider.fetch(context());
    };

    const original = await run("Weekly limit");
    const renamed = await run("Rolling quota window");

    expect(original.entries[0]?.rowKey).toBe("named:weekly");
    expect(renamed.entries[0]?.rowKey).toBe(original.entries[0]?.rowKey);
    expect(renamed.entries[0]?.label).toBe("Rolling quota window:");
    expect(renamed.entries[0]?.name).toContain("Rolling quota window");
  });

  it("kimi code: separates duplicate labels by technical window without label or ordinal ids", async () => {
    bindCredentials([
      keyCredential({
        integrationId: "kimi-code-plan-global",
        id: "cred-kimi-work",
        label: "Work",
        key: "kimi-work-key",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(KIMI_QUOTA_URL);
      return jsonResponse({
        limits: [
          {
            name: "Rolling limit",
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: 100, used: 30 },
          },
          {
            name: "Rolling limit",
            window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: 50, used: 10 },
          },
          { detail: { limit: 20, used: 5 } },
        ],
      });
    });

    const output = await kimiCodePlanGlobalProvider.fetch(context());

    expect(output.entries.map((entry) => entry.label)).toEqual([
      "Rolling limit:",
      "Rolling limit:",
      "Limit #3:",
    ]);
    expect(output.entries.map((entry) => entry.rowKey)).toEqual([
      "named:TIME_UNIT_MINUTE:300",
      "named:TIME_UNIT_DAY:1",
      "named:limits",
    ]);
  });

  it("minimax: keeps typed semantics and describes the invalid login", async () => {
    bindCredentials([
      keyCredential({
        integrationId: "minimax-coding-plan",
        id: "cred-minimax-work",
        label: "Work",
        key: "minimax-work-key",
      }),
      keyCredential({
        integrationId: "minimax-coding-plan",
        id: "cred-minimax-home",
        label: "Home",
        key: "",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(MINIMAX_QUOTA_URL);
      return jsonResponse({
        model_remains: [
          {
            model_name: "MiniMax-M*",
            current_interval_total_count: 100,
            current_interval_usage_count: 20,
            remains_time: 3_600_000,
            current_weekly_total_count: 200,
            current_weekly_usage_count: 50,
            weekly_remains_time: 86_400_000,
          },
        ],
        base_resp: { status_code: 0, status_msg: "success" },
      });
    });

    const output = await minimaxCodingPlanProvider.fetch(context());

    expect(output.entries).toHaveLength(2);
    for (const entry of output.entries) {
      expect(entry.rowKey).toBeUndefined();
      expect(entry.semantic?.metric.kind).toBe("window");
      expect(entry.accounting.sourceId).toBe("cred-minimax-work");
      expect(entry.group).toBe("[MiniMax Token Plan Work] (active)");
    }
    expect(output.errors).toEqual([
      expect.objectContaining({
        label: "[MiniMax Token Plan Home]",
        sourceId: "cred-minimax-home",
      }),
    ]);
    expect(output.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-minimax-work",
      "cred-minimax-home",
    ]);
  });

  it("openai: describes OAuth and API-key logins and their failure", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "openai",
        id: "cred-openai-work",
        label: "Work",
        value: { access: "openai-work-token", expires: Date.now() + 3_600_000 },
      }),
      {
        integrationId: "openai",
        id: "cred-openai-home",
        label: "Home",
        registered: true,
        method: "key",
        value: { type: "key" },
        resolveError: "refresh_failed: HTTP 401",
      },
    ]);
    stubFetch((url, init) => {
      expect(String(url)).toBe(OPENAI_USAGE_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-work-token");
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3_600,
          },
          secondary_window: null,
        },
      });
    });

    const output = await openaiProvider.fetch(context());

    expect(output.entries).toEqual([
      expect.objectContaining({
        name: "[OpenAI Work] (Plus) (active) 5h",
        rowKey: "window:five_hour",
        percentRemaining: 80,
        accounting: expect.objectContaining({ sourceId: "cred-openai-work" }),
      }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[OpenAI Home]", sourceId: "cred-openai-home" }),
    ]);
    expect(output.accounts).toEqual([
      { sourceId: "cred-openai-work", label: "[OpenAI Work] (Plus) (active)", active: true },
      { sourceId: "cred-openai-home", label: "[OpenAI Home]", active: false },
    ]);
  });

  it("opencode go: maps window row keys and describes the invalid login", async () => {
    bindCredentials([
      keyCredential({
        integrationId: "opencode-go",
        id: "cred-go-work",
        label: "Work",
        key: "go-work-key",
      }),
      keyCredential({
        integrationId: "opencode-go",
        id: "cred-go-home",
        label: "Home",
        key: "",
      }),
    ]);
    stubFetch((url) => {
      expect(String(url)).toBe(OPENCODE_GO_USAGE_URL);
      return jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 12.5, resetsAt: "2026-08-12T12:30:00.000Z" },
          weekly: { status: "ok", percent: 45, resetsAt: "2026-08-16T16:00:00.000Z" },
          monthly: { status: "ok", percent: 80, resetsAt: "2026-09-01T04:00:00.000Z" },
        },
      });
    });

    const output = await opencodeGoProvider.fetch(context());

    expect(output.entries?.map((entry) => entry.rowKey)).toEqual([
      "window:five_hour",
      "window:week",
      "window:month",
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ label: "[OpenCode Go Home]", sourceId: "cred-go-home" }),
    ]);
    expect(output.accounts?.map((account) => account.sourceId)).toEqual([
      "cred-go-work",
      "cred-go-home",
    ]);
  });

  it("google gemini cli: describes both DB logins when the companion cannot answer", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "google-gemini-cli",
        id: "cred-gemini-work",
        label: "Work",
        value: {
          access: "gemini-work-token",
          refresh: "gemini-refresh|gemini-project",
          expires: Date.now() + 3_600_000,
        },
      }),
      oauthCredential({
        integrationId: "google-gemini-cli",
        id: "cred-gemini-home",
        label: "Home",
        resolveError: "refresh_failed: HTTP 401",
      }),
    ]);
    stubFetch(() => new Response("", { status: 500 }));

    const output = await googleGeminiCliProvider.fetch(context());

    expect(output.entries).toEqual([]);
    expect(output.errors?.map((error) => error.sourceId)).toEqual([
      "cred-gemini-work",
      "cred-gemini-home",
    ]);
    expect(output.accounts).toEqual([
      { sourceId: "cred-gemini-work", label: "[Gemini CLI Work] (active)", active: true },
      { sourceId: "cred-gemini-home", label: "[Gemini CLI Home]", active: false },
    ]);
  });

  it("google agy: keeps zero-entry logins visible and reports the failed one", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "google-agy",
        id: "cred-agy-work",
        label: "Work",
        value: {
          access: "agy-work-token",
          refresh: "agy-refresh|agy-project",
          expires: Date.now() + 3_600_000,
          email: "work@example.com",
        },
      }),
      oauthCredential({
        integrationId: "google-agy",
        id: "cred-agy-home",
        label: "Home",
        resolveError: "refresh_failed: HTTP 401",
      }),
    ]);
    stubFetch(() => new Response("", { status: 500 }));

    const output = await googleAgyProvider.fetch(context());

    expect(output.attempted).toBe(true);
    expect(output.entries).toEqual([]);
    expect(output.errors?.map((error) => error.sourceId)).toEqual(["cred-agy-work"]);
    expect(output.accounts).toEqual([
      { sourceId: "cred-agy-work", label: "[Google AGY Work] (active)", active: true },
      { sourceId: "cred-agy-home", label: "[Google AGY Home]", active: false },
    ]);
  });
});

describe("dashboard discovery of known-failed Google logins", () => {
  it("google agy: collects an all-failed stored login set as known-failed accounts", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "google-agy",
        id: "cred-agy-work",
        label: "Work",
        resolveError: "refresh_failed: HTTP 401",
      }),
      oauthCredential({
        integrationId: "google-agy",
        id: "cred-agy-home",
        label: "Home",
        value: {},
      }),
    ]);
    const fetchMock = stubFetch(() => new Response("", { status: 500 }));

    const probes = await collectQuotaDashboardProviderResults({
      client: context().client,
      config: renderConfig(),
      workspaceRoot: tempRoot,
      providers: [googleAgyProvider],
    });

    expect(probes.map((probe) => probe.providerId)).toEqual(["google-agy"]);
    expect(probes[0]?.result.accounts).toEqual([
      { sourceId: "cred-agy-work", label: "[Google AGY Work] (active)", active: true },
      { sourceId: "cred-agy-home", label: "[Google AGY Home]", active: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    // The legacy availability gate and the legacy collection stay unchanged.
    await expect(googleAgyProvider.isAvailable(context())).resolves.toBe(false);
    const legacy = await collectQuotaRenderData({
      client: context().client,
      config: renderConfig(),
      workspaceRoot: tempRoot,
      surfaceExplicitProviderIssues: false,
      providers: [googleAgyProvider],
    });
    expect(legacy.active).toEqual([]);
    expect(legacy.providerResults).toEqual([]);
  });

  it("google gemini cli: collects all-failed stored logins with stable error source ids", async () => {
    bindCredentials([
      oauthCredential({
        integrationId: "google-gemini-cli",
        id: "cred-gemini-work",
        label: "Work",
        resolveError: "refresh_failed: HTTP 401",
      }),
      oauthCredential({
        integrationId: "google-gemini-cli",
        id: "cred-gemini-home",
        label: "Home",
        value: {},
      }),
    ]);
    const fetchMock = stubFetch(() => new Response("", { status: 500 }));

    const probes = await collectQuotaDashboardProviderResults({
      client: context().client,
      config: renderConfig(),
      workspaceRoot: tempRoot,
      providers: [googleGeminiCliProvider],
    });

    expect(probes.map((probe) => probe.providerId)).toEqual(["google-gemini-cli"]);
    expect(probes[0]?.result.accounts).toEqual([
      { sourceId: "cred-gemini-work", label: "[Gemini CLI Work] (active)", active: true },
      { sourceId: "cred-gemini-home", label: "[Gemini CLI Home]", active: false },
    ]);
    expect(probes[0]?.result.errors).toEqual([
      {
        label: "[Gemini CLI Work] (active)",
        message: expect.stringContaining("could not be refreshed"),
        sourceId: "cred-gemini-work",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(googleGeminiCliProvider.isAvailable(context())).resolves.toBe(false);
  });
});

describe("legacy Google companion account identity", () => {
  const accountLabels = new Map([["work@example.com", "work…"]]);

  it("keeps AGY ordinals byte-exact and adds only the email digest as identityKey", () => {
    const buckets: GoogleAgyQuotaBucket[] = [
      {
        family: "Claude and GPT models",
        window: "weekly",
        windowLabel: "Weekly",
        remainingFraction: 0.5,
        percentRemaining: 50,
        accountIndex: 0,
        accountEmail: "work@example.com",
        sourceKey: "google-agy",
      },
      {
        family: "Gemini Models",
        window: "five_hour",
        windowLabel: "5h",
        remainingFraction: 0.7,
        percentRemaining: 70,
        accountIndex: 1,
        sourceKey: "google-agy",
      },
    ];

    const accounts = buildAgyLegacyAccounts({ buckets, accountLabels });

    expect(accounts).toEqual([
      {
        sourceId: "account-1",
        identityKey: deriveStableAccountIdentityKey("work@example.com"),
        label: "work…",
      },
      { sourceId: "account-2", label: "Account 2" },
    ]);
    expect(accounts[1]?.identityKey).toBeUndefined();
    expect(agyBucketRowKey(buckets[0])).toBe("named:Claude and GPT models weekly");
  });

  it("keeps Gemini emails byte-exact in sourceId and digests them in identityKey", () => {
    const buckets: GeminiCliQuotaBucket[] = [
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 50,
        accountEmail: "work@example.com",
        sourceKey: "google-gemini-cli",
      },
    ];

    const accounts = buildGeminiCliLegacyAccounts({
      buckets,
      errors: [{ email: "failed@example.com", error: "boom" }],
      accountLabels,
    });

    expect(accounts).toEqual([
      {
        sourceId: "work@example.com",
        identityKey: deriveStableAccountIdentityKey("work@example.com"),
        label: "work…",
      },
      {
        sourceId: "failed@example.com",
        identityKey: deriveStableAccountIdentityKey("failed@example.com"),
        label: "fai…",
      },
    ]);
    const identityKey = accounts[0]?.identityKey ?? "";
    expect(identityKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(identityKey).not.toContain("example.com");
    expect(identityKey).not.toContain("@");
    expect(geminiCliBucketRowKey(buckets[0])).toBe("named:Gemini Pro");
  });

  it("derives the email digest deterministically without case or padding drift", () => {
    const digest = deriveStableAccountIdentityKey("work@example.com");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveStableAccountIdentityKey("  Work@Example.COM  ")).toBe(digest);
    expect(digest).not.toContain("example.com");
  });
});
