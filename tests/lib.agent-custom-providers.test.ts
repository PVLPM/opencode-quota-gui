import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuiSettingsStore } from "../src/gui/config.js";
import {
  createSafeAgentProviderFetch,
  requestPinnedAddressForTest,
  type SafeProviderAddress,
  type SafeProviderRequest,
} from "../src/lib/agent-custom-provider-network.js";
import {
  agentCustomProviderTrustFingerprint,
  createAgentCustomProviderStore,
} from "../src/lib/agent-custom-providers.js";
import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";
import type { QuotaProviderDefinition } from "../src/lib/quota-providers.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaToastConfig,
} from "./helpers/config-loader-test-harness.js";
import { symlinkOrSkip } from "./helpers/symlink-capability.js";

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-agent-custom-provider-");
  workspaces.push(workspace);
  return workspace;
}

function remoteDefinition(
  overrides: Partial<Extract<QuotaProviderDefinition, { mode: "remote-api" }>> = {},
): Extract<QuotaProviderDefinition, { mode: "remote-api" }> {
  return {
    id: "acme-quota",
    providerId: "acme",
    label: "Acme Quota",
    mode: "remote-api",
    url: "https://quota.example.test/v1/quota/private-path-marker",
    format: "quota-v1",
    apiKeyEnv: "ACME_QUOTA_KEY",
    ...overrides,
  };
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
  vi.unstubAllEnvs();
});

