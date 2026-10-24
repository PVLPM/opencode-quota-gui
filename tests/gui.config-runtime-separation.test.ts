/**
 * The dashboard settings snapshot is runtime state: canonical GUI config plus
 * defaults only. Legacy and workspace layers are import candidates, never live
 * settings. A read or write must leave those source files byte-identical.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore } from "../src/gui/config.js";
import { createLoadConfigMeta, getGuiConfigPath, loadConfig } from "../src/lib/config.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import type { GuiConfigWorkspace } from "./helpers/config-loader-test-harness.js";
import {
  createGuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-runtime-settings-");
  workspaces.push(workspace);
  return workspace;
}

function makeStore(workspace: GuiConfigWorkspace) {
  return createGuiSettingsStore({
    configDir: workspace.configDir,
    workspaceRoot: workspace.workspaceRoot,
  });
}

async function runtimeConfig(workspace: GuiConfigWorkspace) {
  return loadConfig(undefined, createLoadConfigMeta(), {
    configRootDir: workspace.workspaceRoot,
    globalConfigDir: workspace.configDir,
  });
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

describe("runtime settings vs legacy import candidates", () => {
  it("shows canonical values, provenance, port and visibility over conflicting legacy layers", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, {
      minIntervalMs: 3000,
      accountingDetail: "summary",
      dashboard: { port: 4567, hiddenCards: ["canonical-card"] },
    });
    const globalLegacy = writeQuotaSidecarConfig(workspace.configDir, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
      percentLabelStyle: "bare",
      requestTimeoutMs: 2500,
      dashboard: { port: 9999, hiddenCards: ["global-legacy-card"] },
    });
    const workspaceLegacy = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      waitForQuotaReset: false,
      dashboard: { port: 7777, hiddenRows: ["workspace-legacy-row"] },
    });
    const globalBytes = readFileSync(globalLegacy, "utf8");
    const workspaceBytes = readFileSync(workspaceLegacy, "utf8");

    const store = makeStore(workspace);
    const snapshot = await store.settings();
    const runtime = await runtimeConfig(workspace);

    expect(snapshot.values.minIntervalMs).toBe(3000);
    expect(snapshot.values.minIntervalMs).toBe(runtime.minIntervalMs);
    expect(snapshot.values.accountingDetail).toBe("summary");
    expect(snapshot.values.waitForQuotaReset).toBe(true);
    expect(snapshot.values["dashboard.port"]).toBe(4567);
    expect(snapshot.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.sources.accountingDetail).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.sources.waitForQuotaReset).toBe("defaults");
    expect(snapshot.provenance?.minIntervalMs).toEqual({ scope: "global" });
    expect(snapshot.provenance?.waitForQuotaReset).toEqual({ scope: "defaults" });
    expect(snapshot.dashboard).toEqual({
      port: 4567,
      url: "http://127.0.0.1:4567",
    });
    expect(snapshot.visibility).toEqual({
      hiddenCards: ["canonical-card"],
      hiddenRows: [],
    });

    // The legacy files remain import candidates only.
    expect(snapshot.import.available).toBe(true);
    expect(snapshot.import.keyCount).toBe(2);
    expect(snapshot.import.from).toBe("global opencode-quota/quota-toast.json");
    expect(readFileSync(globalLegacy, "utf8")).toBe(globalBytes);
    expect(readFileSync(workspaceLegacy, "utf8")).toBe(workspaceBytes);
  });

  it("uses defaults when the canonical file is absent, even when legacy layers conflict", async () => {
    const workspace = makeWorkspace();
    const globalLegacy = writeQuotaSidecarConfig(workspace.configDir, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
      dashboard: { port: 9999, hiddenCards: ["global-legacy-card"] },
    });
    const workspaceLegacy = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      waitForQuotaReset: false,
      dashboard: { hiddenRows: ["workspace-legacy-row"] },
    });
    const globalBytes = readFileSync(globalLegacy, "utf8");
    const workspaceBytes = readFileSync(workspaceLegacy, "utf8");

    const store = makeStore(workspace);
    const snapshot = await store.settings();
    const runtime = await runtimeConfig(workspace);

    expect(snapshot.values.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(snapshot.values.minIntervalMs).toBe(runtime.minIntervalMs);
    expect(snapshot.values.accountingDetail).toBe(DEFAULT_CONFIG.accountingDetail);
    expect(snapshot.values.waitForQuotaReset).toBe(true);
    expect(snapshot.sources.minIntervalMs).toBe("defaults");
    expect(snapshot.sources.accountingDetail).toBe("defaults");
    expect(snapshot.provenance?.minIntervalMs).toEqual({ scope: "defaults" });
    expect(snapshot.provenance?.waitForQuotaReset).toEqual({ scope: "defaults" });
    expect(snapshot.dashboard).toEqual({
      port: 4144,
      url: "http://127.0.0.1:4144",
    });
    expect(snapshot.visibility).toEqual({ hiddenCards: [], hiddenRows: [] });
    expect(snapshot.import).toMatchObject({
      available: true,
      from: "global opencode-quota/quota-toast.json",
      keyCount: 2,
    });
    expect(readFileSync(globalLegacy, "utf8")).toBe(globalBytes);
    expect(readFileSync(workspaceLegacy, "utf8")).toBe(workspaceBytes);
  });

  it("keeps workspace-only legacy values out of runtime and out of the import plan", async () => {
    const workspace = makeWorkspace();
    const workspaceLegacy = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1111,
      accountingDetail: "detailed",
      dashboard: { port: 7777, hiddenCards: ["workspace-legacy-card"] },
    });
    const workspaceBytes = readFileSync(workspaceLegacy, "utf8");

    const store = makeStore(workspace);
    const snapshot = await store.settings();
    const preview = await store.importPreview();

    expect(snapshot.values.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(snapshot.values.accountingDetail).toBe(DEFAULT_CONFIG.accountingDetail);
    expect(snapshot.visibility).toEqual({ hiddenCards: [], hiddenRows: [] });
    expect(snapshot.dashboard.port).toBe(4144);
    expect(snapshot.import).toEqual({ available: false, issues: [] });
    expect(preview.keys).toEqual([]);
    expect(preview.from).toBe("");
    expect(readFileSync(workspaceLegacy, "utf8")).toBe(workspaceBytes);
  });

  it("matches runtime before import and canonical state after explicit import without touching the source", async () => {
    const workspace = makeWorkspace();
    const globalLegacy = writeQuotaSidecarConfig(workspace.configDir, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
    });
    const globalBytes = readFileSync(globalLegacy, "utf8");
    const store = makeStore(workspace);

    const before = await store.settings();
    const beforeRuntime = await runtimeConfig(workspace);
    expect(before.values.minIntervalMs).toBe(beforeRuntime.minIntervalMs);
    expect(before.values.accountingDetail).toBe(beforeRuntime.accountingDetail);

    const preview = await store.importPreview();
    await store.importApply({ expectedRevision: preview.expectedRevision });

    const after = await store.settings();
    const afterRuntime = await runtimeConfig(workspace);
    expect(after.values.minIntervalMs).toBe(1000);
    expect(after.values.minIntervalMs).toBe(afterRuntime.minIntervalMs);
    expect(after.values.accountingDetail).toBe("detailed");
    expect(after.values.accountingDetail).toBe(afterRuntime.accountingDetail);
    expect(after.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(after.import).toEqual({ available: false, issues: [] });
    expect(readFileSync(globalLegacy, "utf8")).toBe(globalBytes);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toContain(
      "// Imported from global opencode-quota/quota-toast.json",
    );
  });

  it("saves visibility from defaults, not from a legacy hiddenCards value, without touching the source", async () => {
    const workspace = makeWorkspace();
    const globalLegacy = writeQuotaSidecarConfig(workspace.configDir, {
      dashboard: { hiddenCards: ["legacy-card"], port: 9999 },
    });
    const globalBytes = readFileSync(globalLegacy, "utf8");
    const store = makeStore(workspace);

    const before = await store.settings();
    expect(before.visibility).toEqual({ hiddenCards: [], hiddenRows: [] });
    expect(before.dashboard.port).toBe(4144);

    await store.saveVisibility({
      hiddenCards: ["new-card"],
      hiddenRows: ["new-row"],
      expectedRevision: before.revision,
    });

    const after = await store.settings();
    expect(after.visibility).toEqual({ hiddenCards: ["new-card"], hiddenRows: ["new-row"] });
    expect(after.dashboard.port).toBe(4144);
    expect(readFileSync(globalLegacy, "utf8")).toBe(globalBytes);
    const canonical = JSON.parse(readFileSync(getGuiConfigPath(workspace.configDir), "utf8"));
    expect(canonical.dashboard).toEqual({
      hiddenCards: ["new-card"],
      hiddenCardsVersion: 2,
      hiddenRows: ["new-row"],
    });
  });

  it("does not create or write a canonical file for a settings read when none exists", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 1000 });
    writeQuotaToastConfig(workspace.configDir, { requestTimeoutMs: 2500 });

    await makeStore(workspace).settings();

    expect(() => readFileSync(workspace.guiConfigPath, "utf8")).toThrow();
  });
});
