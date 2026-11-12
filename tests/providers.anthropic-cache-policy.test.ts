import { describe, expect, it, vi } from "vitest";

const opencodeAuth = vi.hoisted(() => ({
  readCredentialRows: vi.fn(
    async (_integrationIds: readonly string[], _options?: unknown): Promise<unknown[]> => [],
  ),
}));

const availability = vi.hoisted(() => ({
  isAnyProviderIdAvailable: vi.fn(async () => false),
}));

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  resolveAnthropicAuthIdentity: vi.fn(async () => null),
  resolveAnthropicAccountSetIdentity: vi.fn(async () => null),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: opencodeAuth.readCredentialRows,
}));

vi.mock("../src/lib/provider-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/provider-availability.js")>()),
  isAnyProviderIdAvailable: availability.isAnyProviderIdAvailable,
}));

describe("anthropic cache policy route identity", () => {
  it("scopes the Claude Code route identity to the Claude CLI login and effective binary", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const { resolveAnthropicAuthIdentity } = await import("../src/lib/anthropic.js");
    const policy = PROVIDER_CACHE_POLICIES.anthropic;

    await policy.resolveIdentity(
      {
        config: {
          anthropicBinaryPath: "C:\\tools\\claude.exe",
          onlyCurrentModel: true,
          currentProviderID: "claude-agent",
        },
      } as any,
      {},
    );

    expect(resolveAnthropicAuthIdentity).toHaveBeenLastCalledWith({
      binaryPath: "C:\\tools\\claude.exe",
      useClaudeCodeCredentials: true,
    });
  });

  it("scopes the OpenCode route identity to every OpenCode login row, not only the active one", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const { resolveAnthropicAccountSetIdentity } = await import("../src/lib/anthropic.js");
    opencodeAuth.readCredentialRows.mockResolvedValueOnce([
      {
        id: "row-active",
        integrationId: "anthropic",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "work-token" },
      },
      {
        id: "row-idle",
        integrationId: "anthropic",
        label: "Home",
        active: false,
        value: { type: "oauth", access: "home-token" },
      },
      {
        id: "row-broken",
        integrationId: "anthropic",
        label: "Old",
        active: false,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 500",
      },
    ]);

    await PROVIDER_CACHE_POLICIES.anthropic.resolveIdentity(
      {
        config: {
          anthropicBinaryPath: "claude",
          onlyCurrentModel: false,
          currentProviderID: "anthropic",
        },
      } as any,
      {},
    );

    expect(resolveAnthropicAccountSetIdentity).toHaveBeenLastCalledWith({
      binaryPath: "claude",
      openCodeAccounts: [
        expect.objectContaining({
          sourceId: "row-active",
          active: true,
          accessToken: "work-token",
        }),
        expect.objectContaining({ sourceId: "row-idle", active: false, accessToken: "home-token" }),
        expect.objectContaining({ sourceId: "row-broken", active: false }),
      ],
      onlyCurrentModel: false,
      claudeCodeRuntimeDetected: false,
    });
  });

  it("passes the selected route flag and whether OpenCode detects a Claude Code runtime", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const { resolveAnthropicAccountSetIdentity } = await import("../src/lib/anthropic.js");
    availability.isAnyProviderIdAvailable.mockResolvedValueOnce(true);

    await PROVIDER_CACHE_POLICIES.anthropic.resolveIdentity(
      {
        config: {
          anthropicBinaryPath: "claude",
          onlyCurrentModel: true,
          currentProviderID: "anthropic",
        },
      } as any,
      {},
    );

    expect(resolveAnthropicAccountSetIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ onlyCurrentModel: true, claudeCodeRuntimeDetected: true }),
    );
  });
});
