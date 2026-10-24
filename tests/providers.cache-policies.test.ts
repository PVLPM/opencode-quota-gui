import { beforeEach, describe, expect, it, vi } from "vitest";

const cachePolicyMocks = vi.hoisted(() => ({
  resolveGlobal: vi.fn(),
  resolveCn: vi.fn(),
  deriveIdentity: vi.fn(async (params: unknown) => JSON.stringify(params)),
  composeIdentity: vi.fn(async (params: unknown) => `composed:${JSON.stringify(params)}`),
  resolveConsoleAuth: vi.fn(),
  resolveConsoleAccounts: vi.fn(),
  resolveGoAuth: vi.fn(),
  resolveOpenRouterIdentity: vi.fn(),
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
  resolveOpenCodeConsoleAuthAccounts: cachePolicyMocks.resolveConsoleAccounts,
}));

vi.mock("../src/lib/opencode-go-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-go-auth.js")>()),
  resolveOpenCodeGoAuthCached: cachePolicyMocks.resolveGoAuth,
}));

vi.mock("../src/lib/openrouter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/openrouter.js")>()),
  resolveOpenRouterAuthIdentity: cachePolicyMocks.resolveOpenRouterIdentity,
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>();
  return {
    ...actual,
    deriveResolvedAuthIdentity: cachePolicyMocks.deriveIdentity,
    composeResolvedAuthIdentities: cachePolicyMocks.composeIdentity,
  };
});

import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { getProviders } from "../src/providers/registry.js";

function consoleAccount(sourceId: string, credential: Record<string, unknown>) {
  return {
    state: "configured" as const,
    sourceId,
    label: sourceId,
    active: sourceId.endsWith("_1"),
    credential,
  };
}

