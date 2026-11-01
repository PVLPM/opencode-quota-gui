// @vitest-environment happy-dom
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PrimaryQuotaWindowRef,
  PrimaryQuotaWindowSlot,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import { buildSessionHeaderView, type HeaderCard } from "../src/native/session-header-model.js";
import { createPreviewDisclosure } from "../src/native/session-header-preview.js";
import {
  SessionHeaderStrip,
  type SessionHeaderStripProps,
} from "../src/native/session-header-strip.js";
import type { DisplayPreferences } from "../src/ui/quota-semantics.js";

/**
 * Real-DOM behavior for the `session.header` token strip.
 *
 * The SSR tests pin markup and the pure tests pin the model. These mount the
 * presentational strip in happy-dom so the behavior that only exists once the
 * browser wires it up is exercised: a real click, focus-driven preview
 * disclosure, the hidden measurement anchor, and slot-stable rings across a
 * window disappearing and returning. Real Desktop host geometry remains a
 * separate, unverified integration check.
 */

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const preferences: DisplayPreferences = {
  percentMode: "used",
  showRunway: false,
  detailed: false,
};

const disposers: Array<() => void> = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const container of containers.splice(0)) container.remove();
});

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
  providerId: string;
  rows: QuotaCardRow[];
  windows?: readonly PrimaryQuotaWindowRef[];
}): ProviderCard {
  return {
    cardId: params.cardId as CardId,
    providerId: params.providerId,
    providerLabel: params.providerId,
    rows: params.rows,
    ...(params.windows === undefined ? {} : { primaryQuotaWindows: [...params.windows] }),
    errors: [],
  };
}

function snapshot(cards: ProviderCard[]): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: { cards, enabledProviders: "auto", polledAtMs: NOW },
  };
}

function cardsFor(cards: ProviderCard[], hiddenRows: readonly string[] = []): HeaderCard[] {
  return buildSessionHeaderView({
    snapshot: snapshot(cards),
    hiddenCards: [],
    hiddenRows,
    preferences,
    nowMs: NOW,
  }).cards;
}

function mountStrip(options: {
  cards: () => HeaderCard[];
  hidden?: () => boolean;
  previewOpen?: () => boolean;
  onOpenPanel?: () => void;
  onFocusIn?: () => void;
  onFocusOut?: () => void;
  onEscape?: () => void;
  overflow?: { visible: boolean; hiddenCount: number };
}): {
  container: HTMLDivElement;
  root: HTMLDivElement;
  button: HTMLButtonElement;
  dispose: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: SessionHeaderStripProps = {
    get cards() {
      return options.cards();
    },
    get visibleCount() {
      return options.cards().length;
    },
    hiddenCount: options.overflow?.hiddenCount ?? 0,
    overflowVisible: options.overflow?.visible ?? false,
    get previewOpen() {
      return options.previewOpen?.() ?? false;
    },
    previewId: "preview-dom",
    get hidden() {
      return options.hidden?.() ?? false;
    },
    onOpenPanel: options.onOpenPanel ?? (() => {}),
    onPointerEnter: () => {},
    onPointerLeave: () => {},
    onFocusIn: options.onFocusIn ?? (() => {}),
    onFocusOut: options.onFocusOut ?? (() => {}),
    onEscape: options.onEscape ?? (() => {}),
  };
  const dispose = render(() => createComponent(SessionHeaderStrip, props), container);
  disposers.push(dispose);
  const root = container.querySelector<HTMLDivElement>(".qg-slot-strip");
  const button = container.querySelector<HTMLButtonElement>(".qg-slot-token");
  if (root === null || button === null) throw new Error("strip did not render a token");
  return { container, root, button, dispose };
}

function ringElements(
  root: HTMLElement,
  selector: ".qg-slot-token__ring" | ".qg-slot-token__track",
) {
  return [...root.querySelectorAll<SVGCircleElement>(selector)];
}

