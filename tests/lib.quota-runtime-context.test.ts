import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedHomeDir = vi.hoisted(() => ({
  value: "",
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir.value || actual.homedir(),
  };
});

import { createLoadConfigMeta, getGuiConfigPath } from "../src/lib/config.js";
import { resolveRuntimeContextRoots } from "../src/lib/config-file-utils.js";
import {
  createQuotaProviderRuntimeContext,
  type QuotaRuntimeClient,
  resolveQuotaRuntimeContext,
} from "../src/lib/quota-runtime-context.js";
import { buildQuotaProviderStateCacheKey } from "../src/lib/quota-state.js";
import { __resetQuotaTelemetryForTests } from "../src/lib/quota-telemetry.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

function writeCanonicalConfig(configDir: string, data: Record<string, unknown>): string {
  const dir = join(configDir, "opencode-quota-gui");
  mkdirSync(dir, { recursive: true });
  const path = getGuiConfigPath(configDir);
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
}

describe("quota runtime context", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  let tempDir: string;
  let worktreeDir: string;
  let nestedDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    __resetQuotaTelemetryForTests();
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-runtime-context-"));
    mockedHomeDir.value = tempDir;
    worktreeDir = join(tempDir, "worktree");
    nestedDir = join(worktreeDir, "packages", "feature");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    process.env = {
      ...originalEnv,
      HOME: tempDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
      APPDATA: join(tempDir, "appdata", "roaming"),
      LOCALAPPDATA: join(tempDir, "appdata", "local"),
    };
    process.chdir(nestedDir);
  });

  afterEach(() => {
    __resetQuotaTelemetryForTests();
    process.chdir(originalCwd);
    process.env = originalEnv;
    mockedHomeDir.value = "";
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createClient(): QuotaRuntimeClient {
    return {
      config: {
        get: vi.fn().mockResolvedValue({ data: {} }),
        providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "copilot" }] } }),
      },
    } as unknown as QuotaRuntimeClient;
  }

  it("keeps workspace-root and config-root selection separate", () => {
    expect(
      resolveRuntimeContextRoots({
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        configRoot: nestedDir,
        fallbackDirectory: nestedDir,
      }),
    ).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: nestedDir,
    });
  });

  it("loads only the canonical GUI config from the global config dir", async () => {
    // Legacy layers exist but are import-only: they must not reach the runtime config.
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    const canonicalPath = writeCanonicalConfig(join(xdgConfigHome, "opencode"), { enabled: false });

    const runtime = await resolveQuotaRuntimeContext({
      client: createClient(),
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
      providers: [],
    });

    expect(runtime.roots).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: worktreeDir,
    });
    expect(runtime.config.enabled).toBe(false);
    expect(runtime.configMeta.source).toBe("files");
    expect(runtime.configMeta.paths).toEqual([canonicalPath]);
    expect(runtime.configMeta.globalConfigPaths).toEqual([canonicalPath]);
    expect(runtime.configMeta.workspaceConfigPaths).toEqual([]);
    expect(runtime.configMeta.settingSources.enabled).toBe(canonicalPath);
  });

  it("uses OPENCODE_CONFIG_DIR as the global config dir and keeps the worktree config root", async () => {
    const customGlobalDir = join(tempDir, "custom-global");
    process.env.OPENCODE_CONFIG_DIR = customGlobalDir;
    mkdirSync(customGlobalDir, { recursive: true });
    writeFileSync(
      join(customGlobalDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    const canonicalPath = writeCanonicalConfig(customGlobalDir, { enabled: false });
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { minIntervalMs: 12_345 } } }),
      "utf8",
    );
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { formatStyle: "allWindows" } } }),
      "utf8",
    );

    const runtime = await resolveQuotaRuntimeContext({
      client: createClient(),
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
      providers: [],
    });

    expect(runtime.roots).toEqual({ workspaceRoot: worktreeDir, configRoot: worktreeDir });
    expect(runtime.config.enabled).toBe(false);
    expect(runtime.config.formatStyle).toBe(DEFAULT_CONFIG.formatStyle);
    expect(runtime.config.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(runtime.configMeta.globalConfigPaths).toEqual([canonicalPath]);
    expect(runtime.configMeta.workspaceConfigPaths).toEqual([]);
  });

  it("propagates provider config but keeps accounting detail out of provider and cache context", () => {
    const configMeta = createLoadConfigMeta();
    configMeta.settingSources.requestTimeoutMs = "test config";

    const client = createClient();
    const providerContext = createQuotaProviderRuntimeContext({
      client,
      resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
      config: {
        ...DEFAULT_CONFIG,
        accountingDetail: "detailed",
        requestTimeoutMs: 12000,
      },
      configMeta,
      session: {},
    });

    expect(providerContext.config?.requestTimeoutMs).toBe(12000);
    expect(providerContext.config).not.toHaveProperty("accountingDetail");
    expect(providerContext.config).not.toHaveProperty("opencodeZenDisplay");
    expect(providerContext.config?.providerCacheTtlMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(providerContext.config?.requestTimeoutMsConfigured).toBe(true);

    const summaryContext = createQuotaProviderRuntimeContext({
      client,
      resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
      config: { ...DEFAULT_CONFIG, accountingDetail: "summary", requestTimeoutMs: 12000 },
      configMeta,
      session: {},
    });
    expect(buildQuotaProviderStateCacheKey("openai", providerContext)).toBe(
      buildQuotaProviderStateCacheKey("openai", summaryContext),
    );
  });

  it("scopes telemetry tokens to enabled normalized provider configuration without I/O", () => {
    const client = createClient();
    const createContext = (enabled: boolean, enabledProviders = DEFAULT_CONFIG.enabledProviders) =>
      createQuotaProviderRuntimeContext({
        client,
        resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
        config: {
          ...DEFAULT_CONFIG,
          enabled,
          enabledProviders,
          telemetry: { enabled: true },
        },
        session: {},
      });

    expect(createContext(false).config.telemetryToken).toBeUndefined();
    const first = createContext(true).config.telemetryToken;
    expect(first).toBeDefined();
    expect(createContext(true).config.telemetryToken).toEqual(first);
    expect(createContext(true, ["openai"]).config.telemetryToken).not.toEqual(first);
    expect(client.config.get).not.toHaveBeenCalled();
    expect(client.config.providers).not.toHaveBeenCalled();
  });

  it("copies default request timeout without marking it explicitly configured", () => {
    const client = createClient();
    const providerContext = createQuotaProviderRuntimeContext({
      client,
      resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
      config: DEFAULT_CONFIG,
      session: {},
    });

    expect(providerContext.config?.requestTimeoutMs).toBe(DEFAULT_CONFIG.requestTimeoutMs);
    expect(providerContext.config?.requestTimeoutMsConfigured).toBe(false);
  });

  it("resolves session meta only when the canonical shared config requests it", async () => {
    writeCanonicalConfig(join(xdgConfigHome, "opencode"), {
      enabled: true,
      onlyCurrentModel: true,
    });

    const resolveSessionMeta = vi.fn().mockResolvedValue({
      providerID: "copilot",
      modelID: "gpt-4.1",
    });

    const runtime = await resolveQuotaRuntimeContext({
      client: createClient(),
      roots: {
        workspaceRoot: worktreeDir,
        configRoot: nestedDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
      sessionID: "session-1",
      resolveSessionMeta,
      includeSessionMeta: (config) => config.onlyCurrentModel,
      providers: [],
    });

    expect(resolveSessionMeta).toHaveBeenCalledWith("session-1");
    expect(runtime.roots).toEqual({
      workspaceRoot: worktreeDir,
      configRoot: nestedDir,
    });
    expect(runtime.session.sessionMeta).toEqual({
      providerID: "copilot",
      modelID: "gpt-4.1",
    });
  });
});