describe("agent custom-provider backend", () => {
  it("stores new proposals only in the canonical config and leaves them disabled", async () => {
    const workspace = makeWorkspace();
    const upstreamConfig = join(workspace.configDir, "opencode.json");
    const legacyConfig = join(workspace.workspaceRoot, "opencode.json");
    const upstreamBytes = JSON.stringify({
      provider: { user: { options: { apiKey: "upstream-secret-marker" } } },
    });
    await writeFile(upstreamConfig, upstreamBytes, "utf8");
    writeQuotaToastConfig(workspace.workspaceRoot, {
      quotaProviders: [remoteDefinition({ id: "legacy" })],
    });
    const legacyBytes = await readFile(legacyConfig, "utf8");
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    const result = await store.add(remoteDefinition());
    const canonical = JSON.parse(await readFile(workspace.guiConfigPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({
      id: "acme-quota",
      providerId: "acme",
      mode: "remote-api",
      trusted: false,
      enabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-path-marker");
    expect(JSON.stringify(result)).not.toContain("upstream-secret-marker");
    expect(canonical.enabledProviders).toBe("auto");
    expect(canonical.quotaProviders).toEqual([]);
    expect(canonical.agentCustomProviders).toEqual([
      { definition: remoteDefinition(), trustedDefinitionHash: null, enabled: false },
    ]);
    await expect(readFile(upstreamConfig, "utf8")).resolves.toBe(upstreamBytes);
    await expect(readFile(legacyConfig, "utf8")).resolves.toBe(legacyBytes);
  });

  it("rejects a duplicate proposal without replacing its saved definition", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto" });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await store.add(remoteDefinition());
    const before = await readFile(workspace.guiConfigPath, "utf8");

    await expect(
      store.add(remoteDefinition({ url: "https://other.example.test/quota" })),
    ).rejects.toMatchObject({ code: "duplicate-id" });
    await expect(readFile(workspace.guiConfigPath, "utf8")).resolves.toBe(before);
  });

  it("reads useful request and mapping details without resolving credential values", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const secret = "read-only-secret-marker";
    vi.stubEnv("ACME_QUOTA_KEY", secret);
    const getEnv = vi.fn(() => secret);
    const definition = remoteDefinition({
      id: "mapped-quota",
      providerId: "mapped",
      format: "json-v1",
      adapter: {
        rowsPath: ["data", "rows"],
        mappings: [
          {
            resultType: "quota",
            name: "Requests",
            metric: {
              type: "remaining-limit",
              remaining: { path: ["remaining"] },
              limit: { path: ["limit"] },
            },
          },
        ],
      },
    });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir, getEnv });

    await store.add(definition);
    const result = await store.read("mapped-quota");

    expect(result).toMatchObject({
      id: "mapped-quota",
      enabled: false,
      definition: {
        id: "mapped-quota",
        providerId: "mapped",
        label: "[redacted]",
        mode: "remote-api",
        url: "https://quota.example.test/[redacted]/[redacted]/[redacted]",
        format: "json-v1",
        apiKeyEnv: "ACME_QUOTA_KEY",
        adapter: {
          rowsPath: ["[redacted]", "[redacted]"],
          mappings: [
            {
              resultType: "quota",
              name: "[redacted]",
              metric: {
                type: "remaining-limit",
                remaining: { path: ["[redacted]"] },
                limit: { path: ["[redacted]"] },
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(getEnv).not.toHaveBeenCalled();
  });

  it("redacts path and display values while preserving request and mapping structure", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const markers = [
      "url-path-resource",
      "display-label-value",
      "adapter-path-field",
      "adapter-literal-value",
      "claude-3-7-sonnet-20250219",
    ];
    const definition = remoteDefinition({
      label: markers[1],
      url: `https://quota.example.test/v1/${markers[0]}`,
      modelIds: [markers[4]!],
      format: "json-v1",
      adapter: {
        rowsPath: ["data", markers[2]!],
        mappings: [
          {
            resultType: "quota",
            name: markers[1]!,
            label: markers[1]!,
            unit: markers[1]!,
            unitPosition: "suffix",
            resetTime: {
              literal: "2025-01-01T00:00:00Z",
              encoding: "iso-8601",
            },
            observedTime: { path: [markers[2]!, "observed"], encoding: "iso-8601" },
            metric: {
              type: "remaining-limit",
              remaining: { path: [markers[2]!] },
              limit: { path: ["limit"] },
            },
          },
          {
            resultType: "status",
            name: "Status",
            metric: {
              type: "status",
              value: { literal: markers[3]! },
            },
          },
          {
            resultType: "usage",
            name: "Usage",
            metric: { type: "value", valueType: "used", value: { literal: 42 } },
          },
        ],
      },
    });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await store.add(definition);

    const result = await store.read("acme-quota");
    const serialized = JSON.stringify(result);

    for (const marker of markers) expect(serialized).not.toContain(marker);
    expect(result.definition).toMatchObject({
      label: "[redacted]",
      url: "https://quota.example.test/[redacted]/[redacted]",
      modelIds: ["[redacted]"],
      apiKeyEnv: "ACME_QUOTA_KEY",
      adapter: {
        rowsPath: ["[redacted]", "[redacted]"],
        mappings: [
          {
            name: "[redacted]",
            label: "[redacted]",
            unit: "[redacted]",
            unitPosition: "suffix",
            resetTime: { literal: "[redacted]", encoding: "iso-8601" },
            observedTime: {
              path: ["[redacted]", "[redacted]"],
              encoding: "iso-8601",
            },
            metric: {
              type: "remaining-limit",
              remaining: { path: ["[redacted]"] },
              limit: { path: ["[redacted]"] },
            },
          },
          {
            name: "[redacted]",
            metric: { type: "status", value: { literal: "[redacted]" } },
          },
          {
            name: "[redacted]",
            metric: { type: "value", valueType: "used", value: { literal: 42 } },
          },
        ],
      },
    });
  });

  it("redacts path and free-form values without restricting proposals or stored parsing", async () => {
    const apiKey = "sk-proj-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    const definitions = [
      remoteDefinition({
        id: "credential-url-path",
        url: `https://quota.example.test/v1/${apiKey}`,
      }),
      remoteDefinition({
        id: "credential-encoded-url-path",
        url: `https://quota.example.test/v1/${apiKey.replace("sk-proj-", "%73k%2Dproj%2D")}`,
      }),
      remoteDefinition({
        id: "credential-literal",
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "status",
              name: "Status",
              metric: {
                type: "status",
                value: { literal: `Authorization: Bearer ${apiKey}` },
              },
            },
          ],
        },
      }),
      remoteDefinition({
        id: "simple-secret-fields",
        label: "plain-secret-value",
        url: "https://quota.example.test/v1/customer-private-path",
        modelIds: ["claude-3-7-sonnet-20250219"],
        format: "json-v1",
        adapter: {
          rowsPath: ["data", "private-response-key"],
          mappings: [
            {
              resultType: "status",
              name: "private-display-label",
              metric: {
                type: "status",
                value: { literal: "plain-secret-literal" },
              },
            },
          ],
        },
      }),
    ];

    for (const definition of definitions) await store.add(definition);
    await expect(store.list()).resolves.toHaveLength(definitions.length);

    for (const definition of definitions) {
      const result = await store.read(definition.id);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(result.definition.apiKeyEnv).toBe("ACME_QUOTA_KEY");
    }

    const simpleSecretRead = await store.read("simple-secret-fields");
    const serialized = JSON.stringify(simpleSecretRead);
    for (const marker of [
      "plain-secret-value",
      "customer-private-path",
      "claude-3-7-sonnet-20250219",
      "private-response-key",
      "private-display-label",
      "plain-secret-literal",
    ]) {
      expect(serialized).not.toContain(marker);
    }
    expect(simpleSecretRead.definition).toMatchObject({
      id: "simple-secret-fields",
      label: "[redacted]",
      url: "https://quota.example.test/[redacted]/[redacted]",
      modelIds: ["[redacted]"],
      adapter: {
        rowsPath: ["[redacted]", "[redacted]"],
        mappings: [
          {
            name: "[redacted]",
            metric: { type: "status", value: { literal: "[redacted]" } },
          },
        ],
      },
    });
  });

  it("reads local estimate windows from the stored definition", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const definition: QuotaProviderDefinition = {
      id: "local-gateway",
      providerId: "local-provider",
      label: "Local Gateway",
      mode: "local-estimate",
      windows: [{ id: "daily", label: "Daily", type: "utc-day", requestLimit: 10, usdBudget: 5 }],
      pricingModelMap: { "private-model-id": "anthropic/claude-sonnet-4-5" },
    };
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    await store.add(definition);

    await expect(store.read("local-gateway")).resolves.toMatchObject({
      definition: {
        ...definition,
        label: "[redacted]",
        windows: [{ ...definition.windows[0], label: "[redacted]" }],
        pricingModelMap: { "[redacted-key-1]": "[redacted]" },
      },
    });
    const result = await store.read("local-gateway");
    expect(JSON.stringify(result)).not.toContain("private-model-id");
  });

  it("fails closed without echoing unknown stored record or definition fields", async () => {
    const secret = "unknown-field-secret-marker";
    const cases = [
      {
        id: "unknown-record-field",
        record: {
          definition: remoteDefinition({ id: "unknown-record-field" }),
          trustedDefinitionHash: null,
          enabled: false,
          credential: secret,
        },
        errorCode: "config-invalid",
      },
      {
        id: "unknown-definition-field",
        record: {
          definition: {
            ...remoteDefinition({ id: "unknown-definition-field" }),
            credential: secret,
          },
          trustedDefinitionHash: null,
          enabled: false,
        },
        errorCode: "invalid-definition",
      },
    ] as const;

    for (const { id, record, errorCode } of cases) {
      const workspace = makeWorkspace();
      writeGuiCanonicalConfig(workspace, { agentCustomProviders: [record] });
      const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
      let error: unknown;
      try {
        await store.read(id);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: errorCode });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("accepts more than 100 stored custom-provider proposals", async () => {
    const workspace = makeWorkspace();
    const existingRecords = Array.from({ length: 100 }, (_, index) => {
      const definition = remoteDefinition({
        id: `provider-${index}`,
        providerId: `upstream-${index}`,
      });
      return { definition, trustedDefinitionHash: null, enabled: false };
    });
    writeGuiCanonicalConfig(workspace, { agentCustomProviders: existingRecords });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    await store.add(remoteDefinition({ id: "provider-extra", providerId: "upstream-extra" }));

    await expect(store.list()).resolves.toHaveLength(101);
  });

  it("binds queued writes to their captured canonical bytes instead of rebasing them", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    const results = await Promise.allSettled([
      store.add(remoteDefinition()),
      store.add(remoteDefinition({ id: "second-quota", providerId: "second" })),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const canonical = JSON.parse(await readFile(workspace.guiConfigPath, "utf8")) as {
      enabledProviders: unknown;
      quotaProviders?: unknown;
      agentCustomProviders?: unknown[];
    };

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "config-changed" } });
    expect(canonical.enabledProviders).toBe("auto");
    expect(canonical.quotaProviders).toEqual([]);
    expect(canonical.agentCustomProviders).toHaveLength(1);
  });

  it("coordinates GUI settings and proposal writes on the shared canonical path", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    const gui = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
    });
    const initial = await gui.settings();

    const outcomes = await Promise.allSettled([
      store.add(remoteDefinition()),
      gui.saveSettings({
        patch: { minIntervalMs: 90_000 },
        expectedRevision: initial.revision,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: { code: "config-changed" } });

    const canonical = JSON.parse(await readFile(workspace.guiConfigPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(
      canonical.agentCustomProviders === undefined || Array.isArray(canonical.agentCustomProviders),
    ).toBe(true);
    expect(canonical.minIntervalMs === undefined || canonical.minIntervalMs === 90_000).toBe(true);
  });

  it("invalidates trust when material definition changes but not when only the label changes", async () => {
    const workspace = makeWorkspace();
    const original = remoteDefinition();
    writeGuiCanonicalConfig(workspace, {
      agentCustomProviders: [
        {
          definition: original,
          trustedDefinitionHash: agentCustomProviderTrustFingerprint(original),
        },
      ],
    });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    await expect(store.read("acme-quota")).resolves.toMatchObject({
      trusted: true,
      enabled: false,
    });
    await writeFile(
      workspace.guiConfigPath,
      JSON.stringify({
        agentCustomProviders: [
          {
            definition: { ...original, label: "Renamed" },
            trustedDefinitionHash: agentCustomProviderTrustFingerprint(original),
          },
        ],
      }),
      "utf8",
    );
    await expect(store.read("acme-quota")).resolves.toMatchObject({
      trusted: true,
      enabled: false,
    });

    await writeFile(
      workspace.guiConfigPath,
      JSON.stringify({
        agentCustomProviders: [
          {
            definition: { ...original, url: "https://new.example.test/v1/quota" },
            trustedDefinitionHash: agentCustomProviderTrustFingerprint(original),
          },
        ],
      }),
      "utf8",
    );
    await expect(store.read("acme-quota")).resolves.toMatchObject({
      trusted: false,
      enabled: false,
    });
  });

  it("never resolves credentials for an agent test, even when the proposal names an env variable", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const secret = "runtime-only-secret-marker";
    vi.stubEnv("ACME_QUOTA_KEY", secret);
    const getEnv = vi.fn(() => secret);
    const testProvider = vi.fn(async (_definition: unknown, key: string | undefined) => {
      expect(key).toBeUndefined();
      return {
        success: true as const,
        entries: [
          {
            kind: "value" as const,
            name: "secret-row-marker",
            value: secret,
            accounting: {
              resultType: "balance" as const,
              acquisitionMethod: "remote_api" as const,
              ownership: "user_configured" as const,
              authority: "provider_reported" as const,
            },
          },
        ],
      };
    });
    const store = createAgentCustomProviderStore({
      configDir: workspace.configDir,
      getEnv,
      testProvider,
    });
    await store.add(remoteDefinition());
    const before = await readFile(workspace.guiConfigPath, "utf8");

    const result = await store.test("acme-quota");

    expect(result).toMatchObject({ status: "passed", trusted: false, enabled: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("secret-row-marker");
    expect(JSON.stringify(result)).not.toContain("private-path-marker");
    expect(testProvider).toHaveBeenCalledOnce();
    expect(getEnv).not.toHaveBeenCalled();
    await expect(readFile(workspace.guiConfigPath, "utf8")).resolves.toBe(before);
  });

  it("exposes explicit user approval and enable operations bound to the reviewed definition revision", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await store.add(remoteDefinition());

    const proposal = await store.listForUser();
    expect(proposal.providers[0]).toMatchObject({
      id: "acme-quota",
      approved: false,
      enabled: false,
      definition: remoteDefinition(),
    });
    await expect(store.setEnabled("acme-quota", true, proposal.revision)).rejects.toMatchObject({
      code: "approval-required",
    });

    const approved = await store.approve("acme-quota", proposal.revision);
    expect(approved.providers[0]).toMatchObject({ approved: true, enabled: false });
    const enabled = await store.setEnabled("acme-quota", true, approved.revision);
    expect(enabled.providers[0]).toMatchObject({ approved: true, enabled: true });
    await expect(store.read("acme-quota")).resolves.toMatchObject({
      trusted: true,
      enabled: false,
    });
  });

  it("requires the user to disable an enabled proposal before agent removal", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await store.add(remoteDefinition());
    const proposal = await store.listForUser();
    const approved = await store.approve("acme-quota", proposal.revision);
    const enabled = await store.setEnabled("acme-quota", true, approved.revision);

    await expect(store.remove("acme-quota")).rejects.toMatchObject({ code: "provider-enabled" });
    await expect(store.listForUser()).resolves.toMatchObject({
      providers: [{ id: "acme-quota", approved: true, enabled: true }],
    });

    const disabled = await store.setEnabled("acme-quota", false, enabled.revision);
    await expect(store.remove("acme-quota")).resolves.toEqual({
      id: "acme-quota",
      removed: true,
    });
    await expect(store.listForUser()).resolves.toMatchObject({ providers: [] });
    expect(disabled.revision).not.toBe(enabled.revision);
  });

  it("provides the same user-owned review seam through GUI settings without secret values", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const agentStore = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await agentStore.add(remoteDefinition());
    const gui = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
    });

    const list = gui.agentCustomProviders;
    const approve = gui.approveAgentCustomProvider;
    const setEnabled = gui.setAgentCustomProviderEnabled;
    if (!list || !approve || !setEnabled) throw new Error("GUI approval seam was not installed");
    const proposal = await list();
    expect(proposal.providers[0]).toMatchObject({ approved: false, enabled: false });
    expect(JSON.stringify(proposal)).not.toContain("runtime-only-secret");

    const approved = await approve({ id: "acme-quota", expectedRevision: proposal.revision });
    const enabled = await setEnabled({
      id: "acme-quota",
      enabled: true,
      expectedRevision: approved.revision,
    });
    expect(enabled.providers[0]).toMatchObject({ approved: true, enabled: true });
    expect(JSON.stringify(enabled)).not.toContain("approved-test-key-marker");
  });

  it("loads only explicitly enabled proposals whose approval fingerprint still matches", async () => {
    const workspace = makeWorkspace();
    const definition = remoteDefinition();
    const trustedHash = agentCustomProviderTrustFingerprint(definition);
    writeGuiCanonicalConfig(workspace, {
      enabledProviders: "auto",
      quotaProviders: [],
      agentCustomProviders: [{ definition, trustedDefinitionHash: trustedHash, enabled: true }],
    });

    const enabled = await loadConfig(undefined, createLoadConfigMeta(), {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });
    expect(enabled.quotaProviders).toEqual([definition]);
    expect(enabled.agentCustomProviderTrust).toEqual({ "acme-quota": trustedHash });

    writeGuiCanonicalConfig(workspace, {
      enabledProviders: "auto",
      quotaProviders: [],
      agentCustomProviders: [
        {
          definition: remoteDefinition({ url: "https://attacker.example.test/quota" }),
          trustedDefinitionHash: trustedHash,
          enabled: true,
        },
      ],
    });
    const changed = await loadConfig(undefined, createLoadConfigMeta(), {
      configRootDir: workspace.workspaceRoot,
      globalConfigDir: workspace.configDir,
    });
    expect(changed.quotaProviders).toEqual([]);
    expect(changed.agentCustomProviderTrust).toEqual({});
  });

  it("requires current user approval before a credential-bearing test and ties that approval to the endpoint", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [] });
    const secret = "approved-test-key-marker";
    const getEnv = vi.fn((name: string) => (name === "ACME_QUOTA_KEY" ? secret : undefined));
    const testProvider = vi.fn(async (_definition: unknown, key: string | undefined) => ({
      success: key === secret,
      entries: [],
    }));
    const store = createAgentCustomProviderStore({
      configDir: workspace.configDir,
      getEnv,
      testProvider,
    });
    await store.add(remoteDefinition());
    const proposal = await store.listForUser();

    await expect(store.testApproved("acme-quota", proposal.revision)).rejects.toMatchObject({
      code: "approval-required",
    });
    expect(getEnv).not.toHaveBeenCalled();

    const approved = await store.approve("acme-quota", proposal.revision);
    const result = await store.testApproved("acme-quota", approved.revision);
    expect(result).toMatchObject({ status: "passed", trusted: true, enabled: false });
    expect(getEnv).toHaveBeenCalledOnce();
    expect(testProvider).toHaveBeenCalledWith(remoteDefinition(), secret);
    expect(JSON.stringify(result)).not.toContain(secret);

    await writeFile(
      workspace.guiConfigPath,
      JSON.stringify({
        agentCustomProviders: [
          {
            definition: remoteDefinition({ url: "https://attacker.example.test/quota" }),
            trustedDefinitionHash: agentCustomProviderTrustFingerprint(remoteDefinition()),
            enabled: true,
          },
        ],
      }),
      "utf8",
    );
    const changed = await store.listForUser();
    await expect(store.testApproved("acme-quota", changed.revision)).rejects.toMatchObject({
      code: "approval-required",
    });
    expect(getEnv).toHaveBeenCalledOnce();
  });

  it("rejects secret-bearing unknown fields without echoing submitted values", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, {});
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    const secret = "submitted-inline-secret-marker";

    await expect(store.add({ ...remoteDefinition(), apiKey: secret })).rejects.toMatchObject({
      code: "invalid-definition",
    });
    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(workspace.guiConfigPath, "utf8")).resolves.toBe("{}\n");
  });

  it("refuses a canonical-file symlink to opencode.json without reading or changing that file", async (context) => {
    const workspace = makeWorkspace();
    const upstreamConfig = join(workspace.configDir, "opencode.json");
    const upstreamBytes = JSON.stringify({ provider: { untouched: {} } });
    await writeFile(upstreamConfig, upstreamBytes, "utf8");
    await mkdir(workspace.guiConfigDir, { recursive: true });
    if (!symlinkOrSkip(context, upstreamConfig, workspace.guiConfigPath, "file")) return;
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });

    await expect(store.add(remoteDefinition())).rejects.toMatchObject({
      code: "unsafe-config-target",
    });
    await expect(readFile(upstreamConfig, "utf8")).resolves.toBe(upstreamBytes);
  });

  it("removes only a proposal and leaves active quota providers untouched", async () => {
    const workspace = makeWorkspace();
    const active = remoteDefinition({ id: "active-provider", providerId: "active" });
    writeGuiCanonicalConfig(workspace, { enabledProviders: "auto", quotaProviders: [active] });
    const store = createAgentCustomProviderStore({ configDir: workspace.configDir });
    await store.add(remoteDefinition());

    await store.remove("acme-quota");

    await expect(store.list()).resolves.toEqual([]);
    const canonical = JSON.parse(await readFile(workspace.guiConfigPath, "utf8")) as {
      enabledProviders: unknown;
      quotaProviders: unknown[];
      agentCustomProviders: unknown[];
    };
    expect(canonical.enabledProviders).toBe("auto");
    expect(canonical.quotaProviders).toEqual([active]);
    expect(canonical.agentCustomProviders).toEqual([]);
  });
});

