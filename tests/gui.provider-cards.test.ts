/**
 * P3B — provider card mapping and read-source composition (design spec §6
 * R17–R20, plan P3 step 1).
 *
 * Card mapping runs on synthetic `QuotaProviderResult` fixtures (no provider
 * queries, no database). Composition tests drive `createDashboardReadSource`
 * through its plain-callback DI seams with the real analytics factory.
 */
import { describe, expect, it } from "vitest";

import {
  type BankedResetAvailability,
  OPENAI_CREDITS_INFO,
  OPENAI_CREDITS_ROW_KEY,
  OPENAI_RESETS_INFO,
  OPENAI_RESETS_ROW_KEY,
} from "../src/contracts/openai-quota.js";
import type { UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import { buildProviderCards, type ProviderCardPreferences } from "../src/gui/provider-cards.js";
import { createDashboardReadSource, DashboardSourceError } from "../src/gui/sources.js";
import type {
  AccountingPercentageBasis,
  AccountingResultType,
  AccountingWindow,
  FixedWindowProjectionEvidence,
  QuotaPercentEntry,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import type { OpenCodeRawAssistantRow } from "../src/lib/opencode-storage.js";
import type { QuotaStatusLiveProbe } from "../src/lib/quota-render-data.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 2026-10-18T12:00:00Z
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const SUMMARY: ProviderCardPreferences = { accountingDetail: "summary" };

const TEST_ACCOUNTING = {
  resultType: "quota" satisfies AccountingResultType,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function percentEntry(params: {
  sourceId?: string;
  name?: string;
  window?: AccountingWindow;
  percentRemaining?: number;
  resultType?: AccountingResultType;
  rowKey?: string;
  resetTimeIso?: string;
  fixedWindow?: FixedWindowProjectionEvidence;
  basis?: AccountingPercentageBasis;
}): QuotaPercentEntry {
  const accounting: QuotaPercentEntry["accounting"] = {
    ...TEST_ACCOUNTING,
    resultType: params.resultType ?? "quota",
  };
  if (params.sourceId !== undefined) accounting.sourceId = params.sourceId;

  const entry: QuotaPercentEntry = {
    kind: "percent",
    name: params.name ?? "Weekly",
    percentRemaining: params.percentRemaining ?? 62.5,
    accounting,
    semantic: {
      metric: { kind: "window", window: params.window ?? "week" },
      prominence: "primary",
    },
  };
  if (params.rowKey !== undefined) entry.rowKey = params.rowKey;
  if (params.resetTimeIso !== undefined) entry.resetTimeIso = params.resetTimeIso;
  if (params.fixedWindow !== undefined) entry.fixedWindow = params.fixedWindow;
  if (params.basis !== undefined) entry.basis = params.basis;
  return entry;
}

function valueEntry(params: {
  sourceId?: string;
  name: string;
  label: string;
  rowKey: string;
  value: string;
  resultType: AccountingResultType;
  info?: string;
  bankedResets?: BankedResetAvailability;
}): QuotaToastEntry {
  const accounting: QuotaToastEntry["accounting"] = {
    ...TEST_ACCOUNTING,
    resultType: params.resultType,
  };
  if (params.sourceId !== undefined) accounting.sourceId = params.sourceId;
  return {
    kind: "value",
    name: params.name,
    group: "OpenAI",
    label: params.label,
    rowKey: params.rowKey,
    value: params.value,
    accounting,
    ...(params.info !== undefined ? { info: params.info } : {}),
    ...(params.bankedResets !== undefined ? { bankedResets: params.bankedResets } : {}),
  } as QuotaToastEntry;
}

function result(overrides: Partial<QuotaProviderResult> = {}): QuotaProviderResult {
  return { attempted: true, entries: [], errors: [], ...overrides };
}

function probe(providerId: string, value: QuotaProviderResult): QuotaStatusLiveProbe {
  return { providerId, result: value };
}

function cardsFor(probes: readonly QuotaStatusLiveProbe[]): ReturnType<typeof buildProviderCards> {
  return buildProviderCards({ probes, preferences: SUMMARY, nowMs: NOW });
}

function baseConfig(overrides: Partial<QuotaToastConfig> = {}): QuotaToastConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    dashboard: { ...DEFAULT_CONFIG.dashboard, ...overrides.dashboard },
  };
}

const EMPTY_DATASET: UsageAnalyticsDataset = {
  sessions: {},
  projects: {},
  messages: [],
  compactions: [],
};

function messageRow(tokens: Partial<OpenCodeRawAssistantRow["tokens"]>): OpenCodeRawAssistantRow {
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    createdAtMs: NOW - 1_000,
    completedAtMs: NOW - 100,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  };
}