function consoleQualifiers(
  accounts: ReadonlyArray<{
    active: boolean;
    label: string;
    sourceId: string;
    state: string;
  }>,
): string[] {
  return accounts.map(({ active, label, sourceId, state }) =>
    JSON.stringify({ active, label, sourceId, state }),
  );
}

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
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([]);
    cachePolicyMocks.resolveGoAuth.mockResolvedValue({ state: "none" });
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
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_cloud", {
        accessToken: "st_secret-token",
        orgId: "wrk_shared",
        accountId: "acc_1",
      }),
    ]);
    const cloudIdentity = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_self_hosted", {
        accessToken: "st_self-hosted-token",
        orgId: "wrk_shared",
        accountId: "acc_1",
        server: "https://console.self-hosted.example",
      }),
    ]);
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
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("acc_a", {
        accessToken: "st_secret-token-1",
        orgId: "wrk_shared",
        accountId: "acc_a",
      }),
    ]);
    const identityA = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("acc_b", {
        accessToken: "st_secret-token-2",
        orgId: "wrk_shared",
        accountId: "acc_b",
      }),
    ]);
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

  it("keeps same-org workspaces distinct by token when the sign-in has no account id", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const ctx = { config: {} } as never;
    const cacheContext = {} as never;
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_first", { accessToken: "st_first-token", orgId: "wrk_shared" }),
    ]);
    const firstIdentity = await policy.resolveIdentity(ctx, cacheContext);

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_second", { accessToken: "st_second-token", orgId: "wrk_shared" }),
    ]);
    const secondIdentity = await policy.resolveIdentity(ctx, cacheContext);

    expect(firstIdentity).not.toBeNull();
    expect(secondIdentity).not.toBeNull();
    expect(firstIdentity).not.toBe(secondIdentity);
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "st_first-token"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_shared", "st_second-token"]) },
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

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_primary", credential as Record<string, unknown>),
    ]);
    await policy.resolveIdentity({ config: {} } as never, {} as never);

    expect(cachePolicyMocks.deriveIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      principal,
      qualifiers: ["https://opencode.ai/console"],
    });
  });

  it.each([
    { name: "no login", accounts: [] },
    {
      name: "an expired login",
      accounts: [
        {
          state: "expired",
          sourceId: "cred_expired",
          label: "Expired",
          active: true,
          credential: { accessToken: "st_secret-token", orgId: "wrk_shared" },
        },
      ],
    },
    {
      name: "an invalid login",
      accounts: [
        {
          state: "invalid",
          sourceId: "cred_invalid",
          label: "Invalid",
          active: true,
          error: "refresh_failed: boom",
        },
      ],
    },
  ])("returns no OpenCode Zen identity without a configured Console sign-in ($name)", async ({
    accounts,
  }) => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue(accounts);
    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBeNull();
    expect(cachePolicyMocks.deriveIdentity).not.toHaveBeenCalled();
  });

  it("composes every Console workspace into one OpenCode Zen cache identity", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const work = consoleAccount("cred_work", {
      accessToken: "st_work-token",
      orgId: "wrk_work",
      accountId: "acc_work",
    });
    const personal = consoleAccount("cred_personal", {
      accessToken: "st_personal-token",
      orgId: "wrk_personal",
      accountId: "acc_personal",
    });
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([work, personal]);

    const identity = await policy.resolveIdentity({ config: {} } as never, {} as never);

    const workIdentity = JSON.stringify({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_work", "acc_work"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    const personalIdentity = JSON.stringify({
      providerId: "opencode",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_personal", "acc_personal"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    const qualifiers = consoleQualifiers([work, personal]);
    expect(cachePolicyMocks.composeIdentity).toHaveBeenCalledWith({
      providerId: "opencode",
      identities: [workIdentity, personalIdentity],
      qualifiers,
    });
    expect(identity).toBe(
      `composed:${JSON.stringify({
        providerId: "opencode",
        identities: [workIdentity, personalIdentity],
        qualifiers,
      })}`,
    );
  });

  it("invalidates OpenCode Zen when any workspace credential changes", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_work", { accessToken: "st_work-token", orgId: "wrk_work" }),
      consoleAccount("cred_personal", { accessToken: "st_personal-token", orgId: "wrk_personal" }),
    ]);
    const before = await policy.resolveIdentity({ config: {} } as never, {} as never);

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([
      consoleAccount("cred_work", { accessToken: "st_work-token", orgId: "wrk_work" }),
      consoleAccount("cred_personal", {
        accessToken: "st_personal-token",
        orgId: "wrk_personal_renamed",
      }),
    ]);
    const after = await policy.resolveIdentity({ config: {} } as never, {} as never);

    expect(before).not.toBe(after);
  });

  it("invalidates Console identity when account metadata or failed rows change", async () => {
    const policy = PROVIDER_CACHE_POLICIES.opencode;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const stable = consoleAccount("cred_stable", { accessToken: "st_stable-token" });
    const target = consoleAccount("cred_target_1", { accessToken: "st_target-token" });
    const baseline = [stable, target];
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue(baseline);
    const before = await policy.resolveIdentity({ config: {} } as never, {} as never);

    const changes = [
      [stable, { ...target, sourceId: "cred_target_2" }],
      [stable, { ...target, label: "Renamed" }],
      [stable, { ...target, active: false }],
      [stable, { ...target, state: "expired" }],
      [
        stable,
        target,
        {
          state: "invalid",
          sourceId: "cred_failed",
          label: "Failed",
          active: false,
          error: "refresh failed",
        },
      ],
    ];

    for (const accounts of changes) {
      cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue(accounts);
      const after = await policy.resolveIdentity({ config: {} } as never, {} as never);
      expect(after).not.toBe(before);
    }

    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue(baseline);
    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBe(
      before,
    );
  });

  it("composes OpenCode Go Console workspaces with the legacy API key identity", async () => {
    const policy = PROVIDER_CACHE_POLICIES["opencode-go"];
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    const work = consoleAccount("cred_work", { accessToken: "st_work-token", orgId: "wrk_work" });
    const personal = consoleAccount("cred_personal", {
      accessToken: "st_personal-token",
      orgId: "wrk_personal",
    });
    cachePolicyMocks.resolveConsoleAccounts.mockResolvedValue([work, personal]);
    cachePolicyMocks.resolveGoAuth.mockResolvedValue({
      state: "configured",
      apiKey: "legacy-go-key",
    });

    await policy.resolveIdentity({ config: {} } as never, {} as never);

    const workIdentity = JSON.stringify({
      providerId: "opencode-go",
      principal: { kind: "stable-id", value: JSON.stringify(["wrk_work", "st_work-token"]) },
      qualifiers: ["https://opencode.ai/console"],
    });
    const personalIdentity = JSON.stringify({
      providerId: "opencode-go",
      principal: {
        kind: "stable-id",
        value: JSON.stringify(["wrk_personal", "st_personal-token"]),
      },
      qualifiers: ["https://opencode.ai/console"],
    });
    const legacyIdentity = JSON.stringify({
      providerId: "opencode-go",
      principal: { kind: "credential", value: "legacy-go-key" },
    });
    expect(cachePolicyMocks.composeIdentity).toHaveBeenCalledWith({
      providerId: "opencode-go",
      identities: [workIdentity, personalIdentity, legacyIdentity],
      qualifiers: consoleQualifiers([work, personal]),
    });
  });

  it("keeps the legacy OpenCode Go key identity and returns null with no OpenCode Go auth", async () => {
    const policy = PROVIDER_CACHE_POLICIES["opencode-go"];
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveGoAuth.mockResolvedValue({
      state: "configured",
      apiKey: "legacy-go-key",
    });
    const legacyOnly = await policy.resolveIdentity({ config: {} } as never, {} as never);

    expect(cachePolicyMocks.composeIdentity).not.toHaveBeenCalled();
    expect(legacyOnly).toBe(
      JSON.stringify({
        providerId: "opencode-go",
        principal: { kind: "credential", value: "legacy-go-key" },
      }),
    );

    cachePolicyMocks.resolveGoAuth.mockResolvedValue({ state: "none" });
    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBeNull();
  });

  it("uses the OpenRouter multi-key cache identity export", async () => {
    const policy = PROVIDER_CACHE_POLICIES.openrouter;
    if (policy.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");

    cachePolicyMocks.resolveOpenRouterIdentity.mockResolvedValue("openrouter-multi-identity");

    await expect(policy.resolveIdentity({ config: {} } as never, {} as never)).resolves.toBe(
      "openrouter-multi-identity",
    );
    expect(cachePolicyMocks.resolveOpenRouterIdentity).toHaveBeenCalledOnce();
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
