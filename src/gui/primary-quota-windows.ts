/**
 * Server-side primary quota-window classification for the native
 * `session.header` tokens (migration architecture §8, Stage 6).
 *
 * The projection only promotes an **existing** finite percentage row whose
 * provider-owned identity says it is one of the subscription's main usage
 * windows. Display labels, emission position, current utilization and the
 * "most constraining" row never decide membership or slot. Budget, spend,
 * balance, credits, model/tool-specific secondary allowances and
 * response-defined dynamic rows stay in the combined preview and full card.
 *
 * Slots are stable per-card family positions in full-card order (0 outer,
 * 1 middle, 2 inner), not global time-unit ranks; they are assigned from
 * established window semantics, never from utilization. A missing earlier
 * window leaves later windows on their original slot. Identity follows
 * `rowIdForEntry` exactly: `semantic.metric` first, then an explicit provider
 * `rowKey`, then the aggregate result-type identity. Rules are keyed by
 * provider id so a shared row key cannot leak across providers.
 */
import type { PrimaryQuotaWindowSlot } from "../contracts/dashboard.js";
import type { AccountingComponent, AccountingWindow, QuotaToastEntry } from "../lib/entries.js";
import { isPercentEntry } from "../lib/entries.js";

interface SlotValue<T> {
  readonly value: T;
  readonly slot: PrimaryQuotaWindowSlot;
}

interface PrimaryQuotaWindowRule {
  /** Explicit provider row keys (providers with no typed semantic). */
  readonly rowKeys?: readonly SlotValue<string>[];
  /** Typed semantic window metrics. */
  readonly windows?: readonly SlotValue<AccountingWindow>[];
  /** Typed semantic named metrics that the provider itself marks primary. */
  readonly namedMetrics?: readonly SlotValue<string>[];
  /** Typed semantic component metrics that still represent the plan quota. */
  readonly components?: readonly SlotValue<AccountingComponent>[];
  /** Providers whose single static percent row has no semantic or rowKey. */
  readonly untypedSlot?: PrimaryQuotaWindowSlot;
}

/**
 * Explicit, evidence-backed mapping. Omitted providers intentionally have no
 * defensible primary/auxiliary split in their current source (see the Stage 6
 * report); adding one is a provider-semantics change, not a label heuristic.
 */
