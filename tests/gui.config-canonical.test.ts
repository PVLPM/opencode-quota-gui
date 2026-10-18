import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
import { symlinkOrSkip } from "./helpers/symlink-capability.js";

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
  it("places the canonical candidate after global legacy layers and before project layers", () => {
    const workspace = makeWorkspace();
    const candidates = buildConfigLayerCandidates(workspace.configDir, workspace.workspaceRoot);

    const canonicalIndex = candidates.findIndex((candidate) => candidate.kind === "canonical");
    expect(canonicalIndex).toBeGreaterThan(0);
    expect(candidates.filter((candidate) => candidate.kind === "canonical")).toHaveLength(1);
    expect(candidates[canonicalIndex]).toMatchObject({
      path: getGuiConfigPath(workspace.configDir),
      kind: "canonical",
      scope: "global",
    });
    expect(
      candidates.slice(0, canonicalIndex).every((candidate) => candidate.scope === "global"),
    ).toBe(true);
    expect(
      candidates.slice(canonicalIndex + 1).every((candidate) => candidate.scope === "workspace"),
    ).toBe(true);
    expect(GUI_CONFIG_RELATIVE_PATH).toBe("opencode-quota-gui/config.jsonc");
  });

  it("applies canonical keys that lower layers do not override and keeps project keys", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1000,
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

  it("lets project values win on keys the canonical file also sets", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 2222,
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, {
      minIntervalMs: 1111,
      accountingDetail: "summary",
      waitForQuotaReset: false,
    });

    const { config, meta } = await load(workspace);

    expect(config.minIntervalMs).toBe(2222);
    expect(config.accountingDetail).toBe("detailed");
    expect(config.waitForQuotaReset).toBe(false);
    expect(meta.settingSources.minIntervalMs).toBe(
      quotaSidecarConfigSource(workspace.workspaceRoot),
    );
    expect(meta.settingSources.accountingDetail).toBe(
      quotaSidecarConfigSource(workspace.workspaceRoot),
    );
    expect(meta.settingSources.waitForQuotaReset).toBe(workspace.guiConfigPath);
    expect(meta.configIssues).toEqual([]);
  });

  it("keeps canonical global precedence over legacy layers in the same root", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.configDir, {
      minIntervalMs: 1000,
      percentDisplayMode: "used",
      accountingDetail: "detailed",
    });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 2000, accountingDetail: "summary" });

    const { config, meta } = await load(workspace);

    expect(config.minIntervalMs).toBe(2000);
    expect(config.accountingDetail).toBe("summary");
    expect(config.percentDisplayMode).toBe("used");
    expect(meta.settingSources.minIntervalMs).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.accountingDetail).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.percentDisplayMode).toBe(
      quotaSidecarConfigSource(workspace.configDir),
    );
    expect(meta.configIssues).toEqual([]);
  });

  it("deduplicates project candidates when the project root is the global config dir", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 1000 });
    writeGuiCanonicalConfig(workspace, {
      minIntervalMs: 2000,
      waitForQuotaReset: false,
      opencodeMonthlyLimit: 0,
    });

    const candidates = buildConfigLayerCandidates(workspace.configDir, workspace.configDir);
    expect(candidates.some((candidate) => candidate.scope === "workspace")).toBe(false);
    expect(candidates.filter((candidate) => candidate.kind === "canonical")).toHaveLength(1);

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspace.configDir,
      globalConfigDir: workspace.configDir,
    });

    expect(config.minIntervalMs).toBe(2000);
    expect(config.waitForQuotaReset).toBe(false);
    expect(config.opencodeMonthlyLimit).toBe(0);
    expect(meta.settingSources.minIntervalMs).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.opencodeMonthlyLimit).toBe(workspace.guiConfigPath);
    expect(meta.configIssues).toEqual([]);
  });

  it("preserves false and zero values from the canonical file", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, {
      waitForQuotaReset: false,
      resetTimeDecimals: 0,
      opencodeMonthlyLimit: 0,
    });

    const { config, meta } = await load(workspace);

    expect(config.waitForQuotaReset).toBe(false);
    expect(config.resetTimeDecimals).toBe(0);
    expect(config.opencodeMonthlyLimit).toBe(0);
    expect(meta.settingSources.waitForQuotaReset).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.resetTimeDecimals).toBe(workspace.guiConfigPath);
    expect(meta.settingSources.opencodeMonthlyLimit).toBe(workspace.guiConfigPath);
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

