import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  PrimaryQuotaWindowRef,
  PrimaryQuotaWindowSlot,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type {
  TemporalModelStatus,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
} from "../src/contracts/temporal.js";
import { revealDashboardPanel } from "../src/native/panel-open.js";
import {
  buildSessionHeaderView,
  fitHeaderTokens,
  headerTokenBudget,
  overflowChipWidth,
  peakPreviewText,
  primaryRingRows,
  SLOT_TOKEN_GAP,
  SLOT_TOKEN_SIZE,
} from "../src/native/session-header-model.js";
import {
  createPreviewDisclosure,
  previewShouldClose,
} from "../src/native/session-header-preview.js";
import type { DisplayPreferences } from "../src/ui/quota-semantics.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Stage 6 `session.header` Slot.
 *
 * These tests pin the approved semantics without a real Desktop window: the
 * server's explicitly slotted primary windows become zero to three rings on
 * stable tracks (zero means a logo-only token, not an excluded card), Peak is red now /
 * yellow within an hour and never Off-Peak, stale or unmapped data produces no
 * token, the container-width fit never overflows or oscillates, and the
 * presentational strip/preview render the markup those rules produce. Real host
 * geometry is recorded separately as an unverified integration check.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

const preferences: DisplayPreferences = {
  percentMode: "used",
  showRunway: false,
  detailed: false,
};

interface SsrGraph {
  renderToString: (fn: () => unknown) => string;
  createComponent: (component: unknown, props: unknown) => unknown;
  load: (modulePath: string) => Promise<Record<string, unknown>>;
}

let server: ViteDevServer | undefined;
let graph: SsrGraph;
let stripModule: Record<string, unknown>;
let previewModule: Record<string, unknown>;

