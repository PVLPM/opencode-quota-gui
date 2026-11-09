import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { expect, it } from "vitest";
import { QuotaCardView } from "../src/ui/components/quota-card";
import { percentRow, providerCard } from "./fixtures/gui-ui-fixtures";

it("mounts the web tooltip on both quota targets and exposes the same text on focus", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const card = providerCard({
    rows: [
      percentRow({
        runway: { kind: "lasts_past_reset" },
        resetAtIso: new Date(Date.now() + 86_400_000).toISOString(),
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
    expect(document.getElementById(id!)?.textContent).toBe("Projected to last until reset");
    trigger.blur();
    await Promise.resolve();
  }
  dispose();
  target.remove();
});