const DATASET: UsageAnalyticsDataset = {
  sessions: {
    ses_1: {
      id: "ses_1",
      title: "Alpha work",
      projectID: "p1",
      time: { created: NOW - 3 * HOUR_MS, updated: NOW - 1_800_000 },
    },
  },
  projects: { p1: { id: "p1", name: "Alpha", directories: [], worktrees: [] } },
  messages: [messageRow({ input: 10, output: 5 })],
  compactions: [],
};

interface HarnessOptions {
  config?: QuotaToastConfig;
  dataset?: UsageAnalyticsDataset;
  probes?: QuotaStatusLiveProbe[];
  nowMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const config = options.config ?? baseConfig();
  const dataset = options.dataset ?? EMPTY_DATASET;
  const collectorCalls: Array<{ config: QuotaToastConfig; nowMs: number }> = [];
  const datasetCalls = { count: 0 };
  const source = createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "C:/synthetic-workspace",
    configDir: "C:/synthetic-config",
    now: () => options.nowMs ?? NOW,
    loadConfig: async () => config,
    loadDataset: async () => {
      datasetCalls.count += 1;
      return dataset;
    },
    collectProviderResults: async (input) => {
      collectorCalls.push(input);
      return options.probes ?? [];
    },
  });
  return { source, config, dataset, collectorCalls, datasetCalls };
}