beforeAll(async () => {
  const created = await createIsolatedViteServer({
    configFile: false,
    root: repoRoot,
    plugins: [solid({ include: [/src\/native\//, /src\/ui\//], ssr: true })],
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
      alias: [
        {
          find: /^\.\.?\/opencode-ui$/,
          replacement: path.join(repoRoot, "src/native/ui.tsx"),
        },
        {
          find: /^\.\/provider-logo$/,
          replacement: path.join(repoRoot, "src/native/provider-logo.tsx"),
        },
      ],
    },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const web = (await created.ssrLoadModule("solid-js/web")) as {
    renderToString: SsrGraph["renderToString"];
  };
  const core = (await created.ssrLoadModule("solid-js")) as {
    createComponent: SsrGraph["createComponent"];
  };
  graph = {
    renderToString: web.renderToString,
    createComponent: core.createComponent,
    load: (modulePath) => created.ssrLoadModule(modulePath) as Promise<Record<string, unknown>>,
  };
  stripModule = await graph.load(path.join(repoRoot, "src/native/session-header.tsx"));
  previewModule = stripModule;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

function render(component: unknown, props: unknown): string {
  return graph.renderToString(() => graph.createComponent(component, props));
}

/* ---------------------------------------------------------------- fixtures */

function row(cardId: string, key: string, overrides: Partial<QuotaCardRow> = {}): QuotaCardRow {
  return {
    rowId: `${cardId}#${key}` as RowId,
    label: key,
    kind: "percent",
    resultType: "quota",
    percentRemaining: 62,
    percentUsed: 38,
    ...overrides,
  };
}

function windowRef(row: QuotaCardRow, slot: PrimaryQuotaWindowSlot): PrimaryQuotaWindowRef {
  return { rowId: row.rowId, slot };
}

function card(params: {
  cardId: string;
  providerId?: string;
  providerLabel?: string;
  rows: QuotaCardRow[];
  windows?: readonly PrimaryQuotaWindowRef[];
  planLabel?: string;
  accountLabel?: string;
  errors?: ProviderCard["errors"];
}): ProviderCard {
  const providerId = params.providerId ?? "synthetic";
  return {
    cardId: params.cardId as CardId,
    providerId,
    providerLabel: params.providerLabel ?? providerId,
    ...(params.planLabel === undefined ? {} : { planLabel: params.planLabel }),
    ...(params.accountLabel === undefined ? {} : { accountLabel: params.accountLabel }),
    rows: params.rows,
    ...(params.windows === undefined ? {} : { primaryQuotaWindows: [...params.windows] }),
    errors: params.errors ?? [],
  };
}

function snapshot(
  cards: ProviderCard[],
  options: { stale?: boolean; temporal?: TemporalStatusSnapshot } = {},
): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: options.stale ?? false,
    timeZone: "UTC",
    providers: { cards, enabledProviders: "auto", polledAtMs: NOW },
    ...(options.temporal === undefined ? {} : { temporal: options.temporal }),
  };
}

function model(overrides: Partial<TemporalModelStatus> = {}): TemporalModelStatus {
  return {
    modelId: "synthetic/model",
    state: "offpeak",
    intervals: [],
    ...overrides,
  };
}

function temporalProvider(
  providerId: string,
  models: TemporalModelStatus[],
  overrides: Partial<TemporalProviderStatus> = {},
): TemporalProviderStatus {
  return {
    providerId,
    providerLabel: providerId,
    discovered: true,
    phase: "offpeak",
    models,
    holidays: [],
    ...overrides,
  };
}

function temporal(providers: TemporalProviderStatus[]): TemporalStatusSnapshot {
  return {
    generatedAtMs: NOW,
    providers,
    snapshot: { revision: "test", generatedAtMs: NOW },
  };
}

function viewFor(
  cards: ProviderCard[],
  options: {
    stale?: boolean;
    hiddenCards?: string[];
    hiddenRows?: string[];
    prefs?: DisplayPreferences;
    temporal?: TemporalStatusSnapshot;
    nowMs?: number;
  } = {},
) {
  return buildSessionHeaderView({
    snapshot: snapshot(cards, {
      ...(options.stale === undefined ? {} : { stale: options.stale }),
      ...(options.temporal === undefined ? {} : { temporal: options.temporal }),
    }),
    hiddenCards: options.hiddenCards ?? [],
    hiddenRows: options.hiddenRows ?? [],
    preferences: options.prefs ?? preferences,
    nowMs: options.nowMs ?? NOW,
  });
}

/* ------------------------------------------------------- ring semantics */

describe("session.header rings", () => {
  it("uses the server's explicit slots, capped at three", () => {
    const fiveHour = row("card-openai", "five", {
      label: "5h",
      resultType: "rate_limit",
    });
    const weekly = row("card-openai", "weekly", {
      label: "Weekly",
      resultType: "rate_limit",
    });
    const monthly = row("card-openai", "monthly", {
      label: "Monthly",
      resultType: "rate_limit",
    });
    const codeReview = row("card-openai", "review", {
      label: "Code Review",
      percentUsed: 5,
      percentRemaining: 95,
      resultType: "rate_limit",
    });
    const cardValue = card({
      cardId: "card-openai",
      providerId: "openai",
      providerLabel: "OpenAI",
      rows: [fiveHour, weekly, monthly, codeReview],
      windows: [windowRef(fiveHour, 0), windowRef(weekly, 1), windowRef(monthly, 2)],
    });

    const view = viewFor([cardValue]);
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.rings.map((ring) => ring.label)).toEqual(["5h", "Weekly", "Monthly"]);
    expect(view.cards[0]?.rings.map((ring) => ring.slot)).toEqual([0, 1, 2]);
    // The preview keeps the secondary allowance the rings intentionally omit.
    expect(view.cards[0]?.previewRows.map((preview) => preview.label)).toEqual([
      "5h",
      "Weekly",
      "Monthly",
      "Code Review",
    ]);
  });

  it("keeps untyped and auxiliary percent rows in the preview without inferring rings", () => {
    const untyped = row("card-untyped", "quota", { label: "Quota" });
    const budget = row("card-untyped", "budget", {
      label: "Budget",
      resultType: "budget",
      percentUsed: 60,
      percentRemaining: 40,
    });
    const cardValue = card({ cardId: "card-untyped", rows: [untyped, budget] });
    const view = viewFor([cardValue]);
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.rings).toEqual([]);
    expect(view.cards[0]?.previewRows.map((entry) => entry.label)).toEqual(["Quota", "Budget"]);
  });

  it("keeps auxiliary percentage rows in the preview but out of the rings", () => {
    const fiveHour = row("card-anthropic", "five", { label: "5h" });
    const weekly = row("card-anthropic", "weekly", { label: "Weekly" });
    const extraUsage = row("card-anthropic", "month", {
      label: "Monthly Usage Credits",
      percentUsed: 10,
      percentRemaining: 90,
    });
    const fable = row("card-anthropic", "fable", { label: "Fable" });
    const cardValue = card({
      cardId: "card-anthropic",
      providerId: "anthropic",
      providerLabel: "Claude",
      rows: [fiveHour, weekly, extraUsage, fable],
      windows: [windowRef(fiveHour, 0), windowRef(weekly, 1), windowRef(fable, 2)],
    });

    const view = viewFor([cardValue]);
    expect(view.cards[0]?.rings.map((ring) => ring.label)).toEqual(["5h", "Weekly", "Fable"]);
    expect(view.cards[0]?.rings.map((ring) => ring.slot)).toEqual([0, 1, 2]);
    expect(view.cards[0]?.previewRows.map((preview) => preview.label)).toContain(
      "Monthly Usage Credits",
    );
    expect(view.cards[0]?.rings).toHaveLength(3);
  });

  it("drops a hidden referenced row instead of substituting another row", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const weekly = row("card-1", "weekly", { label: "Weekly" });
    const monthly = row("card-1", "monthly", { label: "Monthly" });
    const cardValue = card({
      cardId: "card-1",
      rows: [fiveHour, weekly, monthly],
      windows: [windowRef(fiveHour, 0), windowRef(weekly, 1)],
    });

    const view = viewFor([cardValue], { hiddenRows: [weekly.rowId] });
    expect(view.cards[0]?.rings.map((ring) => ring.label)).toEqual(["5h"]);
    expect(view.cards[0]?.rings.map((ring) => ring.slot)).toEqual([0]);
    expect(view.cards[0]?.rings.map((ring) => ring.label)).not.toContain("Monthly");
    expect(view.cards[0]?.previewRows.map((preview) => preview.label)).toEqual(["5h", "Monthly"]);
  });

  it("keeps the weekly ring on slot 1 when 5h is hidden and when it returns", () => {
    const five = row("card-stable", "five", { label: "5h" });
    const weekly = row("card-stable", "weekly", { label: "Weekly" });
    const cardValue = card({
      cardId: "card-stable",
      rows: [five, weekly],
      windows: [windowRef(five, 0), windowRef(weekly, 1)],
    });
    const ringsFor = (hiddenRows: string[] = []) =>
      viewFor([cardValue], { hiddenRows }).cards[0]?.rings.map((ring) => [ring.label, ring.slot]);

    expect(ringsFor()).toEqual([
      ["5h", 0],
      ["Weekly", 1],
    ]);
    expect(ringsFor([five.rowId])).toEqual([["Weekly", 1]]);
    expect(ringsFor()).toEqual([
      ["5h", 0],
      ["Weekly", 1],
    ]);
  });

  it("leaves a missing middle slot empty without compacting the inner ring", () => {
    const five = row("card-gap", "five", { label: "5h" });
    const monthly = row("card-gap", "monthly", { label: "Monthly" });
    const cardValue = card({
      cardId: "card-gap",
      rows: [five, monthly],
      windows: [windowRef(five, 0), windowRef(monthly, 2)],
    });
    expect(viewFor([cardValue]).cards[0]?.rings.map((ring) => [ring.label, ring.slot])).toEqual([
      ["5h", 0],
      ["Monthly", 2],
    ]);
  });

  it("uses each reference's stable slot, not the array order", () => {
    const first = row("card-order", "first", { label: "First" });
    const second = row("card-order", "second", { label: "Second" });
    const cardValue = card({
      cardId: "card-order",
      rows: [first, second],
      // Deliberately unsorted: the slot, not the array index, decides the ring.
      windows: [windowRef(first, 1), windowRef(second, 0)],
    });
    const view = viewFor([cardValue]);
    expect(view.cards[0]?.rings.map((ring) => ring.label)).toEqual(["Second", "First"]);
    expect(view.cards[0]?.rings.map((ring) => ring.slot)).toEqual([0, 1]);
  });

  it("ignores malformed references and repeated references", () => {
    const quota = row("card-malformed", "quota", { label: "Quota" });
    const budget = row("card-malformed", "budget", {
      label: "Budget",
      resultType: "budget",
      percentUsed: 60,
      percentRemaining: 40,
    });
    const cardValue = card({
      cardId: "card-malformed",
      rows: [quota, budget],
      windows: [windowRef(budget, 0), windowRef(quota, 1), windowRef(quota, 2)],
    });
    const view = viewFor([cardValue]);
    expect(view.cards[0]?.rings.map((ring) => ring.label)).toEqual(["Quota"]);
    expect(view.cards[0]?.rings.map((ring) => ring.slot)).toEqual([1]);
  });

  it("ignores an out-of-range slot instead of guessing one", () => {
    const quota = row("card-bad-slot", "quota", { label: "Quota" });
    const cardValue = card({
      cardId: "card-bad-slot",
      rows: [quota],
      windows: [{ rowId: quota.rowId, slot: 3 as never }],
    });
    const view = viewFor([cardValue]);
    expect(view.cards[0]?.rings).toEqual([]);
    expect(view.cards[0]?.previewRows.map((entry) => entry.label)).toEqual(["Quota"]);
  });

  it("renders a zero-ring token when the server names no primary window", () => {
    const percent = row("card-unmapped", "quota", { label: "Quota" });
    const cardValue = card({ cardId: "card-unmapped", rows: [percent] });
    const view = viewFor([cardValue]);
    expect(primaryRingRows(cardValue, [], preferences)).toEqual([]);
    // Eligibility is visible + meaningful percentage data; primary metadata
    // only controls the ring count, so the token remains as a logo-only mark.
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.rings).toEqual([]);
    expect(view.cards[0]?.previewRows.map((entry) => entry.label)).toEqual(["Quota"]);
    expect(view.cards[0]?.ariaLabel).toContain("Quota details in preview");
  });

  it("counts a zero-ring token in the header budget and +N", () => {
    const quota = row("card-zero", "quota", { label: "Quota" });
    const five = row("card-ring", "five", { label: "5h" });
    const view = viewFor([
      card({ cardId: "card-zero", rows: [quota] }),
      card({
        cardId: "card-ring",
        rows: [five],
        windows: [windowRef(five, 0)],
      }),
    ]);
    expect(view.cards).toHaveLength(2);
    expect(view.cards[0]?.rings).toEqual([]);
    const fit = fitHeaderTokens({
      // One pixel short of both tokens: only the +N chip fits, and its count
      // must include the zero-ring card.
      availableWidth: SLOT_TOKEN_SIZE * 2 + SLOT_TOKEN_GAP - 1,
      tokenCount: view.cards.length,
    });
    expect(fit).toEqual({ visibleCount: 0, hiddenCount: 2, overflowVisible: true });
  });

  it("keeps a zero-ring token when every referenced primary row is hidden", () => {
    const primary = row("card-1", "five", { label: "5h" });
    const auxiliary = row("card-1", "credits", {
      label: "Monthly Usage Credits",
      resultType: "usage",
      percentUsed: 10,
      percentRemaining: 90,
    });
    const cardValue = card({
      cardId: "card-1",
      rows: [primary, auxiliary],
      windows: [windowRef(primary, 0)],
    });
    const view = viewFor([cardValue], { hiddenRows: [primary.rowId] });
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.rings).toEqual([]);
    expect(view.cards[0]?.previewRows.map((entry) => entry.label)).toEqual([
      "Monthly Usage Credits",
    ]);
  });

  it("omits a card with no meaningful percentage row from tokens and preview", () => {
    const balance: QuotaCardRow = {
      rowId: "card-balance#balance" as RowId,
      label: "Balance",
      kind: "value",
      resultType: "balance",
      value: "12.00 USD",
    };
    const cardValue = card({ cardId: "card-balance", rows: [balance] });
    expect(viewFor([cardValue]).cards).toEqual([]);
  });

  it("never dresses a stale payload as fresh rings or preview rows", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const cardValue = card({
      cardId: "card-1",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    expect(viewFor([cardValue], { stale: true }).cards).toEqual([]);
  });

  it("respects card visibility and saved order without merging same-provider cards", () => {
    const a = row("card-a", "quota", { label: "Account A" });
    const b = row("card-b", "quota", { label: "Account B" });
    const c = row("card-c", "quota", { label: "Account C" });
    const cards = [
      card({
        cardId: "card-a",
        providerId: "openai",
        accountLabel: "A",
        rows: [a],
        windows: [windowRef(a, 0)],
      }),
      card({
        cardId: "card-b",
        providerId: "openai",
        accountLabel: "B",
        rows: [b],
        windows: [windowRef(b, 0)],
      }),
      card({
        cardId: "card-c",
        providerId: "anthropic",
        accountLabel: "C",
        rows: [c],
        windows: [windowRef(c, 0)],
      }),
    ];
    const view = viewFor(cards, {
      hiddenCards: ["card-b"],
      prefs: {
        ...preferences,
        cardOrder: ["card-c", "card-a"],
      },
    });
    expect(view.cards.map((entry) => entry.cardId)).toEqual(["card-c", "card-a"]);
    expect(
      view.cards.every(
        (entry) => entry.providerId === "openai" || entry.providerId === "anthropic",
      ),
    ).toBe(true);
  });

  it("follows used/remaining display while severity stays on true used quota", () => {
    const fiveHour = row("card-1", "five", {
      percentUsed: 80,
      percentRemaining: 20,
    });
    const cardValue = card({
      cardId: "card-1",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });

    const remaining = viewFor([cardValue], {
      prefs: { ...preferences, percentMode: "remaining" },
    }).cards[0]?.rings[0];
    expect(remaining?.percent).toBe(20);
    expect(remaining?.severity).toBe("warning");

    const used = viewFor([cardValue], { prefs: preferences }).cards[0]?.rings[0];
    expect(used?.percent).toBe(80);
    expect(used?.severity).toBe("warning");

    const critical = viewFor([cardValue], {
      prefs: preferences,
      nowMs: NOW,
    });
    expect(critical.cards[0]?.rings[0]?.severity).toBe("warning");

    const over = row("card-2", "quota", { percentUsed: 120, percentRemaining: -20 });
    const overCard = card({
      cardId: "card-2",
      rows: [over],
      windows: [windowRef(over, 0)],
    });
    const overRing = viewFor([overCard]).cards[0]?.rings[0];
    expect(overRing?.percent).toBe(100);
    expect(overRing?.severity).toBe("critical");
  });
});

/* ------------------------------------------------------------ Peak dot */

describe("session.header Peak dot", () => {
  it("is red when any relevant model is Peak now, even if another is soon", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const cardValue = card({
      cardId: "card-1",
      providerId: "synthetic",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    const view = viewFor([cardValue], {
      temporal: temporal([
        temporalProvider("synthetic", [
          model({ state: "peak" }),
          model({ state: "offpeak", nextChangeAtMs: NOW + 20 * 60_000, nextState: "peak" }),
        ]),
      ]),
    });
    expect(view.cards[0]?.peak).toBe("now");
    expect(view.cards[0]?.peakAtMs).toBeUndefined();
  });

  it("is yellow only for a supported Peak transition inside 60 minutes", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const cardValue = card({
      cardId: "card-1",
      providerId: "synthetic",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    const at = (delta: number) =>
      viewFor([cardValue], {
        temporal: temporal([
          temporalProvider("synthetic", [
            model({ state: "offpeak", nextChangeAtMs: NOW + delta, nextState: "peak" }),
          ]),
        ]),
      }).cards[0]?.peak;

    expect(at(59 * 60_000)).toBe("soon");
    expect(at(60 * 60_000)).toBe("soon");
    expect(at(61 * 60_000)).toBeUndefined();
  });

  it("does not invent a Peak destination or show an Off-Peak dot", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const cardValue = card({
      cardId: "card-1",
      providerId: "synthetic",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    const views = [
      temporal([
        temporalProvider("synthetic", [
          model({ state: "offpeak", nextChangeAtMs: NOW + 20 * 60_000 }),
        ]),
      ]),
      temporal([
        temporalProvider("synthetic", [
          model({ state: "offpeak", nextChangeAtMs: NOW + 20 * 60_000, nextState: "offpeak" }),
        ]),
      ]),
      temporal([temporalProvider("synthetic", [model({ state: "offpeak" })])]),
    ];
    for (const status of views) {
      expect(viewFor([cardValue], { temporal: status }).cards[0]?.peak).toBeUndefined();
    }
  });

  it("respects the existing temporal provider visibility override", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const cardValue = card({
      cardId: "card-1",
      providerId: "synthetic",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    const view = viewFor([cardValue], {
      prefs: { ...preferences, temporalProviderOverrides: { synthetic: false } },
      temporal: temporal([temporalProvider("synthetic", [model({ state: "peak" })])]),
    });
    expect(view.cards[0]?.peak).toBeUndefined();
  });

  it("renders Peak copy only for now or within the hour", () => {
    expect(peakPreviewText("now", undefined, NOW)).toBe("Peak now");
    expect(peakPreviewText("soon", NOW + 42 * 60_000, NOW)).toBe("Peak in 42m");
    // A snapshot can predate the transition by up to one poll interval.
    expect(peakPreviewText("soon", NOW - 1, NOW)).toBe("Peak now");
    expect(peakPreviewText(undefined, undefined, NOW)).toBeUndefined();
  });
});

/* -------------------------------------------------------------- geometry */

describe("session.header responsive fit", () => {
  it("shows every complete token when they all fit", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const total = count * SLOT_TOKEN_SIZE + (count - 1) * SLOT_TOKEN_GAP;
      expect(fitHeaderTokens({ availableWidth: total, tokenCount: count })).toEqual({
        visibleCount: count,
        hiddenCount: 0,
        overflowVisible: false,
      });
    }
  });

  it("reserves the chip inside the same width, never partially drawing a token", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const total = count * SLOT_TOKEN_SIZE + (count - 1) * SLOT_TOKEN_GAP;
      const fit = fitHeaderTokens({ availableWidth: total - 1, tokenCount: count });
      const used =
        fit.visibleCount * SLOT_TOKEN_SIZE +
        Math.max(0, fit.visibleCount - 1) * SLOT_TOKEN_GAP +
        (fit.overflowVisible && fit.visibleCount > 0 ? SLOT_TOKEN_GAP : 0) +
        (fit.overflowVisible ? overflowChipWidth(fit.hiddenCount) : 0);
      expect(fit.visibleCount).toBeLessThan(count);
      if (fit.overflowVisible) {
        expect(fit.visibleCount + fit.hiddenCount).toBe(count);
        expect(used).toBeLessThanOrEqual(total - 1);
      } else {
        expect(fit.visibleCount).toBe(0);
      }
    }
  });

  it("shows only the focusable +N when no complete token fits", () => {
    const fit = fitHeaderTokens({ availableWidth: 34, tokenCount: 4 });
    expect(fit.visibleCount).toBe(0);
    expect(fit.hiddenCount).toBe(4);
    expect(fit.overflowVisible).toBe(true);
    expect(overflowChipWidth(4)).toBe(30);
  });

  it("renders nothing when even the +N chip cannot fit", () => {
    const fit = fitHeaderTokens({ availableWidth: 10, tokenCount: 4 });
    expect(fit).toEqual({ visibleCount: 0, hiddenCount: 4, overflowVisible: false });
  });

  it("never claims more than the measured header budget at realistic widths", () => {
    const fixtures = [
      { layoutWidth: 1440, locationWidth: 260, otherActionsWidth: 64, otherActionCount: 2 },
      { layoutWidth: 1280, locationWidth: 240, otherActionsWidth: 48, otherActionCount: 2 },
      { layoutWidth: 1024, locationWidth: 210, otherActionsWidth: 40, otherActionCount: 1 },
      { layoutWidth: 900, locationWidth: 200, otherActionsWidth: 40, otherActionCount: 1 },
      { layoutWidth: 800, locationWidth: 180, otherActionsWidth: 32, otherActionCount: 1 },
      { layoutWidth: 640, locationWidth: 160, otherActionsWidth: 32, otherActionCount: 1 },
      { layoutWidth: 520, locationWidth: 150, otherActionsWidth: 24, otherActionCount: 1 },
      { layoutWidth: 420, locationWidth: 130, otherActionsWidth: 24, otherActionCount: 1 },
      { layoutWidth: 360, locationWidth: 120, otherActionsWidth: 24, otherActionCount: 1 },
      { layoutWidth: 320, locationWidth: 110, otherActionsWidth: 24, otherActionCount: 1 },
      { layoutWidth: 280, locationWidth: 100, otherActionsWidth: 24, otherActionCount: 1 },
      // A loading header has neither a location nor other plugins' actions.
      { layoutWidth: 640, locationWidth: 0, otherActionsWidth: 0, otherActionCount: 0 },
      // Other header content already consumes most of the row.
      { layoutWidth: 900, locationWidth: 300, otherActionsWidth: 180, otherActionCount: 3 },
      // Location plus other actions exceed the row: the strip claims nothing.
      { layoutWidth: 320, locationWidth: 200, otherActionsWidth: 180, otherActionCount: 2 },
    ];
    for (const fixture of fixtures) {
      const budget = headerTokenBudget(fixture);
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThan(fixture.layoutWidth);
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const fit = fitHeaderTokens({ availableWidth: budget, tokenCount: count });
        const used =
          fit.visibleCount * SLOT_TOKEN_SIZE +
          Math.max(0, fit.visibleCount - 1) * SLOT_TOKEN_GAP +
          (fit.overflowVisible && fit.visibleCount > 0 ? SLOT_TOKEN_GAP : 0) +
          (fit.overflowVisible ? overflowChipWidth(fit.hiddenCount) : 0);
        expect(used).toBeLessThanOrEqual(budget);
        expect(fit.visibleCount + fit.hiddenCount).toBe(count);
      }
    }
  });

  it("keeps a title reserve and shrinks as location or other actions grow", () => {
    expect(
      headerTokenBudget({
        layoutWidth: 0,
        locationWidth: 0,
        otherActionsWidth: 0,
        otherActionCount: 0,
      }),
    ).toBe(0);
    const base = headerTokenBudget({
      layoutWidth: 800,
      locationWidth: 160,
      otherActionsWidth: 32,
      otherActionCount: 1,
    });
    const longerLocation = headerTokenBudget({
      layoutWidth: 800,
      locationWidth: 260,
      otherActionsWidth: 32,
      otherActionCount: 1,
    });
    const moreActions = headerTokenBudget({
      layoutWidth: 800,
      locationWidth: 160,
      otherActionsWidth: 72,
      otherActionCount: 3,
    });
    expect(base).toBeGreaterThan(longerLocation);
    expect(base).toBeGreaterThan(moreActions);
  });
});