describe("session.header strip in a real DOM", () => {
  it("opens the Panel from a real click and exposes the preview while focused", () => {
    const five = row("card-dom", "five", { label: "5h" });
    const cards = cardsFor([
      card({
        cardId: "card-dom",
        providerId: "openai",
        rows: [five],
        windows: [windowRef(five, 0)],
      }),
    ]);
    const disclosure = createPreviewDisclosure({ delayMs: 0 });
    const onOpenPanel = vi.fn(() => {
      disclosure.close();
    });
    const { button } = mountStrip({
      cards: () => cards,
      previewOpen: disclosure.open,
      onOpenPanel,
      onFocusIn: disclosure.onFocusIn,
      onFocusOut: disclosure.onFocusOut,
    });

    button.focus();
    expect(document.activeElement).toBe(button);
    expect(disclosure.open()).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("preview-dom");

    button.click();
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(disclosure.open()).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("closes an open preview from a real Escape keydown", () => {
    const five = row("card-dom", "five", { label: "5h" });
    const cards = cardsFor([
      card({
        cardId: "card-dom",
        providerId: "openai",
        rows: [five],
        windows: [windowRef(five, 0)],
      }),
    ]);
    const onEscape = vi.fn();
    const { button } = mountStrip({
      cards: () => cards,
      previewOpen: () => true,
      onEscape,
    });

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("hides the strip without unmounting its measurement anchor", () => {
    const five = row("card-dom", "five", { label: "5h" });
    const cards = cardsFor([
      card({
        cardId: "card-dom",
        providerId: "openai",
        rows: [five],
        windows: [windowRef(five, 0)],
      }),
    ]);
    const [hidden, setHidden] = createSignal(true);
    const { root } = mountStrip({
      cards: () => cards,
      hidden,
    });

    expect(root.style.display).toBe("none");
    const anchor = root;
    setHidden(false);
    expect(root.style.display).toBe("");
    expect(anchor.isConnected).toBe(true);
    expect(anchor).toBe(root);
  });

  it("keeps the weekly ring in slot 1 when 5h disappears, is hidden and returns", () => {
    const five = row("card-slot", "five", { label: "5h" });
    const weekly = row("card-slot", "weekly", { label: "Weekly" });
    const fullCard = card({
      cardId: "card-slot",
      providerId: "openai",
      rows: [five, weekly],
      windows: [windowRef(five, 0), windowRef(weekly, 1)],
    });
    const weeklyOnly = card({
      cardId: "card-slot",
      providerId: "openai",
      rows: [weekly],
      windows: [windowRef(weekly, 1)],
    });
    const fullCards = cardsFor([fullCard]);
    const hiddenFiveCards = cardsFor([fullCard], [five.rowId]);
    const weeklyOnlyCards = cardsFor([weeklyOnly]);
    const [cards, setCards] = createSignal(fullCards);
    const { root } = mountStrip({ cards });

    const weeklyRing = () =>
      root.querySelector<SVGCircleElement>('.qg-slot-token__ring[data-row-id="card-slot#weekly"]');
    expect(weeklyRing()?.getAttribute("data-ring-slot")).toBe("1");
    expect(weeklyRing()?.getAttribute("r")).toBe("9.5");
    expect(
      ringElements(root, ".qg-slot-token__track").map((track) => track.getAttribute("r")),
    ).toEqual(["12", "9.5"]);

    // 5h hidden: its slot stays empty; Weekly is still the middle ring.
    setCards(hiddenFiveCards);
    expect(weeklyRing()?.getAttribute("data-ring-slot")).toBe("1");
    expect(weeklyRing()?.getAttribute("r")).toBe("9.5");
    expect(root.querySelector('.qg-slot-token__track[data-ring-slot="0"]')).toBeNull();

    // 5h absent from the payload entirely: no compaction outward.
    setCards(weeklyOnlyCards);
    expect(weeklyRing()?.getAttribute("data-ring-slot")).toBe("1");
    expect(weeklyRing()?.getAttribute("r")).toBe("9.5");
    expect(root.querySelector('.qg-slot-token__track[data-ring-slot="0"]')).toBeNull();

    // 5h returns: the outer ring comes back, Weekly does not move.
    setCards(fullCards);
    expect(weeklyRing()?.getAttribute("data-ring-slot")).toBe("1");
    expect(weeklyRing()?.getAttribute("r")).toBe("9.5");
    expect(root.querySelector('.qg-slot-token__track[data-ring-slot="0"]')).not.toBeNull();
  });

  it("leaves a missing middle slot empty instead of compacting the inner ring", () => {
    const five = row("card-gap", "five", { label: "5h" });
    const monthly = row("card-gap", "monthly", { label: "Monthly" });
    const cards = cardsFor([
      card({
        cardId: "card-gap",
        providerId: "openai",
        rows: [five, monthly],
        windows: [windowRef(five, 0), windowRef(monthly, 2)],
      }),
    ]);
    const { root } = mountStrip({ cards: () => cards });

    expect(
      ringElements(root, ".qg-slot-token__track").map((track) => track.getAttribute("r")),
    ).toEqual(["12", "7"]);
    expect(root.querySelector('.qg-slot-token__track[data-ring-slot="1"]')).toBeNull();
    expect(
      root.querySelector('.qg-slot-token__ring[data-row-id="card-gap#monthly"]')?.getAttribute("r"),
    ).toBe("7");
  });

  it("keeps a zero-ring token actionable without inventing progress", () => {
    const quota = row("card-zero", "quota", { label: "Quota" });
    const cards = cardsFor([card({ cardId: "card-zero", providerId: "cursor", rows: [quota] })]);
    const onOpenPanel = vi.fn();
    const { button } = mountStrip({
      cards: () => cards,
      onOpenPanel,
    });

    expect(button.getAttribute("data-ring-count")).toBe("0");
    expect(button.querySelector(".qg-slot-token__ring")).toBeNull();
    expect(button.querySelector(".qg-slot-token__track")).toBeNull();
    expect(button.querySelector(".qg-slot-token__svg")).toBeNull();
    expect(button.querySelector(".qg-slot-token__logo")).not.toBeNull();
    button.click();
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });

  it("opens the Panel from the +N overflow chip", () => {
    const rows = [1, 2, 3].map((index) =>
      row(`card-${index}`, "quota", { label: `Quota ${index}` }),
    );
    const cards = rows.map((entry, index) =>
      card({
        cardId: `card-${index + 1}`,
        providerId: "synthetic",
        rows: [entry],
        windows: [windowRef(entry, 0)],
      }),
    );
    const builtCards = cardsFor(cards);
    const onOpenPanel = vi.fn();
    const { container } = mountStrip({
      cards: () => builtCards,
      onOpenPanel,
      overflow: { visible: true, hiddenCount: 1 },
    });
    const overflow = container.querySelector<HTMLButtonElement>(".qg-slot-overflow");
    expect(overflow?.textContent).toBe("+1");
    overflow?.click();
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });
});
