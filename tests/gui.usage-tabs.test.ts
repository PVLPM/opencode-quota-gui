import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTabs, QuotaUsageTabs } from "../src/ui/components/analytics-tabs";

/**
 * Quota / Usage must use the Analytics tab contract exactly, and both rows are
 * one implementation: `FrameTabs` owns the nav, the anchors and the active
 * underline. The Native panel styles `.qg-frame-tab:not(.qg-analytics-tabs)`
 * with a full-width bottom border, so a parallel tab class would draw an
 * underline Analytics never has and make the inactive tab look current.
 */

function mount(element: () => unknown): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  render(() => element(), target);
  return target;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Quota/Usage tab contract", () => {
  it("uses the same nav classes and anchor markup as Analytics", () => {
    const analytics = mount(() =>
      createComponent(AnalyticsTabs, { active: "analytics", range: "7d" }),
    );
    const quota = mount(() =>
      createComponent(QuotaUsageTabs, { active: "usage", range: "7d", usageRange: "7d" }),
    );

    const analyticsNav = analytics.querySelector("nav");
    const quotaNav = quota.querySelector("nav");
    expect(analyticsNav?.className).toBe("qg-frame-tab qg-analytics-tabs");
    expect(quotaNav?.className).toBe(analyticsNav?.className);

    const analyticsLinks = [...(analyticsNav?.querySelectorAll("a") ?? [])];
    const quotaLinks = [...(quotaNav?.querySelectorAll("a") ?? [])];
    expect(quotaLinks).toHaveLength(analyticsLinks.length);
    for (const [index, link] of quotaLinks.entries()) {
      expect([...link.classList]).toEqual([...(analyticsLinks[index]?.classList ?? [])]);
    }

    expect(quotaLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/quota",
      "/usage?range=7d",
    ]);
    expect(quotaLinks.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(analyticsLinks.map((link) => link.getAttribute("aria-current"))).toEqual(["page", null]);
  });

  it("switches the active underline in place, without remounting the row", () => {
    const [active, setActive] = createSignal<"quota" | "usage">("quota");
    const target = mount(() =>
      createComponent(QuotaUsageTabs, {
        get active() {
          return active();
        },
        range: "7d",
      }),
    );
    const nav = target.querySelector("nav");
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual(["page", null]);

    setActive("usage");

    // The same anchors are reused: only the current marker moved.
    expect([...(nav?.querySelectorAll("a") ?? [])]).toEqual(links);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page"]);
  });

  it("carries the selected Usage range and never the Quota label back", () => {
    const target = mount(() =>
      createComponent(QuotaUsageTabs, { active: "quota", range: "30d", usageRange: "lifetime" }),
    );
    const links = [...(target.querySelector("nav")?.querySelectorAll("a") ?? [])];

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/quota",
      "/usage?range=lifetime",
    ]);
    expect(target.querySelector("nav")?.getAttribute("aria-label")).toBe("Quota views");
    expect(links.map((link) => link.textContent)).toEqual(["Quota", "Usage"]);
  });
});
