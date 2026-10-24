import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../src/contracts/dashboard.js";
import {
  createGuiSettingsStore,
  GUI_SETTINGS_KEYS,
  GUI_SETTINGS_WRITABLE_KEYS,
  GuiSettingsError,
  type GuiSettingsErrorCode,
  type GuiSettingsErrorDetails,
} from "../src/gui/config.js";
import { buildCardId, buildProviderScopeCardId } from "../src/gui/identity.js";
import { getGuiConfigPath } from "../src/lib/config.js";
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

async function expectGuiError<T>(
  run: Promise<T>,
  code: GuiSettingsErrorCode,
  details?: GuiSettingsErrorDetails,
): Promise<GuiSettingsError> {
  const error = await run.then(
    () => null,
    (thrown: Error) => thrown,
  );
  if (!(error instanceof GuiSettingsError)) {
    throw new Error("expected the store to reject with GuiSettingsError");
  }
  expect(error.code).toBe(code);
  if (details) {
    expect(error.details).toMatchObject(details);
  }
  return error;
}

function readCanonicalObject(workspace: GuiConfigWorkspace): Record<string, JsonValue> {
  return JSON.parse(readFileSync(workspace.guiConfigPath, "utf8"));
}

function readDotted(workspace: GuiConfigWorkspace, key: string): JsonValue | undefined {
  let node: JsonValue | undefined = readCanonicalObject(workspace);
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = Array.isArray(node) ? node[Number(part)] : node[part];
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
  "dashboard.providerOrder",
  "dashboard.cardOrder",
  "dashboard.port",
  "dashboard.hiddenCardsVersion",
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
  it("exposes exactly the spec 5.4 table, with the port and semantics version read-only", () => {
    expect([...GUI_SETTINGS_KEYS]).toEqual([...EXPECTED_KEYS]);
    expect([...GUI_SETTINGS_WRITABLE_KEYS]).toEqual(
      EXPECTED_KEYS.filter(
        (key) => key !== "dashboard.port" && key !== "dashboard.hiddenCardsVersion",
      ),
    );
    for (const legacyOnly of LEGACY_ONLY_KEYS) {
      expect(GUI_SETTINGS_KEYS).not.toContain(legacyOnly);
    }
  });

  it("reports defaults for a missing canonical file", async () => {
    const workspace = makeWorkspace();
    const snapshot = await makeStore(workspace).settings();

    expect(snapshot.pathLabel).toBe(getGuiConfigPath(workspace.configDir));
    expect(snapshot.values).toEqual({
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      percentLabelStyle: null,
      quotaProjection: null,
      resetTimeDecimals: null,
      resetTimeSpaced: true,
      waitForQuotaReset: true,
      enabledProviders: "auto",
      minIntervalMs: 60000,
      requestTimeoutMs: 5000,
      accountingDetail: "summary",
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
      opencodeMonthlyLimit: null,
      "dashboard.hiddenCards": [],
      "dashboard.hiddenRows": [],
      "dashboard.providerOrder": [],
      "dashboard.cardOrder": [],
      "dashboard.port": 4144,
      "dashboard.hiddenCardsVersion": 2,
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

  it("normalizes legacy scope ids and stamps version 2 on a generic hidden-card save", async () => {
    const workspace = makeWorkspace();
    const scope = buildProviderScopeCardId("openai");
    const account = buildCardId("openai", "account-1");
    const bareScopeHash = scope.slice(scope.indexOf(":") + 1);
    writeGuiCanonicalConfig(workspace, {
      dashboard: {
        hiddenCards: [scope, account, "unknown-hidden-card", bareScopeHash],
        providerOrder: ["openai", "cursor"],
      },
    });
    const store = makeStore(workspace);
    const before = await store.settings();
    const hiddenCards = before.values["dashboard.hiddenCards"];

    expect(hiddenCards).toEqual(["openai", account, "unknown-hidden-card", bareScopeHash]);
    expect(before.values["dashboard.hiddenCardsVersion"]).toBe(2);

    await store.saveSettings({
      patch: { "dashboard.hiddenCards": hiddenCards as JsonValue },
      expectedRevision: before.revision,
    });

    expect(readDotted(workspace, "dashboard.hiddenCards")).toEqual([
      "openai",
      account,
      "unknown-hidden-card",
      bareScopeHash,
    ]);
    expect(readDotted(workspace, "dashboard.hiddenCardsVersion")).toBe(2);
    expect(readDotted(workspace, "dashboard.providerOrder")).toEqual(["openai", "cursor"]);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).not.toContain(scope);
  });

  it("keeps an exact provider-scope card id under version 2 and stamps saveVisibility", async () => {
    const workspace = makeWorkspace();
    const scope = buildProviderScopeCardId("openai");
    const sibling = buildCardId("openai", "account-1");
    writeGuiCanonicalConfig(workspace, {
      dashboard: { hiddenCardsVersion: 2, hiddenCards: [scope] },
    });
    const store = makeStore(workspace);
    const before = await store.settings();

    expect(before.values["dashboard.hiddenCards"]).toEqual([scope]);
    expect(before.values["dashboard.hiddenCardsVersion"]).toBe(2);

    await store.saveVisibility({
      hiddenCards: [scope],
      hiddenRows: [],
      expectedRevision: before.revision,
    });

    expect(readDotted(workspace, "dashboard.hiddenCards")).toEqual([scope]);
    expect(readDotted(workspace, "dashboard.hiddenCards")).not.toContain(sibling);
    expect(readDotted(workspace, "dashboard.hiddenCardsVersion")).toBe(2);
    expect(readFileSync(workspace.guiConfigPath, "utf8")).toContain(scope);
  });

  it("round-trips the version marker through canonical JSONC", async () => {
    const workspace = makeWorkspace();
    const scope = buildProviderScopeCardId("openai");
    writeGuiCanonicalConfig(
      workspace,
      `{
  // keep the hidden choice
  "dashboard": {
    "hiddenCardsVersion": 2,
    "hiddenCards": ["${scope}"]
  }
}
`,
    );
    const store = makeStore(workspace);
    const before = await store.settings();

    expect(before.values["dashboard.hiddenCards"]).toEqual([scope]);
    expect(before.values["dashboard.hiddenCardsVersion"]).toBe(2);

    await store.saveVisibility({
      hiddenCards: [scope],
      hiddenRows: [],
      expectedRevision: before.revision,
    });

    const raw = readFileSync(workspace.guiConfigPath, "utf8");
    expect(raw).toContain("// keep the hidden choice");
    expect(raw).toMatch(/"hiddenCardsVersion":\s*2/u);
    expect(raw).toContain(scope);
  });

  it("does not erase the semantics marker when hiddenCards is cleared generically", async () => {
    const workspace = makeWorkspace();
    const scope = buildProviderScopeCardId("opencode-go");
    writeGuiCanonicalConfig(workspace, { dashboard: { hiddenCards: [scope] } });
    const store = makeStore(workspace);
    const before = await store.settings();

    expect(before.values["dashboard.hiddenCards"]).toEqual(["opencode-go"]);

    await store.saveSettings({
      patch: { "dashboard.hiddenCards": null },
      expectedRevision: before.revision,
    });

    expect(readDotted(workspace, "dashboard.hiddenCards")).toBeUndefined();
    expect(readDotted(workspace, "dashboard.hiddenCardsVersion")).toBe(2);

    const after = await store.settings();
    expect(after.values["dashboard.hiddenCards"]).toEqual([]);
    expect(after.values["dashboard.hiddenCardsVersion"]).toBe(2);
  });

  it("rejects direct writes to the read-only hiddenCardsVersion marker", async () => {
    const workspace = makeWorkspace();
    const store = makeStore(workspace);
    const before = await store.settings();

    for (const value of [1, 2, null] as const) {
      await expectGuiError(
        store.saveSettings({
          patch: { "dashboard.hiddenCardsVersion": value as JsonValue },
          expectedRevision: before.revision,
        }),
        "invalid-setting",
      );
    }
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
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
    ["dashboard.providerOrder", ["provider-1", "provider-2"], ["provider-1", "provider-2"]],
    ["dashboard.cardOrder", ["card-2", "card-1"], ["card-2", "card-1"]],
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
        "dashboard.providerOrder": ["second", "first", "second"],
        "dashboard.cardOrder": ["card-b", "card-a", "card-b"],
      },
      expectedRevision: before.revision,
    });

    expect(readDotted(workspace, "opencodeGoWindows")).toEqual(["weekly", "monthly"]);
    expect(readDotted(workspace, "dashboard.hiddenCards")).toEqual(["a", "b"]);
    expect(readDotted(workspace, "dashboard.providerOrder")).toEqual(["second", "first"]);
    expect(readDotted(workspace, "dashboard.cardOrder")).toEqual(["card-b", "card-a"]);
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
    ["dashboard.providerOrder", "x"],
    ["dashboard.providerOrder", [""]],
    ["dashboard.providerOrder", ["ok", 1]],
    ["dashboard.cardOrder", "x"],
    ["dashboard.cardOrder", [""]],
    ["dashboard.cardOrder", ["ok", 1]],
    ["dashboard.hiddenCards", Array.from({ length: 501 }, (_value, index) => `card-${index}`)],
    [
      "dashboard.providerOrder",
      Array.from({ length: 501 }, (_value, index) => `provider-${index}`),
    ],
    ["dashboard.cardOrder", Array.from({ length: 501 }, (_value, index) => `card-${index}`)],
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
    expect(after.values.minIntervalMs).toBe(60000);
    expect(after.values.accountingDetail).toBe("summary");
  });

  it("reports symbolic sources and exempts only pathLabel from the absolute-path walk", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1000 });

    const snapshot = await makeStore(workspace).settings();
    // Deliberate narrow exception: only the top-level pathLabel may be absolute.
    const { pathLabel, ...pathFreeSnapshot } = snapshot;
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) for (const entry of value) walk(entry);
      else if (value && typeof value === "object")
        for (const entry of Object.values(value)) walk(entry);
    };
    walk(pathFreeSnapshot);

    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) {
      expect(entry).not.toContain(workspace.tempDir);
    }
    expect(pathLabel).toBe(getGuiConfigPath(workspace.configDir));
  });
});
