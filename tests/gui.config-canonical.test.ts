import { readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore } from "../src/gui/config.js";
import {
  buildConfigLayerCandidates,
  createLoadConfigMeta,
  GUI_CONFIG_RELATIVE_PATH,
  getGuiConfigPath,
  loadConfig,
} from "../src/lib/config.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  quotaConfigSource,
  quotaSidecarConfigSource,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-canonical-");
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

async function load(workspace: GuiConfigWorkspace) {
  const meta = createLoadConfigMeta();
  const config = await loadConfig(undefined, meta, {
    configRootDir: workspace.workspaceRoot,
    globalConfigDir: workspace.configDir,
  });
  return { config, meta };
}

describe("canonical dashboard config layer", () => {
  it("appends the canonical candidate last and keeps it the only one", () => {
    const workspace = makeWorkspace();
    const candidates = buildConfigLayerCandidates(workspace.configDir, workspace.workspaceRoot);

    const last = candidates.at(-1);
    expect(last).toBeDefined();
    expect(last?.path).toBe(getGuiConfigPath(workspace.configDir));
    expect(last?.kind).toBe("canonical");
    expect(last?.scope).toBe("global");
    expect(candidates.filter((candidate) => candidate.kind === "canonical")).toHaveLength(1);
    expect(GUI_CONFIG_RELATIVE_PATH).toBe("opencode-quota-gui/config.jsonc");
  });

  it("applies only the keys the canonical file sets, over every lower layer", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, {
      accountingDetail: "summary",
      waitForQuotaReset: false,
    });

    const { config, meta } = await load(workspace);

    expect(config.accountingDetail).toBe("summary");
    expect(config.waitForQuotaReset).toBe(false);
    expect(config.minIntervalMs).toBe(1000);
    expect(meta.settingSources.accountingDetail).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.minIntervalMs).toBe(
      quotaSidecarConfigSource(workspace.workspaceRoot),
    );
    expect(meta.configIssues).toEqual([]);
  });

  it("does not suppress the legacy layer in the same root", async () => {
    const workspace = makeWorkspace();
    writeQuotaToastConfig(workspace.configDir, {
      percentDisplayMode: "used",
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 2000 });

    const { config, meta } = await load(workspace);

    expect(config.percentDisplayMode).toBe("used");
    expect(config.accountingDetail).toBe("detailed");
    expect(config.minIntervalMs).toBe(2000);
    expect(meta.settingSources.percentDisplayMode).toBe(quotaConfigSource(workspace.configDir));
    expect(meta.settingSources.minIntervalMs).toBe(workspace.guiConfigPath);
  });

  it("parses JSONC comments and trailing commas", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(
      workspace,
      `{
  // GUI-owned values
  "percentDisplayMode": "used",
  "resetTimeDecimals": 2,
  "opencodeGoWindows": ["weekly"],
}
`,
    );

    const { config, meta } = await load(workspace);

    expect(config.percentDisplayMode).toBe("used");
    expect(config.resetTimeDecimals).toBe(2);
    expect(config.opencodeGoWindows).toEqual(["weekly"]);
    expect(meta.configIssues).toEqual([]);
  });

  it("keeps lower layers working on a malformed canonical file and never overwrites it", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { accountingDetail: "detailed" });
    writeGuiCanonicalConfig(workspace, '{ "accountingDetail": ');
    const before = readFileSync(workspace.guiConfigPath, "utf8");

    const { config, meta } = await load(workspace);

    expect(config.accountingDetail).toBe("detailed");
    expect(meta.source).toBe("files");
    const issue = meta.configIssues.find((entry) => entry.path === workspace.guiConfigPath);
    expect(issue).toBeDefined();
    expect(issue?.key).toBe("$root");
    expect(issue?.message).toMatch(/malformed/i);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toBe(before);
  });

  it("reads dashboard.port and reports an invalid port as an issue", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 4999 } });

    const configured = await load(workspace);
    expect(configured.config.dashboard.port).toBe(4999);
    expect(configured.meta.settingSources["dashboard.port"]).toBe(workspace.guiConfigPath);

    writeGuiCanonicalConfig(workspace, { dashboard: { port: 70000 } });
    const invalid = await load(workspace);
    expect(invalid.config.dashboard.port).toBe(4144);
    expect(invalid.meta.configIssues.some((entry) => entry.key === "dashboard.port")).toBe(true);
  });

  it("ignores a sibling config.json and raises an unread issue for it", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 500 });
    writeFileSync(workspace.guiConfigJsonPath, JSON.stringify({ accountingDetail: "detailed" }));

    const snapshot = await createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
    }).settings();

    expect(snapshot.values.accountingDetail).toBe("summary");
    const siblingIssue = snapshot.issues.find((issue) => issue.message.includes("config.json"));
    expect(siblingIssue).toBeDefined();
    for (const issue of snapshot.issues) {
      expect(issue.label).not.toContain(workspace.tempDir);
      expect(issue.message).not.toContain(workspace.tempDir);
    }
  });

  it("still works when only the canonical file exists", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: [] });

    const { config, meta } = await load(workspace);

    expect(meta.source).toBe("files");
    expect(meta.paths).toEqual([workspace.guiConfigPath]);
    expect(config.enabledProviders).toEqual([]);
  });
});
