import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPlainTextReport } from "../src/lib/report-document.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge } from "./helpers/quota-rpc-bridge.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-announcements-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const ANNOUNCEMENT_HOME_MESSAGE =
  "Notice: Maintainer announcement available. Run /quota_announcements.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  providerIds: ["copilot"],
}));

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

const announcementMocks = vi.hoisted(() => ({
  getMaintainerAnnouncementsSummary: vi.fn(),
  formatMaintainerAnnouncementHomeCountLine: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);
// Records the getters of the TUI's Solid signals, so a test can read what a view shows.
const signals = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("solid-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("solid-js")>();
  return {
    ...actual,
    createSignal: ((...args: Parameters<typeof actual.createSignal>) => {
      const signal = actual.createSignal(...args);
      signals.push(signal[0]);
      return signal;
    }) as typeof actual.createSignal,
  };
});
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  formatMaintainerAnnouncementHomeCountLine:
    announcementMocks.formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary: announcementMocks.getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds: () => ["copilot"],
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

function configureQuestionQuotaToast(
  overrides: Parameters<typeof makeQuotaToastTestConfig>[0] = {},
): void {
  mocks.loadConfig.mockResolvedValue(
    makeQuotaToastTestConfig({
      enabled: true,
      enableToast: true,
      enabledProviders: ["copilot"],
      showOnIdle: false,
      showOnQuestion: true,
      showOnCompact: false,
      minIntervalMs: 0,
      maintainerAnnouncements: {
        enabled: true,
        home: true,
      },
      ...overrides,
    }),
  );
  mocks.getProviders.mockReturnValue([
    {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
        errors: [],
      }),
    },
  ]);
}

/** Live server-plugin setups are released after each test (dashboard lease included). */
const pluginCleanups: Array<() => Promise<void> | void> = [];

/** Starts the server plugin and the TUI plugin, joined by the quota RPC. */
async function startCli() {
  vi.stubGlobal("React", {
    createElement: (type: unknown, props: Record<string, unknown> | null) =>
      typeof type === "function" ? type(props ?? {}) : { type, props },
  });
  const { default: server } = await import("../src/plugin.js");
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } }));
  const cleanup = await server.setup({
    location: { directory: process.cwd() },
    provider: { list: vi.fn(async () => ({ data: [{ id: "copilot" }] })) },
    session: { get: vi.fn(async () => ({})), hook: vi.fn() },
    command: { transform: vi.fn() },
    tool: { transform: vi.fn() },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as never);
  if (typeof cleanup === "function") pluginCleanups.push(cleanup);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    Parameters<typeof createQuotaRpcBridge>[0],
  ];
  const { default: plugin } = await import("../src/tui-v2.js");
  const listeners = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const renderers = new Map<string, () => unknown>();
  const toast = vi.fn();
  const context = {
    location: { directory: process.cwd() },
    client: { rpc: createQuotaRpcBridge(handlers) },
    data: {
      session: { get: vi.fn(() => undefined) },
      on: vi.fn((name: string, listener: (event: { data: Record<string, unknown> }) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }),
    },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim: { append: string; render: () => unknown }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") claim.render();
        return vi.fn();
      }),
      toast: { show: toast },
    },
  };
  const dispose = plugin.setup(context as never);
  const renderHome = () => renderers.get("home.footer.status")?.();
  return { listeners, toast, renderHome, dispose };
}