describe("gui provider cards — account mapping", () => {
  it("maps every discovered account to its own card with opaque ids and no aliases", () => {
    const cards = cardsFor([
      probe(
        "anthropic",
        result({
          accounts: [
            { sourceId: "raw-a", label: "Work" },
            { sourceId: "raw-b", label: "Personal", active: true },
          ],
          entries: [
            percentEntry({
              sourceId: "raw-a",
              name: "5h",
              window: "five_hour",
              percentRemaining: 80,
            }),
            percentEntry({
              sourceId: "raw-b",
              name: "5h",
              window: "five_hour",
              percentRemaining: 20,
            }),
          ],
          errors: [{ label: "Auth", message: "token refresh failed", sourceId: "raw-b" }],
        }),
      ),
    ]);

    expect(cards.map((card) => card.accountLabel)).toEqual(["Work", "Personal"]);
    expect(cards.map((card) => card.labelSource)).toEqual(["connection", "connection"]);
    expect(cards.map((card) => card.providerId)).toEqual(["anthropic", "anthropic"]);
    expect(cards.map((card) => card.providerLabel)).toEqual(["Anthropic", "Anthropic"]);
    expect(cards[0]?.rows.map((row) => row.percentRemaining)).toEqual([80]);
    expect(cards[1]?.rows.map((row) => row.percentRemaining)).toEqual([20]);
    expect(cards[0]?.errors).toEqual([]);
    expect(cards[1]?.errors).toEqual([
      { label: "Auth", message: "token refresh failed", retryable: undefined },
    ]);

    const serialized = JSON.stringify(cards);
    expect(serialized).not.toContain("raw-a");
    expect(serialized).not.toContain("raw-b");
    expect(new Set(cards.map((card) => card.cardId)).size).toBe(2);
  });

  it("keeps zero-entry accounts visible and attaches known failures by sourceId", () => {
    const cards = cardsFor([
      probe(
        "copilot",
        result({
          accounts: [{ sourceId: "raw-zero" }, { sourceId: "raw-ok", label: "Main" }],
          entries: [percentEntry({ sourceId: "raw-ok", window: "month", percentRemaining: 50 })],
          errors: [{ label: "Sync", message: "login expired", sourceId: "raw-zero" }],
        }),
      ),
    ]);

    expect(cards.map((card) => card.accountLabel)).toEqual(["Account 1", "Main"]);
    expect(cards.map((card) => card.labelSource)).toEqual(["account", "connection"]);
    expect(cards[0]?.rows).toEqual([]);
    expect(cards[0]?.errors.map((error) => error.label)).toEqual(["Sync"]);
    expect(cards[1]?.rows).toHaveLength(1);
    expect(cards[1]?.errors).toEqual([]);
  });

  it("renders a provider-level failure as one provider card and invents no account", () => {
    const cards = cardsFor([
      probe(
        "xai",
        result({
          attempted: false,
          errors: [{ label: "Network", message: "ECONNREFUSED" }],
        }),
      ),
    ]);

    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card?.accountLabel).toBeUndefined();
    expect(card?.labelSource).toBe("provider");
    expect(card?.providerLabel).toBe("xAI");
    expect(card?.rows).toEqual([]);
    expect(card?.errors.map((error) => error.label)).toEqual(["Network"]);
  });

  it("adds a provider card beside account cards for unscoped content only", () => {
    const cards = cardsFor([
      probe(
        "openai",
        result({
          accounts: [{ sourceId: "raw-openai", label: "Plus" }],
          entries: [
            percentEntry({ sourceId: "raw-openai", window: "week" }),
            percentEntry({ sourceId: "raw-unknown", window: "month" }),
          ],
          errors: [{ label: "Provider", message: "upstream unavailable" }],
        }),
      ),
    ]);

    expect(cards.map((card) => card.accountLabel)).toEqual([undefined, "Plus"]);
    expect(cards.map((card) => card.labelSource)).toEqual(["provider", "connection"]);
    expect(cards[0]?.rows.map((row) => row.metric)).toEqual([{ kind: "window", window: "month" }]);
    expect(cards[0]?.errors.map((error) => error.label)).toEqual(["Provider"]);
    expect(cards[1]?.rows.map((row) => row.metric)).toEqual([{ kind: "window", window: "week" }]);
    expect(cards[1]?.errors).toEqual([]);
  });

  it("deduplicates duplicate row keys and duplicate account descriptors without duplicating ids", () => {
    const duplicateDescriptor = cardsFor([
      probe(
        "zai",
        result({
          accounts: [
            { sourceId: "raw-dup", label: "First" },
            { sourceId: "raw-dup", label: "Second" },
          ],
        }),
      ),
    ]);
    expect(duplicateDescriptor).toHaveLength(1);
    expect(duplicateDescriptor[0]?.accountLabel).toBe("First");

    const duplicateRows = cardsFor([
      probe(
        "zai",
        result({
          attempted: true,
          entries: [
            percentEntry({ name: "First row" }),
            percentEntry({ name: "Second row" }),
            percentEntry({ name: "Spend row", resultType: "spend" }),
          ],
        }),
      ),
    ]);
    const rows = duplicateRows[0]?.rows ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.label)).toEqual(["Weekly quota", "Weekly spend"]);
    expect(new Set(rows.map((row) => row.rowId)).size).toBe(rows.length);
  });

  it("keeps card and row ids stable across account label renames and reordering", () => {
    const first = cardsFor([
      probe(
        "copilot",
        result({
          accounts: [
            { sourceId: "raw-one", label: "Alpha" },
            { sourceId: "raw-two", label: "Beta" },
          ],
          entries: [percentEntry({ sourceId: "raw-one", window: "week" })],
        }),
      ),
    ]);
    const originalCard = first.find((card) => card.accountLabel === "Alpha");
    const originalRow = originalCard?.rows[0];

    const second = cardsFor([
      probe(
        "copilot",
        result({
          accounts: [
            { sourceId: "raw-two", label: "Renamed Beta" },
            { sourceId: "raw-one", label: "Renamed Alpha" },
          ],
          entries: [percentEntry({ sourceId: "raw-one", window: "week" })],
        }),
      ),
    ]);
    expect(second.map((card) => card.accountLabel)).toEqual(["Renamed Beta", "Renamed Alpha"]);
    const renamedCard = second[1];
    expect(renamedCard).toBeDefined();
    expect(renamedCard?.cardId).toBe(originalCard?.cardId);
    expect(renamedCard?.rows[0]?.rowId).toBe(originalRow?.rowId);
  });

  it("maps all four entry kinds with typed numbers and existing labels", () => {
    const resetInTwoDays = futureIso(2 * DAY_MS);
    const resetInOneDay = futureIso(DAY_MS);
    const cards = cardsFor([
      probe(
        "kimi",
        result({
          accounts: [{ sourceId: "raw-k", label: "Kimi" }],
          entries: [
            percentEntry({
              sourceId: "raw-k",
              window: "five_hour",
              percentRemaining: 62.5,
              resetTimeIso: resetInTwoDays,
            }),
            {
              kind: "value",
              name: "Credits balance",
              value: "42 GB",
              accounting: { ...TEST_ACCOUNTING, resultType: "spend", sourceId: "raw-k" },
              rowKey: "named:credits",
              resetTimeIso: resetInOneDay,
            } satisfies QuotaToastEntry,
            {
              kind: "quantity",
              name: "Remaining credits",
              quantity: { decimal: "12.50", unit: { kind: "currency", code: "USD" } },
              accounting: { ...TEST_ACCOUNTING, resultType: "spend", sourceId: "raw-k" },
              semantic: {
                metric: { kind: "component", component: "remaining_credits" },
                prominence: "primary",
              },
            } satisfies QuotaToastEntry,
            {
              kind: "boolean",
              name: "Availability",
              value: true,
              accounting: { ...TEST_ACCOUNTING, resultType: "status", sourceId: "raw-k" },
              semantic: { metric: { kind: "named", name: "Status" }, prominence: "primary" },
            } satisfies QuotaToastEntry,
          ],
        }),
      ),
    ]);

    const rows = cards[0]?.rows ?? [];
    expect(rows).toHaveLength(4);

    const [percent, value, quantity, boolean] = rows;
    expect(percent?.kind).toBe("percent");
    expect(percent?.percentRemaining).toBe(62.5);
    expect(percent?.percentUsed).toBe(37.5);
    expect(percent?.resultType).toBe("quota");
    expect(percent?.metric).toEqual({ kind: "window", window: "five_hour" });
    expect(percent?.label).toBe("5h quota");
    expect(percent?.countdown).toBe("2d0h0m");
    expect(percent?.resetAtIso).toBe(resetInTwoDays);

    expect(value?.kind).toBe("value");
    expect(value?.value).toBe("42 GB");
    expect(value?.label).toBe("Credits balance");
    expect(value?.metric).toBeUndefined();
    expect(value?.countdown).toBe("1d0h0m");

    expect(quantity?.kind).toBe("quantity");
    expect(quantity?.quantity).toEqual({
      decimal: "12.50",
      unit: { kind: "currency", code: "USD" },
    });
    expect(quantity?.resultType).toBe("spend");
    expect(quantity?.metric).toEqual({ kind: "component", component: "remaining_credits" });
    expect(quantity?.value).toBeUndefined();

    expect(boolean?.kind).toBe("boolean");
    expect(boolean?.booleanValue).toBe(true);
    expect(boolean?.resultType).toBe("status");
    expect(boolean?.metric).toEqual({ kind: "named", name: "Status" });
  });

  it("computes percentUsed from percentRemaining without clamping provider values", () => {
    const cards = cardsFor([
      probe(
        "minimax",
        result({
          entries: [
            percentEntry({ window: "week", percentRemaining: -20.5 }),
            percentEntry({ window: "month", percentRemaining: 130 }),
          ],
        }),
      ),
    ]);
    const rows = cards[0]?.rows ?? [];
    expect(rows.map((row) => row.percentRemaining)).toEqual([-20.5, 130]);
    expect(rows.map((row) => row.percentUsed)).toEqual([120.5, -30]);
  });

  it("adds the runway projection only when the config asks for it", () => {
    const endsAtIso = new Date(NOW + 12 * HOUR_MS).toISOString();
    const fixedWindow: FixedWindowProjectionEvidence = {
      kind: "fixed_window",
      startedAtIso: new Date(NOW - HOUR_MS).toISOString(),
      observedAtIso: new Date(NOW - 1_800_000).toISOString(),
      endsAtIso,
      fullReset: true,
    };
    const probes = [
      probe(
        "cursor",
        result({
          entries: [
            percentEntry({
              window: "month",
              percentRemaining: 50,
              resetTimeIso: endsAtIso,
              fixedWindow,
            }),
          ],
        }),
      ),
    ];

    const off = buildProviderCards({ probes, preferences: SUMMARY, nowMs: NOW });
    expect(off[0]?.rows[0]?.runway).toBeUndefined();

    const on = buildProviderCards({
      probes,
      preferences: { ...SUMMARY, quotaProjection: "runway" },
      nowMs: NOW,
    });
    expect(on[0]?.rows[0]?.runway).toEqual({
      kind: "before_reset",
      projectedAtIso: new Date(NOW).toISOString(),
    });
  });

  it("adds detail rows only for accountingDetail detailed", () => {
    const basis: AccountingPercentageBasis = {
      used: {
        quantity: { decimal: "12", unit: { kind: "currency", code: "USD" } },
        authority: "provider_reported",
      },
      limit: {
        quantity: { decimal: "100", unit: { kind: "currency", code: "USD" } },
        authority: "provider_reported",
      },
    };
    const probes = [
      probe("anthropic", result({ entries: [percentEntry({ window: "month", basis })] })),
    ];

    const summary = buildProviderCards({ probes, preferences: SUMMARY, nowMs: NOW });
    expect(summary[0]?.rows[0]?.detailRows).toBeUndefined();

    const detailed = buildProviderCards({
      probes,
      preferences: { ...SUMMARY, accountingDetail: "detailed" },
      nowMs: NOW,
    });
    expect(detailed[0]?.rows[0]?.detailRows).toEqual([
      { label: "Used", value: "USD 12.00" },
      { label: "Limit", value: "USD 100.00" },
    ]);
  });

  it("keeps mapping when a provider quantity decimal is not canonical", () => {
    const cards = cardsFor([
      probe(
        "chutes",
        result({
          entries: [
            {
              kind: "quantity",
              name: "Chutes balance",
              quantity: { decimal: "1e3", unit: { kind: "count", unit: "credit" } },
              accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
              semantic: {
                metric: { kind: "component", component: "current_balance" },
                prominence: "primary",
              },
            } satisfies QuotaToastEntry,
          ],
        }),
      ),
    ]);
    const row = cards[0]?.rows[0];
    expect(row?.kind).toBe("quantity");
    expect(row?.quantity?.decimal).toBe("1e3");
    expect(row?.label).toBe("Chutes balance");
    expect(row?.resultType).toBe("balance");
  });

  it("sanitizes control characters in labels and values", () => {
    const cards = cardsFor([
      probe(
        "glm",
        result({
          entries: [
            {
              kind: "percent",
              name: "We\u001B[31mekly\u0007",
              percentRemaining: 50,
              accounting: { ...TEST_ACCOUNTING },
              rowKey: "window:week",
            } satisfies QuotaToastEntry,
            {
              kind: "value",
              name: "Credits",
              value: "ok\u0000ay",
              accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
              rowKey: "named:credits",
            } satisfies QuotaToastEntry,
          ],
        }),
      ),
    ]);
    const rows = cards[0]?.rows ?? [];
    expect(rows[0]?.label).toBe("Weekly");
    expect(rows[1]?.value).toBe("okay");
  });

  it("copies sanitized entry info onto the mapped row and omits absent info", () => {
    const cards = cardsFor([
      probe(
        "opencode",
        result({
          entries: [
            {
              kind: "quantity",
              name: "Monthly spend",
              info: "  Workspace\nmonthly spend\u001B[31m  ",
              quantity: { decimal: "11.8202", unit: { kind: "currency", code: "USD" } },
              accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
              semantic: {
                metric: { kind: "window", window: "month" },
                prominence: "primary",
              },
            } satisfies QuotaToastEntry,
            percentEntry({ window: "week" }),
          ],
        }),
      ),
    ]);
    const rows = cards[0]?.rows ?? [];
    expect(rows[0]?.info).toBe("Workspace monthly spend");
    expect(rows[1]?.info).toBeUndefined();
  });

  it("removes a trailing colon from canonical GUI row labels", () => {
    const cards = cardsFor([
      probe(
        "kimi",
        result({
          entries: [
            {
              kind: "boolean",
              name: "Weekly quota:",
              value: true,
              accounting: { ...TEST_ACCOUNTING, resultType: "status" },
              semantic: {
                metric: { kind: "named", name: "Weekly quota:" },
                prominence: "primary",
              },
            } satisfies QuotaToastEntry,
          ],
        }),
      ),
    ]);
    expect(cards[0]?.rows[0]?.label).toBe("Weekly quota");
  });

  it("removes a trailing colon from fallback GUI row labels", () => {
    const cards = cardsFor([
      probe(
        "chutes",
        result({
          entries: [
            {
              kind: "quantity",
              name: "Chutes balance",
              label: "5h: ",
              quantity: { decimal: "1e3", unit: { kind: "count", unit: "credit" } },
              accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
            } satisfies QuotaToastEntry,
          ],
        }),
      ),
    ]);
    expect(cards[0]?.rows[0]?.label).toBe("5h");
  });
});

