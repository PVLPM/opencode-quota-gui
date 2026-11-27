import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { buildSyntheticUsageSnapshot } from "../scripts/fixtures/synthetic-usage.mjs";
import { UsageView } from "../src/ui/views/usage";

/**
 * Usage is a Quota-area view: one card per account, every quota window stacked
 * full-width, one focusable inspection surface per chart, and a collapsible
 * model-first breakdown with an explicit Unattributed row.
 */

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const SNAPSHOT = buildSyntheticUsageSnapshot({ range: "7d", nowMs: NOW });

function mount(mode: "used" | "remaining") {
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(UsageView, {
        snapshot: SNAPSHOT,
        preferences: { percentMode: mode, detailed: false },
      }),
    target,
  );
  return { target, dispose };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Usage view DOM", () => {
  it("renders one account card and one full-width window chart per quota window", () => {
    const { target, dispose } = mount("remaining");

    expect(target.querySelectorAll("article.qg-usage-account")).toHaveLength(3);
    expect(target.querySelectorAll(".qg-usage-window")).toHaveLength(6);
    // Every window chart is a direct row of its account, never a side-by-side grid.
    for (const account of target.querySelectorAll(".qg-usage-account__windows")) {
      for (const child of account.children) {
        expect(child.classList.contains("qg-usage-window")).toBe(true);
      }
    }
    expect(target.textContent).toContain("5h limit");
    expect(target.textContent).toContain("Weekly");
    expect(target.textContent).toContain("Fable weekly");
    expect(target.textContent).toContain("Unknown effort");
    expect(target.textContent).toContain("Default effort (recorded)");

    dispose();
  });

  it("marks unobserved gaps dashed, boundaries disconnected and missing history banded", () => {
    const { target, dispose } = mount("remaining");

    expect(target.querySelectorAll(".qg-usage-chart__gap").length).toBeGreaterThan(0);
    expect(target.querySelectorAll(".qg-usage-chart__boundary").length).toBeGreaterThan(0);
    expect(target.querySelectorAll(".qg-usage-chart__unavailable").length).toBeGreaterThan(0);
    expect(target.querySelectorAll(".qg-usage-chart__line").length).toBeGreaterThan(0);

    dispose();
  });

  it("flips Remaining to Used only at render time", () => {
    const remaining = mount("remaining");
    const remainingSurface = remaining.target.querySelector<HTMLElement>(".qg-chart__surface");
    expect(remainingSurface).not.toBeNull();
    remainingSurface?.focus();
    expect(remainingSurface?.getAttribute("aria-valuetext")).toContain("Remaining");
    expect(remainingSurface?.getAttribute("aria-valuetext")).toContain("82.00%");
    remaining.dispose();

    const used = mount("used");
    const usedSurface = used.target.querySelector<HTMLElement>(".qg-chart__surface");
    usedSurface?.focus();
    expect(usedSurface?.getAttribute("aria-valuetext")).toContain("Used");
    expect(usedSurface?.getAttribute("aria-valuetext")).toContain("18.00%");
    expect(used.target.textContent).toContain("Used");
    used.dispose();
  });

  it("steps through intervals with the keyboard and exposes the full tooltip", async () => {
    const { target, dispose } = mount("remaining");
    const surface = target.querySelector<HTMLElement>(".qg-chart__surface");
    expect(surface).not.toBeNull();
    surface?.focus();
    await Promise.resolve();

    const initial = surface?.getAttribute("aria-valuetext");
    expect(initial).toContain("Observed");
    const tooltip = target.querySelector(".qg-usage-chart__tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain("Previous");
    expect(tooltip?.textContent).toContain("Current");
    expect(tooltip?.textContent).toContain("Estimated attribution");
    expect(tooltip?.textContent).toContain("Unattributed");
    expect(tooltip?.textContent).toContain("estimated");
    expect(tooltip?.textContent).toContain("cannot be excluded");

    surface?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(surface?.getAttribute("aria-valuetext")).not.toBe(initial);
    expect(surface?.getAttribute("aria-valuetext")).toContain("Monitoring gap");
    expect(target.querySelector(".qg-usage-chart__tooltip")?.textContent).toContain(
      "the trajectory is unknown",
    );

    surface?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    expect(surface?.getAttribute("aria-valuenow")).toBe(surface?.getAttribute("aria-valuemax"));

    dispose();
  });

  it("shows a precise reset time only when the provider fixed it", async () => {
    const { target, dispose } = mount("remaining");
    const surfaces = target.querySelectorAll<HTMLElement>(".qg-chart__surface");

    // Account 0 window 1 proves the reset time; account 1 window 0 does not.
    const precise = surfaces[1];
    precise?.focus();
    precise?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(
      precise?.closest(".qg-usage-window")?.querySelector(".qg-usage-chart__tooltip")?.textContent,
    ).toContain("Reset at");

    const unknown = surfaces[2];
    unknown?.focus();
    unknown?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(
      unknown?.closest(".qg-usage-window")?.querySelector(".qg-usage-chart__tooltip")?.textContent,
    ).toContain("Reset between observations");

    dispose();
  });

  it("renders imported harness activity as its own labelled section", () => {
    const { target, dispose } = mount("remaining");

    const sections = target.querySelectorAll(".qg-usage-imported");
    expect(sections).toHaveLength(2);
    expect(target.textContent).toContain(
      "Imported from Claude Code — recorded activity, not attributed to quota",
    );
    expect(target.textContent).toContain(
      "Imported from Codex — recorded activity, not attributed to quota",
    );
    expect(sections[0]?.textContent).toContain("claude-sonnet-4-5");
    expect(sections[0]?.textContent).toContain("API-equivalent");
    expect(sections[1]?.textContent).toContain("gpt-5.2-codex");
    expect(sections[1]?.textContent).toContain("high");

    // Imported sections sit after every quota account card, outside their charts.
    const cards = [...target.querySelectorAll(".qg-usage-account")];
    expect(cards.some((card) => card.querySelector(".qg-usage-imported"))).toBe(false);

    dispose();
  });

  it("expands the model breakdown, switches quota windows and keeps Unattributed explicit", async () => {
    const { target, dispose } = mount("remaining");
    const breakdown = target.querySelector<HTMLDetailsElement>(
      ".qg-usage-account .qg-usage-breakdown",
    );
    expect(breakdown).not.toBeNull();
    if (breakdown) breakdown.open = true;
    await Promise.resolve();

    expect(breakdown?.querySelectorAll(".qg-usage-breakdown__model")).toHaveLength(2);
    expect(breakdown?.textContent).toContain("Unknown effort");
    expect(breakdown?.textContent).toContain("Default effort (recorded)");
    expect(breakdown?.textContent).toContain("estimated");
    expect(breakdown?.textContent).toContain("tokens");

    const select = breakdown?.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("five_hour");
    expect(select?.querySelectorAll("option")).toHaveLength(2);
    const coverage = breakdown?.querySelector(".qg-usage-breakdown__coverage")?.textContent;
    expect(coverage).toContain("53% observed");

    if (select) {
      select.value = "weekly";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
    expect(select?.value).toBe("weekly");
    expect(breakdown?.querySelector(".qg-usage-breakdown__coverage")?.textContent).toContain(
      "38% observed",
    );

    const unattributed = breakdown?.querySelector(".qg-usage-breakdown__unattributed");
    expect(unattributed?.textContent).toContain("Unattributed");
    expect(unattributed?.textContent).toContain("7.00 pp");
    expect(unattributed?.textContent).toContain("zero API-equivalent weight");

    dispose();
  });
});