/**
 * A workspace root path that reaches the same real directory as `dir` but with
 * a differently cased final segment: the natural Windows/macOS case alias when
 * that path already resolves, otherwise a junction/symlink at the same
 * differently cased name. Returns `undefined` after a capability skip when
 * neither is possible.
 */
function differentlyCasedAliasFor(
  context: { skip: (note?: string) => void },
  dir: string,
): string | undefined {
  const base = basename(dir);
  const upper = base.toUpperCase();
  if (upper === base) return undefined;

  const alias = join(dirname(dir), upper);
  if (existsSync(alias)) {
    // A case-insensitive root already resolves the differently cased name.
    if (realpathSync.native(alias) === realpathSync.native(dir)) return alias;
    context.skip("a differently cased path exists here but is a distinct real directory");
    return undefined;
  }

  const linkType = process.platform === "win32" ? "junction" : "dir";
  return symlinkOrSkip(context, dir, alias, linkType) ? alias : undefined;
}

async function expectAliasResolvesAsGlobal(
  workspace: GuiConfigWorkspace,
  aliasRoot: string,
): Promise<void> {
  expect(realpathSync.native(aliasRoot)).toBe(realpathSync.native(workspace.configDir));

  writeQuotaSidecarConfig(workspace.configDir, {
    minIntervalMs: 1000,
    accountingDetail: "detailed",
  });
  writeGuiCanonicalConfig(workspace, { minIntervalMs: 2000 });

  const meta = createLoadConfigMeta();
  const config = await loadConfig(undefined, meta, {
    configRootDir: aliasRoot,
    globalConfigDir: workspace.configDir,
  });

  expect(config.minIntervalMs).toBe(2000);
  expect(config.accountingDetail).toBe("detailed");
  expect(meta.settingSources.minIntervalMs).toBe(workspace.guiConfigPath);
  expect(meta.globalConfigPaths).toContain(workspace.guiConfigPath);
  expect(meta.workspaceConfigPaths).toEqual([]);
  expect(meta.configIssues).toEqual([]);

  const candidates = buildConfigLayerCandidates(workspace.configDir, aliasRoot);
  expect(candidates.some((candidate) => candidate.scope === "workspace")).toBe(false);
}

describe("same-root layer identity", () => {
  it("deduplicates a differently cased workspace root that is the global config dir", async (context) => {
    const workspace = makeWorkspace();
    const aliasRoot = differentlyCasedAliasFor(context, workspace.configDir);
    if (aliasRoot === undefined) return;

    await expectAliasResolvesAsGlobal(workspace, aliasRoot);
  });

  it("deduplicates a junction or symlinked workspace root aliasing the global config dir", async (context) => {
    const workspace = makeWorkspace();
    const aliasRoot = join(workspace.tempDir, "alias-root");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    if (!symlinkOrSkip(context, workspace.configDir, aliasRoot, linkType)) return;

    await expectAliasResolvesAsGlobal(workspace, aliasRoot);
  });

  it("keeps a genuinely case-distinct project root as a project layer", async (context) => {
    const workspace = makeWorkspace();
    const distinctRoot = join(workspace.tempDir, "CONFIG");
    mkdirSync(distinctRoot, { recursive: true });
    if (realpathSync.native(distinctRoot) === realpathSync.native(workspace.configDir)) {
      context.skip("this filesystem is case-insensitive; case-distinct roots cannot coexist");
      return;
    }

    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 1000 });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 2000 });
    writeQuotaSidecarConfig(distinctRoot, { minIntervalMs: 3000 });

    const meta = createLoadConfigMeta();
    const config = await loadConfig(undefined, meta, {
      configRootDir: distinctRoot,
      globalConfigDir: workspace.configDir,
    });

    expect(config.minIntervalMs).toBe(3000);
    expect(meta.settingSources.minIntervalMs).toBe(quotaSidecarConfigSource(distinctRoot));
  });
});
