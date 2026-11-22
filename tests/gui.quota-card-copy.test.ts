import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviderCards } from "../src/gui/provider-cards.js";
import { parseOAuthUsageResponse } from "../src/lib/anthropic.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";
import { SOLID_JSX_SOURCES } from "../vite.ui.config.mjs";
import type { TestListener, TestNode } from "./fixtures/gui-test-renderer.js";
import { NOW, percentRow, providerCard } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  // The real parser stays in place so the copied rows come from the provider's own parsing.
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuotaWithOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = fileURLToPath(new URL("./fixtures/gui-test-renderer.ts", import.meta.url));
const webShim = fileURLToPath(new URL("./fixtures/gui-solid-web.ts", import.meta.url));
let server: ViteDevServer;
let cardView: unknown;
let graph: {
  createComponent: (component: unknown, props: unknown) => unknown;
  mount: (code: () => unknown, root: TestNode) => () => void;
  createTestRoot: () => TestNode;
  elementsNamed: (root: TestNode, tag: string) => TestNode[];
  listenerOf: (node: TestNode, name: string) => TestListener | undefined;
  textOf: (node: TestNode) => string;
};

beforeAll(async () => {
  server = await createIsolatedViteServer({
    configFile: false,
    root: rootDir,
    plugins: [
      {
        name: "tooltip-render-boundary",
        enforce: "pre",
        transform(_code, id) {
          if (id.replaceAll("\\", "/").endsWith("/overlays/tooltip/tooltip.tsx"))
            return "export function Tooltip(props) { return props.children }";
        },
      },
      solid({
        include: [...SOLID_JSX_SOURCES],
        solid: { generate: "universal", moduleName: "@gui-test-renderer" },
      }),
    ],
    resolve: {
      alias: [
        { find: "@gui-test-renderer", replacement: rendererPath },
        {
          find: /^solid-js$/,
          replacement: path.join(rootDir, "node_modules/solid-js/dist/solid.js"),
        },
        { find: /^solid-js\/web$/, replacement: webShim },
        {
          find: /^solid-js\/store$/,
          replacement: path.join(rootDir, "node_modules/solid-js/store/dist/store.js"),
        },
      ],
    },
    ssr: {
      noExternal: [
        "solid-js",
        "solid-js/universal",
        "@opencode/ui",
        "@kobalte/core",
        "@kobalte/utils",
        "@kitlangton/solid-motion",
        "@solid-primitives/props",
        "@solid-primitives/resize-observer",
      ],
    },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  const core = await server.ssrLoadModule("solid-js");
  const renderer = await server.ssrLoadModule(rendererPath);
  cardView = (await server.ssrLoadModule(path.join(rootDir, "src/ui/components/quota-card.tsx")))
    .QuotaCardView;
  graph = {
    createComponent: core.createComponent,
    mount: renderer.mountTestTree,
    createTestRoot: renderer.createTestRoot,
    elementsNamed: renderer.elementsNamed,
    listenerOf: renderer.listenerOf,
    textOf: renderer.textOf,
  };
}, 60_000);
afterAll(async () => {
  await server?.close();
});
afterEach(() => vi.unstubAllGlobals());

describe("quota card clipboard", () => {
  it("copies only the clicked account's visible rows with its current display preferences", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const firstRow = percentRow({ label: "First quota", countdown: "1h" });
    const hiddenRow = percentRow({ label: "Hidden quota" });
    const first = providerCard({
      accountLabel: "Alice",
      rows: [firstRow, hiddenRow],
      errors: [{ label: "Private error", message: "secret error text" }],
    });
    const second = providerCard({
      accountLabel: "Bob",
      rows: [percentRow({ label: "Bob quota", countdown: undefined })],
    });
    // The fixture normally reuses one row ID; make only the second row hidden.
    hiddenRow.rowId = "hidden-row" as typeof hiddenRow.rowId;
    const root = graph.createTestRoot();
    const preferences = { percentMode: "remaining", showRunway: false, detailed: false };
    const dispose = graph.mount(
      () => [
        graph.createComponent(cardView, {
          card: first,
          preferences,
          hiddenRows: [hiddenRow.rowId],
          stale: false,
          timeZone: "UTC",
        }),
        graph.createComponent(cardView, {
          card: second,
          preferences,
          hiddenRows: [],
          stale: false,
          timeZone: "UTC",
        }),
      ],
      root,
    );
    try {
      const buttons = graph
        .elementsNamed(root, "button")
        .filter((node) => node.props.class === "qg-card__copy");
      expect(buttons).toHaveLength(2);
      graph.listenerOf(buttons[0]!, "onClick")?.({});
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledExactlyOnceWith(
        "Synthetic Provider · Alice\nPrivate error\nsecret error text\nFirst quota: 62% remaining · Resets in 1h",
      );
      expect(graph.textOf(root)).toContain("Quota summary copied.");
      graph.listenerOf(buttons[1]!, "onClick")?.({});
      await Promise.resolve();
      expect(writeText).toHaveBeenLastCalledWith(
        "Synthetic Provider · Bob\nBob quota: 62% remaining",
      );
    } finally {
      dispose();
    }
  });

  it("announces clipboard failure", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(cardView, {
          card: providerCard(),
          preferences: { percentMode: "used", showRunway: false, detailed: false },
          hiddenRows: [],
          stale: false,
          timeZone: "UTC",
        }),
      root,
    );
    try {
      const button = graph
        .elementsNamed(root, "button")
        .find((node) => node.props.class === "qg-card__copy");
      expect(button).toBeDefined();
      graph.listenerOf(button!, "onClick")?.({});
      await Promise.resolve();
      expect(graph.textOf(root)).toContain("Could not copy quota summary.");
    } finally {
      dispose();
    }
  });
});

