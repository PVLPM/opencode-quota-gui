import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildProviderCards } from "../src/gui/provider-cards";
import type { QuotaPercentEntry } from "../src/lib/entries";
import { QuotaCardView } from "../src/ui/components/quota-card";
import { QuotaView } from "../src/ui/views/home";
import { percentRow, providerCard } from "./fixtures/gui-ui-fixtures";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1_000;

it("marks only retained account values stale and excludes their runway and copy it as last known", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const row = percentRow({
    percentRemaining: 50,
    runway: { kind: "before_reset", projectedAtIso: new Date(Date.now() + HOUR_MS).toISOString() },
  });
  const a = providerCard({ accountLabel: "A", rows: [row], errors: [] });
  const b = providerCard({
    cardId: "b" as typeof a.cardId,
    accountLabel: "B",
    rows: [row],
    stale: true,
    errors: [{ label: "B", message: "offline" }],
  });
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaView, {
        snapshot: {
          generatedAtMs: Date.now(),
          stale: false,
          timeZone: "UTC",
          providers: { cards: [a, b], enabledProviders: "auto", polledAtMs: Date.now() },
        },
        preferences: { percentMode: "remaining", detailed: false },
        hiddenCards: [],
        hiddenRows: [],
        stale: false,
      }),
    target,
  );
  const cards = target.querySelectorAll("article");
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).not.toContain("Data may be stale");
  expect(cards[0]?.querySelector(".qg-row__value-tip")).not.toBeNull();
  expect(cards[1]?.textContent).toContain("Data may be stale");
  expect(cards[1]?.textContent).toContain("offline");
  expect(cards[1]?.textContent).toContain("50%");
  expect(cards[1]?.querySelector(".qg-row__value-tip")).toBeNull();
  cards[1]?.querySelector("button")?.click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Data may be stale"));
  dispose();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("shows OpenAI's evidence-backed runway in the real tooltip on value and bar", async () => {
  const endsAtIso = new Date(NOW + 4 * HOUR_MS).toISOString();
  const entry: QuotaPercentEntry = {
    kind: "percent",
    name: "5h",
    percentRemaining: 50,
    resetTimeIso: endsAtIso,
    fixedWindow: {
      kind: "fixed_window",
      startedAtIso: new Date(NOW - HOUR_MS).toISOString(),
      observedAtIso: new Date(NOW).toISOString(),
      endsAtIso,
      fullReset: true,
    },
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      observedAtIso: new Date(NOW).toISOString(),
    },
    semantic: { metric: { kind: "window", window: "five_hour" }, prominence: "primary" },
  };
  const card = buildProviderCards({
    probes: [{ providerId: "openai", result: { attempted: true, entries: [entry], errors: [] } }],
    preferences: { accountingDetail: "summary" },
    nowMs: NOW,
  })[0];
  expect(card?.rows[0]?.runway).toEqual({
    kind: "before_reset",
    projectedAtIso: new Date(NOW + HOUR_MS).toISOString(),
  });

  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaCardView, {
        card: card!,
        preferences: { percentMode: "remaining", detailed: false },
        hiddenRows: [],
        stale: false,
        timeZone: "UTC",
      }),
    target,
  );
  const triggers = target.querySelectorAll<HTMLElement>(".qg-row__value-tip, .qg-row__bar-tip");
  expect(triggers).toHaveLength(2);
  expect(target.querySelectorAll(".qg-row__value-tip")).toHaveLength(1);
  expect(target.querySelectorAll(".qg-row__bar-tip")).toHaveLength(1);
  expect(target.textContent).not.toContain("Runs out");
  for (const trigger of triggers) {
    trigger.focus();
    await Promise.resolve();
    const id = trigger.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const tooltip = document.getElementById(id!);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Runs out in ~1h");
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
    trigger.blur();
    await Promise.resolve();
  }
  dispose();
  target.remove();
});

it("shows lasts-past-reset in the real tooltip on value and bar and closes on blur", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const card = providerCard({
    rows: [
      percentRow({
        runway: { kind: "lasts_past_reset" },
        resetAtIso: new Date(NOW + 86_400_000).toISOString(),
      }),
    ],
  });
  const dispose = render(
    () =>
      createComponent(QuotaCardView, {
        card,
        preferences: { percentMode: "remaining", detailed: false, showRunway: false },
        hiddenRows: [],
        stale: false,
        timeZone: "UTC",
      }),
    target,
  );
  const triggers = target.querySelectorAll<HTMLElement>(".qg-row__value-tip, .qg-row__bar-tip");
  expect(triggers).toHaveLength(2);
  for (const trigger of triggers) {
    trigger.focus();
    await Promise.resolve();
    const id = trigger.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const tooltip = document.getElementById(id!);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Projected to last until reset");
    trigger.blur();
    await Promise.resolve();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById(id!)?.hasAttribute("data-closed")).toBe(true);
  }
  dispose();
  target.remove();
});