/* ------------------------------------------------------- hover/focus state */

describe("session.header preview disclosure", () => {
  function scheduler() {
    let now = 0;
    const tasks: { at: number; callback: () => void; cancelled: boolean }[] = [];
    return {
      options: {
        delayMs: 100,
        setTimer: (callback: () => void, delayMs: number) => {
          const task = { at: now + delayMs, callback, cancelled: false };
          tasks.push(task);
          return task;
        },
        clearTimer: (handle: unknown) => {
          (handle as { cancelled: boolean }).cancelled = true;
        },
      },
      advance(ms: number) {
        now += ms;
        for (const task of [...tasks]) {
          if (!task.cancelled && task.at <= now) {
            task.cancelled = true;
            task.callback();
          }
        }
      },
    };
  }

  it("opens on hover and waits before closing", () => {
    const clock = scheduler();
    const disclosure = createPreviewDisclosure(clock.options);
    expect(disclosure.open()).toBe(false);
    disclosure.onPointerEnter();
    expect(disclosure.open()).toBe(true);
    disclosure.onPointerLeave();
    clock.advance(99);
    expect(disclosure.open()).toBe(true);
    clock.advance(1);
    expect(disclosure.open()).toBe(false);
  });

  it("keeps the preview open while the pointer crosses into it", () => {
    const clock = scheduler();
    const disclosure = createPreviewDisclosure(clock.options);
    disclosure.onPointerEnter();
    disclosure.onPointerLeave();
    disclosure.onPreviewPointerEnter();
    clock.advance(500);
    expect(disclosure.open()).toBe(true);
    disclosure.onPreviewPointerLeave();
    clock.advance(100);
    expect(disclosure.open()).toBe(false);
  });

  it("keeps focus and hover independent, and Escape closes at once", () => {
    const clock = scheduler();
    const disclosure = createPreviewDisclosure(clock.options);
    disclosure.onFocusIn();
    disclosure.onPointerEnter();
    disclosure.onPointerLeave();
    clock.advance(500);
    expect(disclosure.open()).toBe(true);
    disclosure.onFocusOut();
    disclosure.onEscape();
    clock.advance(100);
    expect(disclosure.open()).toBe(false);
  });

  it("cancels a pending close when focus moves between tokens", () => {
    const clock = scheduler();
    const disclosure = createPreviewDisclosure(clock.options);
    disclosure.onFocusIn();
    disclosure.onFocusOut();
    clock.advance(50);
    disclosure.onFocusIn();
    clock.advance(100);
    expect(disclosure.open()).toBe(true);
  });

  it("closes when the timeline becomes inactive or its anchor disappears", () => {
    expect(previewShouldClose({ active: true, hasVisibleToken: true, cardCount: 2 })).toBe(false);
    expect(previewShouldClose({ active: false, hasVisibleToken: true, cardCount: 2 })).toBe(true);
    expect(previewShouldClose({ active: true, hasVisibleToken: false, cardCount: 2 })).toBe(true);
    expect(previewShouldClose({ active: true, hasVisibleToken: true, cardCount: 0 })).toBe(true);
  });
});

