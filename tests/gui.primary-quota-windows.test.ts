/**
 * Stage 6 projection: primary quota-window references for the native
 * `session.header` tokens. The server names existing percent rows and assigns
 * each a stable provider-defined slot; clients never infer rings from labels,
 * array position or ordinal.
 */
import { describe, expect, it } from "vitest";
import type { PrimaryQuotaWindowRef, ProviderCard } from "../src/contracts/dashboard.js";
import { isQuotaSnapshot } from "../src/contracts/dto-guards.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import { rowIdForEntry } from "../src/gui/identity.js";
import { buildProviderCards, type ProviderCardPreferences } from "../src/gui/provider-cards.js";
import type {
  AccountingComponent,
  AccountingResultType,
  AccountingWindow,
  QuotaPercentEntry,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import type { QuotaStatusLiveProbe } from "../src/lib/quota-render-data.js";
import { DashboardError, parseQuotaSnapshot } from "../src/ui/dashboard-client.js";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const SUMMARY: ProviderCardPreferences = { accountingDetail: "summary" };

const TEST_ACCOUNTING = {
  resultType: "quota" satisfies AccountingResultType,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

function percentEntry(params: {
  sourceId?: string;
  resultType?: AccountingResultType;
  rowKey?: string;
  window?: AccountingWindow;
  named?: string;
  component?: AccountingComponent;
  prominence?: "primary" | "supplementary";
  percentRemaining?: number;
  name?: string;
}): QuotaPercentEntry {
  const accounting: QuotaPercentEntry["accounting"] = {
    ...TEST_ACCOUNTING,
    resultType: params.resultType ?? "quota",
  };
  if (params.sourceId !== undefined) accounting.sourceId = params.sourceId;

  const entry: QuotaPercentEntry = {
    kind: "percent",
    name: params.name ?? "quota",
    percentRemaining: params.percentRemaining ?? 62.5,
    accounting,
  };
  if (params.rowKey !== undefined) entry.rowKey = params.rowKey;
  if (params.window !== undefined || params.named !== undefined || params.component !== undefined) {
    entry.semantic = {
      metric:
        params.window !== undefined
          ? { kind: "window", window: params.window }
          : params.component !== undefined
            ? { kind: "component", component: params.component }
            : { kind: "named", name: params.named as string },
      prominence: params.prominence ?? "primary",
    };
  }
  return entry;
}

function result(overrides: Partial<QuotaProviderResult> = {}): QuotaProviderResult {
  return { attempted: true, entries: [], errors: [], ...overrides };
}

function probe(providerId: string, value: QuotaProviderResult): QuotaStatusLiveProbe {
  return { providerId, result: value };
}

function cardsFor(probes: readonly QuotaStatusLiveProbe[]): ProviderCard[] {
  return buildProviderCards({ probes, preferences: SUMMARY, nowMs: NOW });
}

function cardFor(providerId: string, entries: readonly QuotaToastEntry[]): ProviderCard {
  const card = cardsFor([probe(providerId, result({ entries }))])[0];
  if (!card) throw new Error(`expected a ${providerId} card`);
  return card;
}

function expectedWindow(
  card: ProviderCard,
  entry: QuotaToastEntry,
  slot: PrimaryQuotaWindowRef["slot"],
): PrimaryQuotaWindowRef {
  return { rowId: rowIdForEntry(card.cardId, entry), slot };
}

function expectValidPrimaryReferences(card: ProviderCard): void {
  const primary = card.primaryQuotaWindows;
  if (primary === undefined) return;
  expect(primary.length).toBeLessThanOrEqual(3);
  expect(new Set(primary.map((window) => window.rowId)).size).toBe(primary.length);
  expect(new Set(primary.map((window) => window.slot)).size).toBe(primary.length);
  const slots = primary.map((window) => window.slot);
  expect([...slots].sort()).toEqual(slots);
  const rows = new Map(card.rows.map((row) => [row.rowId, row] as const));
  for (const window of primary) {
    expect([0, 1, 2]).toContain(window.slot);
    const row = rows.get(window.rowId);
    expect(row, `${window.rowId} must reference an existing row`).toBeDefined();
    expect(row?.kind).toBe("percent");
    expect(["quota", "rate_limit"]).toContain(row?.resultType);
    expect(Number.isFinite(row?.percentRemaining)).toBe(true);
    expect(window.rowId.startsWith(`${card.cardId}#`)).toBe(true);
  }
}

describe("primary quota-window projection", () => {
  it("maps OpenAI's three usage windows in full-card order and omits code-review", () => {
    const fiveHour = percentEntry({
      resultType: "rate_limit",
      rowKey: "window:five_hour",
      name: "5h row",
    });
    const weekly = percentEntry({
      resultType: "rate_limit",
      rowKey: "window:week",
      name: "weekly row",
    });
    const monthly = percentEntry({
      resultType: "rate_limit",
      rowKey: "window:month",
      name: "monthly row",
    });
    const codeReview = percentEntry({
      resultType: "rate_limit",
      rowKey: "window:code_review",
      name: "code review row",
    });

    const card = cardFor("openai", [fiveHour, weekly, monthly, codeReview]);

    expect(card.primaryQuotaWindows).toEqual([
      expectedWindow(card, fiveHour, 0),
      expectedWindow(card, weekly, 1),
      expectedWindow(card, monthly, 2),
    ]);
    expect(card.primaryQuotaWindows?.map((window) => window.rowId)).not.toContain(
      expectedWindow(card, codeReview, 0).rowId,
    );
    expectValidPrimaryReferences(card);
  });

  it("maps Anthropic 5h/weekly/Fable and excludes monthly usage credits", () => {
    const fiveHour = percentEntry({ rowKey: "window:five_hour" });
    const weekly = percentEntry({ rowKey: "window:week" });
    const usageCredits = percentEntry({ rowKey: "window:month", name: "Usage Credits" });
    const fable = percentEntry({ named: "Fable weekly", name: "Fable weekly" });

    const card = cardFor("anthropic", [fiveHour, weekly, usageCredits, fable]);

    expect(card.primaryQuotaWindows).toEqual([
      expectedWindow(card, fiveHour, 0),
      expectedWindow(card, weekly, 1),
      expectedWindow(card, fable, 2),
    ]);
    expect(card.primaryQuotaWindows?.map((window) => window.rowId)).not.toContain(
      expectedWindow(card, usageCredits, 0).rowId,
    );
  });

  it.each(["zai", "zhipu"])("keeps %s five-hour/weekly windows and omits MCP", (providerId) => {
    const fiveHour = percentEntry({ rowKey: "window:five_hour" });
    const weekly = percentEntry({ rowKey: "window:week" });
    const mcp = percentEntry({ rowKey: "window:mcp", name: "MCP" });

    const card = cardFor(providerId, [fiveHour, weekly, mcp]);

    expect(card.primaryQuotaWindows).toEqual([
      expectedWindow(card, fiveHour, 0),
      expectedWindow(card, weekly, 1),
    ]);
    expect(card.primaryQuotaWindows?.map((window) => window.rowId)).not.toContain(
      expectedWindow(card, mcp, 0).rowId,
    );
  });

  it("keeps all three OpenCode Go subscription windows", () => {
    const fiveHour = percentEntry({ rowKey: "window:five_hour" });
    const weekly = percentEntry({ rowKey: "window:week" });
    const monthly = percentEntry({ rowKey: "window:month" });

    const card = cardFor("opencode-go", [fiveHour, weekly, monthly]);

    expect(card.primaryQuotaWindows).toEqual([
      expectedWindow(card, fiveHour, 0),
      expectedWindow(card, weekly, 1),
      expectedWindow(card, monthly, 2),
    ]);
  });

  it("uses typed semantic windows, not display labels, for semantic providers", () => {
    const daily = percentEntry({ window: "day", name: "Monthly-looking label" });
    const monthly = percentEntry({ window: "month", name: "Daily-looking label" });
    const auxiliaryWeek = percentEntry({
      window: "week",
      prominence: "supplementary",
      name: "5h-looking label",
    });
    const nano = cardFor("nanogpt", [daily, monthly, auxiliaryWeek]);

    expect(nano.primaryQuotaWindows).toEqual([
      expectedWindow(nano, daily, 0),
      expectedWindow(nano, monthly, 1),
    ]);

    const fiveHour = percentEntry({ window: "five_hour", name: "Weekly-looking label" });
    const week = percentEntry({ window: "week", name: "5h-looking label" });
    const minimax = cardFor("minimax-coding-plan", [fiveHour, week]);
    expect(minimax.primaryQuotaWindows).toEqual([
      expectedWindow(minimax, fiveHour, 0),
      expectedWindow(minimax, week, 1),
    ]);

    const month = percentEntry({ window: "month", name: "Balance-looking label" });
    const xiaomi = cardFor("xiaomi", [month]);
    expect(xiaomi.primaryQuotaWindows).toEqual([expectedWindow(xiaomi, month, 0)]);
  });

  it("includes the Kilo Pass quota percentage at its single stable slot", () => {
    const credits = percentEntry({
      component: "remaining_credits",
      name: "Kilo credits",
    });
    const card = cardFor("kilo", [credits]);

    expect(card.primaryQuotaWindows).toEqual([expectedWindow(card, credits, 0)]);
  });

  it("omits custom quota-provider rows because result type alone is not primary evidence", () => {
    const quota = percentEntry({ resultType: "quota", name: "quota" });
    const rateLimit = percentEntry({ resultType: "rate_limit", name: "rate limit" });
    const budget = percentEntry({ resultType: "budget", name: "budget" });
    const card = cardFor("quota-providers", [quota, rateLimit, budget]);

    expect(card).not.toHaveProperty("primaryQuotaWindows");
  });

  it("omits Alibaba Token and Ollama rows whose aggregate meaning moves with availability", () => {
    for (const providerId of ["alibaba-token-plan", "ollama-cloud"]) {
      const first = percentEntry({ name: "first available window", percentRemaining: 70 });
      const later = percentEntry({ name: "later window", percentRemaining: 20 });

      const firstOnly = cardFor(providerId, [first]);
      const laterOnly = cardFor(providerId, [later]);

      // The aggregate row identity is stable while its window meaning is not.
      expect(firstOnly.rows[0]?.rowId).toBe(laterOnly.rows[0]?.rowId);
      expect(firstOnly.rows[0]?.label).not.toBe(laterOnly.rows[0]?.label);
      expect(firstOnly).not.toHaveProperty("primaryQuotaWindows");
      expect(laterOnly).not.toHaveProperty("primaryQuotaWindows");
    }
  });

  it("keeps static single-window provider rows that cannot change meaning", () => {
    const chutes = percentEntry({ name: "Chutes quota" });
    const chutesCard = cardFor("chutes", [chutes]);
    expect(chutesCard.primaryQuotaWindows).toEqual([expectedWindow(chutesCard, chutes, 0)]);

    // Alibaba Coding Plan always emits 5h/weekly/monthly in that order, so the
    // surviving aggregate row is always the static 5h row.
    const codingPlan = [
      percentEntry({ name: "5h" }),
      percentEntry({ name: "Weekly" }),
      percentEntry({ name: "Monthly" }),
    ];
    const codingPlanCard = cardFor("alibaba-coding-plan", codingPlan);
    expect(codingPlanCard.rows).toHaveLength(1);
    expect(codingPlanCard.primaryQuotaWindows).toEqual([
      expectedWindow(codingPlanCard, codingPlan[0] as QuotaToastEntry, 0),
    ]);
  });

  it.each([
    ["cursor", "budget", "named" as const],
    ["openrouter", "budget", "untyped" as const],
    ["opencode", "budget", "window" as const],
  ])("omits %s's budget percentage", (providerId, resultType, shape) => {
    const entry =
      shape === "named"
        ? percentEntry({ resultType: resultType as AccountingResultType, named: "API" })
        : shape === "window"
          ? percentEntry({ resultType: resultType as AccountingResultType, window: "month" })
          : percentEntry({ resultType: resultType as AccountingResultType });
    const card = cardFor(providerId, [entry]);
    expect(card).not.toHaveProperty("primaryQuotaWindows");
  });

  it("omits Copilot's additional-usage budget while keeping its monthly quota", () => {
    const quota = percentEntry({ rowKey: "window:month", name: "Copilot Premium Requests" });
    const budget = percentEntry({
      resultType: "budget",
      rowKey: "named:additional_usage",
      name: "Copilot Additional Usage",
    });
    const card = cardFor("copilot", [quota, budget]);

    expect(card.primaryQuotaWindows).toEqual([expectedWindow(card, quota, 0)]);
    expect(card.primaryQuotaWindows?.map((window) => window.rowId)).not.toContain(
      expectedWindow(card, budget, 0).rowId,
    );
  });

  it.each([
    "google-agy",
    "google-gemini-cli",
    "kimi-code-plan-global",
    "kimi-code-plan-cn",
  ])("omits ambiguous response-defined rows for %s", (providerId) => {
    const dynamic = percentEntry({ rowKey: "named:response-defined-window" });
    expect(cardFor(providerId, [dynamic])).not.toHaveProperty("primaryQuotaWindows");
  });

  it("omits providers with no finite percentage quota row", () => {
    const balance: QuotaToastEntry = {
      kind: "quantity",
      name: "DeepSeek balance",
      quantity: { decimal: "12.00", unit: { kind: "currency", code: "USD" } },
      accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
      semantic: {
        metric: { kind: "component", component: "total_balance" },
        prominence: "primary",
      },
    };
    expect(cardFor("deepseek", [balance])).not.toHaveProperty("primaryQuotaWindows");

    const missingPercent = percentEntry({
      rowKey: "window:five_hour",
      percentRemaining: Number.NaN,
    });
    const weekly = percentEntry({ rowKey: "window:week" });
    const card = cardFor("openai", [missingPercent, weekly]);
    expect(card.primaryQuotaWindows).toEqual([expectedWindow(card, weekly, 1)]);
  });

  it("deduplicates row ids first-occurrence and never repeats a primary reference", () => {
    const fiveHour = percentEntry({ resultType: "rate_limit", rowKey: "window:five_hour" });
    const duplicateFiveHour = percentEntry({
      resultType: "rate_limit",
      rowKey: "window:five_hour",
      name: "duplicate",
    });
    const weekly = percentEntry({ resultType: "rate_limit", rowKey: "window:week" });
    const monthly = percentEntry({ resultType: "rate_limit", rowKey: "window:month" });

    const card = cardFor("openai", [fiveHour, duplicateFiveHour, weekly, monthly]);

    expect(card.rows).toHaveLength(3);
    expect(card.primaryQuotaWindows).toEqual([
      expectedWindow(card, fiveHour, 0),
      expectedWindow(card, weekly, 1),
      expectedWindow(card, monthly, 2),
    ]);
    expect(new Set(card.primaryQuotaWindows?.map((window) => window.rowId)).size).toBe(3);
    expectValidPrimaryReferences(card);
  });

  it("references the single surviving static row when Synthetic windows collapse", () => {
    // Synthetic always emits 5h then weekly, so the aggregate row's meaning is
    // statically the 5h window rather than whichever window happened to exist.
    const fiveHour = percentEntry({ name: "5h" });
    const weekly = percentEntry({ name: "Weekly" });
    const card = cardFor("synthetic", [fiveHour, weekly]);

    expect(card.rows).toHaveLength(1);
    expect(card.primaryQuotaWindows).toEqual([expectedWindow(card, fiveHour, 0)]);
  });

  it("holds stable slots when earlier windows disappear", () => {
    const fiveHour = percentEntry({ rowKey: "window:five_hour" });
    const weekly = percentEntry({ rowKey: "window:week" });
    const monthly = percentEntry({ rowKey: "window:month" });
    const fable = percentEntry({ named: "Fable weekly", name: "Fable weekly" });

    const weeklyOnly = cardFor("openai", [weekly]);
    expect(weeklyOnly.primaryQuotaWindows).toEqual([expectedWindow(weeklyOnly, weekly, 1)]);

    const monthlyOnly = cardFor("openai", [monthly]);
    expect(monthlyOnly.primaryQuotaWindows).toEqual([expectedWindow(monthlyOnly, monthly, 2)]);

    const firstAndLast = cardFor("openai", [fiveHour, monthly]);
    expect(firstAndLast.primaryQuotaWindows).toEqual([
      expectedWindow(firstAndLast, fiveHour, 0),
      expectedWindow(firstAndLast, monthly, 2),
    ]);

    const withoutWeekly = cardFor("anthropic", [fiveHour, fable]);
    expect(withoutWeekly.primaryQuotaWindows).toEqual([
      expectedWindow(withoutWeekly, fiveHour, 0),
      expectedWindow(withoutWeekly, fable, 2),
    ]);

    const fableOnly = cardFor("anthropic", [fable]);
    expect(fableOnly.primaryQuotaWindows).toEqual([expectedWindow(fableOnly, fable, 2)]);

    const xaiWeek = percentEntry({ rowKey: "window:week" });
    const xaiWeekCard = cardFor("xai", [xaiWeek]);
    expect(xaiWeekCard.primaryQuotaWindows).toEqual([expectedWindow(xaiWeekCard, xaiWeek, 0)]);

    const xaiMonth = percentEntry({ rowKey: "window:month" });
    const xaiMonthCard = cardFor("xai", [xaiMonth]);
    expect(xaiMonthCard.primaryQuotaWindows).toEqual([expectedWindow(xaiMonthCard, xaiMonth, 0)]);

    const nanoMonth = percentEntry({ window: "month" });
    const nanoMonthCard = cardFor("nanogpt", [nanoMonth]);
    expect(nanoMonthCard.primaryQuotaWindows).toEqual([
      expectedWindow(nanoMonthCard, nanoMonth, 1),
    ]);
  });

  it("uses outer slot 0 for each single-window card family", () => {
    const copilotMonth = percentEntry({ rowKey: "window:month" });
    const copilot = cardFor("copilot", [copilotMonth]);
    expect(copilot.primaryQuotaWindows).toEqual([expectedWindow(copilot, copilotMonth, 0)]);

    const xiaomiMonth = percentEntry({ window: "month" });
    const xiaomi = cardFor("xiaomi", [xiaomiMonth]);
    expect(xiaomi.primaryQuotaWindows).toEqual([expectedWindow(xiaomi, xiaomiMonth, 0)]);

    for (const rowKey of ["window:day", "window:week", "window:month", "named:period"]) {
      const xaiWindow = percentEntry({ rowKey });
      const xai = cardFor("xai", [xaiWindow]);
      expect(xai.primaryQuotaWindows).toEqual([expectedWindow(xai, xaiWindow, 0)]);
    }
  });

  it("omits Kimi root/dynamic keys that collide instead of inventing an identity", () => {
    const rootWeekly = percentEntry({ rowKey: "named:weekly", name: "Root weekly" });
    const dynamicWeekly = percentEntry({ rowKey: "named:weekly", name: "Dynamic weekly" });
    for (const providerId of ["kimi-code-plan-global", "kimi-code-plan-cn"]) {
      const card = cardFor(providerId, [rootWeekly, dynamicWeekly]);
      expect(card.rows).toHaveLength(1);
      expect(card).not.toHaveProperty("primaryQuotaWindows");
    }
  });

  it("keeps primary ids account-scoped and free of raw identities", () => {
    const workFiveHour = percentEntry({ sourceId: "raw-work", rowKey: "window:five_hour" });
    const workWeekly = percentEntry({ sourceId: "raw-work", rowKey: "window:week" });
    const personalFiveHour = percentEntry({
      sourceId: "raw-personal",
      rowKey: "window:five_hour",
    });
    const cards = cardsFor([
      probe(
        "openai",
        result({
          accounts: [
            { sourceId: "raw-work", label: "Work" },
            { sourceId: "raw-personal", label: "Personal" },
          ],
          entries: [workFiveHour, workWeekly, personalFiveHour],
        }),
      ),
    ]);
    const work = cards.find((card) => card.accountLabel === "Work");
    const personal = cards.find((card) => card.accountLabel === "Personal");
    expect(work).toBeDefined();
    expect(personal).toBeDefined();

    expect(work?.primaryQuotaWindows).toEqual([
      expectedWindow(work as ProviderCard, workFiveHour, 0),
      expectedWindow(work as ProviderCard, workWeekly, 1),
    ]);
    expect(personal?.primaryQuotaWindows).toEqual([
      expectedWindow(personal as ProviderCard, personalFiveHour, 0),
    ]);
    expect(work?.primaryQuotaWindows).not.toEqual(personal?.primaryQuotaWindows);

    const serialized = JSON.stringify(cards);
    expect(serialized).not.toContain("raw-work");
    expect(serialized).not.toContain("raw-personal");
    for (const card of cards) {
      expectValidPrimaryReferences(card);
      for (const window of card.primaryQuotaWindows ?? []) {
        expect(window.rowId.startsWith(`${card.cardId}#`)).toBe(true);
      }
    }
  });

  it("never emits more than three references for a card with four candidate rows", () => {
    const entries = [
      percentEntry({ rowKey: "window:five_hour" }),
      percentEntry({ rowKey: "window:week" }),
      percentEntry({ rowKey: "window:month" }),
      percentEntry({ rowKey: "window:code_review" }),
    ];
    const card = cardFor("openai", entries);
    expect(card.primaryQuotaWindows).toHaveLength(3);
    expectValidPrimaryReferences(card);
  });
});

function invalidPrimaryRows(): ProviderCard["rows"] {
  return [
    {
      rowId: "openai:card#value|quota:value" as RowId,
      label: "Not a percentage",
      kind: "value",
      resultType: "quota",
      value: "text",
    },
    {
      rowId: "openai:card#budget|budget:percent" as RowId,
      label: "Budget",
      kind: "percent",
      resultType: "budget",
      percentRemaining: 50,
      percentUsed: 50,
    },
    {
      rowId: "openai:card#missing-percent|quota:percent" as RowId,
      label: "No finite percentage",
      kind: "percent",
      resultType: "quota",
      percentUsed: 50,
    },
  ];
}

function snapshotWith(card: ProviderCard): unknown {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [card], enabledProviders: "auto", polledAtMs: NOW },
  };
}

