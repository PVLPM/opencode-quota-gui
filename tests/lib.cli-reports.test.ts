import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const { mockProviders, runtimeDirs, statusData } = vi.hoisted(() => ({
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDir: "/tmp/opencode-quota-cli-reports-data",
      configDir: "/tmp/opencode-quota-cli-reports-config",
      cacheDir: "/tmp/opencode-quota-cli-reports-cache",
      stateDir: "/tmp/opencode-quota-cli-reports-state",
    },
  },
  statusData: {
    value: null as null | {
      output: string;
      payload: Record<string, unknown>;
      hasComparableProviderData?: boolean;
    },
  },
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => runtimeDirs.value,
}));

vi.mock("../src/lib/quota-dialog-commands.js", () => ({
  buildStatusReportData: vi.fn(async () => {
    if (!statusData.value) {
      return { output: null, payload: null };
    }
    return {
      output: statusData.value.output,
      payload: statusData.value.payload,
      hasComparableProviderData: statusData.value.hasComparableProviderData ?? true,
    };
  }),
}));

import { buildCliShowJson, buildCliShowText, buildCliStatus } from "../src/lib/cli-reports.js";
import { resolveOpenCodeLocationRoots } from "../src/lib/config-file-utils.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";
import { resolveQuotaRuntimeContext } from "../src/lib/quota-runtime-context.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    version: "3.11.2",
    generatedAt: "2026-07-16T00:00:00.000Z",
    config: {
      configSource: "workspace",
      configPaths: ["/tmp/opencode.json"],
      enabledProviders: ["synthetic"],
      onlyCurrentModel: false,
      pricingSnapshotSource: "auto",
    },
    providers: [
      { id: "synthetic", enabled: true, available: true, matchesCurrentModel: undefined },
    ],
    pricing: {
      selection: "auto",
      activeSource: "bundled",
      snapshot: {
        source: "bundled",
        generatedAt: "2026-01-01T00:00:00.000Z",
        units: "USD per 1M tokens",
      },
      snapshotPath: "/tmp/pricing.json",
      refreshStatePath: "/tmp/pricing-state.json",
    },
    liveProbes: [{ id: "synthetic", ok: true }],
    ...overrides,
  };
}

function useStatusData(
  payload = basePayload(),
  hasComparableProviderData?: boolean,
  output = "report text",
): void {
  statusData.value = { output, payload, hasComparableProviderData };
}

