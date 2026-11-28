/**
 * Every declared optional Visibility row must name the exact id its provider
 * emits for that field, and the Settings catalog must never show a declared row
 * beside a second emitted row for the same field.
 *
 * The fixtures mirror each adapter's own success mapping (window semantics,
 * component semantics, explicit row keys, and result types); provider surface
 * tests remain responsible for the full payload shape.
 */
import { describe, expect, it } from "vitest";
import { optionalRowId } from "../src/contracts/identity.js";
import { orderRowsByPreference } from "../src/contracts/row-order.js";
import { effectiveHiddenRowIds } from "../src/contracts/row-visibility.js";
import { buildProviderScopeCardId } from "../src/gui/identity.js";
import { buildProviderCards } from "../src/gui/provider-cards.js";
import type {
  AccountingComponent,
  AccountingResultType,
  AccountingWindow,
  QuotaPercentEntry,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import { getQuotaProviderRegistration } from "../src/lib/provider-metadata.js";
import { visibleRows } from "../src/ui/view-model.js";
import { catalogFromQuotaSnapshot } from "../src/ui/visibility-catalog.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

interface ValueEntryDraft {
  accounting: QuotaToastEntry["accounting"];
  name: string;
  rowKey?: string;
  semantic?: QuotaToastEntry["semantic"];
}

function accounting(resultType: AccountingResultType): QuotaToastEntry["accounting"] {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
  };
}

function percent(params: {
  resultType: AccountingResultType;
  window?: AccountingWindow;
  named?: string;
  component?: AccountingComponent;
  rowKey?: string;
}): QuotaPercentEntry {
  const entry: QuotaPercentEntry = {
    kind: "percent",
    accounting: accounting(params.resultType),
    name: params.rowKey ?? params.named ?? params.component ?? params.window ?? "row",
    percentRemaining: 50,
    semantic: params.named
      ? { metric: { kind: "named", name: params.named }, prominence: "primary" }
      : params.component
        ? { metric: { kind: "component", component: params.component }, prominence: "primary" }
        : { metric: { kind: "window", window: params.window ?? "week" }, prominence: "primary" },
  };
  if (params.rowKey !== undefined) {
    entry.rowKey = params.rowKey;
    delete entry.semantic;
  }
  return entry;
}

function value(params: {
  rowKey?: string;
  named?: string;
  component?: AccountingComponent;
  window?: AccountingWindow;
  resultType: AccountingResultType;
  rendered?: "value" | "quantity" | "boolean";
}): QuotaToastEntry {
  const rendered = params.rendered ?? "value";
  const base: ValueEntryDraft = {
    accounting: accounting(params.resultType),
    name: params.rowKey ?? params.named ?? params.component ?? params.window ?? "row",
  };
  if (params.rowKey !== undefined) base.rowKey = params.rowKey;
  const semantic =
    params.named !== undefined
      ? {
          metric: { kind: "named" as const, name: params.named },
          prominence: "primary" as const,
        }
      : params.component !== undefined
        ? {
            metric: { kind: "component" as const, component: params.component },
            prominence: "primary" as const,
          }
        : params.window !== undefined
          ? {
              metric: { kind: "window" as const, window: params.window },
              prominence: "primary" as const,
            }
          : undefined;
  if (semantic !== undefined) base.semantic = semantic;
  if (rendered === "quantity") {
    return {
      ...base,
      kind: "quantity",
      quantity: { decimal: "1", unit: { kind: "currency", code: "USD" } },
    };
  }
  if (rendered === "boolean") {
    return { ...base, kind: "boolean", value: true };
  }
  return { ...base, kind: "value", value: "1" };
}

function probe(providerId: string, entries: QuotaToastEntry[]) {
  return {
    providerId,
    result: { attempted: true as const, entries, errors: [] },
  };
}

function fieldKey(rowId: string): string {
  const hash = rowId.indexOf("#");
  const key = hash >= 0 ? rowId.slice(hash + 1) : rowId;
  const discriminator = key.lastIndexOf("|");
  return discriminator >= 0 ? key.slice(0, discriminator) : key;
}

