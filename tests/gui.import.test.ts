import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createGuiSettingsStore, GuiSettingsError } from "../src/gui/config.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-import-");
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

function keyMap(keys: { key: string; value: unknown }[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((entry) => [entry.key, entry.value]));
}

async function expectGuiError(run: Promise<unknown>, code: string): Promise<GuiSettingsError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GuiSettingsError);
  expect((error as GuiSettingsError).code).toBe(code);
  return error as GuiSettingsError;
}

describe("settings import preview and apply", () => {
  it("previews inherited lower-layer values with a relative source and a covering revision", async () => {
    const workspace = makeWorkspace();
    const sidecar = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
      percentLabelStyle: "bare",
    });
    const store = makeStore(workspace);

    const preview = await store.importPreview();

    expect(preview.from).toBe("project opencode-quota/quota-toast.json");
    expect(keyMap(preview.keys)).toEqual({
      percentLabelStyle: "bare",
      minIntervalMs: 1000,
      accountingDetail: "detailed",
    });
    expect(preview.issues).toEqual([]);
    expect(preview.expectedRevision.length).toBeGreaterThan(0);
    expect(sidecar).toBeDefined();

    const snapshot = await store.settings();
    expect(snapshot.import).toEqual({
      available: true,
      from: "project opencode-quota/quota-toast.json",
      keyCount: 3,
      issues: [],
    });
  });

  it("applies the preview, comments the source, and leaves the legacy file untouched", async () => {
    const workspace = makeWorkspace();
    const sidecar = writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
    });
    const legacyBytes = readFileSync(sidecar, "utf8");
    const store = makeStore(workspace);
    const preview = await store.importPreview();

    const result = await store.importApply({ expectedRevision: preview.expectedRevision });

    expect(result.applied).toEqual({ minIntervalMs: 1000, accountingDetail: "detailed" });
    expect(result.warnings).toEqual([]);
    expect(result.revision).not.toBe(preview.expectedRevision);

    const raw = readFileSync(workspace.guiConfigPath, "utf8");
    expect(raw).toContain("// Imported from project opencode-quota/quota-toast.json");
    expect(readFileSync(sidecar, "utf8")).toBe(legacyBytes);

    const after = await store.settings();
    expect(after.values.minIntervalMs).toBe(1000);
    expect(after.values.accountingDetail).toBe("detailed");
    expect(after.sources.minIntervalMs).toBe("opencode-quota-gui/config.jsonc");
    expect(after.import).toEqual({ available: false, issues: [] });
  });

  it("writes nothing when every inherited value is already in the canonical file", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    const store = makeStore(workspace);
    const preview = await store.importPreview();
    await store.importApply({ expectedRevision: preview.expectedRevision });
    const bytesAfterFirstImport = readFileSync(workspace.guiConfigPath, "utf8");

    const secondPreview = await store.importPreview();
    expect(secondPreview.keys).toEqual([]);
    const second = await store.importApply({ expectedRevision: secondPreview.expectedRevision });

    expect(second.applied).toEqual({});
    expect(second.revision).toBe(secondPreview.expectedRevision);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toBe(bytesAfterFirstImport);
  });

  it("treats an edit to an inherited source between preview and apply as a conflict", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    const store = makeStore(workspace);
    const preview = await store.importPreview();

    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 2000 });

    await expectGuiError(
      store.importApply({ expectedRevision: preview.expectedRevision }),
      "config-changed",
    );
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("treats an edit to the canonical file between preview and apply as a conflict", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    const store = makeStore(workspace);
    const preview = await store.importPreview();

    writeGuiCanonicalConfig(workspace, { waitForQuotaReset: false });

    await expectGuiError(
      store.importApply({ expectedRevision: preview.expectedRevision }),
      "config-changed",
    );
    expect(JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"))).toEqual({
      waitForQuotaReset: false,
    });
  });

  it("does not import keys the canonical file already sets", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      minIntervalMs: 1000,
      accountingDetail: "detailed",
    });
    const store = makeStore(workspace);
    const before = await store.settings();
    await store.saveSettings({
      patch: { accountingDetail: "summary" },
      expectedRevision: before.revision,
    });

    const preview = await store.importPreview();
    expect(keyMap(preview.keys)).toEqual({ minIntervalMs: 1000 });

    const result = await store.importApply({ expectedRevision: preview.expectedRevision });
    expect(result.applied).toEqual({ minIntervalMs: 1000 });
  });

  it("reports inherited-layer issues in the preview and keeps canonical issues out of it", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { quotaProjection: "other" });
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 0 } });
    const store = makeStore(workspace);

    const preview = await store.importPreview();
    expect(preview.issues).toEqual([{ key: "quotaProjection", message: 'expected "runway"' }]);

    const snapshot = await store.settings();
    expect(snapshot.issues.some((issue) => issue.key === "dashboard.port")).toBe(true);
  });

  it("refuses to import into a malformed canonical file and keeps its bytes", async () => {
    const workspace = makeWorkspace();
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1000 });
    writeGuiCanonicalConfig(workspace, "{ broken");
    const store = makeStore(workspace);

    const preview = await store.importPreview();
    expect(keyMap(preview.keys)).toEqual({ minIntervalMs: 1000 });

    await expectGuiError(
      store.importApply({ expectedRevision: preview.expectedRevision }),
      "config-read-error",
    );
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toBe("{ broken");
  });

  it("writes nothing when no lower layer supplies a GUI key", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);

    const preview = await store.importPreview();
    expect(preview.keys).toEqual([]);
    expect(preview.from).toBe("");

    const result = await store.importApply({ expectedRevision: preview.expectedRevision });
    expect(result.applied).toEqual({});
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("imports a legacy value from a plain global opencode.json", async () => {
    const workspace = makeWorkspace();
    writeQuotaToastConfig(workspace.configDir, { requestTimeoutMs: 2500 });
    const store = makeStore(workspace);

    const preview = await store.importPreview();
    expect(preview.from).toBe("global opencode.json (experimental.quotaToast)");
    expect(keyMap(preview.keys)).toEqual({ requestTimeoutMs: 2500 });
  });
});
