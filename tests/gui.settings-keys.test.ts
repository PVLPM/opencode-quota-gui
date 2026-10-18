import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../src/contracts/dashboard.js";
import {
  createGuiSettingsStore,
  GUI_SETTINGS_KEYS,
  GUI_SETTINGS_WRITABLE_KEYS,
  GuiSettingsError,
  type GuiSettingsErrorCode,
} from "../src/gui/config.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-keys-");
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

async function expectGuiError(
  run: Promise<unknown>,
  code: GuiSettingsErrorCode,
  details?: Record<string, unknown>,
): Promise<GuiSettingsError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GuiSettingsError);
  const guiError = error as GuiSettingsError;
  expect(guiError.code).toBe(code);
  if (details) {
    expect(guiError.details).toMatchObject(details);
  }
  return guiError;
}

function readCanonicalObject(workspace: GuiConfigWorkspace): Record<string, unknown> {
  return JSON.parse(readFileSync(workspace.guiConfigPath, "utf8")) as Record<string, unknown>;
}

function readDotted(workspace: GuiConfigWorkspace, key: string): unknown {
  let node: unknown = readCanonicalObject(workspace);
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const EXPECTED_KEYS = [
  "formatStyle",
  "percentDisplayMode",
  "percentLabelStyle",
  "quotaProjection",
  "resetTimeDecimals",
  "resetTimeSpaced",
  "waitForQuotaReset",
  "enabledProviders",
  "minIntervalMs",
  "requestTimeoutMs",
  "accountingDetail",
  "opencodeGoWindows",
  "opencodeMonthlyLimit",
  "dashboard.hiddenCards",
  "dashboard.hiddenRows",
  "dashboard.port",
] as const;

const LEGACY_ONLY_KEYS = [
  "enabled",
  "enableToast",
  "resetNotifications.enabled",
  "resetNotifications.windows",
  "tuiSidebarPanel.enabled",
  "tuiCompactStatus.enabled",
  "telemetry.enabled",
  "toastDurationMs",
  "debug",
  "showOnIdle",
  "onlyCurrentModel",
] as const;

describe("GUI settings keys", () => {
  it("exposes exactly the spec 5.4 table, with the port read-only", () => {
    expect([...GUI_SETTINGS_KEYS]).toEqual([...EXPECTED_KEYS]);
    expect([...GUI_SETTINGS_WRITABLE_KEYS]).toEqual(
      EXPECTED_KEYS.filter((key) => key !== "dashboard.port"),
    );
    for (const legacyOnly of LEGACY_ONLY_KEYS) {
      expect(GUI_SETTINGS_KEYS as readonly string[]).not.toContain(legacyOnly);
    }
  });

  it("reports defaults for a missing canonical file", async () => {
    const workspace = makeWorkspace();
    const snapshot = await makeStore(workspace).settings();

    expect(snapshot.pathLabel).toBe("opencode-quota-gui/config.jsonc");
    expect(snapshot.values).toEqual({
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      percentLabelStyle: null,
      quotaProjection: null,
      resetTimeDecimals: null,
      resetTimeSpaced: true,
      waitForQuotaReset: true,
      enabledProviders: "auto",
      minIntervalMs: 300000,
      requestTimeoutMs: 5000,
      accountingDetail: "summary",
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
      opencodeMonthlyLimit: null,
      "dashboard.hiddenCards": [],
      "dashboard.hiddenRows": [],
      "dashboard.port": 4144,
    });
    expect(snapshot.sources).toEqual(
      Object.fromEntries(EXPECTED_KEYS.map((key) => [key, "defaults"])),
    );
    expect([...snapshot.writable]).toEqual([...GUI_SETTINGS_WRITABLE_KEYS]);
    expect(snapshot.dashboard).toEqual({ port: 4144, url: "http://127.0.0.1:4144" });
    expect(snapshot.visibility).toEqual({ hiddenCards: [], hiddenRows: [] });
    expect(snapshot.import).toEqual({ available: false, issues: [] });
    expect(snapshot.issues).toEqual([]);
  });

  it("reads dashboard.port from the canonical file and keeps it read-only", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 4999 } });
    const store = makeStore(workspace);

    const snapshot = await store.settings();
    expect(snapshot.values["dashboard.port"]).toBe(4999);
    expect(snapshot.dashboard).toEqual({ port: 4999, url: "http://127.0.0.1:4999" });
    expect(snapshot.sources["dashboard.port"]).toBe("opencode-quota-gui/config.jsonc");

    const error = await expectGuiError(
      store.saveSettings({
        patch: { "dashboard.port": 5000 },
        expectedRevision: snapshot.revision,
      }),
      "invalid-setting",
    );
    expect(error.message).not.toContain(workspace.tempDir);
    expect(readDotted(workspace, "dashboard.port")).toBe(4999);
  });

  it("reports an invalid configured port instead of failing", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 70000 } });

    const snapshot = await makeStore(workspace).settings();
    expect(snapshot.dashboard.port).toBe(4144);
    expect(snapshot.issues.some((issue) => issue.key === "dashboard.port")).toBe(true);
  });

  const writeCases: Array<[string, JsonValue, JsonValue]> = [
    ["formatStyle", "allWindows", "allWindows"],
    ["percentDisplayMode", "used", "used"],
    ["percentLabelStyle", "bare", "bare"],
    ["quotaProjection", "runway", "runway"],
    ["resetTimeDecimals", 0, 0],
    ["resetTimeDecimals", 4, 4],
    ["resetTimeSpaced", false, false],
    ["waitForQuotaReset", false, false],
    ["enabledProviders", "auto", "auto"],
    ["enabledProviders", [], []],
    ["enabledProviders", ["openai"], ["openai"]],
    ["minIntervalMs", 0.5, 0.5],
    ["requestTimeoutMs", 1, 1],
    ["accountingDetail", "detailed", "detailed"],
    ["opencodeGoWindows", ["weekly"], ["weekly"]],
    ["opencodeMonthlyLimit", 0, 0],
    ["opencodeMonthlyLimit", 42.5, 42.5],
    ["dashboard.hiddenCards", ["card-1"], ["card-1"]],
    ["dashboard.hiddenRows", ["card-1#row-1"], ["card-1#row-1"]],
  ];

  it.each(writeCases)("writes %s = %j for real", async (key, value, expected) => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    const result = await store.saveSettings({
      patch: { [key]: value },
      expectedRevision: before.revision,
    });

    expect(result.applied).toEqual({ [key]: expected });
    expect(result.warnings).toEqual([]);
    expect(readDotted(workspace, key)).toEqual(expected);

    const after = await store.settings();
    expect(after.values[key]).toEqual(expected);
    expect(after.sources[key]).toBe("opencode-quota-gui/config.jsonc");
  });

  it("clears a key with null and keeps zero and false as real values", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const first = await store.settings();
    await store.saveSettings({
      patch: { percentLabelStyle: "bare", resetTimeDecimals: 0, resetTimeSpaced: false },
      expectedRevision: first.revision,
    });

    const loaded = await store.settings();
    expect(loaded.values.resetTimeDecimals).toBe(0);
    expect(loaded.values.resetTimeSpaced).toBe(false);

    const cleared = await store.saveSettings({
      patch: { percentLabelStyle: null, resetTimeDecimals: null },
      expectedRevision: loaded.revision,
    });
    expect(cleared.applied).toEqual({ percentLabelStyle: null, resetTimeDecimals: null });

    const after = await store.settings();
    expect(after.values.percentLabelStyle).toBeNull();
    expect(after.values.resetTimeDecimals).toBeNull();
    expect(after.values.resetTimeSpaced).toBe(false);
    expect(after.sources.percentLabelStyle).toBe("defaults");

    const raw = readFileSync(workspace.guiConfigPath, "utf8");
    expect(raw).not.toContain("percentLabelStyle");
    expect(raw).not.toContain("resetTimeDecimals");
    expect(raw).toContain('"resetTimeSpaced": false');
  });

  it("normalizes enabledProviders and warns about unknown ids", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    const result = await store.saveSettings({
      patch: { enabledProviders: ["openai", "not-a-provider"] },
      expectedRevision: before.revision,
    });

    expect(result.applied).toEqual({ enabledProviders: ["openai"] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.key).toBe("enabledProviders");
    expect(result.warnings[0]?.message).toContain("not-a-provider");
    expect(readDotted(workspace, "enabledProviders")).toEqual(["openai"]);
  });

  it("accepts legacy formatStyle aliases and stores the canonical value", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    const result = await store.saveSettings({
      patch: { formatStyle: "grouped" },
      expectedRevision: before.revision,
    });

    expect(result.applied).toEqual({ formatStyle: "allWindows" });
    expect(readDotted(workspace, "formatStyle")).toBe("allWindows");
  });

  it("dedupes list values", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    await store.saveSettings({
      patch: {
        opencodeGoWindows: ["weekly", "weekly", "monthly"],
        "dashboard.hiddenCards": ["a", "a", "b"],
      },
      expectedRevision: before.revision,
    });

    expect(readDotted(workspace, "opencodeGoWindows")).toEqual(["weekly", "monthly"]);
    expect(readDotted(workspace, "dashboard.hiddenCards")).toEqual(["a", "b"]);
  });

  it("rejects unknown keys with unknown-setting and writes nothing", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    for (const key of ["telemetry.enabled", "debug", "nope"]) {
      const error = await expectGuiError(
        store.saveSettings({ patch: { [key]: true }, expectedRevision: before.revision }),
        "unknown-setting",
      );
      expect(error.message).not.toContain(workspace.tempDir);
    }
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  const invalidCases: Array<[string, JsonValue]> = [
    ["formatStyle", "fancy"],
    ["percentDisplayMode", "nope"],
    ["percentLabelStyle", "x"],
    ["quotaProjection", "other"],
    ["resetTimeDecimals", 5],
    ["resetTimeDecimals", -1],
    ["resetTimeDecimals", 1.5],
    ["resetTimeSpaced", 1],
    ["waitForQuotaReset", "yes"],
    ["enabledProviders", "nope"],
    ["enabledProviders", ["not-a-provider"]],
    ["enabledProviders", [42]],
    ["minIntervalMs", 0],
    ["minIntervalMs", -5],
    ["minIntervalMs", Number.POSITIVE_INFINITY],
    ["minIntervalMs", "500"],
    ["requestTimeoutMs", 0],
    ["accountingDetail", "x"],
    ["opencodeGoWindows", []],
    ["opencodeGoWindows", ["weekly", "nope"]],
    ["opencodeMonthlyLimit", -1],
    ["opencodeMonthlyLimit", "0"],
    ["dashboard.hiddenCards", "x"],
    ["dashboard.hiddenRows", [1]],
    ["dashboard.hiddenCards", Array.from({ length: 501 }, (_value, index) => `card-${index}`)],
  ];

  it.each(invalidCases)("rejects invalid %s = %j with invalid-setting", async (key, value) => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    await expectGuiError(
      store.saveSettings({ patch: { [key]: value }, expectedRevision: before.revision }),
      "invalid-setting",
    );
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
  });

  it("applies no part of a patch that contains an invalid value", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    await expectGuiError(
      store.saveSettings({
        patch: { minIntervalMs: 1000, accountingDetail: "nope" },
        expectedRevision: before.revision,
      }),
      "invalid-setting",
    );

    expect(existsSync(workspace.guiConfigPath)).toBe(false);
    const after = await store.settings();
    expect(after.values.minIntervalMs).toBe(300000);
    expect(after.values.accountingDetail).toBe("summary");
  });

  it("reports symbolic sources and never an absolute path in the snapshot", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1000 });

    const snapshot = await makeStore(workspace).settings();
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) for (const entry of value) walk(entry);
      else if (value && typeof value === "object")
        for (const entry of Object.values(value)) walk(entry);
    };
    walk(snapshot);

    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) {
      expect(entry).not.toContain(workspace.tempDir);
    }
  });
});
