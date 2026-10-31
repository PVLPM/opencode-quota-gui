import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGuiSettingsStore,
  getGuiDashboardEnabled,
  getGuiDashboardPort,
} from "../src/gui/config.js";
import { createLoadConfigMeta, getGuiConfigPath, loadConfigLayered } from "../src/lib/config.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-migration-");
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

async function load(workspace: GuiConfigWorkspace) {
  const meta = createLoadConfigMeta();
  const config = await loadConfigLayered(undefined, meta, {
    configRootDir: workspace.workspaceRoot,
    globalConfigDir: workspace.configDir,
  });
  return { config, meta };
}

describe("legacy config compatibility beside the canonical layer", () => {
  it("keeps the full legacy configuration available to the import loader", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.configDir, {
      enabled: false,
      enableToast: false,
      telemetry: { enabled: true },
      showOnIdle: false,
      toastDurationMs: 1234,
      tuiSidebarPanel: { enabled: false },
      resetNotifications: { enabled: true, windows: ["weekly", "monthly"] },
      debug: true,
    });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 2000 });

    const { config, meta } = await load(workspace);

    expect(config.enabled).toBe(false);
    expect(config.enableToast).toBe(false);
    expect(config.telemetry.enabled).toBe(true);
    expect(config.showOnIdle).toBe(false);
    expect(config.toastDurationMs).toBe(1234);
    expect(config.tuiSidebarPanel.enabled).toBe(false);
    expect(config.resetNotifications).toEqual({ enabled: true, windows: ["weekly", "monthly"] });
    expect(config.debug).toBe(true);
    expect(config.minIntervalMs).toBe(2000);
    expect(meta.configIssues).toEqual([]);
  });

  it("reports canonical runtime values and keeps legacy layers for import", async () => {
    const workspace = makeWorkspace();
    writeQuotaToastConfig(workspace.configDir, {
      minIntervalMs: 1111,
      percentDisplayMode: "used",
    });
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 2222,
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 3333, waitForQuotaReset: false });

    const store = makeStore(workspace);
    const snapshot = await store.settings();

    expect(snapshot.values.minIntervalMs).toBe(3333);
    expect(snapshot.values.percentDisplayMode).toBe("remaining");
    expect(snapshot.values.accountingDetail).toBe("summary");
    expect(snapshot.values.waitForQuotaReset).toBe(false);
    expect(snapshot.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.sources.percentDisplayMode).toBe("defaults");
    expect(snapshot.sources.accountingDetail).toBe("defaults");
    expect(snapshot.sources.waitForQuotaReset).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.sources.percentLabelStyle).toBe("defaults");

    const preview = await store.importPreview();
    expect(Object.fromEntries(preview.keys.map((entry) => [entry.key, entry.value]))).toEqual({
      percentDisplayMode: "used",
    });
  });

  it("writes the global canonical file and leaves project legacy layers inactive", async () => {
    const workspace = makeWorkspace();
    const sidecar = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 2222,
      accountingDetail: "detailed",
    });
    const sidecarBytes = readFileSync(sidecar, "utf8");
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1111, waitForQuotaReset: false });
    const store = makeStore(workspace);

    const before = await store.settings();
    expect(before.values.minIntervalMs).toBe(1111);
    expect(before.values.accountingDetail).toBe("summary");
    expect(before.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(before.sources.accountingDetail).toBe("defaults");

    await store.saveSettings({
      patch: { minIntervalMs: 1000, accountingDetail: "summary" },
      expectedRevision: before.revision,
    });

    const after = await store.settings();
    expect(after.values.minIntervalMs).toBe(1000);
    expect(after.values.accountingDetail).toBe("summary");
    expect(after.values.waitForQuotaReset).toBe(false);
    expect(after.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(after.sources.accountingDetail).toBe("opencode-quota-gui/config.jsonc");
    expect(after.sources.waitForQuotaReset).toBe("opencode-quota-gui/config.jsonc");
    expect(readFileSync(sidecar, "utf8")).toBe(sidecarBytes);
    const canonical = JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"));
    expect(canonical.minIntervalMs).toBe(1000);
    expect(canonical.accountingDetail).toBe("summary");
  });

  it("never writes a project legacy sidecar and ignores its runtime values", async () => {
    const workspace = makeWorkspace();
    const sidecar = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      dashboard: { hiddenCards: ["card-a"] },
      waitForQuotaReset: false,
    });
    const sidecarBytes = readFileSync(sidecar, "utf8");
    const store = makeStore(workspace);

    const before = await store.settings();
    expect(before.visibility.hiddenCards).toEqual([]);
    expect(before.sources["dashboard.hiddenCards"]).toBe("defaults");
    expect(before.values.waitForQuotaReset).toBe(true);
    expect(before.sources.waitForQuotaReset).toBe("defaults");

    await store.saveVisibility({
      hiddenCards: ["card-b"],
      hiddenRows: ["row-b"],
      expectedRevision: before.revision,
    });

    expect(readFileSync(sidecar, "utf8")).toBe(sidecarBytes);
    const after = await store.settings();
    expect(after.visibility).toEqual({ hiddenCards: ["card-b"], hiddenRows: ["row-b"] });
    expect(after.values.waitForQuotaReset).toBe(true);
    const canonical = JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"));
    expect(canonical.dashboard.hiddenCards).toEqual(["card-b"]);
    expect(canonical.dashboard.hiddenRows).toEqual(["row-b"]);
  });

  it("keeps an in-repo dashboard config file inactive", async () => {
    const workspace = makeWorkspace();
    const projectGuiDir = join(workspace.workspaceRoot, "opencode-quota-gui");
    mkdirSync(projectGuiDir, { recursive: true });
    writeFileSync(
      join(projectGuiDir, "config.jsonc"),
      JSON.stringify({ accountingDetail: "detailed", minIntervalMs: 42 }),
    );
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1234 });

    const { config, meta } = await load(workspace);
    const snapshot = await makeStore(workspace).settings();

    expect(config.accountingDetail).toBe("summary");
    expect(config.minIntervalMs).toBe(1234);
    expect(meta.paths).not.toContain(join(projectGuiDir, "config.jsonc"));
    expect(snapshot.values.minIntervalMs).toBe(1234);
    expect(snapshot.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
  });

  it("resolves the effective dashboard port with a safe fallback", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 4567 } });

    const { config } = await load(workspace);
    expect(getGuiDashboardPort(config)).toBe(4567);
    expect(getGuiDashboardPort(undefined)).toBe(4144);
    expect(getGuiDashboardPort({ dashboard: { port: 0 } })).toBe(4144);
    expect(getGuiDashboardPort({ dashboard: { port: 1.5 } })).toBe(4144);
    expect(getGuiDashboardPort({ dashboard: { port: Number.NaN } })).toBe(4144);
    expect(getGuiDashboardPort({ dashboard: { port: 70000 } })).toBe(4144);
  });

  it("enables web only for an explicit dashboard.enabled true", async () => {
    expect(getGuiDashboardEnabled(undefined)).toBe(false);
    expect(getGuiDashboardEnabled({})).toBe(false);
    expect(getGuiDashboardEnabled({ dashboard: {} })).toBe(false);
    expect(getGuiDashboardEnabled({ dashboard: { enabled: false } })).toBe(false);
    expect(getGuiDashboardEnabled({ dashboard: { enabled: true } })).toBe(true);
    expect(getGuiDashboardEnabled({ dashboard: { enabled: "true" } })).toBe(false);
    expect(getGuiDashboardEnabled({ dashboard: { enabled: 1 } })).toBe(false);
  });

  it("exposes only the absolute canonical pathLabel and keeps other strings path-free", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 4999 } });

    const snapshot = await makeStore(workspace).settings();
    const { pathLabel, ...pathFreePayload } = snapshot;
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) for (const entry of value) walk(entry);
      else if (value && typeof value === "object") {
        for (const entry of Object.values(value)) walk(entry);
      }
    };
    walk(pathFreePayload);

    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) {
      expect(entry).not.toContain(workspace.tempDir);
      expect(entry).not.toContain(workspace.configDir);
      expect(entry).not.toContain(workspace.workspaceRoot);
    }

    // The sole authorized absolute-path display exception.
    expect(pathLabel).toBe(getGuiConfigPath(workspace.configDir));
    expect(pathLabel).toBe(workspace.guiConfigPath);
  });
});
