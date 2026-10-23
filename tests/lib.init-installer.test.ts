import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInitInstallerPlan,
  getQuotaPluginSpecForVersion,
  type InitInstallerSelections,
  planInitInstaller,
  QUOTA_PLUGIN_SPEC_ENV,
  runInitInstaller,
} from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";
import { QUOTA_PROVIDER_SHAPES } from "../src/lib/provider-metadata.js";
import { symlinkOrSkip } from "./helpers/symlink-capability.js";

// New installs default to the canonical opencode-quota-gui release tag; these tests pin the
// explicit local pack override.
const EXPLICIT_PACK_SPEC = "file:./opencode-quota-gui-5.0.0.tgz";

const openCodeMajor = vi.hoisted(() => ({ value: 2 as 1 | 2 | undefined }));
vi.mock("../src/lib/opencode-version.js", () => ({
  detectOpenCodeMajor: async () => openCodeMajor.value,
}));

function readJson(path: string): any {
  const resolvedPath = !existsSync(path) && path.endsWith(".json") ? `${path}c` : path;
  const content = readFileSync(resolvedPath, "utf8");
  return parseJsonOrJsonc(content, resolvedPath.endsWith(".jsonc"));
}

function installerSelections(
  overrides: Partial<InitInstallerSelections> = {},
): InitInstallerSelections {
  return {
    interfaces: "tui",
    scope: "project",
    quotaUi: ["toast"],
    providerMode: "auto",
    manualProviders: [],
    formatStyle: "singleWindow",
    percentDisplayMode: "remaining",
    showSessionTokens: true,
    ...overrides,
  };
}

const DEFAULT_PROMPT_SELECT_VALUES = ["project", "auto", "remaining"] as const;

function createPromptStub(params: {
  selectValues?: unknown[];
  multiselectValues?: unknown[];
  confirmValues?: unknown[];
}) {
  const selectValues = [...(params.selectValues ?? [])];
  const multiselectValues = [...(params.multiselectValues ?? [])];
  const confirmValues = [...(params.confirmValues ?? [])];
  const selectCalls: { message: string; options: unknown[] }[] = [];
  const multiselectCalls: { message: string; required?: boolean; options: unknown[] }[] = [];
  const outroCalls: string[] = [];
  const infoCalls: string[] = [];
  const errorCalls: string[] = [];
  const confirmCalls: { message: string; initialValue?: boolean }[] = [];

  return {
    intro: () => {},
    outro: (message: string) => {
      outroCalls.push(message);
    },
    select: async (options: { message: string; options: unknown[] }) => {
      selectCalls.push(options);
      return selectValues.shift();
    },
    multiselect: async (options: { message: string; required?: boolean; options: unknown[] }) => {
      multiselectCalls.push(options);
      return multiselectValues.shift();
    },
    confirm: async (options: { message: string; initialValue?: boolean }) => {
      confirmCalls.push(options);
      return confirmValues.shift();
    },
    isCancel: (value: unknown) => value === Symbol.for("cancel"),
    log: {
      info: (message: string) => {
        infoCalls.push(message);
      },
      success: () => {},
      error: (message: string) => {
        errorCalls.push(message);
      },
    },
    selectCalls,
    multiselectCalls,
    outroCalls,
    infoCalls,
    errorCalls,
    confirmCalls,
  };
}