function dtoCard(
  overrides: Partial<ProviderCard> = {},
  rows: ProviderCard["rows"] = [
    {
      rowId: "openai:card#window:five_hour|rate_limit:percent" as RowId,
      label: "5h",
      kind: "percent",
      resultType: "rate_limit",
      percentRemaining: 50,
      percentUsed: 50,
    },
    {
      rowId: "openai:card#window:week|rate_limit:percent" as RowId,
      label: "Weekly",
      kind: "percent",
      resultType: "rate_limit",
      percentRemaining: 25,
      percentUsed: 75,
    },
  ],
): ProviderCard {
  return {
    cardId: "openai:card" as CardId,
    providerId: "openai",
    providerLabel: "OpenAI",
    labelSource: "provider",
    rows,
    errors: [],
    ...overrides,
  };
}

function windowRef(rowId: RowId, slot: PrimaryQuotaWindowRef["slot"]): PrimaryQuotaWindowRef {
  return { rowId, slot };
}

function fourRows(): ProviderCard["rows"] {
  return [
    ...dtoCard().rows,
    {
      rowId: "openai:card#window:month|quota:percent" as RowId,
      label: "Monthly",
      kind: "percent" as const,
      resultType: "quota" as const,
      percentRemaining: 30,
      percentUsed: 70,
    },
    {
      rowId: "openai:card#window:day|quota:percent" as RowId,
      label: "Daily",
      kind: "percent" as const,
      resultType: "quota" as const,
      percentRemaining: 40,
      percentUsed: 60,
    },
  ];
}

