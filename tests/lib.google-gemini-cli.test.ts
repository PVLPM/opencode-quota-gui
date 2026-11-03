import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    readAuthFileCached: vi.fn(),
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          request: RequestInit;
          timeoutMs?: number;
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse(url, options.request, options.timeoutMs);
        return await options.consume(response, new AbortController().signal);
      },
    ),
    getCachedAccessToken: vi.fn(),
    makeAccountCacheKey: vi.fn(),
    setCachedAccessToken: vi.fn(),
    inspectGeminiCliCompanionPresence: vi.fn(),
    resolveGeminiCliClientCredentials: vi.fn(),
    clearGeminiCliCompanionCacheForTests: vi.fn(),
    deriveResolvedAuthIdentity: vi.fn(
      async (params: { providerId: string }) => `identity:${params.providerId}`,
    ),
    composeResolvedAuthIdentities: vi.fn(
      async (params: { providerId: string; identities: readonly string[] }) =>
        `composed:${params.providerId}:${params.identities.join("|")}`,
    ),
  };
});

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: mocks.getCachedAccessToken,
  makeAccountCacheKey: mocks.makeAccountCacheKey,
  setCachedAccessToken: mocks.setCachedAccessToken,
}));

vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: mocks.inspectGeminiCliCompanionPresence,
  resolveGeminiCliClientCredentials: mocks.resolveGeminiCliClientCredentials,
  clearGeminiCliCompanionCacheForTests: mocks.clearGeminiCliCompanionCacheForTests,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: mocks.deriveResolvedAuthIdentity,
  composeResolvedAuthIdentities: mocks.composeResolvedAuthIdentities,
}));

