import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, percentRow, providerCard } from "./fixtures/gui-ui-fixtures";

// The native build aliases the shared UI boundary to its real local primitives.
vi.mock("../src/ui/opencode-ui", async () => import("../src/native/ui"));

import { QuotaCardView } from "../src/ui/components/quota-card";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(
  runway: ReturnType<typeof percentRow>["runway"],
  showRunway: boolean,
  options: { stale?: boolean; resetAtIso?: string | null } = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  const card = providerCard({
    rows: [
      percentRow({
        runway,
        resetAtIso:
          options.resetAtIso === null
            ? undefined
            : (options.resetAtIso ?? new Date(NOW + 86_400_000).toISOString()),
      }),
    ],
  });
  const dispose = render(
    () =>
      createComponent(QuotaCardView, {
        card,
        preferences: {
          percentMode: "remaining",
          percentLabelStyle: "full",
          detailed: false,
          showRunway,
        },
        hiddenRows: [],
        stale: options.stale ?? false,
        timeZone: "UTC",
      }),
    target,
  );
  return { target, dispose };
}

function tooltipText(trigger: HTMLElement): string | null {
  const id = trigger.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

describe("quota runway tooltips", () => {
  for (const showRunway of [false, true]) {
    it(`copies the quota summary without runway regardless of legacy toggle ${showRunway}`, async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      try {
        const { target, dispose } = mount(
          { kind: "before_reset", projectedAtIso: new Date(NOW + 60_000).toISOString() },
          showRunway,
        );
        target.querySelector<HTMLButtonElement>(".qg-card__copy")?.click();
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledOnce();
        const copied = writeText.mock.calls[0]?.[0] as string;
        expect(copied).toContain("Synthetic Provider");
        expect(copied).toContain("Five hour window: 62% remaining");
        expect(copied).toContain("Resets in");
        expect(copied).not.toContain("Runs out");
        expect(target.querySelector("output")?.textContent).toBe("Quota summary copied.");
        dispose();
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
    it(`shows identical focus and hover content on both targets with legacy toggle ${showRunway}`, async () => {
      const { target, dispose } = mount(
        { kind: "before_reset", projectedAtIso: new Date(NOW + 204 * 60_000).toISOString() },
        showRunway,
      );
      const triggers = [
        target.querySelector<HTMLElement>(".qg-row__value-tip"),
        target.querySelector<HTMLElement>(".qg-row__bar-tip"),
      ];
      expect(triggers.every(Boolean)).toBe(true);
      expect(target.textContent).not.toContain("Runs out");
      for (const trigger of triggers) {
        expect(trigger?.tabIndex).toBe(0);
        trigger?.focus();
        expect(tooltipText(trigger!)).toBe("Runs out in ~3h 24m");
        trigger?.blur();
        await Promise.resolve();
        expect(tooltipText(trigger!)).toBeNull();
        trigger?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
        vi.advanceTimersByTime(400);
        expect(tooltipText(trigger!)).toBe("Runs out in ~3h 24m");
        trigger?.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
        expect(tooltipText(trigger!)).toBeNull();
      }
      dispose();
    });
  }

  it("has no empty tooltip without evidence or when the projected time has passed", () => {
    for (const runway of [
      undefined,
      { kind: "before_reset" as const, projectedAtIso: new Date(NOW - 1).toISOString() },
    ]) {
      const { target, dispose } = mount(runway, true);
      expect(target.querySelector(".qg-row__value-tip, .qg-row__bar-tip")).toBeNull();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      dispose();
      target.remove();
    }
  });

  it("offers the same last-until-reset message on both targets", () => {
    const { target, dispose } = mount({ kind: "lasts_past_reset" }, false);
    for (const trigger of target.querySelectorAll<HTMLElement>(
      ".qg-row__value-tip, .qg-row__bar-tip",
    )) {
      trigger.focus();
      expect(tooltipText(trigger)).toBe("Projected to last until reset");
    }
    dispose();
  });

  it("suppresses all runway messages on stale snapshots", () => {
    for (const runway of [
      { kind: "lasts_past_reset" as const },
      { kind: "before_reset" as const, projectedAtIso: new Date(NOW + 60_000).toISOString() },
    ]) {
      const { target, dispose } = mount(runway, false, { stale: true });
      expect(target.querySelector(".qg-row__value-tip, .qg-row__bar-tip")).toBeNull();
      dispose();
    }
  });

  it("requires a valid future reset and removes the tooltip at reset", () => {
    for (const resetAtIso of [null, "invalid", new Date(NOW - 1).toISOString()]) {
      const { target, dispose } = mount({ kind: "lasts_past_reset" }, false, { resetAtIso });
      expect(target.querySelector(".qg-row__value-tip, .qg-row__bar-tip")).toBeNull();
      dispose();
    }
    const { target, dispose } = mount({ kind: "lasts_past_reset" }, false, {
      resetAtIso: new Date(NOW + 2_000).toISOString(),
    });
    expect(target.querySelectorAll(".qg-row__value-tip, .qg-row__bar-tip")).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(target.querySelector(".qg-row__value-tip, .qg-row__bar-tip")).toBeNull();
    dispose();
  });

  it("removes a projection after its timestamp passes", () => {
    const { target, dispose } = mount(
      { kind: "before_reset", projectedAtIso: new Date(NOW + 2_000).toISOString() },
      false,
    );
    expect(target.querySelectorAll(".qg-row__value-tip, .qg-row__bar-tip")).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(target.querySelector(".qg-row__value-tip, .qg-row__bar-tip")).toBeNull();
    dispose();
  });
});
