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
    });
  });

  it("does not cache retired OpenCode OAuth quota", async () => {
    const { PROVIDER_CACHE_POLICIES } = await import("../src/providers/cache-policies.js");
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

    expect(PROVIDER_CACHE_POLICIES.anthropic.kind).toBe("uncached");
    expect(opencodeAuth.readCredentialRows).not.toHaveBeenCalled();
    expect(cli.execFile).not.toHaveBeenCalled();
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
  it("keeps Claude CLI identity independent of OpenCode OAuth credentials", async () => {
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
    const identity = () => PROVIDER_CACHE_POLICIES["claude-agent"].resolveIdentity(ctx, {});

    cli.token = "cli-token-a";
    setOpenCode("open-token-a");
    expect(PROVIDER_CACHE_POLICIES.anthropic.kind).toBe("uncached");
    expect(cli.execFile).not.toHaveBeenCalled();
    expect(cli.spawn).not.toHaveBeenCalled();
    const initial = await identity();
    expect(initial).not.toBeNull();

    cli.token = "cli-token-b";
    const changedCli = await identity();
    expect(changedCli).not.toBe(initial);

    setOpenCode("open-token-b");
    const changedOpenCode = await identity();
    expect(changedOpenCode).toBe(changedCli);

    setOpenCode("cli-token-b");
    const duplicate = await identity();
    expect(duplicate).toBe(changedOpenCode);
    expect(opencodeAuth.readCredentialRows).not.toHaveBeenCalled();
  });
});