describe("quota card clipboard runway and banked resets", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function copiedSummary(
    card: ReturnType<typeof providerCard>,
    stale = false,
  ): Promise<string> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(cardView, {
          card,
          preferences: { percentMode: "remaining", showRunway: true, detailed: false },
          hiddenRows: [],
          stale,
          timeZone: "UTC",
        }),
      root,
    );
    try {
      const button = graph
        .elementsNamed(root, "button")
        .find((node) => node.props.class === "qg-card__copy");
      expect(button).toBeDefined();
      graph.listenerOf(button!, "onClick")?.({});
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledOnce();
      return writeText.mock.calls[0]?.[0] as string;
    } finally {
      dispose();
    }
  }

  /** Summary body without the identity line, so row text is asserted exactly. */
  function rowLines(copied: string): string[] {
    return copied.split("\n").slice(1);
  }

  it("copies an error-only provider-level card with the displayed label and message", async () => {
    const copied = await copiedSummary(
      providerCard({
        providerLabel: "Claude Agent",
        planLabel: undefined,
        accountLabel: undefined,
        rows: [],
        errors: [
          {
            label: "Claude Agent",
            message: "Claude sign-in could not be used. Run `claude auth login` and try again.",
          },
        ],
      }),
    );
    expect(copied).toBe(
      "Claude Agent\nProvider-level error · Claude Agent\nClaude sign-in could not be used. Run `claude auth login` and try again.",
    );
  });

  it("copies stale marker, every error and rows in display order", async () => {
    const copied = await copiedSummary(
      providerCard({
        accountLabel: undefined,
        rows: [percentRow({ label: "Quota", countdown: undefined })],
        errors: [
          { label: "One", message: "first" },
          { label: "Two", message: "second" },
        ],
      }),
      true,
    );
    expect(rowLines(copied)).toEqual([
      "Data may be stale",
      "Provider-level error · One",
      "first",
      "Provider-level error · Two",
      "second",
      "Quota: 62% remaining",
    ]);
  });

  it("adds a valid before-reset runway to the same row as its quota and reset", async () => {
    const copied = await copiedSummary(
      providerCard({
        accountLabel: "Alice",
        rows: [
          percentRow({
            label: "First quota",
            countdown: "1h",
            runway: { kind: "before_reset", projectedAtIso: new Date(NOW + 60_000).toISOString() },
          }),
        ],
      }),
    );
    expect(copied).toBe(
      "Synthetic Provider · Alice\nFirst quota: 62% remaining · Resets in 1h · Runs out in ~1m",
    );
  });

  it("adds lasts-past-reset only while its reset is a valid future time", async () => {
    const cases: Array<{ resetAtIso: string | undefined; runway: string | undefined }> = [
      { resetAtIso: new Date(NOW + 2_000).toISOString(), runway: "Projected to last until reset" },
      { resetAtIso: undefined, runway: undefined },
      { resetAtIso: "invalid", runway: undefined },
      { resetAtIso: new Date(NOW - 1).toISOString(), runway: undefined },
    ];
    for (const { resetAtIso, runway } of cases) {
      const copied = await copiedSummary(
        providerCard({
          rows: [
            percentRow({
              label: "Quota",
              countdown: undefined,
              resetAtIso,
              runway: { kind: "lasts_past_reset" },
            }),
          ],
        }),
      );
      expect(rowLines(copied)).toEqual([
        runway === undefined ? "Quota: 62% remaining" : `Quota: 62% remaining · ${runway}`,
      ]);
    }
  });

  it("omits runway from stale cards while keeping quota and reset text", async () => {
    const copied = await copiedSummary(
      providerCard({
        rows: [
          percentRow({
            label: "Quota",
            countdown: "1h",
            runway: { kind: "before_reset", projectedAtIso: new Date(NOW + 60_000).toISOString() },
          }),
        ],
      }),
      true,
    );
    expect(rowLines(copied)).toEqual(["Data may be stale", "Quota: 62% remaining · Resets in 1h"]);
  });

  it("keeps banked-reset summaries unchanged", async () => {
    const copied = await copiedSummary(
      providerCard({
        providerId: "openai",
        providerLabel: "OpenAI",
        rows: [
          percentRow({
            label: "Banked resets",
            kind: "value",
            bankedResets: { availableCount: 2, credits: [] },
            runway: undefined,
            countdown: undefined,
          }),
        ],
      }),
    );
    expect(rowLines(copied)).toEqual(["Banked resets: 2 available · Expiry unknown"]);
  });

  it("copies Claude Agent saved resets but not direct Anthropic banked data", async () => {
    const rows = [
      percentRow({
        label: "Resets",
        kind: "value",
        bankedResets: { availableCount: 1, credits: [] },
        runway: undefined,
        countdown: undefined,
      }),
    ];
    const claude = await copiedSummary(
      providerCard({ providerId: "claude-agent", providerLabel: "Claude Agent", rows }),
    );
    expect(rowLines(claude)).toEqual(["Resets: 1 available · Expiry unknown"]);
    const anthropic = await copiedSummary(
      providerCard({ providerId: "anthropic", providerLabel: "Anthropic", rows }),
    );
    expect(rowLines(anthropic)).not.toEqual(["Resets: 1 available · Expiry unknown"]);
  });

  it("copies Claude Agent's provider rows with exact labels and runway from the provider payload", async () => {
    const HOUR_MS = 60 * 60_000;
    const DAY_MS = 24 * HOUR_MS;
    const isoAt = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      oauthCredentialSource: "claude-credentials",
      checkedCommands: ["claude --version"],
      quota: parseOAuthUsageResponse(
        {
          five_hour: { utilization: 60, resets_at: isoAt(3 * HOUR_MS) },
          seven_day: { utilization: 28, resets_at: isoAt(3 * DAY_MS) },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 2,
              resets_at: isoAt(3 * DAY_MS),
              scope: { model: { display_name: "Fable" } },
            },
          ],
        },
        NOW,
      ),
    });
    const result = await claudeAgentProvider.fetch({} as any);
    const [card] = buildProviderCards({
      probes: [{ providerId: "claude-agent", result }],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    });

    expect(card).toBeDefined();
    expect(rowLines(await copiedSummary(card!))).toEqual([
      "5h: 40% remaining · Resets in 3h0m · Runs out in ~1h 20m",
      "Weekly: 72% remaining · Resets in 3d0h0m · Projected to last until reset",
      "Fable: 98% remaining · Resets in 3d0h0m",
    ]);
  });

  it("shows only the Claude Agent card and its plan when OpenCode OAuth also exists", async () => {
    const { getAnthropicDiagnostics, queryAnthropicQuotaWithOAuth } = await import(
      "../src/lib/anthropic.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "anthropic-personal",
        integrationId: "anthropic",
        label: "Personal",
        active: true,
        value: { type: "oauth", access: "personal-token" },
      },
    ]);
    (queryAnthropicQuotaWithOAuth as any).mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
    });
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: ["claude --version"],
      quota: { five_hour: { percentRemaining: 50 } },
      credentialFingerprint: "claude-cli-fingerprint",
      planLabel: "Max",
    });

    const result = await anthropicProvider.fetch({} as any);
    const claudeResult = await claudeAgentProvider.fetch({} as any);
    const cards = buildProviderCards({
      probes: [
        { providerId: "anthropic", result },
        { providerId: "claude-agent", result: claudeResult },
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    });
    expect(cards).toHaveLength(1);
    const claudeCodeCard = cards.find((card) => card.planLabel !== undefined);
    expect(claudeCodeCard?.planLabel).toBe("Max");
    expect(queryAnthropicQuotaWithOAuth).not.toHaveBeenCalled();

    const copied = await copiedSummary(claudeCodeCard!);
    expect(copied.split("\n")[0]).toBe("Claude Agent · Max");
    expect(rowLines(copied)).toEqual(["5h: 50% remaining"]);

    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(cardView, {
          card: claudeCodeCard!,
          preferences: { percentMode: "remaining", showRunway: false, detailed: false },
          hiddenRows: [],
          stale: false,
          timeZone: "UTC",
        }),
      root,
    );
    try {
      expect(headerText(root)).toBe("Claude Agent · Max");
    } finally {
      dispose();
    }
  });

  /** The rendered identity line (provider · plan · account), with separator spacing normalized. */
  function headerText(root: ReturnType<typeof graph.createTestRoot>): string {
    const identity = graph
      .elementsNamed(root, "div")
      .find((node) => node.props.class === "qg-card__identity");
    expect(identity).toBeDefined();
    return graph.textOf(identity!).replace(/\s*·\s*/g, " · ");
  }

  it.each([
    ["a known plan", "Max", "Claude Agent · Max"],
    ["no plan", undefined, "Claude Agent"],
  ])("shows the Claude CLI-only plan in the header and clipboard, with %s", async (_case, planLabel, expectedIdentity) => {
    const { getAnthropicDiagnostics } = await import("../src/lib/anthropic.js");
    // No OpenCode Anthropic login: the verified Claude CLI login is the only account.
    (getAnthropicDiagnostics as any).mockResolvedValueOnce({
      installed: true,
      version: "2.1.258",
      authStatus: "authenticated",
      quotaSupported: true,
      quotaSource: "claude-credentials-oauth-api",
      checkedCommands: ["claude --version"],
      quota: { five_hour: { percentRemaining: 50 } },
      credentialFingerprint: "claude-cli-fingerprint",
      ...(planLabel === undefined ? {} : { planLabel }),
    });

    const result = await claudeAgentProvider.fetch({} as any);
    const cards = buildProviderCards({
      probes: [{ providerId: "claude-agent", result }],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    });
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card!.planLabel).toBe(planLabel);
    expect(card!.accountLabel).toBeUndefined();

    const copied = await copiedSummary(card!);
    expect(copied.split("\n")[0]).toBe(expectedIdentity);
    expect(rowLines(copied)).toEqual(["5h: 50% remaining"]);

    const root = graph.createTestRoot();
    const dispose = graph.mount(
      () =>
        graph.createComponent(cardView, {
          card: card!,
          preferences: { percentMode: "remaining", showRunway: false, detailed: false },
          hiddenRows: [],
          stale: false,
          timeZone: "UTC",
        }),
      root,
    );
    try {
      expect(headerText(root)).toBe(expectedIdentity);
    } finally {
      dispose();
    }
  });
});