describe("init installer planning and merge behavior", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let globalGuiDir: string;
  let savedConfigDir: string | undefined;

  function planSelections(overrides: Partial<InitInstallerSelections> = {}, cwd = tempDir) {
    return planInitInstaller({ cwd, selections: installerSelections(overrides) });
  }

  async function expectSelectionError(
    overrides: Partial<InitInstallerSelections>,
    error: string | RegExp,
  ): Promise<void> {
    await expect(planSelections(overrides)).rejects.toThrow(error);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-init-"));
    globalConfigDir = join(tempDir, "global-config");
    globalGuiDir = join(globalConfigDir, "opencode-quota-gui");
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = globalConfigDir;
    process.env[QUOTA_PLUGIN_SPEC_ENV] = EXPLICIT_PACK_SPEC;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env[QUOTA_PLUGIN_SPEC_ENV];
    openCodeMajor.value = 2;
  });

  it("stops on OpenCode 1 before prompting or writing anything", async () => {
    openCodeMajor.value = 1;
    const prompts = createPromptStub({ selectValues: DEFAULT_PROMPT_SELECT_VALUES });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(1);
    expect(prompts.selectCalls).toEqual([]);
    expect(prompts.errorCalls).toEqual([
      "You're on OpenCode 1. OpenCode Quota 5 needs OpenCode 2.",
    ]);
    expect(prompts.outroCalls).toEqual([
      "OpenCode Quota GUI requires OpenCode 2 — no files changed.",
    ]);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("asks which OpenCode is used when the version is unknown and stops on OpenCode 1", async () => {
    openCodeMajor.value = undefined;
    const prompts = createPromptStub({ selectValues: ["1", ...DEFAULT_PROMPT_SELECT_VALUES] });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(1);
    expect(prompts.selectCalls).toHaveLength(1);
    expect(prompts.selectCalls[0]).toMatchObject({
      message: "Could not detect your OpenCode version. Which OpenCode do you use?",
      initialValue: "2",
    });
    expect(prompts.outroCalls).toEqual([
      "OpenCode Quota GUI requires OpenCode 2 — no files changed.",
    ]);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("continues setup when an unknown OpenCode version is answered as OpenCode 2", async () => {
    openCodeMajor.value = undefined;
    const prompts = createPromptStub({
      selectValues: ["2", ...DEFAULT_PROMPT_SELECT_VALUES],
      multiselectValues: [["toast"]],
      confirmValues: [true, true],
    });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(0);
    expect(readJson(join(tempDir, "opencode.jsonc")).plugins).toEqual([EXPLICIT_PACK_SPEC]);
  });

  it("creates recommended project opencode.jsonc at the worktree root for toast mode", async () => {
    const projectDir = join(tempDir, "project");
    const nestedDir = join(projectDir, "packages", "feature");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: nestedDir,
      selections: installerSelections({
        providerMode: "manual",
        manualProviders: ["openai", "anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
        sessionTokenScope: "tree",
      }),
    });

    expect(plan.baseDir).toBe(projectDir);
    expect(plan.summaryLines).toContain("Session token scope: Current session and descendants");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);
    expect(plan.quickSetupNotes).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        anchor: "anthropic-claude",
      },
    ]);
    expect(plan.summaryLines).toContain("  - Anthropic: docs/readme/providers.md#anthropic-claude");

    const result = await applyInitInstallerPlan(plan);
    expect(result.writtenPaths).toEqual([
      join(projectDir, "opencode.jsonc"),
      join(globalGuiDir, "config.jsonc"),
    ]);
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);

    const config = readJson(join(projectDir, "opencode.jsonc"));
    expect(config).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      plugins: [EXPLICIT_PACK_SPEC],
    });
    expect(config.experimental).toBeUndefined();

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai", "anthropic"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
      sessionTokenScope: "tree",
      tuiCommandDisplay: "dialog",
    });
    expect(quotaConfig).not.toHaveProperty("tuiQuotaCommandDisplay");
    expect(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).toContain(
      "// OpenCode Quota: tuiCommandDisplay chooses whether native TUI command output appears in the session transcript or a local popup dialog.",
    );
  });

  it("keeps the host JSON strict while the dashboard config stays canonical JSONC", async () => {
    const projectDir = join(tempDir, "strict-json");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({ configFormat: "json" }),
    });
    await applyInitInstallerPlan(plan);

    const path = join(projectDir, "opencode.json");
    const raw = readFileSync(path, "utf8");
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toMatch(/^\s*\/\//m);
    const quotaRaw = readFileSync(join(globalGuiDir, "config.jsonc"), "utf8");
    expect(parseJsonOrJsonc(quotaRaw, true).tuiCommandDisplay).toBe("dialog");
    expect(parseJsonOrJsonc(quotaRaw, true).sessionTokenScope).toBe("current");
    expect(plan.summaryLines).toContain("Session token scope: Current session");
    expect(quotaRaw).toContain("// Provider selection:");
    expect(existsSync(join(globalGuiDir, "config.json"))).toBe(false);
  });

  it("writes Inline selection and explanatory comments only to generated JSONC host configs", async () => {
    const projectDir = join(tempDir, "inline-jsonc");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        configFormat: "jsonc",
        quotaUi: ["sidebar"],
        tuiCommandDisplay: "inline",
      }),
    });
    await applyInitInstallerPlan(plan);

    const quotaPath = join(globalGuiDir, "config.jsonc");
    expect(readJson(quotaPath).tuiCommandDisplay).toBe("inline");
    const quotaRaw = readFileSync(quotaPath, "utf8");
    expect(quotaRaw).toContain("// Quota presentation and reset-period choices.");
    expect(quotaRaw).toContain(
      "// Automatic quota surfaces. Dashboard settings remain separate when these are disabled.",
    );
    expect(quotaRaw).not.toContain("Slash commands remain");

    const hostRaw = readFileSync(join(projectDir, "opencode.jsonc"), "utf8");
    expect(hostRaw).toContain(
      "// OpenCode Quota: tuiCommandDisplay chooses whether native TUI command output appears in the session transcript or a local popup dialog.",
    );
    expect(() => parseJsonOrJsonc(hostRaw, true)).not.toThrow();
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
  });

  it("never writes upstream experimental.quotaToast and preserves legacy settings", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const legacySettings = {
      toastStyle: "grouped",
      enableToast: true,
      enabledProviders: ["openai"],
      formatStyle: "allWindows",
    };
    writeFileSync(
      join(projectDir, "opencode.jsonc"),
      `${JSON.stringify({ experimental: { quotaToast: legacySettings } }, null, 2)}\n`,
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        providerMode: "manual",
        manualProviders: ["openai"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
      }),
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedKeys).not.toEqual(
      expect.arrayContaining([expect.stringContaining("experimental.quotaToast")]),
    );

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.experimental.quotaToast).toEqual(legacySettings);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
    });
    expect(quotaConfig).not.toHaveProperty("toastStyle");
  });

  it("preserves unrelated values and legacy upstream settings while adding GUI config", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.jsonc"),
      `{
        // preserve existing user values
        "$schema": "https://custom.local/config.json",
        "plugin": [
          "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js"
        ],
        "experimental": {
          "quotaToast": {
            "toastStyle": "grouped",
            "enableToast": true,
            "showSessionTokens": true,
            "enabledProviders": ["openai"]
          }
        },
        "other": {
          "keep": true
        },
      }`,
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["cursor", "opencode-go"],
        showSessionTokens: false,
      }),
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.warnings).toEqual([]);
    expect(opencodeEdit?.addedPlugins).toEqual([`plugins: ${EXPLICIT_PACK_SPEC}`]);
    expect(opencodeEdit?.addedKeys).toEqual([]);
    expect(opencodeEdit?.skippedValues).toEqual([]);
    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).toEqual(
      expect.arrayContaining([
        "opencode-quota-gui/config.jsonc",
        "quotaToast.formatStyle",
        "quotaToast.percentDisplayMode",
      ]),
    );

    await applyInitInstallerPlan(plan);

    const opencodeRaw = readFileSync(join(projectDir, "opencode.jsonc"), "utf8");
    expect(opencodeRaw).toContain("// preserve existing user values");
    expect(opencodeRaw).toMatch(/"other":\s*\{[\s\S]*"keep": true[\s\S]*\},/);
    expect(opencodeRaw.match(/OpenCode Quota GUI: loads the server plugin/g)).toHaveLength(1);
    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.other).toEqual({ keep: true });
    expect(opencode.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js",
    ]);
    expect(opencode.plugins).toEqual([EXPLICIT_PACK_SPEC]);
    expect(opencode.experimental.quotaToast).toEqual({
      toastStyle: "grouped",
      enableToast: true,
      showSessionTokens: true,
      enabledProviders: ["openai"],
    });
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig).toMatchObject({
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      enableToast: false,
      showSessionTokens: false,
      enabledProviders: ["cursor", "opencode-go"],
    });
    expect(quotaConfig).not.toHaveProperty("toastStyle");
  });

  it("adds the server plugin when opencode config only references the tui entrypoint", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugin: ["file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.js"],
      }),
      "utf8",
    );

    const plan = await planSelections({}, projectDir);

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual([`plugins: ${EXPLICIT_PACK_SPEC}`]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.js",
    ]);
    expect(opencode.plugins).toEqual([EXPLICIT_PACK_SPEC]);
  });

  it("adds the GUI plugin while preserving an upstream plugin entry", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugins: [{ package: "@slkiser/opencode-quota@latest", options: { keep: true } }],
      }),
      "utf8",
    );

    const plan = await planSelections({}, projectDir);

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual([`plugins: ${EXPLICIT_PACK_SPEC}`]);
    expect(opencodeEdit?.valueChanges).toEqual([]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toBeUndefined();
    expect(opencode.plugins).toEqual([
      { package: "@slkiser/opencode-quota@latest", options: { keep: true } },
      EXPLICIT_PACK_SPEC,
    ]);
  });

  it("leaves an existing tui.json untouched and writes sidebar disabled when sidebar is not selected", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: ["@slkiser/opencode-quota"],
      }),
      "utf8",
    );

    const plan = await planSelections({}, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(readFileSync(join(projectDir, "tui.json"), "utf8")).toBe(
      JSON.stringify({ plugin: ["@slkiser/opencode-quota"] }),
    );
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("creates only opencode and quota configs for sidebar mode", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));

    expect(opencode.plugins).toEqual([EXPLICIT_PACK_SPEC]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig).toMatchObject({
      enableToast: false,
      enabledProviders: "auto",
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      showSessionTokens: true,
      tuiSidebarPanel: { enabled: true },
    });
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
  });

  it("leaves compact TUI status alone when not selected for fresh sidebar installs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toBeUndefined();
  });

  it("writes compact TUI config when compact status is selected", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({ quotaUi: ["sidebar", "compact_status"] }),
    });

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
    });
  });

  it("keeps compact-only selection independent from sidebar", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["compact_status"] }, projectDir);

    expect(plan.selections.quotaUi).toEqual(["compact_status"]);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
    });
  });

  it("updates existing sidebar enabled value for compact-only selection", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(
      join(globalGuiDir, "config.jsonc"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: true,
        },
      }),
      "utf8",
    );

    const plan = await planSelections({ quotaUi: ["compact_status"] }, projectDir);

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.tuiSidebarPanel.enabled");
    expect(quotaEdit?.skippedValues).not.toContain(
      "quotaToast.tuiSidebarPanel.enabled preserved existing value",
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toMatchObject({ enabled: true });
  });

  it("writes maintainer announcements disabled without installing TUI solely for announcements", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: false,
      }),
    });

    expect(plan.summaryLines).toContain("Maintainer announcements: Disabled");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: false });
  });

  it("writes maintainer announcements enabled without installing TUI solely for announcements", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: true,
      }),
    });

    expect(plan.summaryLines).toContain("Maintainer announcements: Enabled");
    expect(plan.summaryLines).not.toContain(
      "TUI plugin: install for maintainer announcement home notices only",
    );
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: true, home: true });
  });

  it("rerun with maintainer announcements enabled restores installer-created opt-outs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(
      join(globalGuiDir, "config.jsonc"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        maintainerAnnouncements: { enabled: false, home: false },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: true,
      }),
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.enabled");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.home");

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: true, home: true });
  });

  it("rejects empty, unknown, and mixed current quota UI selections", async () => {
    await expectSelectionError({ quotaUi: [] }, "Quota UI selections must not be empty.");
    await expectSelectionError(
      { quotaUi: ["sidebar", "obsolete"] as any },
      "Unknown Quota UI option: obsolete",
    );
    await expectSelectionError(
      { quotaUi: ["none", "toast"] },
      "Manual commands only cannot be combined with automatic quota displays.",
    );
  });

  it("rejects the obsolete string quota UI selection", async () => {
    await expectSelectionError(
      { quotaUi: "toast_sidebar" as any },
      "Quota UI selections must be an array.",
    );
  });

  it("rejects the obsolete compact installer selection field", async () => {
    await expectSelectionError(
      {
        quotaUi: ["toast", "sidebar"],
        tuiCompactStatus: "home_bottom_session_prompt",
      } as any,
      "Unsupported installer selection: tuiCompactStatus",
    );
  });

  it("updates installer-owned compact config values and preserves custom fields", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(
      join(globalGuiDir, "config.jsonc"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: false,
        },
        tuiCompactStatus: {
          enabled: false,
          sessionPrompt: false,
          maxWidth: 40,
        },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        quotaUi: ["toast", "sidebar", "compact_status"],
      }),
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).toEqual(
      expect.arrayContaining(["quotaToast.tuiCompactStatus.homeBottom"]),
    );
    expect(quotaEdit?.updatedKeys).toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast",
        "quotaToast.tuiSidebarPanel.enabled",
        "quotaToast.tuiCompactStatus.enabled",
        "quotaToast.tuiCompactStatus.sessionPrompt",
      ]),
    );
    expect(quotaEdit?.skippedValues).not.toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast preserved existing value",
        "quotaToast.tuiSidebarPanel.enabled preserved existing value",
        "quotaToast.tuiCompactStatus.enabled preserved existing value",
        "quotaToast.tuiCompactStatus.sessionPrompt preserved existing value",
      ]),
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.enableToast).toBe(true);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      sessionPrompt: true,
      maxWidth: 40,
      homeBottom: true,
    });
  });

  it("disables deselected existing UI surfaces without adding compact safety fields", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(
      join(globalGuiDir, "config.jsonc"),
      JSON.stringify({
        enableToast: true,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: true,
        },
        tuiCompactStatus: {
          enabled: true,
          sessionPrompt: true,
        },
      }),
      "utf8",
    );

    const plan = await planSelections({ quotaUi: ["none"] }, projectDir);

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).not.toEqual(
      expect.arrayContaining(["quotaToast.tuiCompactStatus.homeBottom"]),
    );
    expect(quotaEdit?.updatedKeys).toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast",
        "quotaToast.tuiSidebarPanel.enabled",
        "quotaToast.tuiCompactStatus.enabled",
      ]),
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: false,
      sessionPrompt: true,
    });
  });

  it("prompts only for GUI choices and keeps TUI compatibility configuration opt-in", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["sidebar", "compact_status"]],
      confirmValues: [true, true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(
      prompts.outroCalls.some((message) => message.startsWith("OpenCode Quota setup complete.")),
    ).toBe(true);
    expect(prompts.selectCalls[0]).toMatchObject({
      message: "Where should OpenCode Quota GUI be configured?",
      initialValue: "global",
      options: [
        expect.objectContaining({ label: "Global OpenCode config (recommended)", value: "global" }),
        expect.objectContaining({ label: "Current project", value: "project" }),
      ],
    });
    expect(prompts.multiselectCalls).toEqual([]);
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "How should pre-configured providers be selected?",
      )?.options,
    ).toEqual([
      {
        label: "Auto-detect providers",
        value: "auto",
        hint: "use providers found in your OpenCode configuration and authentication",
      },
      {
        label: "Choose providers manually",
        value: "manual",
        hint: "track only the pre-configured providers you select",
      },
    ]);
    expect(
      prompts.selectCalls.find((call) => call.message === "What should quota percentages show?"),
    ).toBeDefined();
    expect(prompts.selectCalls).toHaveLength(3);
    expect(prompts.confirmCalls[0]).toEqual({
      message: "Apply changes?",
      initialValue: true,
    });
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.sessionTokenScope).toBe("current");
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toMatchObject({
      enabled: false,
    });
  });

  it("prefills installer-owned answers from existing configuration on rerun", async () => {
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(
      join(globalGuiDir, "config.jsonc"),
      `{
        // preserve
        "enableToast": false,
        "enabledProviders": ["openai"],
        "formatStyle": "singleWindow",
        "percentDisplayMode": "remaining",
        "showSessionTokens": false,
        "sessionTokenScope": "tree",
        "tuiCommandDisplay": "inline",
        "tuiSidebarPanel": { "enabled": true },
        "maintainerAnnouncements": { "enabled": true }
      }`,
      "utf8",
    );
    const prompts = createPromptStub({
      selectValues: ["project", "manual", "used"],
      multiselectValues: [["anthropic"]],
      confirmValues: [false, false],
    });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(0);
    expect(prompts.multiselectCalls[0]).toMatchObject({ initialValues: ["openai"] });
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "How should pre-configured providers be selected?",
      ),
    ).toMatchObject({ initialValue: "manual" });
    expect(prompts.selectCalls).toHaveLength(3);
    expect(prompts.outroCalls).toContain("OpenCode Quota setup cancelled — no files changed.");
  });

  it("does not prefill installer answers from legacy upstream or dormant sibling GUI JSON", async () => {
    mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
    const legacyAnswers = JSON.stringify({
      enableToast: false,
      enabledProviders: ["openai"],
      formatStyle: "singleWindow",
      percentDisplayMode: "used",
      showSessionTokens: false,
      sessionTokenScope: "tree",
      tuiCommandDisplay: "inline",
      tuiSidebarPanel: { enabled: true },
      maintainerAnnouncements: { enabled: true },
    });
    const legacyPath = join(globalConfigDir, "opencode-quota", "quota-toast.json");
    writeFileSync(legacyPath, legacyAnswers, "utf8");
    mkdirSync(globalGuiDir, { recursive: true });
    const siblingPath = join(globalGuiDir, "config.json");
    writeFileSync(siblingPath, legacyAnswers, "utf8");
    const prompts = createPromptStub({
      selectValues: ["global", "auto", "remaining"],
      confirmValues: [false],
    });

    expect(await runInitInstaller({ cwd: tempDir, prompts: prompts as any })).toBe(0);

    expect(
      prompts.selectCalls.find(
        (call) => call.message === "How should pre-configured providers be selected?",
      ),
    ).toMatchObject({ initialValue: "auto" });
    expect(
      prompts.selectCalls.find((call) => call.message === "What should quota percentages show?"),
    ).toMatchObject({ initialValue: "remaining" });
    expect(prompts.multiselectCalls).toHaveLength(0);
    expect(existsSync(join(globalGuiDir, "config.jsonc"))).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyAnswers);
    expect(readFileSync(siblingPath, "utf8")).toBe(legacyAnswers);
  });

  it("GUI setup writes announcement opt-out without a separate prompt", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["none"]],
      confirmValues: [true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: false });
  });

  it("prints manual quick-setup reminders that link to the providers guide", async () => {
    const prompts = createPromptStub({
      selectValues: ["project", "manual", "remaining"],
      multiselectValues: [["cursor"]],
      confirmValues: [true, true],
    });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(0);
    expect(prompts.infoCalls).toContain("- Cursor: docs/readme/providers.md#cursor");
  });

  it("links every quick-setup reminder to an anchor that exists in the providers guide", async () => {
    const providersGuide = readFileSync(
      new URL("../docs/readme/providers.md", import.meta.url),
      "utf8",
    );
    const guideAnchors = new Set<string>();
    for (const line of providersGuide.split("\n")) {
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (heading) {
        guideAnchors.add(
          heading[1]
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9 _-]/g, "")
            .replace(/ /g, "-"),
        );
      }
      const explicitAnchor = /<a id="([^"]+)"><\/a>/.exec(line);
      if (explicitAnchor) {
        guideAnchors.add(explicitAnchor[1]);
      }
    }
    const quickSetupProviderIds = QUOTA_PROVIDER_SHAPES.filter(
      (shape) => shape.quickSetupAnchor && shape.autoSetup === "needs_quick_setup",
    ).map((shape) => shape.id);

    const plan = await planSelections({
      providerMode: "manual",
      manualProviders: quickSetupProviderIds,
    });
    const reminderLines = plan.summaryLines.filter((line) => line.includes(".md#"));

    expect(reminderLines).toHaveLength(quickSetupProviderIds.length);
    for (const line of reminderLines) {
      const link = /: (\S+)#(\S+)$/.exec(line);
      expect(link?.[1], line).toBe("docs/readme/providers.md");
      expect(guideAnchors.has(link?.[2] ?? ""), line).toBe(true);
    }
  });

  it("creates only opencode and quota configs for toast + sidebar mode with popup toasts enabled", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({ quotaUi: ["toast", "sidebar"] }),
    });

    expect(plan.summaryLines).toContain("Quota reset periods: Single window");
    expect(plan.summaryLines).toContain("Quota percentage meaning: Remaining");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));

    expect(opencode.plugins).toEqual([EXPLICIT_PACK_SPEC]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: "auto",
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      showSessionTokens: true,
      tuiSidebarPanel: { enabled: true },
    });
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(false);
  });

  it("disables popup toasts for none mode when missing", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["none"] }, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugins).toEqual([EXPLICIT_PACK_SPEC]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("returns zero when the user cancels before applying changes", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["toast"]],
      confirmValues: [false],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "opencode.json"))).toBe(false);
  });

  it("validates and prints an init dry-run without writing files", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["toast"]],
      confirmValues: [true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
      dryRun: true,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "opencode.jsonc"))).toBe(false);
    expect(existsSync(join(globalGuiDir, "config.jsonc"))).toBe(false);
    expect(prompts.outroCalls).toContain(
      `OpenCode Quota setup preview complete — no files changed. Run npx ${EXPLICIT_PACK_SPEC} init to apply.`,
    );
  });

  it("returns one when planning fails after prompt collection", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugin: {
          bad: true,
        },
      }),
      "utf8",
    );

    const logError = vi.fn();
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["toast"]],
    });
    prompts.log.error = logError;

    const code = await runInitInstaller({
      cwd: projectDir,
      prompts: prompts as any,
    });

    expect(code).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/plugin is not an array/i));
  });

  it("chooses the npm tag from the running package version", () => {
    expect(getQuotaPluginSpecForVersion("5.0.0")).toBe("opencode-quota-gui@latest");
    expect(getQuotaPluginSpecForVersion("5.0.0-beta.1")).toBe("opencode-quota-gui@next");
  });

  it("writes the explicit local pack spec for a new install and is idempotent", async () => {
    const projectDir = join(tempDir, "project-latest");
    mkdirSync(projectDir, { recursive: true });
    const selections = installerSelections();

    const firstPlan = await planInitInstaller({ cwd: projectDir, selections });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugins).toEqual([EXPLICIT_PACK_SPEC]);

    const secondPlan = await planInitInstaller({ cwd: projectDir, selections });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
  });

  it("writes and suggests the explicit local pack spec after install", async () => {
    const projectDir = join(tempDir, "project-next");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({ cwd: projectDir, selections: installerSelections() });
    await applyInitInstallerPlan(plan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugins).toEqual([EXPLICIT_PACK_SPEC]);

    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
      multiselectValues: [["toast"]],
    });
    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any, dryRun: true });
    expect(code).toBe(0);
    expect(prompts.outroCalls).toContain(
      `OpenCode Quota setup preview complete — no files changed. Run npx ${EXPLICIT_PACK_SPEC} init to apply.`,
    );
  });

  it("preserves every upstream spec and adds the GUI plugin without touching upstream entries", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const existingPlugins = [
      ["@slkiser/opencode-quota@3.11.1", { keep: true }],
      ["@slkiser/opencode-quota@next", { keep: true }],
      ["@slkiser/opencode-quota@^3.0.0", { keep: true }],
      "file:../opencode-quota",
    ];
    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({ plugin: existingPlugins }),
      "utf8",
    );

    const selections = installerSelections();
    const env = { [QUOTA_PLUGIN_SPEC_ENV]: EXPLICIT_PACK_SPEC };
    const firstPlan = await planInitInstaller({ cwd: projectDir, selections, env });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual(existingPlugins);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugins).toEqual([EXPLICIT_PACK_SPEC]);

    const secondPlan = await planInitInstaller({ cwd: projectDir, selections, env });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
  });

  it("cancels before selecting scope without offering interface choices", async () => {
    const prompts = createPromptStub({ selectValues: [Symbol.for("cancel")] });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(0);
    expect(prompts.selectCalls).toHaveLength(1);
    expect(prompts.selectCalls[0]?.message).toBe("Where should OpenCode Quota GUI be configured?");
  });

  it("installs Web server-only and leaves an existing tui.jsonc untouched", async () => {
    const projectDir = join(tempDir, "web-only");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalGuiDir, { recursive: true });
    const tuiRaw = `{
        // keep this comment
        "plugin": ["@slkiser/opencode-quota"],
      }`;
    writeFileSync(join(projectDir, "tui.jsonc"), tuiRaw, "utf8");

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        interfaces: "web",
        quotaUi: ["sidebar", "toast"],
        showSessionTokens: false,
      }),
    });

    expect(plan.summaryLines).toContain("Interface: GUI dashboard");
    expect(plan.summaryLines.some((line) => line.startsWith("TUI surfaces:"))).toBe(false);
    expect(plan.summaryLines.some((line) => line.startsWith("Command display:"))).toBe(false);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(readFileSync(join(projectDir, "tui.jsonc"), "utf8")).toBe(tuiRaw);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugins).toEqual([EXPLICIT_PACK_SPEC]);
    const quotaConfig = readJson(join(globalGuiDir, "config.jsonc"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiCommandDisplay).toBeUndefined();
  });

  it("preserves unrelated JSONC comments and trailing commas during an in-place rerun edit", async () => {
    const projectDir = join(tempDir, "jsonc-comment-rerun");
    mkdirSync(globalGuiDir, { recursive: true });
    const sidecarPath = join(globalGuiDir, "config.jsonc");
    writeFileSync(
      sidecarPath,
      `{
        // keep root comment
        "enableToast": true,
        "enabledProviders": ["openai"],
        "formatStyle": "singleWindow",
        "percentDisplayMode": "remaining",
        "showSessionTokens": false,
        "tuiCommandDisplay": "inline",
        "tuiSidebarPanel": { "enabled": true },
        // keep unrelated section comment
        "unrelated": {
          "keep": true,
        },
      }`,
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        configFormat: "jsonc",
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        tuiCommandDisplay: "dialog",
        maintainerAnnouncements: false,
      }),
    });
    await applyInitInstallerPlan(plan);

    const raw = readFileSync(sidecarPath, "utf8");
    expect(raw).toContain("// keep root comment");
    expect(raw).toContain("// keep unrelated section comment");
    expect(raw).toMatch(/"keep": true,\s*}/);
    expect(raw).toContain('"enabled": false\n        },');
    expect(readJson(sidecarPath)).toMatchObject({
      enabledProviders: ["anthropic"],
      formatStyle: "allWindows",
      unrelated: { keep: true },
    });
  });

  it("prefers JSONC deterministically when both quota sidecars exist", async () => {
    const projectDir = join(tempDir, "both-sidecars");
    mkdirSync(globalGuiDir, { recursive: true });
    const jsoncPath = join(globalGuiDir, "config.jsonc");
    const jsonPath = join(globalGuiDir, "config.json");
    writeFileSync(jsoncPath, '{ // preferred\n  "enabledProviders": ["openai"],\n}\n', "utf8");
    writeFileSync(jsonPath, JSON.stringify({ enabledProviders: ["chutes"] }), "utf8");

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        interfaces: "web",
        configFormat: "jsonc",
        quotaUi: ["none"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        showSessionTokens: false,
      }),
    });
    expect(plan.warnings).toContain(
      "Both opencode-quota-gui/config.jsonc and config.json exist; using JSONC and preserving the JSON file.",
    );
    await applyInitInstallerPlan(plan);

    expect(readJson(jsoncPath).enabledProviders).toEqual(["anthropic"]);
    expect(readJson(jsonPath).enabledProviders).toEqual(["chutes"]);
  });

  it("refuses malformed preferred JSONC without changing either sidecar", async () => {
    const projectDir = join(tempDir, "malformed-sidecar");
    mkdirSync(globalGuiDir, { recursive: true });
    const jsoncPath = join(globalGuiDir, "config.jsonc");
    const jsonPath = join(globalGuiDir, "config.json");
    const malformed = '{ "enabledProviders": [';
    const valid = JSON.stringify({ enabledProviders: ["openai"] });
    writeFileSync(jsoncPath, malformed, "utf8");
    writeFileSync(jsonPath, valid, "utf8");

    await expect(
      planInitInstaller({
        cwd: projectDir,
        selections: installerSelections({
          interfaces: "web",
          configFormat: "jsonc",
          quotaUi: ["none"],
          showSessionTokens: false,
        }),
      }),
    ).rejects.toThrow("Failed to parse config.jsonc");
    expect(readFileSync(jsoncPath, "utf8")).toBe(malformed);
    expect(readFileSync(jsonPath, "utf8")).toBe(valid);
  });

  it("preserves an existing GUI config.json and creates canonical JSONC without importing dormant values", async () => {
    const projectDir = join(tempDir, "quota-jsonc-migration");
    mkdirSync(globalGuiDir, { recursive: true });
    const sourcePath = join(globalGuiDir, "config.json");
    const sourceRaw = JSON.stringify({
      enableToast: true,
      enabledProviders: ["openai"],
      unrelated: { keep: true },
    });
    writeFileSync(sourcePath, sourceRaw, "utf8");

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({
        interfaces: "both",
        configFormat: "jsonc",
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        maintainerAnnouncements: false,
      }),
    });
    expect(plan.warnings).toContain(
      "Existing opencode-quota-gui/config.json is preserved unchanged; the dashboard reads only config.jsonc.",
    );
    expect(plan.summaryLines).toContain(`create: ${join(globalGuiDir, "config.jsonc")}`);

    await applyInitInstallerPlan(plan);

    expect(readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
    const targetPath = join(globalGuiDir, "config.jsonc");
    const raw = readFileSync(targetPath, "utf8");
    expect(raw).toContain("// Provider selection:");
    expect(readJson(targetPath)).toMatchObject({
      enableToast: false,
      enabledProviders: ["anthropic"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
    });
    expect(readJson(targetPath)).not.toHaveProperty("unrelated");
  });

  it("preflights every OpenCode config before the first installer write", async () => {
    const projectDir = join(tempDir, "preflight");
    mkdirSync(projectDir, { recursive: true });
    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

    const quotaPath = join(globalGuiDir, "config.jsonc");
    mkdirSync(globalGuiDir, { recursive: true });
    writeFileSync(quotaPath, '{"raced":true}\n', "utf8");

    await expect(applyInitInstallerPlan(plan)).rejects.toThrow("changed since preview");
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
    expect(readFileSync(quotaPath, "utf8")).toBe('{"raced":true}\n');
  });

  it("fails when an existing plugin container is not an array", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugin: {
          bad: true,
        },
      }),
      "utf8",
    );

    await expect(
      planInitInstaller({
        cwd: projectDir,
        selections: installerSelections(),
      }),
    ).rejects.toThrow(/plugin is not an array/i);
  });

  it("rejects a canonical directory alias to upstream before planning", async (context) => {
    const projectDir = join(tempDir, "project");
    const upstreamRoot = join(globalConfigDir, "opencode-quota");
    const sentinel = join(upstreamRoot, "quota-toast.jsonc");
    mkdirSync(upstreamRoot, { recursive: true });
    writeFileSync(sentinel, '{"sentinel":"upstream"}\n', "utf8");
    const guiDir = globalGuiDir;
    if (
      !symlinkOrSkip(
        context,
        upstreamRoot,
        guiDir,
        process.platform === "win32" ? "junction" : "dir",
      )
    ) {
      return;
    }

    await expect(
      planInitInstaller({ cwd: projectDir, selections: installerSelections() }),
    ).rejects.toThrow(/upstream quota configuration/i);
    expect(readFileSync(sentinel, "utf8")).toBe('{"sentinel":"upstream"}\n');
    expect(readdirSync(globalConfigDir).sort()).toEqual(["opencode-quota", "opencode-quota-gui"]);
  });

  it("writes through a legitimate GUI config symlink and keeps the link", async (context) => {
    const projectDir = join(tempDir, "project");
    const guiDir = globalGuiDir;
    const realTarget = join(globalConfigDir, "shared", "config.jsonc");
    const target = join(guiDir, "config.jsonc");
    mkdirSync(guiDir, { recursive: true });
    mkdirSync(join(globalConfigDir, "shared"), { recursive: true });
    writeFileSync(realTarget, '{"minIntervalMs":1000}\n', "utf8");
    if (!symlinkOrSkip(context, realTarget, target, "file")) return;

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections(),
    });
    await applyInitInstallerPlan(plan);

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(realTarget, "utf8")).toContain('"enableToast"');
  });

  it("rejects apply when the canonical directory is retargeted to upstream", async (context) => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections(),
    });

    const upstreamRoot = join(globalConfigDir, "opencode-quota");
    const sentinel = join(upstreamRoot, "quota-toast.jsonc");
    mkdirSync(upstreamRoot, { recursive: true });
    writeFileSync(sentinel, '{"sentinel":"upstream"}\n', "utf8");
    const guiDir = globalGuiDir;
    if (
      !symlinkOrSkip(
        context,
        upstreamRoot,
        guiDir,
        process.platform === "win32" ? "junction" : "dir",
      )
    ) {
      return;
    }

    await expect(applyInitInstallerPlan(plan)).rejects.toThrow(/upstream quota configuration/i);
    expect(readFileSync(sentinel, "utf8")).toBe('{"sentinel":"upstream"}\n');
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
  });
});