describe("primary quota-window DTO validation", () => {
  const [firstRow, secondRow] = dtoCard().rows;
  const first = firstRow?.rowId as RowId;
  const second = secondRow?.rowId as RowId;

  it("accepts optional absence and valid stable slots", () => {
    expect(isQuotaSnapshot(snapshotWith(dtoCard()))).toBe(true);
    expect(
      isQuotaSnapshot(snapshotWith(dtoCard({ primaryQuotaWindows: [windowRef(first, 0)] }))),
    ).toBe(true);
    expect(
      isQuotaSnapshot(
        snapshotWith(dtoCard({ primaryQuotaWindows: [windowRef(first, 0), windowRef(second, 1)] })),
      ),
    ).toBe(true);
    expect(
      isQuotaSnapshot(snapshotWith(dtoCard({ primaryQuotaWindows: [windowRef(second, 1)] }))),
    ).toBe(true);
    expect(
      isQuotaSnapshot(snapshotWith(dtoCard({ primaryQuotaWindows: [windowRef(second, 2)] }))),
    ).toBe(true);
  });

  it("rejects wrong types, duplicate ids/slots, over-limit, unknown and invalid rows", () => {
    const rows = fourRows();
    const third = rows[2]?.rowId as RowId;
    const fourth = rows[3]?.rowId as RowId;
    const invalid = [
      dtoCard({ primaryQuotaWindows: "not-an-array" as never }),
      dtoCard({ primaryQuotaWindows: [7 as never] }),
      dtoCard({
        primaryQuotaWindows: [
          { rowId: first, slot: 0 },
          { rowId: first, slot: 1 },
        ],
      }),
      dtoCard({
        primaryQuotaWindows: [
          { rowId: first, slot: 0 },
          { rowId: second, slot: 0 },
        ],
      }),
      dtoCard({ primaryQuotaWindows: [{ rowId: first, slot: 3 as never }] }),
      dtoCard({ primaryQuotaWindows: [{ rowId: first, slot: 1.5 as never }] }),
      dtoCard({ primaryQuotaWindows: [{ rowId: first, slot: "0" as never }] }),
      dtoCard({
        rows,
        primaryQuotaWindows: [
          windowRef(first, 0),
          windowRef(second, 1),
          windowRef(third, 2),
          windowRef(fourth, 0),
        ],
      }),
      dtoCard({ primaryQuotaWindows: [{ rowId: "openai:card#missing" as RowId, slot: 0 }] }),
    ];
    for (const card of invalid) {
      expect(isQuotaSnapshot(snapshotWith(card)), JSON.stringify(card)).toBe(false);
    }

    for (const row of invalidPrimaryRows()) {
      const card = dtoCard({
        rows: [...dtoCard().rows, row],
        primaryQuotaWindows: [windowRef(row.rowId, 0)],
      });
      expect(isQuotaSnapshot(snapshotWith(card)), JSON.stringify(row)).toBe(false);
    }
  });
});