const FIXTURES = {
  anthropic: [
    value({ rowKey: "rate_limit:requests", resultType: "rate_limit" }),
    value({ rowKey: "rate_limit:tokens", resultType: "rate_limit" }),
    value({ rowKey: "rate_limit:inputTokens", resultType: "rate_limit" }),
    value({ rowKey: "rate_limit:outputTokens", resultType: "rate_limit" }),
  ],
  "claude-agent": [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "month" }),
    percent({ resultType: "quota", named: "Fable weekly" }),
    value({ rowKey: "claude-agent:resets", resultType: "status" }),
  ],
  copilot: [
    percent({ resultType: "quota", window: "month" }),
    percent({ resultType: "budget", rowKey: "named:additional_usage" }),
  ],
  openai: [
    percent({ resultType: "rate_limit", window: "five_hour" }),
    percent({ resultType: "rate_limit", window: "week" }),
    percent({ resultType: "rate_limit", window: "month" }),
    percent({ resultType: "rate_limit", window: "code_review" }),
    value({ rowKey: "openai:resets", resultType: "status" }),
    value({ rowKey: "openai:credits", resultType: "balance" }),
  ],
  kilo: [
    percent({ resultType: "quota", component: "remaining_credits" }),
    value({ resultType: "balance", component: "total_balance", rendered: "quantity" }),
  ],
  "alibaba-coding-plan": [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "month" }),
  ],
  "alibaba-token-plan": [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
  ],
  synthetic: [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
  ],
  chutes: [percent({ resultType: "quota", window: "day" })],
  zai: [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "mcp" }),
  ],
  zhipu: [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "mcp" }),
  ],
  nanogpt: [
    percent({ resultType: "quota", window: "day" }),
    percent({ resultType: "quota", window: "month" }),
    value({ resultType: "balance", component: "current_balance", rendered: "quantity" }),
  ],
  deepseek: [
    value({ resultType: "balance", component: "total_balance", rendered: "quantity" }),
    value({ resultType: "balance", component: "granted_balance", rendered: "quantity" }),
    value({ resultType: "balance", component: "topped_up_balance", rendered: "quantity" }),
    value({ resultType: "status", named: "Availability", rendered: "boolean" }),
  ],
  xiaomi: [
    percent({ resultType: "quota", window: "month" }),
    value({ resultType: "balance", component: "total_balance", rendered: "quantity" }),
    value({ resultType: "balance", component: "cash_balance", rendered: "quantity" }),
    value({ resultType: "balance", component: "gift_balance", rendered: "quantity" }),
  ],
  "opencode-go": [
    percent({ resultType: "quota", window: "five_hour" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "month" }),
  ],
  opencode: [
    percent({ resultType: "budget", window: "month" }),
    value({ resultType: "spend", window: "month", rendered: "quantity" }),
    value({ resultType: "balance", component: "current_balance", rendered: "quantity" }),
    value({ resultType: "status", component: "auto_reload", rendered: "boolean" }),
  ],
  "ollama-cloud": [
    percent({ resultType: "quota", named: "Session" }),
    percent({ resultType: "quota", window: "week" }),
    percent({ resultType: "quota", window: "month" }),
    value({ resultType: "balance", component: "remaining_credits" }),
  ],
  mistral: [
    percent({ resultType: "budget", named: "Vibe budget" }),
    percent({ resultType: "budget", named: "API budget" }),
  ],
  // The CLI's rows carry its own bucket ids as explicit row keys, and only the
  // buckets the signed-in account has are reported.
  "antigravity-cli": [
    percent({ resultType: "quota", rowKey: "named:gemini-weekly" }),
    percent({ resultType: "quota", rowKey: "named:3p-weekly" }),
    percent({ resultType: "quota", rowKey: "named:3p-5h" }),
  ],
} satisfies Record<string, QuotaToastEntry[]>;

