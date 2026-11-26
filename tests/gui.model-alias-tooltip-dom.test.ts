import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeAgentAliasPricingProvenance, ModelIdentity } from "../src/contracts/dashboard";
import { modelAliasPricingSummary } from "../src/ui/components/model-alias-pricing";
import { ModelIdentityLabel } from "../src/ui/components/model-identity";

const CAVEAT =
  "Historical model version: unknown — usage was recorded under the alias and may predate the current pricing target.";

const CASES: Array<{
  name: string;
  pricingAlias: ClaudeAgentAliasPricingProvenance;
  target: string;
  pricing: string;
  summary: string;
  source: string;
  extra?: string;
}> = [
  {
    name: "catalog",
    pricingAlias: {
      alias: "opus",
      state: "catalog",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    },
    target: "Current alias target: Opus 5.6",
    pricing: "Pricing: API-equivalent estimate",
    summary: "Pricing: Opus 5.6 (current catalog target); historical version unknown",
    source: "Source: OpenCode model catalog + models.dev",
  },
  {
    name: "catalog without rates",
    pricingAlias: {
      alias: "opus",
      state: "catalog",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: false,
    },
    target: "Current alias target: Opus 5.6",
    pricing: "Pricing: Not estimated (no rate is available for this target)",
    summary:
      "Pricing: target Opus 5.6, rates unavailable; not estimated; historical version unknown",
    source: "Source: OpenCode model catalog + models.dev",
  },
  {
    name: "last confirmed",
    pricingAlias: {
      alias: "opus",
      state: "last-confirmed",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-6",
      targetName: "Opus 5.6",
      priced: true,
    },
    target: "Last confirmed alias target: Opus 5.6",
    pricing: "Pricing: API-equivalent estimate",
    summary: "Pricing: Opus 5.6 (last confirmed); historical version unknown",
    source: "Source: last confirmed OpenCode model catalog evidence + models.dev",
  },
  {
    name: "static fallback",
    pricingAlias: {
      alias: "opus",
      state: "static-fallback",
      targetProviderId: "anthropic",
      targetModelId: "claude-opus-5-5",
      priced: true,
    },
    target: "Static fallback target: anthropic/claude-opus-5-5",
    pricing: "Pricing: API-equivalent estimate",
    summary: "Pricing: anthropic/claude-opus-5-5 (static fallback); historical version unknown",
    source: "Source: static alias fallback + models.dev",
    extra: "Not confirmed as the current native model.",
  },
  {
    name: "unavailable ambiguous",
    pricingAlias: {
      alias: "fable",
      state: "unavailable",
      unavailableReason: "ambiguous",
    },
    target: "Pricing target unavailable",
    pricing: "Pricing: Not estimated",
    summary: "Pricing: not estimated (ambiguous target)",
    source: "Source: OpenCode model catalog + models.dev (no unique match)",
    extra: "More than one candidate target was observed; pricing needs one unambiguous match.",
  },
  {
    name: "unavailable missing",
    pricingAlias: {
      alias: "fable",
      state: "unavailable",
      unavailableReason: "missing",
    },
    target: "Pricing target unavailable",
    pricing: "Pricing: Not estimated",
    summary: "Pricing: not estimated (no confirmed target)",
    source: "Source: OpenCode model catalog + models.dev (no unique match)",
    extra: "No confirmed target could be verified for this alias.",
  },
];

const identity = (pricingAlias: ClaudeAgentAliasPricingProvenance): ModelIdentity => ({
  providerId: "claude-agent",
  modelId: "opus",
  effort: "medium",
  pricingAlias,
});

function expectWording(text: string, entry: (typeof CASES)[number]): void {
  expect(text).toContain("Model: claude-agent/opus#medium");
  expect(text).toContain(entry.target);
  if (entry.extra) expect(text).toContain(entry.extra);
  expect(text).toContain(entry.pricing);
  expect(text).not.toContain(
    entry.pricingAlias.priced === true ? "Pricing: Not estimated" : "Pricing: API-equivalent",
  );
  expect(text).toContain(entry.source);
  expect(text).toContain(CAVEAT);
  // One truthful line for the non-interactive surfaces.
  const summary = modelAliasPricingSummary(entry.pricingAlias);
  expect(summary).toBe(entry.summary);
  expect(summary).not.toContain("\n");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("web model identity alias pricing tooltip", () => {
  it("renders every state and the historical caveat", async () => {
    for (const entry of CASES) {
      const target = document.createElement("div");
      document.body.append(target);
      const dispose = render(
        () => createComponent(ModelIdentityLabel, { identity: identity(entry.pricingAlias) }),
        target,
      );
      const trigger = target.querySelector<HTMLElement>(".qg-alias-pricing-trigger");
      if (trigger === null) throw new Error(`${entry.name}: missing tooltip trigger`);
      trigger.focus();
      await Promise.resolve();
      const id = trigger.getAttribute("aria-describedby");
      if (id === null) throw new Error(`${entry.name}: missing described tooltip id`);
      const tooltip = document.getElementById(id);
      expect(tooltip?.getAttribute("role"), entry.name).toBe("tooltip");
      expectWording(tooltip?.textContent ?? "", entry);
      dispose();
      target.remove();
    }
  });

  it("leaves identities without provenance exactly as before", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const dispose = render(
      () =>
        createComponent(ModelIdentityLabel, {
          identity: { providerId: "claude-agent", modelId: "opus", effort: "medium" },
        }),
      target,
    );
    expect(target.querySelector(".qg-alias-pricing-trigger")).toBeNull();
    const mark = target.querySelector(".qg-model-identity");
    expect(mark?.textContent).toBe("opus#medium");
    expect(mark?.getAttribute("title")).toBe("claude-agent/opus#medium");
    dispose();
    target.remove();
  });
});
