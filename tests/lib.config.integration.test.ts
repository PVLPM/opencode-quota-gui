import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VALID_QUOTA_PROVIDER_INPUTS, VALID_QUOTA_PROVIDERS } from "./fixtures/quota-providers.js";
import {
  type ConfigLoaderWorkspace,
  createConfigLoaderEnv,
  createConfigLoaderWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

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

vi.mock("../src/lib/opencode-version.js", () => ({
  detectOpenCodeMajor: async () => 2,
}));

import { createGuiSettingsStore } from "../src/gui/config.js";
import { createLoadConfigMeta, loadConfig, loadConfigLayered } from "../src/lib/config.js";
import {
  applyInitInstallerPlan,
  planInitInstaller,
  runInitInstaller,
} from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";
import { getOpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";
import { applyScopedUpdatePlan, planScopedUpdate } from "../src/lib/scoped-update.js";

type InstallerChoices = {
  scope?: "project" | "global";
  providerMode?: "auto" | "manual";
  providers?: string[];
  percentDisplayMode?: "remaining" | "used";
};

function createInstallerPrompts(choices: InstallerChoices = {}) {
  const transcript: string[] = [];
  const prompts = {
    intro: (message: string) => transcript.push(message),
    outro: (message: string) => transcript.push(message),
    select: async ({ message, initialValue }: { message: string; initialValue?: string }) => {
      transcript.push(message);
      if (/Where should/.test(message)) return choices.scope ?? "global";
      if (/providers be selected/.test(message)) return choices.providerMode ?? "auto";
      if (/quota percentages show/.test(message)) return choices.percentDisplayMode ?? "remaining";
      if (/OpenCode version/.test(message)) return "2";
      return initialValue;
    },
    multiselect: async ({ message }: { message: string }) => {
      transcript.push(message);
      return choices.providers ?? [];
    },
    confirm: async ({ message }: { message: string }) => {
      transcript.push(message);
      return true;
    },
    isCancel: () => false,
    log: {
      info: (message: string) => transcript.push(message),
      success: (message: string) => transcript.push(message),
      error: (message: string) => transcript.push(`ERROR: ${message}`),
    },
  };
  return { prompts, transcript };
}

describe("loadConfig integration runtime-path resolution", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  let workspace: ConfigLoaderWorkspace;
  let tempDir: string;
  let workspaceDir: string;
  let nestedDir: string;

  beforeEach(() => {
    workspace = createConfigLoaderWorkspace("opencode-quota-config-integration-", {
      nestedPath: ["packages", "feature"],
    });
    tempDir = workspace.tempDir;
    mockedHomeDir.value = tempDir;
    workspaceDir = workspace.workspaceDir;
    nestedDir = workspace.nestedDir;

    process.env = {
      ...originalEnv,
      ...createConfigLoaderEnv(workspace, { home: tempDir }),
    };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.chdir(nestedDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    mockedHomeDir.value = "";
    workspace.cleanup();
  });

  it("uses real runtime dirs as defaults and explicit cwd config as workspace overrides", async () => {
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir }),
    } as NodeJS.ProcessEnv;
    const { configDir } = getOpencodeRuntimeDirs({ env, homeDir: tempDir });
    mkdirSync(configDir, { recursive: true });
    writeQuotaToastConfig(configDir, {
      enabled: false,
      enabledProviders: ["openai"],
      accountingDetail: "summary",
      showOnIdle: false,
      pricingSnapshot: { source: "bundled", autoRefresh: 30 },
    });

    writeQuotaToastConfig(workspaceDir, {
      enabled: true,
      enabledProviders: ["nano-gpt"],
      accountingDetail: "detailed",
      formatStyle: "allWindows",
      onlyCurrentModel: true,
    });

    writeQuotaToastConfig(nestedDir, {
      enabledProviders: ["chutes"],
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { cwd: workspaceDir });

    expect(cfg.enabled).toBe(true);
    expect(cfg.enabledProviders).toEqual(["nanogpt"]);
    expect(cfg.showOnIdle).toBe(false);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.accountingDetail).toBe("detailed");
    expect(cfg.formatStyle).toBe("allWindows");
    expect(cfg.onlyCurrentModel).toBe(true);

    expect(meta.source).toBe("files");
    expect(meta.paths).toContain(quotaConfigSource(configDir));
    expect(meta.paths).toContain(quotaConfigSource(workspaceDir));
    expect(meta.paths).not.toContain(quotaConfigSource(nestedDir));
    expect(meta.workspaceConfigPaths).toEqual([quotaConfigSource(workspaceDir)]);
    expect(meta.globalConfigPaths).toEqual([quotaConfigSource(configDir)]);
    expect(meta.settingSources.enabled).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources.enabledProviders).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources.accountingDetail).toBe(quotaConfigSource(workspaceDir));
    expect(meta.settingSources["pricingSnapshot.source"]).toBe(quotaConfigSource(configDir));
    expect(meta.settingSources["pricingSnapshot.autoRefresh"]).toBe(quotaConfigSource(configDir));
  });

  it("never reads ~/.config/opencode on macOS when XDG_CONFIG_HOME points elsewhere", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const realConfigDirs = [
        join(tempDir, ".config", "opencode"),
        join(tempDir, "Library", "Application Support", "opencode"),
      ];
      for (const dir of realConfigDirs) {
        writeQuotaSidecarConfig(dir, { enabled: false, minIntervalMs: 12_345 });
        writeQuotaToastConfig(dir, { enabled: false, minIntervalMs: 12_345 });
      }
      expect(workspace.xdgConfigHome).not.toBe(join(tempDir, ".config"));

      const meta = createLoadConfigMeta();
      const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });

      expect(cfg.enabled).toBe(true);
      expect(cfg.minIntervalMs).not.toBe(12_345);
      expect(meta.paths).toEqual([]);
      expect(getOpencodeRuntimeDirs().configDir).toBe(workspace.opencodeConfigDir);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("diagnoses the removed Zen display key in file and legacy sources without translation", async () => {
    writeQuotaSidecarConfig(workspaceDir, {
      opencodeZenDisplay: "detailed",
    });

    const sidecarMeta = createLoadConfigMeta();
    const sidecarConfig = await loadConfigLayered(undefined, sidecarMeta, {
      configRootDir: workspaceDir,
    });
    expect(sidecarConfig.accountingDetail).toBe("summary");
    expect(sidecarMeta.settingSources.accountingDetail).toBeUndefined();
    expect(sidecarMeta.configIssues).toContainEqual({
      path: quotaSidecarConfigSource(workspaceDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });

    writeQuotaToastConfig(nestedDir, {
      accountingDetail: "detailed",
      opencodeZenDisplay: "default",
    });

    const legacyMeta = createLoadConfigMeta();
    const legacyConfig = await loadConfigLayered(undefined, legacyMeta, {
      configRootDir: nestedDir,
    });
    expect(legacyConfig.accountingDetail).toBe("detailed");
    expect(legacyMeta.settingSources.accountingDetail).toBe(quotaConfigSource(nestedDir));
    expect(legacyMeta.configIssues).toContainEqual({
      path: quotaConfigSource(nestedDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });
  });

  it("never edits the upstream accounting-detail sidecar and leaves its diagnosis to the runtime", async () => {
    const upstreamPath = writeQuotaSidecarConfig(workspaceDir, {
      opencodeZenDisplay: "default",
    });
    const original = readFileSync(upstreamPath, "utf8");
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir }),
    } as NodeJS.ProcessEnv;

    const plan = await planScopedUpdate({ cwd: workspaceDir, env, homeDir: tempDir });
    expect(plan.configEdits).toEqual([]);
    expect(plan.safeActions).not.toContainEqual(
      expect.objectContaining({ kind: "accounting-detail-migration" }),
    );
    await applyScopedUpdatePlan(plan);
    expect(readFileSync(upstreamPath, "utf8")).toBe(original);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.accountingDetail).toBe("summary");
    expect(meta.settingSources.accountingDetail).toBeUndefined();
    expect(meta.configIssues).toContainEqual({
      path: quotaSidecarConfigSource(workspaceDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });
    expect(readFileSync(upstreamPath, "utf8")).toContain("opencodeZenDisplay");
  });

  it("leaves unsupported legacy display values to runtime diagnostics without updater edits", async () => {
    const hostPath = writeQuotaToastConfig(workspaceDir, {
      opencodeZenDisplay: "expanded",
    });
    const original = readFileSync(hostPath, "utf8");
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir }),
    } as NodeJS.ProcessEnv;

    const plan = await planScopedUpdate({ cwd: workspaceDir, env, homeDir: tempDir });
    expect(plan.configEdits).toEqual([]);
    expect(plan.manualFindings).not.toContainEqual(
      expect.objectContaining({ kind: "display-migration-manual" }),
    );
    await applyScopedUpdatePlan(plan);
    expect(readFileSync(hostPath, "utf8")).toBe(original);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.accountingDetail).toBe("summary");
    expect(meta.settingSources.accountingDetail).toBeUndefined();
    expect(meta.configIssues).toContainEqual({
      path: quotaConfigSource(workspaceDir),
      key: "opencodeZenDisplay",
      message: 'removed; use root "accountingDetail" ("summary" or "detailed")',
    });
  });

  it("loads the recommended quota-toast.jsonc sidecar with comments", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = join(sidecarDir, "quota-toast.jsonc");
    writeFileSync(
      sidecarPath,
      '{ // recommended commented sidecar\n  "enabled": false,\n  "enabledProviders": ["openai"],\n}\n',
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(meta.workspaceConfigPaths.some((path) => path.includes("quota-toast.jsonc"))).toBe(true);
  });

  it("loads a custom provider from the canonical GUI config that init creates in manual mode", async () => {
    const env = process.env as NodeJS.ProcessEnv;
    const { configDir } = getOpencodeRuntimeDirs({ env, homeDir: tempDir });
    const initPlan = await planInitInstaller({
      env,
      homeDir: tempDir,
      // New installs default to the canonical release tag; this test pins the explicit pack override.
      pluginSpec: "file:./opencode-quota-gui-5.0.0.tgz",
      selections: {
        interfaces: "web",
        scope: "global",
        configFormat: "jsonc",
        quotaUi: ["none"],
        providerMode: "manual",
        manualProviders: ["openai"],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: false,
      },
    });
    await applyInitInstallerPlan(initPlan);

    const guiPath = join(configDir, "opencode-quota-gui", "config.jsonc");
    expect(existsSync(guiPath)).toBe(true);
    const initial = parseJsonOrJsonc(readFileSync(guiPath, "utf8"), true) as Record<
      string,
      unknown
    >;
    expect(initial.enabledProviders).toEqual(["openai"]);

    // The GUI Settings surface owns custom providers; the legacy provider-add helper is
    // no longer part of the installation flow.
    writeFileSync(
      guiPath,
      `${JSON.stringify(
        {
          ...initial,
          enabledProviders: ["openai", "quota-providers"],
          quotaProviders: [
            {
              id: "private-gateway",
              mode: "remote-api",
              url: "https://gateway.example/accounting",
              format: "quota-v1",
              apiKeyEnv: "PRIVATE_GATEWAY_KEY",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });
    expect(cfg.enabledProviders).toEqual(["openai", "quota-providers"]);
    expect(cfg.quotaProviders).toEqual([
      expect.objectContaining({ id: "private-gateway", mode: "remote-api" }),
    ]);
    expect(meta.globalConfigPaths).toContain(guiPath);
  });

  it("installs the canonical GUI JSONC from a global JSON host without importing the dormant sibling JSON", async () => {
    const configDir = workspace.opencodeConfigDir;
    const guiDir = join(configDir, "opencode-quota-gui");
    mkdirSync(guiDir, { recursive: true });
    const siblingRaw = `${JSON.stringify(
      {
        enableToast: true,
        enabledProviders: ["openai"],
        percentDisplayMode: "remaining",
        sentinel: "dormant sibling",
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(guiDir, "config.json"), siblingRaw, "utf8");
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify({ plugins: [] }, null, 2)}\n`,
      "utf8",
    );

    const { prompts } = createInstallerPrompts({
      scope: "global",
      providerMode: "manual",
      providers: ["anthropic"],
      percentDisplayMode: "used",
    });
    expect(
      await runInitInstaller({
        cwd: workspaceDir,
        env: process.env,
        homeDir: tempDir,
        prompts,
        pluginSpec: "opencode-quota-gui@latest",
      }),
    ).toBe(0);

    const canonicalPath = join(guiDir, "config.jsonc");
    expect(existsSync(canonicalPath)).toBe(true);
    expect(readFileSync(join(guiDir, "config.json"), "utf8")).toBe(siblingRaw);
    expect(existsSync(join(configDir, "opencode.jsonc"))).toBe(false);
    expect(existsSync(join(workspaceDir, "opencode-quota-gui"))).toBe(false);
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8")).plugins).toEqual([
      "opencode-quota-gui@latest",
    ]);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { globalConfigDir: configDir });
    expect(cfg.enabledProviders).toEqual(["anthropic"]);
    expect(cfg.percentDisplayMode).toBe("used");
    expect(cfg.enableToast).toBe(false);
    expect(meta.globalConfigPaths).toContain(canonicalPath);

    const snapshot = await createGuiSettingsStore({
      configDir,
      workspaceRoot: workspaceDir,
    }).settings();
    expect(snapshot.pathLabel).toBe(canonicalPath);
    expect(snapshot.values.enabledProviders).toEqual(["anthropic"]);
    expect(snapshot.values.percentDisplayMode).toBe("used");
    expect(snapshot.issues.some((issue) => issue.message.includes("config.json"))).toBe(true);
  });

  it("keeps a project plugin entry while installing dashboard behavior at the global canonical root", async () => {
    const configDir = workspace.opencodeConfigDir;
    const guiDir = join(configDir, "opencode-quota-gui");
    mkdirSync(guiDir, { recursive: true });
    const siblingRaw = `${JSON.stringify({
      enableToast: true,
      enabledProviders: ["openai"],
    })}\n`;
    writeFileSync(join(guiDir, "config.json"), siblingRaw, "utf8");
    const globalHostRaw = `${JSON.stringify({ plugins: ["existing-global-plugin"] }, null, 2)}\n`;
    writeFileSync(join(configDir, "opencode.json"), globalHostRaw, "utf8");
    const upstreamDir = join(workspaceDir, "opencode-quota");
    mkdirSync(upstreamDir, { recursive: true });
    const upstreamRaw = `{
  // upstream sentinel
  "upstreamSentinel": "keep"
}
`;
    writeFileSync(join(upstreamDir, "quota-toast.jsonc"), upstreamRaw, "utf8");

    const { prompts, transcript } = createInstallerPrompts({
      scope: "project",
      providerMode: "manual",
      providers: ["anthropic"],
      percentDisplayMode: "used",
    });
    expect(
      await runInitInstaller({
        cwd: workspaceDir,
        env: process.env,
        homeDir: tempDir,
        prompts,
        pluginSpec: "opencode-quota-gui@latest",
      }),
    ).toBe(0);

    const canonicalPath = join(guiDir, "config.jsonc");
    expect(
      (
        parseJsonOrJsonc(
          readFileSync(join(workspaceDir, "opencode.jsonc"), "utf8"),
          true,
        ) as Record<string, unknown>
      ).plugins,
    ).toEqual(["opencode-quota-gui@latest"]);
    expect(existsSync(join(workspaceDir, "opencode-quota-gui"))).toBe(false);
    expect(existsSync(canonicalPath)).toBe(true);
    expect(readFileSync(join(guiDir, "config.json"), "utf8")).toBe(siblingRaw);
    expect(readFileSync(join(configDir, "opencode.json"), "utf8")).toBe(globalHostRaw);
    expect(readFileSync(join(upstreamDir, "quota-toast.jsonc"), "utf8")).toBe(upstreamRaw);

    const preview = transcript.join("\n");
    expect(preview).toContain(`OpenCode plugin scope: project (${workspaceDir})`);
    expect(preview).toContain(`Dashboard config (global): ${canonicalPath}`);

    const meta = createLoadConfigMeta();
    const cfg = await loadConfig(undefined, meta, { globalConfigDir: configDir });
    expect(cfg.enabledProviders).toEqual(["anthropic"]);
    expect(cfg.percentDisplayMode).toBe("used");
    expect(cfg.enableToast).toBe(false);
    expect(meta.globalConfigPaths).toContain(canonicalPath);

    const snapshot = await createGuiSettingsStore({
      configDir,
      workspaceRoot: workspaceDir,
    }).settings();
    expect(snapshot.pathLabel).toBe(canonicalPath);
    expect(snapshot.values.enabledProviders).toEqual(["anthropic"]);
    expect(snapshot.values.percentDisplayMode).toBe("used");
  });

  it("prefers valid JSONC when both sidecars exist and reports the conflict", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(
      join(sidecarDir, "quota-toast.jsonc"),
      '{ // preferred\n  "enabledProviders": ["openai"],\n}\n',
      "utf8",
    );
    writeFileSync(
      join(sidecarDir, "quota-toast.json"),
      JSON.stringify({ enabledProviders: ["chutes"] }),
      "utf8",
    );

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(meta.settingSources.enabledProviders).toContain("quota-toast.jsonc");
    expect(meta.configIssues).toContainEqual(
      expect.objectContaining({
        key: "$file",
        message: "both quota-toast.jsonc and quota-toast.json exist; using quota-toast.jsonc",
      }),
    );
  });

  it("falls through a malformed sidecar and loads valid host quota config", async () => {
    const sidecarDir = join(workspaceDir, "opencode-quota");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, "quota-toast.jsonc"), '{ "enabledProviders": [', "utf8");
    writeQuotaToastConfig(workspaceDir, {
      enabled: false,
      enabledProviders: ["chutes"],
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta, { configRootDir: workspaceDir });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["chutes"]);
    expect(meta.settingSources.enabledProviders).toBe(quotaConfigSource(workspaceDir));
    expect(meta.configIssues).toContainEqual(
      expect.objectContaining({
        key: "$root",
        message: "expected readable JSON object; this sidecar is not authoritative",
      }),
    );
  });

  it("classifies an OPENCODE_CONFIG_DIR overlap with the canonical global sidecar as global", async () => {
    const overlappingRoot = workspace.opencodeConfigDir;
    process.env.OPENCODE_CONFIG_DIR = overlappingRoot;

    writeQuotaSidecarConfig(overlappingRoot, {
      enabled: false,
      minIntervalMs: 12_345,
      quotaProviders: VALID_QUOTA_PROVIDER_INPUTS,
    });

    const meta = createLoadConfigMeta();
    const cfg = await loadConfigLayered(undefined, meta);

    expect(cfg.enabled).toBe(false);
    expect(cfg.minIntervalMs).toBe(12_345);
    expect(cfg.quotaProviders).toEqual(VALID_QUOTA_PROVIDERS);
    expect(meta.globalConfigPaths).toEqual([quotaSidecarConfigSource(overlappingRoot)]);
    expect(meta.workspaceConfigPaths).toEqual([]);
    expect(meta.paths).toEqual(meta.globalConfigPaths);
    expect(meta.settingSources.enabled).toBe(quotaSidecarConfigSource(overlappingRoot));
    expect(meta.settingSources.minIntervalMs).toBe(quotaSidecarConfigSource(overlappingRoot));
    expect(meta.settingSources.quotaProviders).toBe(quotaSidecarConfigSource(overlappingRoot));
  });

  it("uses the provided configRootDir to pick the workspace override layer over shared global defaults", async () => {
    const env = {
      ...process.env,
      ...createConfigLoaderEnv(workspace, { home: tempDir }),
    } as NodeJS.ProcessEnv;
    const { configDir } = getOpencodeRuntimeDirs({ env, homeDir: tempDir });
    mkdirSync(configDir, { recursive: true });
    writeQuotaToastConfig(configDir, {
      enabled: false,
      enabledProviders: ["openai"],
      minIntervalMs: 30_000,
    });

    writeQuotaToastConfig(workspaceDir, {
      enabled: true,
      enabledProviders: ["nano-gpt"],
      minIntervalMs: 1_000,
      formatStyle: "allWindows",
      onlyCurrentModel: true,
    });

    writeQuotaToastConfig(nestedDir, {
      enabled: true,
      enabledProviders: ["chutes"],
      minIntervalMs: 2_000,
      formatStyle: "singleWindow",
      onlyCurrentModel: false,
    });

    const workspaceMeta = createLoadConfigMeta();
    const workspaceCfg = await loadConfigLayered(undefined, workspaceMeta, {
      configRootDir: workspaceDir,
    });

    const nestedMeta = createLoadConfigMeta();
    const nestedCfg = await loadConfigLayered(undefined, nestedMeta, { configRootDir: nestedDir });

    expect(workspaceCfg.enabled).toBe(true);
    expect(nestedCfg.enabled).toBe(true);
    expect(workspaceCfg.enabledProviders).toEqual(["nanogpt"]);
    expect(nestedCfg.enabledProviders).toEqual(["chutes"]);
    expect(workspaceCfg.minIntervalMs).toBe(1_000);
    expect(nestedCfg.minIntervalMs).toBe(2_000);

    expect(workspaceCfg.formatStyle).toBe("allWindows");
    expect(nestedCfg.formatStyle).toBe("singleWindow");
    expect(workspaceCfg.onlyCurrentModel).toBe(true);
    expect(nestedCfg.onlyCurrentModel).toBe(false);

    expect(workspaceMeta.workspaceConfigPaths).toEqual([quotaConfigSource(workspaceDir)]);
    expect(nestedMeta.workspaceConfigPaths).toEqual([quotaConfigSource(nestedDir)]);
    expect(workspaceMeta.globalConfigPaths).toEqual([quotaConfigSource(configDir)]);
    expect(nestedMeta.globalConfigPaths).toEqual([quotaConfigSource(configDir)]);
    expect(workspaceMeta.settingSources.enabled).toBe(quotaConfigSource(workspaceDir));
    expect(nestedMeta.settingSources.enabled).toBe(quotaConfigSource(nestedDir));
    expect(workspaceMeta.settingSources.minIntervalMs).toBe(quotaConfigSource(workspaceDir));
    expect(nestedMeta.settingSources.minIntervalMs).toBe(quotaConfigSource(nestedDir));
  });
});