/* ------------------------------------------------------------ Panel open */

describe("session.header Panel opening", () => {
  const session = { server: "srv", id: "ses-1" } as Parameters<typeof revealDashboardPanel>[2];

  function layout(state: "closed" | "open" | "active" | "visible") {
    const calls: { key: string; session: unknown }[] = [];
    return {
      calls,
      state: () => state,
      open: (key: string, target: unknown) => calls.push({ key, session: target }),
    };
  }

  it("opens a closed tab and selects a stored or hidden one", () => {
    for (const state of ["closed", "open", "active"] as const) {
      const target = layout(state);
      expect(revealDashboardPanel(target, "plugin:dashboard", session)).toBe("opened");
      expect(target.calls).toEqual([{ key: "plugin:dashboard", session }]);
    }
  });

  it("never resets a visible Panel's internal route", () => {
    const target = layout("visible");
    expect(revealDashboardPanel(target, "plugin:dashboard", session)).toBe("already-visible");
    expect(target.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------- markup */

describe("session.header rendered tokens", () => {
  it("renders rings, the logo and the top-right Peak dot", () => {
    const fiveHour = row("card-1", "five", { label: "5h" });
    const weekly = row("card-1", "weekly", { label: "Weekly" });
    const cardValue = card({
      cardId: "card-1",
      providerId: "synthetic",
      providerLabel: "Synthetic",
      rows: [fiveHour, weekly],
      windows: [windowRef(fiveHour, 0), windowRef(weekly, 1)],
    });
    const view = viewFor([cardValue], {
      temporal: temporal([temporalProvider("synthetic", [model({ state: "peak" })])]),
    });
    const html = render(stripModule.SessionHeaderStrip, {
      cards: view.cards,
      visibleCount: 1,
      hiddenCount: 0,
      overflowVisible: false,
      previewOpen: false,
      previewId: "preview-1",
      onOpenPanel: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusIn: () => {},
      onFocusOut: () => {},
      onEscape: () => {},
    });
    expect(html).toContain('class="qg-native qg-slot-strip"');
    expect(html).toContain("qg-slot-token");
    expect(html.match(/class="qg-slot-token__ring"/gu)).toHaveLength(2);
    expect(html.match(/class="qg-slot-token__track"/gu)).toHaveLength(2);
    expect(html).toContain('data-ring-slot="0"');
    expect(html).toContain('data-ring-slot="1"');
    expect(html).toContain('data-severity="healthy"');
    expect(html).toContain('stroke-dasharray="38 62"');
    expect(html).toContain("qg-slot-token__logo");
    expect(html).toMatch(/data-provider-logo="[a-z0-9-]+"/u);
    expect(html).toContain('class="qg-slot-token__peak"');
    expect(html).toContain('data-peak="now"');
    expect(html).toContain("Peak now");
    expect(html).toContain("5h 38% used");
    expect(html).not.toContain("Off-Peak");
    expect(html).not.toContain("+1");
  });

  it("renders the focusable +N overflow chip and the preview link", () => {
    const rows = [1, 2, 3, 4, 5].map((index) =>
      row(`card-${index}`, "quota", { label: `Quota ${index}` }),
    );
    const cards = rows.map((entry, index) =>
      card({
        cardId: `card-${index + 1}`,
        providerId: "synthetic",
        providerLabel: `Provider ${index + 1}`,
        rows: [entry],
        windows: [windowRef(entry, 0)],
      }),
    );
    const view = viewFor(cards);
    const html = render(stripModule.SessionHeaderStrip, {
      cards: view.cards,
      visibleCount: 2,
      hiddenCount: 3,
      overflowVisible: true,
      previewOpen: true,
      previewId: "preview-2",
      onOpenPanel: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusIn: () => {},
      onFocusOut: () => {},
      onEscape: () => {},
    });
    expect(html).toContain("+3");
    expect(html).toContain('aria-label="Show 3 more quota cards in the dashboard"');
    expect(html).toContain('aria-describedby="preview-2"');
    const buttons = html.match(/qg-slot-token"/gu) ?? [];
    expect(buttons.length).toBe(2);
  });

  it("hides an empty strip while keeping its measurement anchor mounted", () => {
    const html = render(stripModule.SessionHeaderStrip, {
      cards: [],
      visibleCount: 0,
      hiddenCount: 0,
      overflowVisible: false,
      previewOpen: false,
      previewId: "preview-empty",
      hidden: true,
      onOpenPanel: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusIn: () => {},
      onFocusOut: () => {},
      onEscape: () => {},
    });
    expect(html).toContain("qg-slot-strip");
    expect(html).toContain("display:none");
    expect(html).not.toContain("qg-slot-token");
  });

  it("keeps the weekly ring in its middle slot when 5h is absent", () => {
    const five = row("card-id", "five", { label: "5h" });
    const weekly = row("card-id", "weekly", { label: "Weekly" });
    const fullCard = card({
      cardId: "card-id",
      rows: [five, weekly],
      windows: [windowRef(five, 0), windowRef(weekly, 1)],
    });
    const compactCard = card({
      cardId: "card-id",
      rows: [weekly],
      windows: [windowRef(weekly, 1)],
    });
    const renderStrip = (cardValue: ProviderCard): string =>
      render(stripModule.SessionHeaderStrip, {
        cards: viewFor([cardValue]).cards,
        visibleCount: 1,
        hiddenCount: 0,
        overflowVisible: false,
        previewOpen: false,
        previewId: "preview-identity",
        onOpenPanel: () => {},
        onPointerEnter: () => {},
        onPointerLeave: () => {},
        onFocusIn: () => {},
        onFocusOut: () => {},
        onEscape: () => {},
      });

    const full = renderStrip(fullCard);
    const compact = renderStrip(compactCard);
    // The weekly window keeps both its identity and its middle slot: the empty
    // outer slot is not filled by compacting the remaining ring outward.
    expect(full).toContain('data-row-id="card-id#weekly"');
    expect(full).toContain('data-ring-slot="1"');
    expect(full).toContain('r="9.5"');
    expect(compact).toContain('data-row-id="card-id#weekly"');
    expect(compact).toContain('data-ring-slot="1"');
    expect(compact).toContain('r="9.5"');
    expect(compact).not.toContain('data-ring-slot="0"');
    expect(compact).not.toContain('data-row-id="card-id#five"');
  });

  it("renders a zero-ring token as a logo-only prefix", () => {
    const percent = row("card-unmapped", "quota", { label: "Quota" });
    const cardValue = card({
      cardId: "card-unmapped",
      providerId: "cursor",
      providerLabel: "Cursor",
      rows: [percent],
    });
    const view = viewFor([cardValue]);
    const html = render(stripModule.SessionHeaderStrip, {
      cards: view.cards,
      visibleCount: 1,
      hiddenCount: 0,
      overflowVisible: false,
      previewOpen: false,
      previewId: "preview-zero",
      onOpenPanel: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusIn: () => {},
      onFocusOut: () => {},
      onEscape: () => {},
    });
    expect(html).toContain('data-ring-count="0"');
    expect(html).not.toContain('class="qg-slot-token__ring"');
    expect(html).not.toContain('class="qg-slot-token__track"');
    expect(html).toContain("qg-slot-token__logo");
    expect(html).toContain("Quota details in preview");
  });

  it("never renders a fourth ring", () => {
    const first = row("card-1", "one", { label: "One" });
    const second = row("card-1", "two", { label: "Two" });
    const third = row("card-1", "three", { label: "Three" });
    const fourth = row("card-1", "four", { label: "Four" });
    const cardValue = card({
      cardId: "card-1",
      rows: [first, second, third, fourth],
      windows: [
        windowRef(first, 0),
        windowRef(second, 1),
        windowRef(third, 2),
        windowRef(fourth, 0),
      ],
    });
    const view = viewFor([cardValue]);
    const html = render(stripModule.SessionHeaderStrip, {
      cards: view.cards,
      visibleCount: 1,
      hiddenCount: 0,
      overflowVisible: false,
      previewOpen: false,
      previewId: "preview-3",
      onOpenPanel: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusIn: () => {},
      onFocusOut: () => {},
      onEscape: () => {},
    });
    expect(html.match(/class="qg-slot-token__ring"/gu)).toHaveLength(3);
    expect(html.match(/class="qg-slot-token__track"/gu)).toHaveLength(3);
  });
});

describe("session.header combined preview", () => {
  it("includes every eligible card, including overflow and auxiliary rows", () => {
    const fiveHour = row("card-1", "five", { label: "5h", countdown: "2h 59m" });
    const codeReview = row("card-1", "review", {
      label: "Code Review",
      resultType: "rate_limit",
      percentUsed: 88,
      percentRemaining: 12,
    });
    const monthly = row("card-2", "month", { label: "Monthly", countdown: "3d" });
    const primary = card({
      cardId: "card-1",
      providerId: "openai",
      providerLabel: "OpenAI",
      planLabel: "Plus",
      rows: [fiveHour, codeReview],
      windows: [windowRef(fiveHour, 0)],
    });
    const second = card({
      cardId: "card-2",
      providerId: "anthropic",
      providerLabel: "Claude",
      accountLabel: "[Claude] (work)",
      rows: [monthly],
      windows: [windowRef(monthly, 0)],
    });
    const view = viewFor([primary, second], {
      temporal: temporal([
        temporalProvider("openai", [
          model({ state: "offpeak", nextChangeAtMs: NOW + 42 * 60_000, nextState: "peak" }),
        ]),
      ]),
    });
    const html = render(previewModule.SessionHeaderPreviewBody, {
      cards: view.cards,
      preferences,
      nowMs: NOW,
      id: "preview-combined",
    });
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('id="preview-combined"');
    expect(html).toContain("OpenAI");
    expect(html).toContain("Plus");
    expect(html).toContain("Claude");
    expect(html).toContain("Code Review");
    expect(html).toContain('data-row-id="card-1#review"');
    expect(html).toContain("Monthly");
    expect(html).toContain("Resets in");
    expect(html).toContain("2h 59m");
    expect(html).toContain("Peak in 42m");
    expect(html).toContain("--qg-used-position:38%");
    expect(html).toContain("--qg-used-position:88%");
    expect(html).not.toMatch(/off.?peak/iu);
    expect(html).not.toContain("4 rings");
  });

  it("advances the preview Peak countdown with the latest view time", () => {
    const fiveHour = row("card-peak", "five", { label: "5h", resultType: "rate_limit" });
    const cardValue = card({
      cardId: "card-peak",
      providerId: "openai",
      providerLabel: "OpenAI",
      rows: [fiveHour],
      windows: [windowRef(fiveHour, 0)],
    });
    const temporalStatus = temporal([
      temporalProvider("openai", [
        model({ state: "offpeak", nextChangeAtMs: NOW + 42 * 60_000, nextState: "peak" }),
      ]),
    ]);
    const early = viewFor([cardValue], { temporal: temporalStatus, nowMs: NOW });
    const later = viewFor([cardValue], {
      temporal: temporalStatus,
      nowMs: NOW + 10 * 60_000,
    });
    const renderAt = (view: ReturnType<typeof viewFor>) =>
      render(previewModule.SessionHeaderPreviewBody, {
        cards: view.cards,
        preferences,
        nowMs: view.nowMs,
        id: "preview-clock",
      });

    expect(early.nowMs).toBe(NOW);
    expect(later.nowMs).toBe(NOW + 10 * 60_000);
    expect(renderAt(early)).toContain("Peak in 42m");
    expect(renderAt(later)).toContain("Peak in 32m");
  });
});

/* --------------------------------------------------------------- wiring */

describe("Native Slot wiring", () => {
  const guiSource = readFileSync(path.join(repoRoot, "src/native/gui.tsx"), "utf8");
  const headerSource = readFileSync(path.join(repoRoot, "src/native/session-header.tsx"), "utf8");
  const stripSource = readFileSync(
    path.join(repoRoot, "src/native/session-header-strip.tsx"),
    "utf8",
  );
  const sourceSource = readFileSync(
    path.join(repoRoot, "src/native/session-header-source.ts"),
    "utf8",
  );
  const measureSource = readFileSync(
    path.join(repoRoot, "src/native/session-header-measure.ts"),
    "utf8",
  );
  const headerCss = readFileSync(path.join(repoRoot, "src/native/session-header.css"), "utf8");

  it("registers the released session.header Slot and one shared quota viewer", () => {
    expect(guiSource).toContain("ctx.add(Slot");
    expect(guiSource).toContain('at: "session.header"');
    expect(guiSource).toContain("<NativeSessionHeader");
    expect(guiSource).toContain("revealPanel(ctx, session)");
    expect(headerSource).toContain('scope: "quota"');
    expect(headerSource).toContain("createSessionHeaderSource");
    expect(sourceSource).toContain("createDashboardPanelState");
    expect(sourceSource).toContain("client.quota()");
    expect(sourceSource).not.toContain("setActiveView");
    expect(sourceSource).not.toContain("setInterval");
    expect(sourceSource).not.toContain("EventSource");
  });

  it("measures the host header container instead of a fixed token count", () => {
    expect(headerSource).toContain("observeHeaderBudget");
    expect(measureSource).toContain('closest(".session-header-layout")');
    expect(measureSource).toContain('closest(".session-header-actions")');
    expect(measureSource).toContain("ResizeObserver");
    expect(measureSource).toContain("otherActionElements");
    expect(measureSource).toContain("headerTokenBudget");
    expect(headerSource).not.toContain("maxCards");
    expect(headerSource).not.toContain("MAX_CARDS");
  });

  it("keeps the Peak dot outside the rings with the approved colours", () => {
    expect(headerCss).toContain(".qg-slot-token__peak");
    expect(headerCss).toMatch(/top:\s*-2px/u);
    expect(headerCss).toMatch(/inset-inline-end:\s*-2px/u);
    expect(headerCss).toContain("#f17471");
    expect(headerCss).toContain("#f4cf74");
    expect(headerCss).not.toMatch(/\.qg-slot-token__peak[^{]*\{[^}]*bottom/u);
  });

  it("feeds the preview the latest view time instead of a captured clock", () => {
    expect(headerSource).toContain("nowMs={view().nowMs}");
    expect(headerSource).toContain("nowMs={props.nowMs}");
    expect(headerSource).not.toContain("openedAtMs");
    expect(headerSource).not.toContain("Date.now()");
  });

  it("keeps a zero-ring token legible without drawing a progress ring", () => {
    expect(headerCss).toContain('[data-ring-count="0"]');
    expect(stripSource).toContain("data-ring-count={card.rings.length}");
    expect(stripSource).toContain("props.card.rings.length > 0");
  });

  it("uses the Desktop data-URL provider mark in the token and preview", () => {
    expect(stripSource).toContain('from "./provider-logo.js"');
    expect(headerSource).toContain('from "./provider-logo.js"');
  });
});