const PRIMARY_QUOTA_WINDOW_RULES: Readonly<Record<string, PrimaryQuotaWindowRule>> = {
  // 5h, weekly, and the provider's explicit Fable weekly slot; `window:month`
  // is Usage Credits (`src/providers/anthropic.ts` 160-195, 240-274).
  anthropic: {
    rowKeys: [
      { value: "window:five_hour", slot: 0 },
      { value: "window:week", slot: 1 },
    ],
    namedMetrics: [{ value: "Fable weekly", slot: 2 }],
  },
  // 5h/weekly/monthly ChatGPT windows; Code Review is a special secondary
  // window (`src/providers/openai.ts` 56-75, 239-261).
  openai: {
    rowKeys: [
      { value: "window:five_hour", slot: 0 },
      { value: "window:week", slot: 1 },
      { value: "window:month", slot: 2 },
    ],
  },
  // GLM five-hour/weekly plan windows; MCP is a tool-specific allowance
  // (`src/providers/glm-coding-plan-provider.ts` 40-79).
  zai: {
    rowKeys: [
      { value: "window:five_hour", slot: 0 },
      { value: "window:week", slot: 1 },
    ],
  },
  zhipu: {
    rowKeys: [
      { value: "window:five_hour", slot: 0 },
      { value: "window:week", slot: 1 },
    ],
  },
  // Rolling/weekly/monthly Go plan windows (`src/providers/opencode-go.ts` 44-55).
  "opencode-go": {
    rowKeys: [
      { value: "window:five_hour", slot: 0 },
      { value: "window:week", slot: 1 },
      { value: "window:month", slot: 2 },
    ],
  },
  // The plan entitlement is Copilot's only primary window, so it occupies the
  // outer slot; the additional-usage row is a budget percent
  // (`src/providers/copilot.ts` 109-142, 185-215).
  copilot: { rowKeys: [{ value: "window:month", slot: 0 }] },
  // Daily/monthly subscription limits are the provider's two-window family in
  // full-card order (`src/providers/nanogpt.ts` 70-105).
  nanogpt: {
    windows: [
      { value: "day", slot: 0 },
      { value: "month", slot: 1 },
    ],
  },
  // MiniMax token-plan 5h/weekly windows (`src/providers/minimax-coding-plan.ts`
  // 105-126, 246-260).
  "minimax-coding-plan": {
    windows: [
      { value: "five_hour", slot: 0 },
      { value: "week", slot: 1 },
    ],
  },
  "minimax-china-coding-plan": {
    windows: [
      { value: "five_hour", slot: 0 },
      { value: "week", slot: 1 },
    ],
  },
  // MiMo's plan window is the card's only primary window, so it occupies the
  // outer slot; its balance rows are quantities, not percentages
  // (`src/providers/mimo.ts` 154-189).
  xiaomi: { windows: [{ value: "month", slot: 0 }] },
  // Kilo Pass credits are a quota percentage with a used/limit/remaining basis,
  // not a balance; the card has one stable primary slot (`src/providers/kilo.ts`
  // 52-82).
  kilo: { components: [{ value: "remaining_credits", slot: 0 }] },
  // xAI always emits exactly one provider-supplied period row, so any valid
  // period identity occupies the same outer slot even when the response-defined
  // period changes (`src/providers/xai.ts` 29-40, 92-153).
  xai: {
    rowKeys: [
      { value: "window:day", slot: 0 },
      { value: "window:week", slot: 0 },
      { value: "window:month", slot: 0 },
      { value: "named:period", slot: 0 },
    ],
  },
  // These providers always emit the same single surviving row, so its window
  // meaning cannot move with availability. Synthetic always emits 5h then
  // weekly; Alibaba Coding Plan always emits 5h/weekly/monthly in that order;
  // Chutes emits one daily-reset quota window (`src/providers/synthetic.ts`
  // 84-103, `src/providers/alibaba-coding-plan.ts` 116-159,
  // `src/providers/chutes.ts` 43-55).
  //
  // Deliberately omitted untyped providers:
  // - Alibaba Token Plan emits optional 5h/weekly
  //   (`src/providers/alibaba-token-plan.ts` 69-74).
  // - Ollama Cloud emits optional session/weekly/included-credit rows
  //   (`src/providers/ollama-cloud.ts` 35-80).
  // Their shared aggregate row keeps one rowId while the represented window
  // changes with availability, so a reference would be unstable.
  // - Custom `quota-providers` result types are user configuration, not
  //   provider-owned primary/auxiliary evidence.
  synthetic: { untypedSlot: 0 },
  chutes: { untypedSlot: 0 },
  "alibaba-coding-plan": { untypedSlot: 0 },
};

function slotFor<T>(
  values: readonly SlotValue<T>[] | undefined,
  value: T,
): PrimaryQuotaWindowSlot | undefined {
  return values?.find((entry) => entry.value === value)?.slot;
}

/**
 * Stable slot for an eligible primary window, or `undefined` when the entry is
 * not classified. Callers must still apply row-id deduplication and the
 * three-reference limit.
 */
export function primaryQuotaWindowSlot(
  providerId: string,
  entry: QuotaToastEntry,
): PrimaryQuotaWindowSlot | undefined {
  const rule = PRIMARY_QUOTA_WINDOW_RULES[providerId];
  if (!rule) return undefined;
  if (!isPercentEntry(entry) || !Number.isFinite(entry.percentRemaining)) return undefined;
  if (entry.accounting.resultType !== "quota" && entry.accounting.resultType !== "rate_limit") {
    return undefined;
  }

  if (entry.semantic) {
    if (entry.semantic.prominence !== "primary") return undefined;
    const metric = entry.semantic.metric;
    if (metric.kind === "window") return slotFor(rule.windows, metric.window);
    if (metric.kind === "named") return slotFor(rule.namedMetrics, metric.name);
    if (metric.kind === "component") return slotFor(rule.components, metric.component);
    return undefined;
  }

  if (entry.rowKey !== undefined) {
    return slotFor(rule.rowKeys, entry.rowKey);
  }
  return rule.untypedSlot;
}