describe("safe agent provider test transport", () => {
  it.each([
    ["truncated", "/truncated"],
    ["oversized", "/oversized"],
  ] as const)("rejects %s HTTPS responses without leaking stream errors", async (_label, path) => {
    const certPath = new URL("./fixtures/agent-provider-test-ca.pem", import.meta.url);
    const keyPath = new URL("./fixtures/agent-provider-test-key.pem", import.meta.url);
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");
    const oversizedBody = Buffer.alloc(256 * 1024 + 1, "x");
    const server = createHttpsServer({ cert, key }, (request, response) => {
      if (request.url === "/truncated") {
        response.writeHead(200, { "content-length": "64" });
        response.flushHeaders();
        response.write("partial", () => response.destroy());
        return;
      }
      response.writeHead(200, { "content-length": String(oversizedBody.byteLength) });
      response.end(oversizedBody);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind");
    const uncaughtErrors: Error[] = [];
    const onUncaughtException = (error: Error) => uncaughtErrors.push(error);
    process.on("uncaughtException", onUncaughtException);

    try {
      async function expectRequestRejected(path: string): Promise<void> {
        let timedOut = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const responsePromise = requestPinnedAddressForTest({
          address: "127.0.0.1",
          family: 4,
          hostname: "localhost",
          authority: `localhost:${address.port}`,
          port: address.port,
          path,
          method: "GET",
          headers: { host: `localhost:${address.port}`, accept: "application/json" },
          ca: cert,
        });
        try {
          await expect(
            Promise.race([
              responsePromise,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                  timedOut = true;
                  reject(new Error("pinned HTTPS response did not terminate"));
                }, 2000);
              }),
            ]),
          ).rejects.toThrow();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(uncaughtErrors).toEqual([]);
          expect(timedOut).toBe(false);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      await expectRequestRejected(path);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      process.off("uncaughtException", onUncaughtException);
    }
  });

  it.each([
    204, 205, 304,
  ] as const)("returns %i from the real pinned HTTPS transport without throwing on an empty body", async (status) => {
    const certPath = new URL("./fixtures/agent-provider-test-ca.pem", import.meta.url);
    const keyPath = new URL("./fixtures/agent-provider-test-key.pem", import.meta.url);
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");
    const server = createHttpsServer({ cert, key }, (_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind");

    try {
      const response = await requestPinnedAddressForTest({
        address: "127.0.0.1",
        family: 4,
        hostname: "localhost",
        authority: `localhost:${address.port}`,
        port: address.port,
        path: "/quota",
        method: "GET",
        headers: { host: `localhost:${address.port}`, accept: "application/json" },
        ca: cert,
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private IPv4", "10.1.2.3"],
    ["link-local IPv4", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["documentation IPv4", "192.0.2.4"],
    ["benchmark IPv4", "198.18.0.1"],
    ["multicast IPv4", "224.0.0.1"],
    ["reserved IPv4", "240.0.0.1"],
    ["loopback IPv6", "::1"],
    ["mapped private IPv6", "::ffff:127.0.0.1"],
    ["unique-local IPv6", "fd00::1"],
    ["link-local IPv6", "fe80::1"],
    ["documentation IPv6", "2001:db8::1"],
    ["6to4 IPv6", "2002::1"],
  ])("refuses %s DNS answers before connecting", async (_label, address) => {
    const requestPinned = vi.fn(
      async (_request: SafeProviderRequest) => new Response("{}", { status: 200 }),
    );
    const safeFetch = createSafeAgentProviderFetch({
      resolveHost: async (): Promise<readonly SafeProviderAddress[]> => [
        { address, family: address.includes(":") ? (6 as const) : (4 as const) },
      ],
      requestPinned,
    });

    await expect(safeFetch("https://quota.example.test/v1/quota")).rejects.toMatchObject({
      code: "unsafe-endpoint",
    });
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it("pins the validated DNS answer to the connection so a rebinding answer is never queried", async () => {
    let resolutions = 0;
    const resolveHost = vi.fn(async (): Promise<readonly SafeProviderAddress[]> => {
      resolutions += 1;
      return [{ address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    });
    const requestPinned = vi.fn(
      async (_request: SafeProviderRequest) => new Response("{}", { status: 200 }),
    );
    const safeFetch = createSafeAgentProviderFetch({ resolveHost, requestPinned });

    const response = await safeFetch("https://quota.example.test/v1/quota");

    expect(response.status).toBe(200);
    expect(resolveHost).toHaveBeenCalledOnce();
    expect(requestPinned.mock.calls[0]?.[0]).toMatchObject({
      address: "8.8.8.8",
      family: 4,
      hostname: "quota.example.test",
      method: "GET",
    });
  });

  it("does not follow a redirect to a private endpoint", async () => {
    const requestPinned = vi.fn(
      async (_request: SafeProviderRequest) =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    const safeFetch = createSafeAgentProviderFetch({
      resolveHost: async (): Promise<readonly SafeProviderAddress[]> => [
        { address: "8.8.8.8", family: 4 },
      ],
      requestPinned,
    });

    const response = await safeFetch("https://quota.example.test/v1/quota", {
      redirect: "follow",
    });

    expect(response.status).toBe(302);
    expect(requestPinned).toHaveBeenCalledOnce();
  });

  it("rejects non-HTTPS and credential-bearing URLs before DNS", async () => {
    const resolveHost = vi.fn(
      async (): Promise<readonly SafeProviderAddress[]> => [{ address: "8.8.8.8", family: 4 }],
    );
    const safeFetch = createSafeAgentProviderFetch({
      resolveHost,
      requestPinned: vi.fn(
        async (_request: SafeProviderRequest) => new Response("{}", { status: 200 }),
      ),
    });

    await expect(safeFetch("http://8.8.8.8/private")).rejects.toMatchObject({
      code: "unsafe-endpoint",
    });
    await expect(safeFetch("https://user:pass@quota.example.test/v1/quota")).rejects.toMatchObject({
      code: "unsafe-endpoint",
    });
    expect(resolveHost).not.toHaveBeenCalled();
  });
});
