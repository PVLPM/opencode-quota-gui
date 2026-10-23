import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const { authMocks, mockProviders, runtimeDirs } = vi.hoisted(() => ({
  authMocks: {
    anthropicConfigured: false,
    kimiGlobalState: "none" as "none" | "configured",
    kimiCnState: "none" as "none" | "configured",
  },
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDir: "/tmp/opencode-quota-cli-show-data",
      configDir: "/tmp/opencode-quota-cli-show-config",
      cacheDir: "/tmp/opencode-quota-cli-show-cache",
      stateDir: "/tmp/opencode-quota-cli-show-state",
    },
  },
}));

vi.mock("../src/lib/anthropic.js", () => ({
  hasAnthropicCredentialsConfigured: vi.fn(async () => authMocks.anthropicConfigured),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 30_000,
  resolveKimiGlobalAuthCached: vi.fn(async () => ({ state: authMocks.kimiGlobalState })),
  resolveKimiCnAuthCached: vi.fn(async () => ({ state: authMocks.kimiCnState })),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => runtimeDirs.value,
}));

import { createCliQuotaClient, runCliShowCommand } from "../src/lib/cli-show.js";
import {
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readCredentialRows,
} from "../src/lib/opencode-auth.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { writeCredentialDatabase } from "./helpers/credential-database.js";

function createCaptureStream() {
  let output = "";
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      },
    },
    get output() {
      return output;
    },
  };
}

