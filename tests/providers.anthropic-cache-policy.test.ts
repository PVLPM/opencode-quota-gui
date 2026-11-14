import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const opencodeAuth = vi.hoisted(() => ({
  readCredentialRows: vi.fn(
    async (_integrationIds: readonly string[], _options?: unknown): Promise<unknown[]> => [],
  ),
}));

const availability = vi.hoisted(() => ({
  isAnyProviderIdAvailable: vi.fn(async () => false),
}));

const cli = vi.hoisted(() => ({
  token: "cli-token",
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: cli.execFile, spawn: cli.spawn }));

vi.mock("fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs/promises")>();
  return {
    ...original,
    readFile: vi.fn((path, ...args) =>
      String(path).endsWith(".credentials.json")
        ? Promise.resolve(JSON.stringify({ claudeAiOauth: { accessToken: cli.token } }))
        : original.readFile(path, ...args),
    ),
  };
});

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: vi.fn(async (params) =>
    createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  ),
  composeResolvedAuthIdentities: vi.fn(async (params) =>
    createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  ),
}));

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  resolveClaudeAgentAccountIdentity: vi.fn(
    (await importOriginal<typeof import("../src/lib/anthropic.js")>())
      .resolveClaudeAgentAccountIdentity,
  ),
  resolveAnthropicAccountSetIdentity: vi.fn(
    (await importOriginal<typeof import("../src/lib/anthropic.js")>())
      .resolveAnthropicAccountSetIdentity,
  ),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: opencodeAuth.readCredentialRows,
}));

vi.mock("../src/lib/provider-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/provider-availability.js")>()),
  isAnyProviderIdAvailable: availability.isAnyProviderIdAvailable,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("anthropic cache policy route identity", () => {
  it("scopes the Claude Code route identity to the Claude CLI login and effective binary", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const { resolveClaudeAgentAccountIdentity } = await import("../src/lib/anthropic.js");
    const policy = PROVIDER_CACHE_POLICIES["claude-agent"];
    vi.mocked(resolveClaudeAgentAccountIdentity).mockResolvedValueOnce(null);

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

    expect(resolveClaudeAgentAccountIdentity).toHaveBeenLastCalledWith({
      binaryPath: "C:\\tools\\claude.exe",
      operationCache: undefined,
      onlyCurrentModel: true,
      runtimeDetected: false,
      excludedCredentialFingerprints: [],
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
    });
  });

  it("passes the selected route flag and whether OpenCode detects a Claude Code runtime", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const { resolveClaudeAgentAccountIdentity } = await import("../src/lib/anthropic.js");
    availability.isAnyProviderIdAvailable.mockResolvedValueOnce(true);
    vi.mocked(resolveClaudeAgentAccountIdentity).mockResolvedValueOnce(null);

    await PROVIDER_CACHE_POLICIES["claude-agent"].resolveIdentity(
      {
        config: {
          anthropicBinaryPath: "claude",
          onlyCurrentModel: true,
          currentProviderID: "anthropic",
        },
      } as any,
      {},
    );

    expect(resolveClaudeAgentAccountIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ onlyCurrentModel: true, runtimeDetected: true }),
    );
  });
});

describe("separate provider cache identities", () => {
  it("isolates login changes, deduplication, namespaces, and never probes the CLI for Anthropic", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
    const configDirectory = join(process.cwd(), "test-claude-config");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
    cli.execFile.mockImplementation((_file, args, _options, callback) => {
      callback(
        null,
        args.includes("--version")
          ? "claude 1.2.3"
          : JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
        "",
      );
      return {};
    });
    const ctx = { config: { anthropicBinaryPath: "claude", onlyCurrentModel: false } } as any;
    availability.isAnyProviderIdAvailable.mockResolvedValue(true);
    const setOpenCode = (token: string) =>
      opencodeAuth.readCredentialRows.mockResolvedValue([
        {
          id: "row",
          integrationId: "anthropic",
          label: "Work",
          active: true,
          value: { type: "oauth", access: token },
        },
      ]);
    const identities = async () => ({
      anthropic: await PROVIDER_CACHE_POLICIES.anthropic.resolveIdentity(ctx, {}),
      agent: await PROVIDER_CACHE_POLICIES["claude-agent"].resolveIdentity(ctx, {}),
    });

    cli.token = "cli-token-a";
    setOpenCode("open-token-a");
    const anthropic = await PROVIDER_CACHE_POLICIES.anthropic.resolveIdentity(ctx, {});
    expect(anthropic).not.toBeNull();
    expect(cli.execFile).not.toHaveBeenCalled();
    expect(cli.spawn).not.toHaveBeenCalled();
    const initial = await identities();
    expect(initial.agent).not.toBeNull();
    expect(initial.agent).not.toBe(initial.anthropic);

    cli.token = "cli-token-b";
    const changedCli = await identities();
    expect(changedCli.anthropic).toBe(initial.anthropic);
    expect(changedCli.agent).not.toBe(initial.agent);

    setOpenCode("open-token-b");
    const changedOpenCode = await identities();
    expect(changedOpenCode.anthropic).not.toBe(changedCli.anthropic);
    expect(changedOpenCode.agent).toBe(changedCli.agent);

    setOpenCode("cli-token-b");
    const duplicate = await identities();
    expect(duplicate.agent).not.toBe(changedOpenCode.agent);
    expect(duplicate.agent).not.toBe(duplicate.anthropic);
  });
});