describe("primary quota-window client decoder", () => {
  const [firstRow, secondRow] = dtoCard().rows;
  const first = firstRow?.rowId as RowId;
  const second = secondRow?.rowId as RowId;

  function parse(card: ProviderCard): ReturnType<typeof parseQuotaSnapshot> {
    return parseQuotaSnapshot(snapshotWith(card) as never);
  }

  it("preserves an absent field and decodes stable slots", () => {
    const absent = parse(dtoCard());
    expect(absent.providers.cards[0]).not.toHaveProperty("primaryQuotaWindows");

    const parsed = parse(
      dtoCard({ primaryQuotaWindows: [windowRef(second, 1), windowRef(first, 0)] }),
    );
    expect(parsed.providers.cards[0]?.primaryQuotaWindows).toEqual([
      windowRef(second, 1),
      windowRef(first, 0),
    ]);
  });

  it("rejects duplicates, over-limit, invalid slots, unknown and invalid rows", () => {
    const rows = fourRows();
    const third = rows[2]?.rowId as RowId;
    const fourth = rows[3]?.rowId as RowId;
    const invalid = [
      dtoCard({
        primaryQuotaWindows: [
          { rowId: first, slot: 0 },
          { rowId: first, slot: 1 },
        ],
      }),
      dtoCard({
        primaryQuotaWindows: [
          { rowId: first, slot: 0 },
          { rowId: second, slot: 0 },
        ],
      }),
      dtoCard({ primaryQuotaWindows: [{ rowId: first, slot: 3 as never }] }),
      dtoCard({ primaryQuotaWindows: [{ rowId: first, slot: -1 as never }] }),
      dtoCard({
        rows,
        primaryQuotaWindows: [
          windowRef(first, 0),
          windowRef(second, 1),
          windowRef(third, 2),
          windowRef(fourth, 0),
        ],
      }),
      dtoCard({ primaryQuotaWindows: [{ rowId: "openai:card#missing" as RowId, slot: 0 }] }),
    ];
    for (const card of invalid) {
      expect(() => parse(card), JSON.stringify(card)).toThrow(DashboardError);
    }

    for (const row of invalidPrimaryRows()) {
      const card = dtoCard({
        rows: [...dtoCard().rows, row],
        primaryQuotaWindows: [windowRef(row.rowId, 0)],
      });
      expect(() => parse(card), JSON.stringify(row)).toThrow(DashboardError);
    }

    expect(() =>
      parse({
        ...dtoCard(),
        primaryQuotaWindows: "not-an-array" as never,
      }),
    ).toThrow(DashboardError);
  });
});