import {
  DEFAULT_GEMINI_CLI_AUTH_CACHE_MAX_AGE_MS,
  hasGeminiCliQuotaRuntimeAvailable,
  inspectGeminiCliAuthPresence,
  parseGeminiCliRefreshParts,
  queryGeminiCliQuota,
  resolveGeminiCliAccounts,
  resolveGeminiCliAuthIdentity,
  resolveGeminiCliConfiguredProjectId,
} from "../src/lib/google-gemini-cli.js";

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe("gemini cli auth resolution", () => {
  let configDir: string;

  function writeGlobalConfig(config: unknown) {
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "opencode-quota-gemini-config-"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
    vi.clearAllMocks();
    mocks.readAuthFileCached.mockResolvedValue(null);
    mocks.fetchResponse.mockResolvedValue(mockJsonResponse({ buckets: [] }));
    mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
    mocks.makeAccountCacheKey.mockReturnValue("test-cache-key");
    mocks.resolveGeminiCliClientCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    delete process.env.OPENCODE_GEMINI_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("composes ordered account and companion identities", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-one|project-one|",
      },
      google: {
        type: "oauth",
        refresh: "refresh-two|project-two|",
      },
    });

    const identity = await resolveGeminiCliAuthIdentity();

    expect(mocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "google-gemini-cli",
      principal: { kind: "credential", value: "refresh-one" },
      qualifiers: ["project-one"],
    });
    expect(mocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "google-gemini-cli:companion",
      principal: { kind: "credential", value: "client-secret" },
      qualifiers: ["client-id"],
    });
    expect(identity).toContain("composed:google-gemini-cli:");
  });

  it("parses opencode-gemini-auth packed refresh strings", () => {
    expect(parseGeminiCliRefreshParts("refresh-token|project-1|managed-project")).toEqual({
      refreshToken: "refresh-token",
      projectId: "project-1",
      managedProjectId: "managed-project",
    });
  });

  it("resolves the canonical Gemini CLI auth entry before compatibility keys", () => {
    expect(
      resolveGeminiCliAccounts({
        "google-gemini-cli": {
          type: "oauth",
          refresh: "canonical-refresh|canonical-project|",
          email: "alice@example.com",
        },
        google: {
          type: "oauth",
          refresh: "google-refresh|google-project|",
          email: "bob@example.com",
        },
      })[0],
    ).toEqual({
      sourceKey: "google-gemini-cli",
      refreshToken: "canonical-refresh",
      projectId: "canonical-project",
      email: "alice@example.com",
    });
  });

  it("supports the upstream opencode-gemini-auth google auth key", () => {
    expect(
      resolveGeminiCliAccounts({
        google: {
          type: "oauth",
          refresh: "refresh-token|project-1|managed-project",
          email: "user@example.com",
          access: "access-token",
          expires: 123,
        },
      }),
    ).toEqual([
      {
        sourceKey: "google",
        refreshToken: "refresh-token",
        projectId: "managed-project",
        email: "user@example.com",
        accessToken: "access-token",
        expiresAt: 123,
      },
    ]);
  });

  it("deduplicates identical credentials stored under compatibility keys", () => {
    expect(
      resolveGeminiCliAccounts({
        "gemini-cli": {
          type: "oauth",
          refresh: "refresh-token|project-1|",
          email: "a@example.com",
        },
        google: { type: "oauth", refresh: "refresh-token|project-1|", email: "a@example.com" },
      }),
    ).toEqual([
      {
        sourceKey: "gemini-cli",
        refreshToken: "refresh-token",
        projectId: "project-1",
        email: "a@example.com",
      },
    ]);
  });

  it("uses configured project id fallback when auth refresh has only a token", () => {
    expect(
      resolveGeminiCliAccounts(
        {
          "gemini-cli": { type: "oauth", refresh: "refresh-token" },
        },
        "configured-project",
      ),
    ).toEqual([
      {
        sourceKey: "gemini-cli",
        refreshToken: "refresh-token",
        projectId: "configured-project",
      },
    ]);
  });

  it("prioritizes managedProjectId and quotaProjectId over developer projectIds in resolveGeminiCliAccounts", () => {
    const auth = {
      google: {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
        managedProjectId: "managed-project-entry",
        quotaProjectId: "quota-project-entry",
      },
    };

    // Test 1: entry.managedProjectId takes top priority
    let resolved = resolveGeminiCliAccounts(auth, "configured-project");
    expect(resolved[0].projectId).toBe("managed-project-entry");

    // Test 2: entry.quotaProjectId takes priority over entry.projectId/projectID and parts and configuredProjectId
    const auth2 = {
      google: {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
        quotaProjectId: "quota-project-entry",
      },
    };
    resolved = resolveGeminiCliAccounts(auth2, "configured-project");
    expect(resolved[0].projectId).toBe("quota-project-entry");

    // Test 3: parts.managedProjectId takes priority over entry.projectId/projectID and parts.projectId and configuredProjectId
    const auth3 = {
      google: {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
      },
    };
    resolved = resolveGeminiCliAccounts(auth3, "configured-project");
    expect(resolved[0].projectId).toBe("managed-project-part");
  });

  it("prefers explicit OpenCode provider config over generic Google project env vars", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "generic-shell-project";
    writeGlobalConfig({
      provider: { google: { options: { projectId: "configured-opencode-project" } } },
    });

    await expect(resolveGeminiCliConfiguredProjectId()).resolves.toBe(
      "configured-opencode-project",
    );
  });

  it("reads the project id from OpenCode 2 native provider settings", async () => {
    writeGlobalConfig({
      providers: { google: { settings: { projectId: "native-opencode-project" } } },
    });

    await expect(resolveGeminiCliConfiguredProjectId()).resolves.toBe("native-opencode-project");
  });

  it("lets a native providers entry replace the legacy provider entry", async () => {
    writeGlobalConfig({
      provider: { google: { options: { projectId: "legacy-opencode-project" } } },
      providers: { google: { settings: { projectId: "native-opencode-project" } } },
    });

    await expect(resolveGeminiCliConfiguredProjectId()).resolves.toBe("native-opencode-project");
  });

  it("keeps OPENCODE_GEMINI_PROJECT_ID as the highest-priority project override", async () => {
    process.env.OPENCODE_GEMINI_PROJECT_ID = "explicit-gemini-project";
    process.env.GOOGLE_CLOUD_PROJECT = "generic-shell-project";
    writeGlobalConfig({
      providers: { google: { settings: { projectId: "native-opencode-project" } } },
    });

    await expect(resolveGeminiCliConfiguredProjectId()).resolves.toBe("explicit-gemini-project");
  });

  it("reports invalid auth when OAuth exists but no project id can be resolved", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: { type: "oauth", refresh: "refresh-token" },
    });

    await expect(inspectGeminiCliAuthPresence()).resolves.toMatchObject({
      state: "invalid",
      sourceKey: "google",
      accountCount: 1,
      validAccountCount: 0,
    });
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_GEMINI_CLI_AUTH_CACHE_MAX_AGE_MS,
      integrationIds: [
        "google-gemini-cli",
        "gemini-cli",
        "opencode-gemini-auth",
        "gemini",
        "google",
      ],
    });
  });

  it("keeps a login OpenCode could not return present without making it an account", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": { type: "oauth", resolveError: "refresh_failed: HTTP 400" },
    });
    mocks.inspectGeminiCliCompanionPresence.mockResolvedValue({
      state: "present",
      resolvedPath: "/plugin",
    });

    await expect(inspectGeminiCliAuthPresence()).resolves.toEqual({
      state: "present",
      sourceKey: "google-gemini-cli",
      accountCount: 1,
      validAccountCount: 0,
    });
    await expect(hasGeminiCliQuotaRuntimeAvailable()).resolves.toBe(true);
    await expect(queryGeminiCliQuota()).resolves.toBeNull();
    expect(mocks.fetchResponse).not.toHaveBeenCalled();
  });

  it("skips a failed login when resolving accounts and counts it next to valid ones", async () => {
    const auth = {
      "google-gemini-cli": { type: "oauth", resolveError: "refresh_failed: HTTP 400" },
      google: { type: "oauth", refresh: "refresh-token|project-id" },
    };
    mocks.readAuthFileCached.mockResolvedValue(auth);

    expect(resolveGeminiCliAccounts(auth).map((account) => account.sourceKey)).toEqual(["google"]);
    await expect(inspectGeminiCliAuthPresence()).resolves.toEqual({
      state: "present",
      sourceKey: "google",
      accountCount: 2,
      validAccountCount: 1,
    });
  });

  it("does not treat a failed Google API key login as a Gemini CLI login", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      google: { type: "api", resolveError: "resolve_empty: no value" },
    });

    await expect(inspectGeminiCliAuthPresence()).resolves.toEqual({
      state: "missing",
      accountCount: 0,
      validAccountCount: 0,
    });
  });

  it("aggregates known Gemini CLI buckets by quality tier and keeps unknown models", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.fetchResponse.mockResolvedValueOnce(
      mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-3.1-pro-preview",
            remainingFraction: 0.8,
            resetTime: "2026-01-01T10:00:00.000Z",
            remainingAmount: "100",
            tokenType: "REQUESTS",
          },
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.2,
            resetTime: "2026-01-01T12:00:00.000Z",
            remainingAmount: "50",
            tokenType: "TOKENS",
          },
          {
            modelId: "gemini-2.5-flash",
            remainingFraction: 0.5,
            resetTime: "2026-01-01T08:00:00.000Z",
            remainingAmount: "1000",
            tokenType: "REQUESTS",
          },
          {
            modelId: "gemini_2_5_flash_lite",
            remainingFraction: 0.1,
            remainingAmount: "25",
          },
          {
            modelId: "gemini-experimental-foo",
            remainingFraction: 0.7,
          },
          {
            remainingFraction: 0.01,
          },
        ],
      }),
    );

    const result = await queryGeminiCliQuota();

    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected successful Gemini CLI quota result");
    }
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 20,
        resetTimeIso: "2026-01-01T12:00:00.000Z",
        remainingAmount: "50",
        tokenType: "TOKENS",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini-2.5-flash",
        displayName: "Gemini Flash",
        percentRemaining: 50,
        resetTimeIso: "2026-01-01T08:00:00.000Z",
        remainingAmount: "1000",
        tokenType: "REQUESTS",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini_2_5_flash_lite",
        displayName: "Gemini Flash Lite",
        percentRemaining: 10,
        remainingAmount: "25",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini-experimental-foo",
        displayName: "Gemini Experimental Foo",
        percentRemaining: 70,
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
    ]);
  });

  it("does not merge Gemini CLI tier buckets across accounts", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-a|project-a|",
        email: "alice@example.com",
      },
      google: {
        type: "oauth",
        refresh: "refresh-b|project-b|",
        email: "bob@example.com",
      },
    });
    mocks.fetchResponse.mockImplementation(async (_url: string, options: { body?: unknown }) => {
      const body = JSON.parse(String(options.body)) as { project: string };
      return mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: body.project === "project-a" ? 0.9 : 0.1,
          },
        ],
      });
    });

    const result = await queryGeminiCliQuota();

    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected successful Gemini CLI quota result");
    }
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 90,
        accountEmail: "alice@example.com",
        sourceKey: "google-gemini-cli",
      },
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 10,
        accountEmail: "bob@example.com",
        sourceKey: "google",
      },
    ]);
  });

  it("labels token revocation and request failures with structured provenance", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValue(null);

    mocks.fetchResponse.mockResolvedValueOnce(mockJsonResponse({ error: "invalid_grant" }, 400));
    const revoked = await queryGeminiCliQuota();
    expect(revoked).toMatchObject({
      success: true,
      buckets: [],
      errors: [{ error: "Token revoked", failureCategory: "credentials" }],
    });

    mocks.fetchResponse.mockResolvedValueOnce(mockJsonResponse({}, 500));
    const refreshFailed = await queryGeminiCliQuota();
    expect(refreshFailed).toMatchObject({
      success: true,
      buckets: [],
      errors: [{ failureCategory: "provider_api" }],
    });

    mocks.fetchResponse.mockResolvedValueOnce(mockJsonResponse({}));
    const malformedRefresh = await queryGeminiCliQuota();
    expect(malformedRefresh).toMatchObject({
      success: true,
      buckets: [],
      errors: [{ failureCategory: "provider_api" }],
    });

    mocks.fetchResponse
      .mockResolvedValueOnce(mockJsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(mockJsonResponse({}, 500));
    const quotaFailed = await queryGeminiCliQuota();
    expect(quotaFailed).toMatchObject({
      success: true,
      buckets: [],
      errors: [{ error: "Gemini CLI quota API error: 500", failureCategory: "provider_api" }],
    });
  });

  it("labels an expired quota credential after one retry as credentials", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValue(null);
    mocks.fetchResponse
      .mockResolvedValueOnce(mockJsonResponse({ access_token: "token-1", expires_in: 3600 }))
      .mockResolvedValueOnce(mockJsonResponse({}, 401))
      .mockResolvedValueOnce(mockJsonResponse({ access_token: "token-2", expires_in: 3600 }))
      .mockResolvedValueOnce(mockJsonResponse({}, 403));

    const result = await queryGeminiCliQuota();
    expect(result).toMatchObject({
      success: true,
      buckets: [],
      errors: [
        {
          error: "Gemini CLI quota auth error: 403",
          failureCategory: "credentials",
        },
      ],
    });
  });

  it("labels malformed quota payloads as provider API", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValue(null);
    mocks.fetchResponse
      .mockResolvedValueOnce(mockJsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      });

    const result = await queryGeminiCliQuota();
    expect(result).toMatchObject({
      success: true,
      buckets: [],
      errors: [{ failureCategory: "provider_api" }],
    });
  });

  it("labels a missing companion plugin as local", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.resolveGeminiCliClientCredentials.mockResolvedValueOnce({ state: "missing" });

    await expect(queryGeminiCliQuota()).resolves.toEqual({
      success: false,
      error: "Gemini CLI requires the opencode-gemini-auth plugin",
      failureCategory: "local",
    });
  });
});
