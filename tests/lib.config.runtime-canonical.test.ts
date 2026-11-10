/**
 * Runtime configuration is canonical GUI config + defaults only. Legacy OpenCode,
 * workspace and SDK settings stay available to the explicit settings import, never
 * to the runtime collectors.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore } from "../src/gui/config.js";
import { createLoadConfigMeta, getGuiConfigPath, loadConfig } from "../src/lib/config.js";
import { parseConfigDocument } from "../src/lib/opencode-config-editor.js";
import { DEFAULT_CONFIG, DEFAULT_DASHBOARD_PORT } from "../src/lib/types.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

function writeWorkspaceLegacy(workspace: GuiConfigWorkspace): void {
  mkdirSync(join(workspace.workspaceRoot, "opencode-quota"), { recursive: true });
  writeFileSync(
    join(workspace.workspaceRoot, "opencode-quota", "quota-toast.json"),
    JSON.stringify({ enabled: false, showOnIdle: false, dashboard: { port: 5511 } }),
    "utf8",
  );
  writeFileSync(
    join(workspace.workspaceRoot, "opencode.json"),
    JSON.stringify({ experimental: { quotaToast: { enabled: false, showOnIdle: false } } }),
    "utf8",
  );
}

function sdkClient(enabled: boolean) {
  return {
    config: {
      get: async () => ({
        data: { experimental: { quotaToast: { enabled, minIntervalMs: 13_333 } } },
      }),
    },
  };
}

function hashFile(path: string): string {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "missing";
}

describe("runtime loadConfig canonical-only", () => {
  let workspace: GuiConfigWorkspace;

  beforeEach(() => {
    workspace = createGuiConfigWorkspace("quota-runtime-config-");
  });

  afterEach(() => workspace.cleanup());

  it("applies canonical GUI settings and ignores legacy files, workspace and SDK settings", async () => {
    writeQuotaSidecarConfig(workspace.configDir, {
      enabled: false,
      minIntervalMs: 9_999,
      dashboard: { port: 5999 },
    });
    writeQuotaToastConfig(workspace.configDir, { enabled: false, minIntervalMs: 8_888 });
    writeWorkspaceLegacy(workspace);
    const canonicalPath = writeGuiCanonicalConfig(workspace, {
      minIntervalMs: 2_222,
      dashboard: { port: 4_567 },
    });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(sdkClient(false), meta, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(config.minIntervalMs).toBe(2_222);
    expect(config.dashboard.port).toBe(4_567);
    expect(meta.source).toBe("files");
    expect(meta.paths).toEqual([canonicalPath]);
    expect(meta.settingSources.minIntervalMs).toBe(canonicalPath);
    expect(meta.settingSourceLayers.minIntervalMs).toEqual({
      scope: "global",
      kind: "canonical",
    });
    expect(meta.globalConfigPaths).toEqual([canonicalPath]);
    expect(meta.workspaceConfigPaths).toEqual([]);
    expect(meta.configIssues).toEqual([]);
  });

  it("returns defaults when the canonical file is absent, even when every legacy source is configured", async () => {
    writeQuotaSidecarConfig(workspace.configDir, { enabled: false, minIntervalMs: 9_999 });
    writeQuotaToastConfig(workspace.configDir, { enabled: false, minIntervalMs: 8_888 });
    writeWorkspaceLegacy(workspace);

    const meta = createLoadConfigMeta();
    const config = await loadConfig(sdkClient(false), meta, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(config.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(config.dashboard.port).toBe(DEFAULT_DASHBOARD_PORT);
    expect(meta.source).toBe("defaults");
    expect(meta.paths).toEqual([]);
    expect(meta.settingSources).toEqual({});
    expect(meta.configIssues).toEqual([]);
  });

  it("returns defaults with one controlled issue when the canonical file is malformed", async () => {
    writeQuotaSidecarConfig(workspace.configDir, { enabled: false, minIntervalMs: 9_999 });
    writeWorkspaceLegacy(workspace);
    const canonicalPath = writeGuiCanonicalConfig(workspace, "{ not jsonc ");

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(config.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(meta.source).toBe("defaults");
    expect(meta.paths).toEqual([]);
    expect(meta.configIssues).toEqual([
      {
        path: canonicalPath,
        key: "$root",
        message: "malformed JSONC; defaults apply",
      },
    ]);
  });

  it("does not read the sibling config.json file", async () => {
    mkdirSync(join(workspace.configDir, "opencode-quota-gui"), { recursive: true });
    writeFileSync(
      join(workspace.configDir, "opencode-quota-gui", "config.json"),
      JSON.stringify({ minIntervalMs: 7_777, dashboard: { port: 4_999 } }),
      "utf8",
    );

    const config = await loadConfig(undefined, undefined, {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
    expect(config.dashboard.port).toBe(DEFAULT_DASHBOARD_PORT);
    expect(existsSync(getGuiConfigPath(workspace.configDir))).toBe(false);
  });

  it("keeps the explicit legacy import read-only until the canonical apply", async () => {
    const legacyPath = writeQuotaSidecarConfig(workspace.configDir, {
      enabled: false,
      minIntervalMs: 9_999,
    });
    const workspaceLegacy = join(workspace.workspaceRoot, "opencode-quota", "quota-toast.json");
    writeWorkspaceLegacy(workspace);
    const before = {
      legacy: hashFile(legacyPath),
      workspace: hashFile(workspaceLegacy),
      canonical: hashFile(getGuiConfigPath(workspace.configDir)),
    };

    const store = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
    });
    const preview = await store.importPreview();

    expect(preview.keys).toEqual([{ key: "minIntervalMs", value: 9_999 }]);
    expect(hashFile(legacyPath)).toBe(before.legacy);
    expect(hashFile(workspaceLegacy)).toBe(before.workspace);
    expect(hashFile(getGuiConfigPath(workspace.configDir))).toBe(before.canonical);
    expect(existsSync(getGuiConfigPath(workspace.configDir))).toBe(false);

    await store.importApply({ expectedRevision: preview.expectedRevision });

    expect(hashFile(legacyPath)).toBe(before.legacy);
    expect(hashFile(workspaceLegacy)).toBe(before.workspace);
    const canonicalPath = getGuiConfigPath(workspace.configDir);
    expect(
      parseConfigDocument(readFileSync(canonicalPath, "utf8"), "jsonc", canonicalPath),
    ).toEqual({ minIntervalMs: 9_999 });
  });
});