describe("CLI reports", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  // A minimal configuration client: the given provider ids, no SDK config. GUI settings
  // come from the canonical global config in runtimeDirs.configDir.
  async function runtimeFor(providerIds: string[] = []) {
    return resolveQuotaRuntimeContext({
      client: {
        config: {
          get: async () => ({ data: {} }),
          providers: async () => ({ data: { providers: providerIds.map((id) => ({ id })) } }),
        },
      },
      roots: resolveOpenCodeLocationRoots(workspaceDir),
      includeSessionMeta: false,
    });
  }

  function writeQuotaConfig(quotaToast: Record<string, unknown>): void {
    const dir = join(globalConfigDir, "opencode-quota-gui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.jsonc"), JSON.stringify(quotaToast), "utf8");
  }

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-reports-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    runtimeDirs.value = {
      dataDir: "/tmp/opencode-quota-cli-reports-data",
      configDir: globalConfigDir,
      cacheDir: join(tempDir, "cache"),
      stateDir: "/tmp/opencode-quota-cli-reports-state",
    };
    mockProviders.length = 0;
    statusData.value = null;
    vi.mocked(buildStatusReportData).mockClear();
    __resetQuotaStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    statusData.value = null;
    __resetQuotaStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildCliShowText", () => {
    it("renders a compact quota glance and returns zero when quota rows are available", async () => {
      const provider = {
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            { accounting: TEST_ACCOUNTING, name: "Synthetic Weekly", percentRemaining: 75 },
          ],
          errors: [],
        }),
      };
      mockProviders.push(provider);
      writeQuotaConfig({ enabledProviders: ["synthetic"], showSessionTokens: true });

      const report = await buildCliShowText({ runtime: await runtimeFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Synthetic Weekly");
      expect(report.stdout).toContain("75%");
      expect(report.stdout.endsWith("\n")).toBe(true);
      expect(report.stderr).toBe("");
      expect(provider.fetch).toHaveBeenCalledOnce();
    });

    it("adds a Quota mode heading for bare CLI labels and spaces reset units by default", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
      mockProviders.push({
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Synthetic Weekly",
              percentRemaining: 81,
              resetTimeIso: "2026-01-17T15:14:00.000Z",
            },
          ],
          errors: [],
        }),
      });
      writeQuotaConfig({
        enabledProviders: ["synthetic"],
        percentDisplayMode: "used",
        percentLabelStyle: "bare",
      });

      const report = await buildCliShowText({ runtime: await runtimeFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stdout.startsWith("Quota [Used]\n\n")).toBe(true);
      expect(report.stdout).toContain("19%");
      expect(report.stdout).not.toContain("19% used");
      expect(report.stdout).toContain("2d 5h 14m");
      expect(report.stderr).toBe("");
    });

    it("renders default-off runway in human-readable CLI output only when configured", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T10:00:00.000Z"));
      mockProviders.push({
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: {
                ...TEST_ACCOUNTING,
                observedAtIso: "2026-09-09T10:00:00.000Z",
              },
              name: "Synthetic Fixed Window",
              percentRemaining: 55,
              resetTimeIso: "2026-09-09T14:00:00.000Z",
              fixedWindow: {
                kind: "fixed_window",
                startedAtIso: "2026-09-09T09:20:00.000Z",
                observedAtIso: "2026-09-09T10:00:00.000Z",
                endsAtIso: "2026-09-09T14:00:00.000Z",
                fullReset: true,
              },
            },
          ],
          errors: [],
        }),
      });

      const run = async (quotaProjection?: "runway") => {
        writeQuotaConfig({
          enabledProviders: ["synthetic"],
          ...(quotaProjection ? { quotaProjection } : {}),
        });
        __resetQuotaStateForTests();
        const report = await buildCliShowText({ runtime: await runtimeFor() });
        expect(report.exitCode).toBe(0);
        expect(report.stderr).toBe("");
        return report.stdout;
      };

      expect(await run()).not.toContain("Runs out");
      expect(await run("runway")).toContain("Runs out  ≈ 49m");
    });

    it("uses the provider as an invocation override", async () => {
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

      const report = await buildCliShowText({ runtime: await runtimeFor(), providerId: "copilot" });

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(copilotProvider.fetch).toHaveBeenCalledOnce();
      expect(openAiProvider.fetch).not.toHaveBeenCalled();
      expect(report.stderr).toBe("");
    });

    it("returns non-zero when quota is disabled in config", async () => {
      writeQuotaConfig({ enabled: false });

      await expect(buildCliShowText({ runtime: await runtimeFor() })).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Quota disabled in config (enabled: false).\n",
      });
    });

    it("renders explicit unavailable provider output but returns non-zero", async () => {
      const provider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(false),
        fetch: vi.fn(),
      };
      mockProviders.push(provider);

      const report = await buildCliShowText({ runtime: await runtimeFor(), providerId: "copilot" });

      expect(report.exitCode).toBe(1);
      expect(report.stdout).toContain("Copilot: Unavailable (not detected)");
      expect(report.stderr).toBe("");
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("renders Copilot and Gemini CLI success rows", async () => {
      const copilotProvider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Copilot",
              group: "Copilot (personal)",
              label: "Quota:",
              right: "0/300",
              percentRemaining: 100,
            },
          ],
          errors: [],
        }),
      };
      const geminiCliProvider = {
        id: "google-gemini-cli",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Gemini Pro",
              group: "Gemini CLI",
              label: "Gemini Pro:",
              right: "840 left",
              percentRemaining: 84,
            },
          ],
          errors: [],
        }),
      };
      mockProviders.push(copilotProvider, geminiCliProvider);
      writeQuotaConfig({
        enabledProviders: ["copilot", "google-gemini-cli"],
        formatStyle: "allWindows",
      });

      const report = await buildCliShowText({ runtime: await runtimeFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(report.stdout).toContain("Gemini CLI");
      expect(copilotProvider.fetch).toHaveBeenCalledOnce();
      expect(geminiCliProvider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });

    it("uses OpenCode's provider ids for provider availability", async () => {
      const provider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn(async (ctx: any) => {
          const response = await ctx.client.config.providers();
          return response.data.providers.some(
            (item: { id: string }) => item.id === "github-copilot",
          );
        }),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 88 }],
          errors: [],
        }),
      };
      mockProviders.push(provider);

      const report = await buildCliShowText({ runtime: await runtimeFor(["github-copilot"]) });

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(provider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });
  });

  describe("buildCliShowJson", () => {
    function syntheticProvider(entries: unknown[], errors: unknown[] = []) {
      return {
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({ attempted: true, entries, errors }),
      };
    }

    it("outputs valid JSON with cached provider data", async () => {
      const provider = syntheticProvider([
        { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 },
      ]);
      mockProviders.push(provider);
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      // The text report populates the cache.
      expect((await buildCliShowText({ runtime: await runtimeFor() })).exitCode).toBe(0);
      expect(provider.fetch).toHaveBeenCalledOnce();

      const report = await buildCliShowJson({ runtime: await runtimeFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(report.stdout);
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
      expect(provider.fetch).toHaveBeenCalledTimes(1); // still only called from the text report
    });

    it("reads from cache only and returns unavailable when no cache exists", async () => {
      const provider = syntheticProvider([
        { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 100 },
      ]);
      mockProviders.push(provider);
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      const report = await buildCliShowJson({ runtime: await runtimeFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(JSON.parse(report.stdout).providers.synthetic.status).toBe("unavailable");
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("returns non-zero when quota is disabled in config", async () => {
      writeQuotaConfig({ enabled: false });

      await expect(buildCliShowJson({ runtime: await runtimeFor() })).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Quota disabled in config (enabled: false).\n",
      });
    });

    it.each([
      [80, 50, 0],
      [30, 50, 1],
    ])("--threshold uses percentage rows even when the first row is a quantity: %s vs %s", async (percentRemaining, threshold, expectedCode) => {
      mockProviders.push(
        syntheticProvider([
          {
            kind: "quantity",
            accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
            semantic: {
              metric: { kind: "component", component: "current_balance" },
              prominence: "primary",
            },
            name: "Synthetic balance",
            quantity: { decimal: "5", unit: { kind: "currency", code: "USD" } },
          },
          { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining },
        ]),
      );
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      await buildCliShowText({ runtime: await runtimeFor() });
      const report = await buildCliShowJson({ runtime: await runtimeFor(), threshold });

      expect(report.exitCode).toBe(expectedCode);
    });

    it("--threshold exits 2 when no provider is ok", async () => {
      mockProviders.push(
        syntheticProvider([
          { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 100 },
        ]),
      );
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      const report = await buildCliShowJson({ runtime: await runtimeFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 when cached ok providers have no percentRemaining values", async () => {
      mockProviders.push(
        syntheticProvider([
          {
            accounting: TEST_ACCOUNTING,
            name: "Synthetic",
            kind: "value",
            value: "$42",
            label: "Usage:",
          },
        ]),
      );
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      await buildCliShowText({ runtime: await runtimeFor() });
      const report = await buildCliShowJson({ runtime: await runtimeFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 for partial cached results instead of passing incomplete data", async () => {
      mockProviders.push(
        syntheticProvider(
          [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 80 }],
          [{ label: "Synthetic secondary", message: "quota endpoint unavailable" }],
        ),
      );
      writeQuotaConfig({ enabledProviders: ["synthetic"] });

      await buildCliShowText({ runtime: await runtimeFor() });
      const report = await buildCliShowJson({ runtime: await runtimeFor(), threshold: 50 });

      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stdout).providers.synthetic).toMatchObject({
        status: "partial",
        entries: [expect.objectContaining({ percentRemaining: 80 })],
        errors: [{ label: "Synthetic secondary", message: "quota endpoint unavailable" }],
      });
    });

    it("--provider copilot only includes the copilot key", async () => {
      const copilotProvider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 90 }],
          errors: [],
        }),
      };
      mockProviders.push(
        copilotProvider,
        syntheticProvider([
          { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 50 },
        ]),
      );
      writeQuotaConfig({ enabledProviders: ["copilot", "synthetic"] });

      await buildCliShowText({ runtime: await runtimeFor() });
      const report = await buildCliShowJson({ runtime: await runtimeFor(), providerId: "copilot" });

      expect(report.exitCode).toBe(0);
      const parsed = JSON.parse(report.stdout);
      expect(Object.keys(parsed.providers)).toEqual(["copilot"]);
      expect(parsed.providers.copilot.status).toBe("ok");
    });
  });

  describe("buildCliStatus", () => {
    it("prints a plain-text Quota Status report and returns zero", async () => {
      useStatusData(
        basePayload(),
        undefined,
        "Quota Status (opencode-quota v3.11.2)\ntoast:\n- enabledProviders: synthetic",
      );

      const report = await buildCliStatus({ runtime: await runtimeFor(), json: false });

      expect(report).toEqual({
        exitCode: 0,
        stdout: "Quota Status (opencode-quota v3.11.2)\ntoast:\n- enabledProviders: synthetic\n",
        stderr: "",
      });
      expect(buildStatusReportData).toHaveBeenCalledWith(
        expect.objectContaining({ providerFilterId: undefined }),
      );
    });

    it("emits a structured JSON payload and returns zero when live probes exist", async () => {
      useStatusData();

      const report = await buildCliStatus({ runtime: await runtimeFor(), json: true });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      const parsed = JSON.parse(report.stdout);
      expect(parsed).toHaveProperty("version", "3.11.2");
      expect(parsed).toHaveProperty("generatedAt");
      expect(parsed).toHaveProperty("config");
      expect(parsed).toHaveProperty("providers");
      expect(parsed).toHaveProperty("pricing");
      expect(parsed).toHaveProperty("liveProbes");
      expect(parsed.liveProbes).toEqual([{ id: "synthetic", ok: true }]);
    });

    it("exits 2 with JSON when there is no comparable provider data", async () => {
      useStatusData(basePayload({ liveProbes: [] }), false);

      const report = await buildCliStatus({ runtime: await runtimeFor(), json: true });

      expect(report.exitCode).toBe(2);
      expect(report.stderr).toBe("");
      // JSON still prints on exit 2.
      expect(JSON.parse(report.stdout).liveProbes).toEqual([]);
    });

    it("exits 2 with JSON when probes fail without producing quota entries", async () => {
      useStatusData(basePayload({ liveProbes: [{ id: "synthetic", ok: false }] }), false);

      const report = await buildCliStatus({ runtime: await runtimeFor(), json: true });

      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stdout).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
    });

    it("succeeds with JSON when a partial probe produced quota entries", async () => {
      useStatusData(basePayload({ liveProbes: [{ id: "synthetic", ok: false }] }), true);

      const report = await buildCliStatus({ runtime: await runtimeFor(), json: true });

      expect(report.exitCode).toBe(0);
    });

    it("forwards the provider filter and still emits JSON", async () => {
      useStatusData();

      const report = await buildCliStatus({
        runtime: await runtimeFor(),
        providerId: "synthetic",
        json: true,
      });

      expect(report.exitCode).toBe(0);
      expect(buildStatusReportData).toHaveBeenCalledWith(
        expect.objectContaining({ providerFilterId: "synthetic" }),
      );
      const parsed = JSON.parse(report.stdout);
      expect(parsed.providers).toHaveLength(1);
      expect(parsed).not.toHaveProperty("providerFilterId");
    });

    it("returns non-zero when quota is disabled in config", async () => {
      writeQuotaConfig({ enabled: false });

      await expect(buildCliStatus({ runtime: await runtimeFor(), json: false })).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Quota disabled in config (enabled: false).\n",
      });
      expect(buildStatusReportData).not.toHaveBeenCalled();
    });
  });
});