async function buildAnnouncementsDialogOutput(params: {
  client: ReturnType<typeof createClient>;
  arguments?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: "quota_announcements",
    arguments: params.arguments,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: "session-announcements",
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  if (result.state !== "output") return "";
  // Every command here renders its document as plain text.
  expect(renderPlainTextReport(result.document)).toBe(result.output);
  // The list's heading has no time and the dialog title names it, so the dialog shows no
  // subtitle. Invalid arguments give a plain message without a heading.
  expect(result.document.heading).toEqual(
    params.arguments?.trim() ? undefined : { line: "Maintainer announcements" },
  );
  return result.output;
}

async function flushMaintainerFallbackWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        showOnCompact: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      },
      resetPluginState: true,
    });
    announcementMocks.getMaintainerAnnouncementsSummary
      .mockReset()
      .mockReturnValue(makeAnnouncementSummary());
    announcementMocks.formatMaintainerAnnouncementHomeCountLine
      .mockReset()
      .mockImplementation((activeCount: number) => {
        if (activeCount <= 0) return "";
        if (activeCount === 1) return ANNOUNCEMENT_HOME_MESSAGE;
        return `Notice: ${activeCount} maintainer announcements available. Run /quota_announcements.`;
      });
    signals.length = 0;
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const cleanup of pluginCleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.unstubAllGlobals();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("builds the CLI /quota_announcements output from available providers", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-command-specs.js");
    const announcementCommand = QUOTA_DIALOG_COMMANDS.find(
      (command) => command.id === "quota_announcements",
    );
    const client = createClient();
    expect(announcementCommand).toEqual(
      expect.objectContaining({ slashName: "quota_announcements" }),
    );

    const output = await buildAnnouncementsDialogOutput({ client });

    expect(output).toBe(
      "Maintainer announcements\n\n- If you use Copilot, GitHub billing is moving to AI Credits.\n  https://github.blog/example",
    );
    expect(output).not.toContain("copilot-credits");
    expect(output).not.toContain("source:");
    expect(output).not.toContain("state");
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );
  });

  it("renders none for provider-targeted announcements when the provider is unavailable", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);
    announcementMocks.getMaintainerAnnouncementsSummary.mockImplementation((params: any) => {
      const enabledProviders = Array.isArray(params?.enabledProviders)
        ? params.enabledProviders
        : [];
      return enabledProviders.includes("copilot")
        ? makeAnnouncementSummary()
        : makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] });
    });

    const client = createClient();

    await expect(buildAnnouncementsDialogOutput({ client })).resolves.toBe(
      "Maintainer announcements\n\nNo current announcements.",
    );
    expect(provider.isAvailable).toHaveBeenCalledOnce();
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: [] }),
    );
  });

  it("renders none when no active announcements are available", async () => {
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(
      makeAnnouncementSummary({
        activeCount: 0,
        activeAnnouncements: [],
      }),
    );

    const client = createClient();

    await expect(buildAnnouncementsDialogOutput({ client })).resolves.toBe(
      "Maintainer announcements\n\nNo current announcements.",
    );
  });

  it("rejects /quota_announcements arguments", async () => {
    const client = createClient();

    await expect(
      buildAnnouncementsDialogOutput({
        client,
        arguments: "show copilot-credits",
      }),
    ).resolves.toBe(
      "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
    );
  });

  it("shows the count-only announcement on Home instead of a toast", async () => {
    configureQuestionQuotaToast();
    const cli = await startCli();
    cli.renderHome();
    // The Home footer shows the lines the server returns over the RPC.
    await vi.waitFor(() =>
      expect(signals.map((read) => read())).toContainEqual([ANNOUNCEMENT_HOME_MESSAGE]),
    );
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );

    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-1", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.success")?.({
      data: { id: "call-1", sessionID: "session-question" },
    });
    await vi.waitFor(() => expect(cli.toast).toHaveBeenCalledOnce());
    await flushMaintainerFallbackWork();
    expect(cli.toast).toHaveBeenCalledOnce();
    expect(cli.toast.mock.calls[0]?.[0].message).toContain("Copilot");
    expect(cli.toast.mock.calls[0]?.[0].message).not.toContain("Notice:");
    cli.dispose?.();
  });

  it("does not show the Home announcement when maintainerAnnouncements.home is off", async () => {
    configureQuestionQuotaToast({
      maintainerAnnouncements: { enabled: true, home: false },
      tuiCompactStatus: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        maxWidth: 96,
      },
    });
    const [copilot] = mocks.getProviders();
    const cli = await startCli();
    cli.renderHome();
    // The Home compact line fetches quota after the announcement check would have run.
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalled());

    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    expect(announcementMocks.formatMaintainerAnnouncementHomeCountLine).not.toHaveBeenCalled();
    cli.dispose?.();
  });
});
