import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore, getGuiDashboardPort } from "../src/gui/config.js";
import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";
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
  const config = await loadConfig(undefined, meta, {
    configRootDir: workspace.workspaceRoot,
    globalConfigDir: workspace.configDir,
  });
  return { config, meta };
}

describe("legacy config compatibility beside the canonical layer", () => {
  it("keeps the full legacy configuration working", async () => {
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

  it("reports the winning layer per key with symbolic labels", async () => {
    const workspace = makeWorkspace();
    writeQuotaToastConfig(workspace.configDir, {
      minIntervalMs: 1111,
      percentDisplayMode: "used",
    });
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 2222,
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, { waitForQuotaReset: false });

    const snapshot = await makeStore(workspace).settings();

    expect(snapshot.values.minIntervalMs).toBe(2222);
    expect(snapshot.sources.minIntervalMs).toBe("project opencode-quota/quota-toast.json");
    expect(snapshot.sources.percentDisplayMode).toBe(
      "global opencode.json (experimental.quotaToast)",
    );
    expect(snapshot.sources.accountingDetail).toBe("project opencode-quota/quota-toast.json");
    expect(snapshot.sources.waitForQuotaReset).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.sources.percentLabelStyle).toBe("defaults");
  });

  it("never writes a project legacy sidecar and never denies its values", async () => {
    const workspace = makeWorkspace();
    const sidecar = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      dashboard: { hiddenCards: ["card-a"] },
      waitForQuotaReset: true,
    });
    const sidecarBytes = readFileSync(sidecar, "utf8");
    const store = makeStore(workspace);

    const before = await store.settings();
    expect(before.visibility.hiddenCards).toEqual(["card-a"]);
    expect(before.sources["dashboard.hiddenCards"]).toBe("project opencode-quota/quota-toast.json");

    await store.saveVisibility({
      hiddenCards: ["card-b"],
      hiddenRows: ["row-b"],
      expectedRevision: before.revision,
    });

    expect(readFileSync(sidecar, "utf8")).toBe(sidecarBytes);
    const after = await store.settings();
    expect(after.visibility).toEqual({ hiddenCards: ["card-b"], hiddenRows: ["row-b"] });
    expect(after.values.waitForQuotaReset).toBe(true);
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

  it("keeps absolute paths out of the settings payload", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 4999 } });

    const snapshot = await makeStore(workspace).settings();
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) for (const entry of value) walk(entry);
      else if (value && typeof value === "object") {
        for (const entry of Object.values(value)) walk(entry);
      }
    };
    walk(snapshot);

    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) {
      expect(entry).not.toContain(workspace.tempDir);
      expect(entry).not.toContain(workspace.configDir);
      expect(entry).not.toContain(workspace.workspaceRoot);
    }
    expect(snapshot.pathLabel).toBe("opencode-quota-gui/config.jsonc");
  });
});
