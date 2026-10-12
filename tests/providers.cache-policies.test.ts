import { beforeEach, describe, expect, it, vi } from "vitest";

const cachePolicyMocks = vi.hoisted(() => ({
  resolveGlobal: vi.fn(),
  resolveCn: vi.fn(),
  deriveIdentity: vi.fn(async (params: unknown) => JSON.stringify(params)),
  resolveConsoleAuth: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveKimiGlobalAuthCached: cachePolicyMocks.resolveGlobal,
  resolveKimiCnAuthCached: cachePolicyMocks.resolveCn,
  resolveKimiGlobalAuthWithDiagnosticsCached: vi.fn(),
  resolveKimiCnAuthWithDiagnosticsCached: vi.fn(),
  resolveKimiGlobalAuth: vi.fn(),
  resolveKimiCnAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuth: cachePolicyMocks.resolveConsoleAuth,
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>();
  return {
    ...actual,
    deriveResolvedAuthIdentity: cachePolicyMocks.deriveIdentity,
  };
});

import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";

describe("provider cache policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cachePolicyMocks.resolveGlobal.mockResolvedValue({
      state: "configured",
      apiKey: "shared-kimi-secret",
      endpoint: "global",
    });
    cachePolicyMocks.resolveCn.mockResolvedValue({
      state: "configured",
      apiKey: "shared-kimi-secret",
      endpoint: "cn",
    });
  });

  it("classifies every canonical provider without an account-neutral fallback", () => {
    const registeredIds = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id).sort();
    expect(Object.keys(PROVIDER_CACHE_POLICIES).sort()).toEqual(registeredIds);
    expect(Object.values(PROVIDER_CACHE_POLICIES)).not.toContainEqual({
      kind: "account-neutral",
    });

    const uncached = Object.entries(PROVIDER_CACHE_POLICIES)
      .filter(([, policy]) => policy.kind === "uncached")
      .map(([id]) => id)
      .sort();
    expect(uncached).toEqual(["alibaba-token-plan", "cursor"]);

    expect(PROVIDER_CACHE_POLICIES["kimi-code-plan-global"].kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES["kimi-code-plan-cn"].kind).toBe("resolved-auth");
    expect(PROVIDER_CACHE_POLICIES).not.toHaveProperty("kimi-for-coding");

    for (const id of ["anthropic", "copilot", "google-gemini-cli", "openrouter", "xai"] as const) {
      expect(PROVIDER_CACHE_POLICIES[id].kind).toBe("resolved-auth");
    }
  });

  it("keeps Kimi identities isolated through the actual regional policy resolvers", async () => {
    const globalPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-global"];
    const cnPolicy = PROVIDER_CACHE_POLICIES["kimi-code-plan-cn"];
    if (globalPolicy.kind !== "resolved-auth" || cnPolicy.kind !== "resolved-auth") {
      throw new Error("Expected resolved-auth Kimi cache policies");
    }

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    const globalFirst = await globalPolicy.resolveIdentity(ctx, cacheContext);
    const cnFirst = await cnPolicy.resolveIdentity(ctx, cacheContext);

    expect(globalFirst).not.toBe(cnFirst);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "kimi-code-plan-global",
      principal: { kind: "credential", value: "shared-kimi-secret" },
      qualifiers: ["global"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "kimi-code-plan-cn",
      principal: { kind: "credential", value: "shared-kimi-secret" },
      qualifiers: ["cn"],
    });

    cachePolicyMocks.resolveCn.mockResolvedValue({
      state: "configured",
      apiKey: "changed-cn-secret",
      endpoint: "cn",
    });

    const globalSecond = await globalPolicy.resolveIdentity(ctx, cacheContext);
    const cnSecond = await cnPolicy.resolveIdentity(ctx, cacheContext);

    expect(globalSecond).toBe(globalFirst);
    expect(cnSecond).not.toBe(cnFirst);
    expect(cachePolicyMocks.resolveGlobal).toHaveBeenCalledTimes(2);
    expect(cachePolicyMocks.resolveCn).toHaveBeenCalledTimes(2);
  });

  it("derives distinct OpenCode Zen identities for the same org on different Console URLs", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token", orgId: "wrk_shared", accountId: "acc_1" },
    });
    const cloudIdentity = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: {
        accessToken: "st_self-hosted-token",
        orgId: "wrk_shared",
        accountId: "acc_1",
        server: "https://console.self-hosted.example",
      },
    });
    const selfHostedIdentity = await policy.resolveIdentity(ctx, cacheContext);

    expect(cloudIdentity).not.toBeNull();
    expect(selfHostedIdentity).not.toBeNull();
    expect(cloudIdentity).not.toBe(selfHostedIdentity);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_1"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_1"]) },
      qualifiers: ["https://console.self-hosted.example"],
    });
  });

  it("derives distinct OpenCode Zen identities for two accounts in the same org", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token-1", orgId: "wrk_shared", accountId: "acc_a" },
    });
    const identityA = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: { accessToken: "st_secret-token-2", orgId: "wrk_shared", accountId: "acc_b" },
    });
    const identityB = await policy.resolveIdentity(ctx, cacheContext);

    expect(identityA).not.toBeNull();
    expect(identityB).not.toBeNull();
    expect(identityA).not.toBe(identityB);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_a"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "acc_b"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
  });

  it.each([
    [
      { accessToken: "st_secret-token", accountId: "acc_1" },
      { kind: "stable-id", value: "acc_1" },
    ],
    [{ accessToken: "st_secret-token" }, { kind: "credential", value: "st_secret-token" }],
  ])("uses the account, then the token, when the Console sign-in has no org (%j)", async (credential, principal) => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue({ state: "configured", credential });
    await policy.resolveIdentity({ config: {} } as never, {} as never);

    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal,
      qualifiers: ["https://opencode.ai/console"],
    });
  });

  it.each([
    { state: "none" },
    { state: "expired", credential: { accessToken: "st_secret-token", orgId: "wrk_shared" } },
    { state: "invalid", error: "refresh_failed: boom" },
  ])("returns no OpenCode Zen identity without a configured Console sign-in (%j)", async (resolution) => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveConsoleAuth.mockResolvedValue(resolution);
    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBeNull();
    expect(cachePolicyMocks.deriveIdentity).not.toHaveBeenCalled();
  });

  it("attaches the exhaustive policy to the stable provider singleton", () => {
    const first = getProviders();
    const second = getProviders();
    expect(first.map(({ id }) => id)).toEqual(
      QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id),
    );

    first.forEach((provider, index) => {
      expect(second[index]).toBe(provider);
      expect(provider.cachePolicy).toBe(
        PROVIDER_CACHE_POLICIES[provider.id as keyof typeof PROVIDER_CACHE_POLICIES],
      );
    });
  });
});
