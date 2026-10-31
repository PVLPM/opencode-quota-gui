import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/contracts/dashboard.js";
import { createGuiSettingsStore } from "../src/gui/config.js";
import { parseSettingsSnapshot } from "../src/ui/dashboard-client.js";
import * as model from "../src/ui/settings-model.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];
function setup() {
  const workspace = createGuiConfigWorkspace("settings-polish-");
  workspaces.push(workspace);
  const store = createGuiSettingsStore(workspace);
  return { workspace, store };
}
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

describe("Settings polish model", () => {
  it("hides six compatibility controls without deleting their descriptors", () => {
    for (const key of [
      "quotaProjection",
      "resetTimeDecimals",
      "resetTimeSpaced",
      "formatStyle",
      "opencodeGoWindows",
      "opencodeMonthlyLimit",
    ]) {
      expect(model.SETTINGS_FIELDS.find((field) => field.key === key)?.hidden).toBe(true);
    }
  });

  it("describes dashboard.enabled as shared metadata without a generic control", () => {
    const field = model.SETTINGS_FIELDS.find((entry) => entry.key === "dashboard.enabled");
    expect(field).toMatchObject({
      group: "dashboard",
      control: "switch",
      hidden: true,
      label: "Web dashboard",
    });
    expect(field?.help).toContain("127.0.0.1");
  });

  it("links descriptor importability to exactly the seven supported concepts", () => {
    expect(
      model.SETTINGS_FIELDS.filter((field) => field.importable)
        .map((field) => field.key)
        .sort(),
    ).toEqual(
      [
        "percentDisplayMode",
        "percentLabelStyle",
        "enabledProviders",
        "minIntervalMs",
        "requestTimeoutMs",
        "accountingDetail",
        "waitForQuotaReset",
      ].sort(),
    );
  });

  it("exposes canonical runtime provenance through the client and concise model notes", async () => {
    const { workspace, store } = setup();
    writeQuotaSidecarConfig(workspace.configDir, { percentDisplayMode: "used" });
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 1234 });
    writeGuiCanonicalConfig(workspace, { accountingDetail: "detailed" });
    const snapshot = parseSettingsSnapshot(
      JSON.parse(JSON.stringify(await store.settings())) as JsonValue,
    );
    expect(snapshot.provenance?.percentDisplayMode).toEqual({ scope: "defaults" });
    expect(snapshot.provenance?.minIntervalMs).toEqual({ scope: "defaults" });
    expect(snapshot.provenance?.accountingDetail).toEqual({ scope: "global" });
    expect(snapshot.provenance?.waitForQuotaReset).toEqual({ scope: "defaults" });
    expect((await store.importPreview()).keys).toEqual([
      { key: "percentDisplayMode", value: "used" },
    ]);
    expect(model.settingProvenanceNote(snapshot, "percentDisplayMode")).toBeUndefined();
    expect(model.settingProvenanceNote(snapshot, "minIntervalMs")).toBeUndefined();
    expect(model.settingProvenanceNote(snapshot, "accountingDetail")).toBeUndefined();
    expect(model.settingProvenanceNote(snapshot, "waitForQuotaReset")).toBeUndefined();
    // Older hosts may still report imported source scopes; the note wording stays stable.
    expect(
      model.settingProvenanceNote(
        { ...snapshot, provenance: { percentDisplayMode: { scope: "legacy" } } },
        "percentDisplayMode",
      ),
    ).toBe("Legacy override");
    expect(
      model.settingProvenanceNote(
        { ...snapshot, provenance: { minIntervalMs: { scope: "workspace" } } },
        "minIntervalMs",
      ),
    ).toBe("Workspace override");
    expect(
      model.settingProvenanceNote({ ...snapshot, provenance: undefined }, "minIntervalMs"),
    ).toBeUndefined();
    expect(() =>
      parseSettingsSnapshot({
        ...JSON.parse(JSON.stringify(snapshot)),
        provenance: { minIntervalMs: { scope: "invented" } },
      }),
    ).toThrow();
  });

  it("never offers ordinary workspace overrides as migration", async () => {
    const { workspace, store } = setup();
    writeQuotaSidecarConfig(workspace.workspaceRoot, {
      percentDisplayMode: "used",
      minIntervalMs: 1000,
    });
    expect((await store.settings()).import.available).toBe(false);
    expect((await store.importPreview()).keys).toEqual([]);
    await store.importApply({ expectedRevision: (await store.importPreview()).expectedRevision });
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("filters preview and apply to seven explicit legacy keys, leaving source bytes untouched", async () => {
    const { workspace, store } = setup();
    const eligible = {
      percentDisplayMode: "used",
      percentLabelStyle: "bare",
      enabledProviders: [],
      minIntervalMs: 1000,
      requestTimeoutMs: 2500,
      accountingDetail: "detailed",
      waitForQuotaReset: false,
    };
    const path = writeQuotaSidecarConfig(workspace.configDir, {
      ...eligible,
      quotaProjection: "runway",
      resetTimeDecimals: 2,
      resetTimeSpaced: false,
      formatStyle: "allWindows",
      opencodeGoWindows: ["weekly"],
      opencodeMonthlyLimit: 20,
      tuiSidebarPanel: { enabled: false },
      dashboard: { hiddenCards: ["synthetic"] },
    });
    const bytes = readFileSync(path, "utf8");
    const preview = await store.importPreview();
    expect(Object.fromEntries(preview.keys.map(({ key, value }) => [key, value]))).toEqual(
      eligible,
    );
    expect(
      (await store.importApply({ expectedRevision: preview.expectedRevision })).applied,
    ).toEqual(eligible);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect((await store.settings()).import.available).toBe(false);
  });

  it("requires a preview rather than accepting a settings revision alone", async () => {
    const { workspace, store } = setup();
    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 1000 });
    await expect(
      store.importApply({ expectedRevision: (await store.settings()).revision }),
    ).rejects.toMatchObject({ code: "config-changed" });
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("offers no migration for hidden-only or canonical-only configuration", async () => {
    const { workspace, store } = setup();
    writeQuotaSidecarConfig(workspace.configDir, {
      formatStyle: "allWindows",
      quotaProjection: "runway",
    });
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1234 });
    expect((await store.settings()).import.available).toBe(false);
    expect((await store.importPreview()).keys).toEqual([]);
  });
});
