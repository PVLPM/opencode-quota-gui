import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTabs } from "../src/ui/components/analytics-tabs";
import { QuotaUsageTabs } from "../src/ui/components/quota-usage-tabs";

/**
 * Quota / Usage must use the Analytics tab contract exactly. The Native panel
 * styles `.qg-frame-tab:not(.qg-analytics-tabs)` with a full-width bottom
 * border, so a parallel tab class draws an underline that Analytics never has
 * and makes the inactive tab look current.
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
    expect(quotaNav?.className).not.toContain("qg-quota-tabs");

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
  });
});