describe("runCliShowCommand", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    authMocks.anthropicConfigured = false;
    authMocks.kimiGlobalState = "none";
    authMocks.kimiCnState = "none";
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-show-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    runtimeDirs.value = {
      dataDir: "/tmp/opencode-quota-cli-show-data",
      configDir: globalConfigDir,
      cacheDir: join(tempDir, "cache"),
      stateDir: "/tmp/opencode-quota-cli-show-state",
    };
    vi.stubEnv("OPENCODE_DB", join(tempDir, "opencode.db"));
    mockProviders.length = 0;
    __resetQuotaStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    __resetQuotaStateForTests();
    clearReadAuthFileCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeQuotaConfig(quotaToast: Record<string, unknown>): void {
    const dir = join(globalConfigDir, "opencode-quota-gui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.jsonc"), JSON.stringify(quotaToast), "utf8");
  }

  it("synthesizes offline Kimi runtime ids independently by region", async () => {
    writeFileSync(join(workspaceDir, "opencode.json"), "{}", "utf8");

    const unauthenticated = await createCliQuotaClient({
      configRootDir: workspaceDir,
    }).config.providers();
    expect(unauthenticated.data?.providers).toEqual([]);

    authMocks.anthropicConfigured = true;
    authMocks.kimiCnState = "configured";
    const cnOnly = await createCliQuotaClient({
      configRootDir: workspaceDir,
    }).config.providers();
    expect(cnOnly.data?.providers).toEqual([{ id: "anthropic" }, { id: "kimi-code-plan-cn" }]);

    authMocks.kimiGlobalState = "configured";
    const bothRegions = await createCliQuotaClient({
      configRootDir: workspaceDir,
    }).config.providers();
    expect(bothRegions.data?.providers).toEqual([
      { id: "anthropic" },
      { id: "kimi-code-plan-global" },
      { id: "kimi-code-plan-cn" },
    ]);
  });

  it("renders a compact quota glance and returns zero when quota rows are available", async () => {
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic Weekly", percentRemaining: 75 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeQuotaConfig({ enabledProviders: ["synthetic"], showSessionTokens: true });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Synthetic Weekly");
    expect(stdout.output).toContain("75%");
    expect(stderr.output).toBe("");
    expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it("reads logins from OpenCode's database, read-only, only while the command runs", async () => {
    const databasePath = join(tempDir, "opencode.db");
    writeCredentialDatabase(databasePath, [
      {
        id: "cred_synthetic",
        integrationId: "synthetic",
        active: 1,
        updated: 1,
        value: { type: "key", key: "synthetic-key" },
      },
    ]);
    const databaseBefore = readFileSync(databasePath);
    let rowsDuringRun: unknown;
    let sourceDuringRun: unknown;
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(async () => {
        rowsDuringRun = await readCredentialRows(["synthetic"]);
        sourceDuringRun = getCredentialSourceDiagnostics();
        return {
          attempted: true,
          entries: [
            { accounting: TEST_ACCOUNTING, name: "Synthetic Weekly", percentRemaining: 75 },
          ],
          errors: [],
        };
      }),
    };
    mockProviders.push(provider);
    writeQuotaConfig({ enabledProviders: ["synthetic"] });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(rowsDuringRun).toEqual([
      {
        id: "cred_synthetic",
        integrationId: "synthetic",
        label: "default",
        active: true,
        value: { type: "api", key: "synthetic-key" },
      },
    ]);
    expect(sourceDuringRun).toMatchObject({ state: "bound", kind: "sqlite" });
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
    expect(readFileSync(databasePath).equals(databaseBefore)).toBe(true);
  });

  it("normalizes --provider aliases and uses the provider as an invocation override", async () => {
    const copilotProvider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 50 }],
        errors: [],
      }),
    };
    const openAiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({ attempted: true, entries: [], errors: [] }),
    };
    mockProviders.push(openAiProvider, copilotProvider);
    writeQuotaConfig({ enabledProviders: ["openai"] });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider=github-copilot"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(copilotProvider.fetch).toHaveBeenCalledOnce();
    expect(openAiProvider.fetch).not.toHaveBeenCalled();
    expect(stderr.output).toBe("");
  });

  it("rejects an unknown provider before probing providers", async () => {
    const provider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider", "not-a-provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Unknown provider: not-a-provider");
    expect(provider.isAvailable).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing provider values", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Missing value for --provider");
    expect(stderr.output).toContain("opencode-quota-gui show");
  });

  it("returns non-zero when quota is disabled in config", async () => {
    writeQuotaConfig({ enabled: false });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
  });

  it("uses canonical GUI config instead of legacy workspace quotaToast settings", async () => {
    const nestedDir = join(workspaceDir, "packages", "app");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".git"));
    writeQuotaConfig({ enabled: false });
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: nestedDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
  });

  it("reads canonical GUI config even when OPENCODE_CONFIG_DIR is set", async () => {
    const nestedDir = join(workspaceDir, "packages", "app");
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".git"));
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    writeQuotaConfig({ enabled: false });
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { enabled: true } } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: nestedDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Quota disabled in config");
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("uses root-level OpenCode provider ids for standalone provider availability", async () => {
    const provider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn(async (ctx: any) => {
        const response = await ctx.client.config.providers();
        return response.data.providers.some((item: { id: string }) => item.id === "github-copilot");
      }),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 88 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: { "github-copilot": {} } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(stderr.output).toBe("");
  });

  // ──────────────────────────────────────────────
  //  --json / --threshold tests
  // ──────────────────────────────────────────────

  it("--json outputs valid JSON to stdout with cached provider data", async () => {
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      }),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["synthetic"] } },
      }),
      "utf8",
    );

    // Run non-JSON show first to populate the cache.
    const textOut = createCaptureStream();
    const textErr = createCaptureStream();
    const textCode = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: textOut.stream as any,
      stderr: textErr.stream as any,
    });
    expect(textCode).toBe(0);
    expect(provider.fetch).toHaveBeenCalledOnce();

    // Now run --json (reads from cache).
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(0);
    expect(jsonErr.output).toBe("");

    const parsed = JSON.parse(jsonOut.output);
    expect(parsed).toHaveProperty("version", 2);
    expect(parsed).toHaveProperty("exportedAt");
    expect(parsed).toHaveProperty("fromCache", true);
    expect(parsed).toHaveProperty("cacheAgeSeconds");
    expect(parsed.providers).toHaveProperty("synthetic");
    expect(parsed.providers.synthetic.status).toBe("ok");
    expect(parsed.providers.synthetic.entries[0].name).toBe("Synthetic");
    expect(parsed.providers.synthetic.entries[0].percentRemaining).toBe(75);
    expect(parsed.providers.synthetic.entries[0].renderType).toBe("percent");
    expect(parsed.providers.synthetic.entries[0]).not.toHaveProperty("unlimited");
    expect(provider.fetch).toHaveBeenCalledTimes(1); // still only called from text path
  });

  it("reports unknown flag with --json as error on stderr with exit code 1", async () => {
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();

    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--bogus-flag"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(1);
    expect(jsonErr.output).toContain("Unknown option: --bogus-flag");
    expect(jsonErr.output).toContain("opencode-quota-gui show");
  });

  it("--threshold validates input and requires --json", async () => {
    const run = async (argv: string[]) => {
      const stdout = createCaptureStream();
      const stderr = createCaptureStream();
      const code = await runCliShowCommand({
        argv,
        cwd: workspaceDir,
        stdout: stdout.stream as any,
        stderr: stderr.stream as any,
      });
      return { code, stderr: stderr.output };
    };

    // Invalid value
    let result = await run(["--json", "--threshold", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Zero
    result = await run(["--json", "--threshold", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Missing value
    result = await run(["--json", "--threshold"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --threshold");

    // Without --json
    result = await run(["--threshold", "5"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold requires --json");
  });

  it("prints help without an OpenCode requirement or exit code 3", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--help"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(stdout.output).toContain("opencode-quota-gui show");
    expect(stdout.output).not.toContain("OpenCode running");
    expect(stdout.output).not.toMatch(/exit code 3/i);
  });
});