describe("gui provider cards — provider order", () => {
  function cardsInOrder(
    probes: readonly QuotaStatusLiveProbe[],
    providerOrder?: readonly string[],
  ): ReturnType<typeof buildProviderCards> {
    const preferences: ProviderCardPreferences =
      providerOrder === undefined ? SUMMARY : { ...SUMMARY, providerOrder };
    return buildProviderCards({ probes, preferences, nowMs: NOW });
  }

  const threeProbes = [
    probe("alpha", result({ entries: [percentEntry({ window: "week" })] })),
    probe("beta", result({ entries: [percentEntry({ window: "month" })] })),
    probe("gamma", result({ entries: [percentEntry({ window: "five_hour" })] })),
  ];

  it("applies the saved provider order", () => {
    const cards = cardsInOrder(threeProbes, ["gamma", "alpha"]);
    expect(cards.map((card) => card.providerId)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("keeps providers absent from the saved order stable at the end", () => {
    const probes = [
      probe("alpha", result({ entries: [percentEntry({ window: "week" })] })),
      probe("unknown-b", result({ entries: [percentEntry({ window: "week" })] })),
      probe("beta", result({ entries: [percentEntry({ window: "week" })] })),
      probe("unknown-a", result({ entries: [percentEntry({ window: "week" })] })),
    ];

    const cards = cardsInOrder(probes, ["beta"]);
    expect(cards.map((card) => card.providerId)).toEqual([
      "beta",
      "alpha",
      "unknown-b",
      "unknown-a",
    ]);
  });

  it("preserves probe order when no saved order exists", () => {
    expect(cardsInOrder(threeProbes).map((card) => card.providerId)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(cardsInOrder(threeProbes, []).map((card) => card.providerId)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("keeps account cards grouped immediately after their provider-scope card", () => {
    const probes = [
      probe(
        "alpha",
        result({
          accounts: [{ sourceId: "raw-a1", label: "A1" }, { sourceId: "raw-a2" }],
          entries: [
            percentEntry({ window: "month" }),
            percentEntry({ sourceId: "raw-a1", window: "week" }),
          ],
        }),
      ),
      probe(
        "beta",
        result({
          accounts: [{ sourceId: "raw-b1", label: "B1" }],
          entries: [
            percentEntry({ window: "month" }),
            percentEntry({ sourceId: "raw-b1", window: "week" }),
          ],
        }),
      ),
    ];

    const cards = cardsInOrder(probes, ["beta", "alpha"]);
    expect(cards.map((card) => card.providerId)).toEqual([
      "beta",
      "beta",
      "alpha",
      "alpha",
      "alpha",
    ]);
    expect(cards.map((card) => card.labelSource)).toEqual([
      "provider",
      "connection",
      "provider",
      "connection",
      "account",
    ]);
    expect(cards.map((card) => card.accountLabel)).toEqual([
      undefined,
      "B1",
      undefined,
      "A1",
      "Account 2",
    ]);
  });
});

describe("gui read source — composition", () => {
  it("keeps every window and card under singleWindow/onlyCurrentModel and hidden lists", async () => {
    const config = baseConfig({
      formatStyle: "singleWindow",
      onlyCurrentModel: true,
      dashboard: { ...DEFAULT_CONFIG.dashboard, hiddenCards: ["hidden"], hiddenRows: ["hidden"] },
    });
    const harness = createHarness({
      config,
      dataset: DATASET,
      probes: [
        probe(
          "anthropic",
          result({
            accounts: [{ sourceId: "raw-a", label: "Work" }],
            entries: [
              percentEntry({ sourceId: "raw-a", name: "5h", window: "five_hour" }),
              percentEntry({ sourceId: "raw-a", name: "Weekly", window: "week" }),
            ],
          }),
        ),
      ],
    });

    const home = await harness.source.home({ range: "7d" });

    expect(home.generatedAtMs).toBe(NOW);
    expect(home.range).toBe("7d");
    // Analytics never waits on quota: providers are empty here.
    expect(home.providers).toEqual({ cards: [], enabledProviders: [], polledAtMs: NOW });
    expect(home.usage.window.untilMs).toBe(NOW);
    expect(home.usage.totals.total).toBe(15);
    expect(home.usage.totals.apiEquivalentCostUsd).toBeNull();
    expect(home.projects.map((row) => row.projectId)).toEqual(["p1"]);
    expect(harness.collectorCalls).toHaveLength(0);
    expect(harness.datasetCalls.count).toBe(1);

    const snapshot = await harness.source.quota();
    expect(snapshot.generatedAtMs).toBe(NOW);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.providers.polledAtMs).toBe(NOW);
    expect(snapshot.providers.enabledProviders).toBe(config.enabledProviders);
    expect(snapshot.providers.cards).toHaveLength(1);
    expect(snapshot.providers.cards[0]?.rows.map((row) => row.label)).toEqual([
      "5h quota",
      "Weekly quota",
    ]);

    expect(harness.collectorCalls).toHaveLength(1);
    expect(harness.collectorCalls[0]?.nowMs).toBe(NOW);
    expect(harness.collectorCalls[0]?.config).toBe(config);
    expect(harness.collectorCalls[0]?.providers.map((provider) => provider.id)).toContain(
      "anthropic",
    );
    expect(harness.datasetCalls.count).toBe(1);
  });

  it("delegates project and session reads and maps missing ids to controlled errors", async () => {
    const harness = createHarness({ dataset: DATASET });

    const project = await harness.source.project({ projectId: "p1", range: "7d" });
    expect(project.projectId).toBe("p1");
    expect(project.name).toBe("Alpha");
    expect(project.roots.map((root) => root.sessionId)).toEqual(["ses_1"]);

    const session = await harness.source.session({ sessionId: "ses_1" });
    expect(session.focusSessionId).toBe("ses_1");
    expect(session.nodes.map((node) => node.sessionId)).toEqual(["ses_1"]);

    await expect(harness.source.project({ projectId: "missing", range: "7d" })).rejects.toThrow(
      DashboardSourceError,
    );
    await expect(
      harness.source.project({ projectId: "missing", range: "7d" }),
    ).rejects.toMatchObject({ code: "project-not-found", message: "Project not found" });
    await expect(harness.source.session({ sessionId: "missing" })).rejects.toMatchObject({
      code: "session-not-found",
      message: "Session not found",
    });

    expect(harness.collectorCalls).toHaveLength(0);
  });

  it("keeps configured spend quantities separate from API-equivalent usage cost", async () => {
    const harness = createHarness({
      probes: [
        probe(
          "opencode-go",
          result({
            entries: [
              {
                kind: "quantity",
                name: "Remaining credits",
                quantity: { decimal: "12.50", unit: { kind: "currency", code: "USD" } },
                accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
                semantic: {
                  metric: { kind: "component", component: "remaining_credits" },
                  prominence: "primary",
                },
              } satisfies QuotaToastEntry,
            ],
          }),
        ),
      ],
    });

    const home = await harness.source.home({ range: "lifetime" });
    expect(home.usage.totals.total).toBe(0);
    expect(home.usage.totals.apiEquivalentCostUsd).toBeNull();
    expect(home.providers.cards).toEqual([]);

    const snapshot = await harness.source.quota();
    const row = snapshot.providers.cards[0]?.rows[0];
    expect(row?.kind).toBe("quantity");
    expect(row?.resultType).toBe("spend");
    expect(row?.quantity?.decimal).toBe("12.50");
  });

  it("applies dashboard.providerOrder to quota cards without reordering rows", async () => {
    const config = baseConfig({
      dashboard: { ...DEFAULT_CONFIG.dashboard, providerOrder: ["gamma", "alpha"] },
    });
    const harness = createHarness({
      config,
      probes: [
        probe(
          "alpha",
          result({
            entries: [percentEntry({ window: "week" }), percentEntry({ window: "month" })],
          }),
        ),
        probe("beta", result({ entries: [percentEntry({ window: "week" })] })),
        probe(
          "gamma",
          result({
            entries: [percentEntry({ window: "five_hour" }), percentEntry({ window: "week" })],
          }),
        ),
      ],
    });

    const snapshot = await harness.source.quota();

    expect(snapshot.providers.cards.map((card) => card.providerId)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(snapshot.providers.cards.map((card) => card.rows.map((row) => row.metric))).toEqual([
      [
        { kind: "window", window: "five_hour" },
        { kind: "window", window: "week" },
      ],
      [
        { kind: "window", window: "week" },
        { kind: "window", window: "month" },
      ],
      [{ kind: "window", window: "week" }],
    ]);
  });
});

describe("gui provider cards — OpenAI optional visibility rows", () => {
  it("seeds Resets and Credits visibility independently of zero runtime data", () => {
    const cards = cardsFor([
      probe(
        "openai",
        result({
          accounts: [{ sourceId: "raw-openai-one", label: "Work" }],
          entries: [],
        }),
      ),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.rows).toEqual([]);
    expect(cards[0]?.visibilityRows?.map(({ label, info }) => ({ label, info }))).toEqual([
      { label: "Resets", info: OPENAI_RESETS_INFO },
      { label: "Credits", info: OPENAI_CREDITS_INFO },
    ]);
    const serialized = JSON.stringify(cards[0]?.visibilityRows);
    expect(serialized).not.toContain("raw-openai-one");
  });

  it("uses the same stable row ids the positive runtime rows carry", () => {
    const cards = cardsFor([
      probe(
        "openai",
        result({
          accounts: [{ sourceId: "raw-openai-one", label: "Work" }],
          entries: [
            valueEntry({
              sourceId: "raw-openai-one",
              name: "Resets",
              label: "Resets:",
              rowKey: OPENAI_RESETS_ROW_KEY,
              value: "3 available",
              resultType: "status",
              info: OPENAI_RESETS_INFO,
              bankedResets: { availableCount: 3, credits: [{ expiresAtIso: null }] },
            }),
            valueEntry({
              sourceId: "raw-openai-one",
              name: "Credits",
              label: "Credits:",
              rowKey: OPENAI_CREDITS_ROW_KEY,
              value: "12.34",
              resultType: "balance",
              info: OPENAI_CREDITS_INFO,
            }),
          ],
        }),
      ),
    ]);

    const card = cards[0]!;
    const [resetsVisibility, creditsVisibility] = card.visibilityRows ?? [];
    expect(card.rows.map((row) => row.rowId)).toEqual([
      resetsVisibility?.rowId,
      creditsVisibility?.rowId,
    ]);
    expect(card.rows[0]).toMatchObject({
      label: "Resets",
      kind: "value",
      resultType: "status",
      value: "3 available",
      info: OPENAI_RESETS_INFO,
      bankedResets: { availableCount: 3, credits: [{ expiresAtIso: null }] },
    });
    expect(card.rows[1]).toMatchObject({
      label: "Credits",
      kind: "value",
      resultType: "balance",
      value: "12.34",
      info: OPENAI_CREDITS_INFO,
    });
  });

  it("keeps account-specific ids separate and adds no optional rows to other providers", () => {
    const cards = cardsFor([
      probe(
        "openai",
        result({
          accounts: [{ sourceId: "raw-one" }, { sourceId: "raw-two" }],
        }),
      ),
      probe(
        "anthropic",
        result({
          accounts: [{ sourceId: "raw-claude" }],
          entries: [percentEntry({ sourceId: "raw-claude" })],
        }),
      ),
    ]);

    const openaiCards = cards.filter((card) => card.providerId === "openai");
    expect(openaiCards).toHaveLength(2);
    expect(openaiCards[0]?.visibilityRows?.[0]?.rowId).not.toBe(
      openaiCards[1]?.visibilityRows?.[0]?.rowId,
    );
    const anthropicCard = cards.find((card) => card.providerId === "anthropic");
    expect(anthropicCard?.visibilityRows).toBeUndefined();
  });
});