describe("provider optional Visibility declarations", () => {
  it.each(
    Object.entries(FIXTURES),
  )("names one emitted row per field for %s", (providerId, entries) => {
    const cardId = buildProviderScopeCardId(providerId);
    const card = buildProviderCards({
      probes: [probe(providerId, entries)],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    })[0]!;
    expect(card.cardId).toBe(cardId);

    const declared = getQuotaProviderRegistration(providerId)?.optionalVisibilityRows ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const emittedIds = new Set(card.rows.map((row) => row.rowId));

    for (const row of declared) {
      const declaredId = optionalRowId(cardId, row.rowKey, row.resultType, row.kind);
      expect(
        emittedIds.has(declaredId),
        `${providerId} declares ${row.rowKey} as ${declaredId}; emitted: ${[...emittedIds].join(", ")}`,
      ).toBe(true);
    }

    const combined = [...card.rows, ...(card.visibilityRows ?? [])];
    const union = new Map(combined.map((row) => [row.rowId, row]));
    const fields = [...union.values()].map((row) => `${fieldKey(row.rowId)}\u0000${row.label}`);
    expect(new Set(fields).size, `${providerId} has duplicate fields: ${fields.join(", ")}`).toBe(
      fields.length,
    );
    expect([...new Set(card.visibilityRows?.map((row) => row.rowId) ?? [])].sort()).toEqual(
      [...emittedIds].sort(),
    );
  });

  it("keeps the declared control id stable when Copilot emits the unlimited value shape", () => {
    const card = buildProviderCards({
      probes: [
        probe("copilot", [value({ resultType: "quota", window: "month", rendered: "value" })]),
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    })[0]!;
    const cardId = buildProviderScopeCardId("copilot");
    const monthlyId = optionalRowId(cardId, "window:month", "quota", "percent");
    const valueId = card.rows[0]?.rowId;
    expect(valueId).not.toBe(monthlyId);

    const monthly = card.visibilityRows?.find((row) => row.label === "Monthly quota");
    expect(monthly?.rowId).toBe(monthlyId);
    expect(monthly?.aliases).toContain(valueId);

    // SAFETY: the fixture card is the complete provider card; the snapshot
    // reader only consumes `providers.cards` for this catalog projection.
    const catalog = catalogFromQuotaSnapshot({ providers: { cards: [card] } } as never);
    expect(catalog.cards[0]?.rows.filter((row) => row.id === monthlyId)).toHaveLength(1);
    expect(catalog.cards[0]?.rows.some((row) => row.id === valueId)).toBe(false);
  });

  it("keeps one control with stable hide and order across absent, value, and percent shapes", () => {
    const alibabaCards = (entries: QuotaToastEntry[]) =>
      buildProviderCards({
        probes: [
          {
            providerId: "alibaba-coding-plan",
            result: {
              attempted: true,
              accounts: [{ sourceId: "raw-alibaba" }],
              entries: entries.map((entry) => ({
                ...entry,
                accounting: { ...entry.accounting, sourceId: "raw-alibaba" },
              })),
              errors: [],
            },
          },
        ],
        preferences: { accountingDetail: "summary" },
        nowMs: NOW,
      });

    const absent = alibabaCards([])[0]!;
    const cardId = absent.cardId;
    const fiveHour = optionalRowId(cardId, "window:five_hour", "quota", "percent");
    const week = optionalRowId(cardId, "window:week", "quota", "percent");
    const stableOrder = [week, fiveHour];
    const hiddenByStable = [fiveHour];

    expect(absent.rows).toEqual([]);
    expect(absent.visibilityRows?.find((row) => row.label === "5h")?.rowId).toBe(fiveHour);

    const valueCard = alibabaCards([value({ resultType: "status", window: "five_hour" })])[0]!;
    const valueRow = valueCard.rows[0]!;
    const valueControl = valueCard.visibilityRows?.find((row) => row.rowId === fiveHour);
    expect(valueControl?.aliases).toContain(valueRow.rowId);
    expect(visibleRows(valueCard.rows, hiddenByStable, valueCard.visibilityRows)).toEqual([]);
    // A hide saved under the old adopted value id still targets the control.
    expect(visibleRows(valueCard.rows, [valueRow.rowId], valueCard.visibilityRows)).toEqual([]);

    // SAFETY: the fixture card is the complete provider card; the snapshot
    // reader only consumes `providers.cards` for this catalog projection.
    const valueCatalog = catalogFromQuotaSnapshot({ providers: { cards: [valueCard] } } as never);
    expect(valueCatalog.cards[0]?.rows.filter((row) => row.id === fiveHour)).toHaveLength(1);
    // The catalog keeps provider emission order so a legacy hide resolves the
    // same way here as on Quota; Settings applies `stableOrder` for display.
    expect(valueCatalog.cards[0]?.rows.map((row) => row.id).slice(0, 2)).toEqual([fiveHour, week]);

    const percentCard = alibabaCards([
      percent({ resultType: "quota", window: "five_hour" }),
      percent({ resultType: "quota", window: "week" }),
    ])[0]!;
    expect(percentCard.rows.map((row) => row.rowId)).toEqual([fiveHour, week]);
    expect(
      visibleRows(percentCard.rows, hiddenByStable, percentCard.visibilityRows).map(
        (row) => row.rowId,
      ),
    ).toEqual([week]);
    // The same saved value-shape id stays effective when only percent is live.
    expect(
      visibleRows(percentCard.rows, [valueRow.rowId], percentCard.visibilityRows).map(
        (row) => row.rowId,
      ),
    ).toEqual([week]);
    expect(
      orderRowsByPreference(
        percentCard.rows,
        stableOrder,
        (row) => row.rowId,
        percentCard.visibilityRows,
      ).map((row) => row.rowId),
    ).toEqual([week, fiveHour]);

    const absentAgain = alibabaCards([])[0]!;
    const absentControl = absentAgain.visibilityRows?.find((row) => row.label === "5h");
    expect(absentControl?.rowId).toBe(fiveHour);
    expect(absentControl?.aliases).toContain(valueRow.rowId);
    // The persisted alias still resolves while the field is absent.
    expect(
      effectiveHiddenRowIds([valueRow.rowId], hiddenByStable, absentAgain.visibilityRows).has(
        valueRow.rowId,
      ),
    ).toBe(true);
  });
});
