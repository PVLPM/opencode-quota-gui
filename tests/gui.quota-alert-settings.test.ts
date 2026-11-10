import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGuiSettingsStore,
  GUI_SETTINGS_WRITABLE_KEYS,
  GuiSettingsError,
} from "../src/gui/config.js";
import { createLoadConfigMeta, getGuiConfigPath, loadConfig } from "../src/lib/config.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  fieldErrors,
  initialDraft,
  lowQuotaThresholdDisplayValue,
  lowQuotaThresholdRemainingValue,
  SETTINGS_FIELDS,
  validateValue,
} from "../src/ui/settings-model.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-alerts-");
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

function makeStore(workspace: GuiConfigWorkspace) {
  return createGuiSettingsStore({
    configDir: workspace.configDir,
    workspaceRoot: workspace.workspaceRoot,
  });
}

function runtimeConfig(workspace: GuiConfigWorkspace) {
  return loadConfig(undefined, createLoadConfigMeta(), {
    configRootDir: workspace.workspaceRoot,
    globalConfigDir: workspace.configDir,
  });
}

function fieldFor(key: string) {
  const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key);
  if (!field) throw new Error(`settings field ${key} is missing`);
  return field;
}

describe("native quota alert settings", () => {
  it("round-trips the complete canonical policy through the revisioned store", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();
    expect(before.values.nativeQuotaNotifications).toEqual(DEFAULT_CONFIG.nativeQuotaNotifications);
    const policy = {
      enabled: false,
      modelChangeToastEnabled: false,
      low: { enabled: false, thresholdRemainingPercent: 25 },
      exhausted: { enabled: false },
      reset: { enabled: false, windows: ["daily", "weekly"] },
      providerError: { enabled: false },
      duplicateCooldownMinutes: 45,
    };
    await store.saveSettings({
      patch: { nativeQuotaNotifications: policy },
      expectedRevision: before.revision,
    });
    expect((await store.settings()).values.nativeQuotaNotifications).toEqual(policy);
    expect((await runtimeConfig(workspace)).nativeQuotaNotifications).toEqual(policy);
    expect(validateValue(fieldFor("nativeQuotaNotifications"), policy)).toBeUndefined();
  });

  it("defaults model-change toast independently of the quota-alert master switch", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();
    const defaultPolicy = before.values.nativeQuotaNotifications as Record<string, JsonValue>;

    expect(DEFAULT_CONFIG.nativeQuotaNotifications.modelChangeToastEnabled).toBe(true);
    expect(defaultPolicy.modelChangeToastEnabled).toBe(true);

    const policy = {
      ...defaultPolicy,
      enabled: false,
      modelChangeToastEnabled: false,
    };
    await store.saveSettings({
      patch: { nativeQuotaNotifications: policy },
      expectedRevision: before.revision,
    });

    const after = await store.settings();
    expect(after.values.nativeQuotaNotifications).toMatchObject({
      enabled: false,
      modelChangeToastEnabled: false,
    });
    expect((await runtimeConfig(workspace)).nativeQuotaNotifications).toMatchObject({
      enabled: false,
      modelChangeToastEnabled: false,
    });
  });
  it("defaults to 10% remaining and a 30-minute cooldown", async () => {
    const workspace = makeWorkspace();
    const config = await runtimeConfig(workspace);
    const snapshot = await makeStore(workspace).settings();

    expect(DEFAULT_CONFIG.lowQuotaThresholdRemainingPercent).toBe(10);
    expect(DEFAULT_CONFIG.duplicateCooldownMinutes).toBe(30);
    expect(config.lowQuotaThresholdRemainingPercent).toBe(10);
    expect(config.duplicateCooldownMinutes).toBe(30);

    expect(snapshot.values.lowQuotaThresholdRemainingPercent).toBe(10);
    expect(snapshot.values.duplicateCooldownMinutes).toBe(30);
    expect(snapshot.sources.lowQuotaThresholdRemainingPercent).toBe("defaults");
    expect(snapshot.sources.duplicateCooldownMinutes).toBe("defaults");
    expect(snapshot.provenance?.lowQuotaThresholdRemainingPercent).toEqual({
      scope: "defaults",
    });
    expect(snapshot.provenance?.duplicateCooldownMinutes).toEqual({ scope: "defaults" });
    expect(GUI_SETTINGS_WRITABLE_KEYS).toContain("lowQuotaThresholdRemainingPercent");
    expect(GUI_SETTINGS_WRITABLE_KEYS).toContain("duplicateCooldownMinutes");
  });

  it("loads valid canonical JSONC values and records their scope", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(
      workspace,
      `{
  // Keep notification tuning in the canonical file.
  "lowQuotaThresholdRemainingPercent": 25,
  "duplicateCooldownMinutes": 0
}
`,
    );
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.lowQuotaThresholdRemainingPercent).toBe(25);
    expect(config.duplicateCooldownMinutes).toBe(0);
    expect(meta.configIssues).toEqual([]);
    expect(meta.settingSources.lowQuotaThresholdRemainingPercent).toBe(
      getGuiConfigPath(workspace.configDir),
    );
    expect(meta.settingSources.duplicateCooldownMinutes).toBe(
      getGuiConfigPath(workspace.configDir),
    );
    expect(meta.settingSourceLayers.lowQuotaThresholdRemainingPercent).toEqual({
      scope: "global",
      kind: "canonical",
    });
    expect(meta.settingSourceLayers.duplicateCooldownMinutes).toEqual({
      scope: "global",
      kind: "canonical",
    });
  });

  it("keeps defaults for invalid canonical values and reports each key", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, {
      lowQuotaThresholdRemainingPercent: 101,
      duplicateCooldownMinutes: -1,
    });
    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.lowQuotaThresholdRemainingPercent).toBe(10);
    expect(config.duplicateCooldownMinutes).toBe(30);
    expect(meta.settingSources).toEqual({});
    expect(meta.configIssues.map((issue) => issue.key).sort()).toEqual([
      "duplicateCooldownMinutes",
      "lowQuotaThresholdRemainingPercent",
    ]);
  });

  it("writes both values through the revisioned canonical JSONC path", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(
      workspace,
      `{
  // Keep this comment when alert settings are saved.
  "lowQuotaThresholdRemainingPercent": 10,
  "duplicateCooldownMinutes": 30
}
`,
    );
    const store = makeStore(workspace);
    const before = await store.settings();

    const result = await store.saveSettings({
      patch: {
        lowQuotaThresholdRemainingPercent: 25,
        duplicateCooldownMinutes: 0,
      },
      expectedRevision: before.revision,
    });

    expect(result.applied).toEqual({
      lowQuotaThresholdRemainingPercent: 25,
      duplicateCooldownMinutes: 0,
    });
    const raw = readFileSync(workspace.guiConfigPath, "utf8");
    expect(raw).toContain("// Keep this comment when alert settings are saved.");
    expect(raw).toMatch(/"lowQuotaThresholdRemainingPercent":\s*25/u);
    expect(raw).toMatch(/"duplicateCooldownMinutes":\s*0/u);

    const after = await store.settings();
    expect(after.values.lowQuotaThresholdRemainingPercent).toBe(25);
    expect(after.values.duplicateCooldownMinutes).toBe(0);
    expect(after.sources.lowQuotaThresholdRemainingPercent).toBe("opencode-quota-gui/config.jsonc");
    expect(after.sources.duplicateCooldownMinutes).toBe("opencode-quota-gui/config.jsonc");
  });

  it.each([
    ["lowQuotaThresholdRemainingPercent", 0],
    ["lowQuotaThresholdRemainingPercent", 101],
    ["lowQuotaThresholdRemainingPercent", 10.5],
    ["lowQuotaThresholdRemainingPercent", "10"],
    ["duplicateCooldownMinutes", -1],
    ["duplicateCooldownMinutes", 1.5],
    ["duplicateCooldownMinutes", "30"],
  ])("rejects invalid %s = %j without creating a file", async (key, value) => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    const error = await store
      .saveSettings({ patch: { [key]: value }, expectedRevision: before.revision })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(GuiSettingsError);
    expect((error as GuiSettingsError).code).toBe("invalid-setting");
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("exposes hidden fields with the stored semantic bounds", () => {
    const threshold = fieldFor("lowQuotaThresholdRemainingPercent");
    const cooldown = fieldFor("duplicateCooldownMinutes");

    expect(threshold).toMatchObject({
      hidden: true,
      control: "integer",
      min: 1,
      max: 100,
    });
    expect(validateValue(threshold, 1)).toBeUndefined();
    expect(validateValue(threshold, 100)).toBeUndefined();
    expect(validateValue(threshold, 0)).toContain("at least 1");
    expect(validateValue(threshold, 101)).toContain("at most 100");
    expect(validateValue(threshold, 10.5)).toContain("whole number");

    expect(cooldown).toMatchObject({ hidden: true, control: "integer", min: 0 });
    expect(validateValue(cooldown, 0)).toBeUndefined();
    expect(validateValue(cooldown, 30)).toBeUndefined();
    expect(validateValue(cooldown, -1)).toContain("at least 0");
    expect(validateValue(cooldown, 1.5)).toContain("whole number");

    const draft = {
      ...initialDraft("revision-1"),
      edits: {
        lowQuotaThresholdRemainingPercent: 0,
        duplicateCooldownMinutes: -1,
      },
    };
    expect(fieldErrors(draft, [threshold, cooldown])).toEqual([
      { key: "lowQuotaThresholdRemainingPercent", message: expect.stringContaining("at least 1") },
      { key: "duplicateCooldownMinutes", message: expect.stringContaining("at least 0") },
    ]);
  });

  it("converts display values without changing the stored remaining semantics", () => {
    expect(lowQuotaThresholdDisplayValue(10, "remaining")).toBe(10);
    expect(lowQuotaThresholdDisplayValue(10, "used")).toBe(90);
    expect(lowQuotaThresholdDisplayValue(1, "used")).toBe(99);
    expect(lowQuotaThresholdDisplayValue(100, "used")).toBe(0);
    expect(lowQuotaThresholdDisplayValue(undefined, "used")).toBeUndefined();

    expect(lowQuotaThresholdRemainingValue(90, "used")).toBe(10);
    expect(lowQuotaThresholdRemainingValue(0, "used")).toBe(100);
    expect(lowQuotaThresholdRemainingValue(99, "used")).toBe(1);
    expect(lowQuotaThresholdRemainingValue(10, "remaining")).toBe(10);
    expect(lowQuotaThresholdRemainingValue(undefined, "used")).toBeUndefined();

    const draft = {
      ...initialDraft("revision-1"),
      edits: {
        lowQuotaThresholdRemainingPercent: lowQuotaThresholdRemainingValue(95, "used"),
      },
    };
    expect(draft.edits.lowQuotaThresholdRemainingPercent).toBe(5);
    expect(fieldErrors(draft, [fieldFor("lowQuotaThresholdRemainingPercent")])).toEqual([]);
  });
});
