import { readFileSync } from "node:fs";
import path from "node:path";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClaudeAgentAliasPricingProvenance,
  CostedTokens,
  ModelIdentity,
  SessionNode,
  SessionSnapshot,
  StepPoint,
  TokenStack,
} from "../src/contracts/dashboard";
import { NativeModelIdentityLabel } from "../src/native/model-identity";
import {
  modelAliasPricingLines,
  modelAliasPricingSummary,
} from "../src/ui/components/model-alias-pricing";
import { SessionChart } from "../src/ui/components/session-chart";
import { SessionModelStrip } from "../src/ui/components/session-model-strip";

/**
 * The alias pricing disclosure only exists where a real browser keeps it
 * alive: the session header entries. The chart's transient overlay is
 * pointer-events:none and unmounts on blur, so it shows the same summary as
 * plain text instead of nesting an unreachable trigger; the Desktop cache pill
 * has no alias provenance to show at all.
 * `@opencode/ui`'s Tooltip trigger is a `div`, so no phrasing element may
 * contain it; real browsers would reparse that markup.
 */

const ALIAS: ClaudeAgentAliasPricingProvenance = {
  alias: "opus",
  state: "catalog",
  targetProviderId: "anthropic",
  targetModelId: "claude-opus-5-6",
  targetName: "Opus 5.6",
  priced: true,
};
const SUMMARY = modelAliasPricingSummary(ALIAS);

const ALIAS_IDENTITY: ModelIdentity = {
  providerId: "claude-agent",
  modelId: "opus",
  effort: "medium",
  pricingAlias: ALIAS,
};

/** The shared detail body the web tooltip renders for this alias. */
const DETAILS = modelAliasPricingLines(ALIAS_IDENTITY, ALIAS);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tokens(total: number): CostedTokens {
  return {
    input: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

const stack = (input: number): TokenStack => ({
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

function snapshot(steps: StepPoint[]): SessionSnapshot {
  const node: SessionNode = {
    sessionId: "ses_focus",
    title: "Focus session",
    depth: 0,
    childIds: [],
    ownTokens: tokens(1_300),
    subtreeTokens: tokens(1_300),
    stepCount: steps.length,
    subtreeNodeCount: 1,
    latestActivityAtMs: 1_700_000_200_000,
    models: [],
  };
  return {
    focusSessionId: "ses_focus",
    timeZone: "UTC",
    projectId: "proj",
    projectName: "Project",
    breadcrumbs: [{ sessionId: "ses_focus", title: "Focus session", isFocus: true }],
    nodes: [node],
    steps,
    compactionMarkers: [],
    ownSummary: { ...tokens(1_300), stepCount: steps.length },
    treeTotals: tokens(1_300),
    stepSemantics: "Steps are completed assistant messages.",
  };
}

/**
 * Alphabetic tag comparison, so no ancestor of a tooltip trigger is a phrasing
 * element that cannot legally contain `@opencode/ui`'s `div` trigger.
 */
function assertNoPhrasingAncestor(trigger: Element, root: Element): void {
  for (let node = trigger.parentElement; node !== null; node = node.parentElement) {
    expect(["P", "SPAN"]).not.toContain(node.tagName);
    if (node === root) return;
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("session model strip alias surface", () => {
  it("keeps tooltip triggers out of phrasing containers and stays focusable", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const identities: ModelIdentity[] = [
      ALIAS_IDENTITY,
      { providerId: "anthropic", modelId: "sonnet" },
      { providerId: "openai", modelId: "gpt-6.1-terra", effort: "high" },
    ];
    const dispose = render(() => createComponent(SessionModelStrip, { identities }), container);

    const strip = container.querySelector<HTMLElement>(".qg-page-head__models");
    expect(strip?.tagName).toBe("DIV");

    const entries = [...container.querySelectorAll<HTMLElement>(".qg-page-head__models-entry")];
    expect(entries).toHaveLength(identities.length);
    // Inline containers for the inline-flex trigger, not block stack items.
    expect(entries.every((entry) => entry.tagName === "DIV")).toBe(true);
    const measureEntries = [
      ...container.querySelectorAll<HTMLElement>(".qg-page-head__models-measure [data-fit-entry]"),
    ];
    expect(measureEntries).toHaveLength(identities.length);
    expect(measureEntries.every((entry) => entry.tagName === "DIV")).toBe(true);

    const styles = readFileSync(path.resolve("src/ui/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.qg-page-head__models-entry,\s*\.qg-page-head__models-measure \[data-fit-entry\] \{[^}]*display: inline-flex;/s,
    );
    expect(styles).not.toContain(".qg-native-tooltip__bubble.qg-alias-pricing");

    const triggers = [
      ...container.querySelectorAll<HTMLElement>('[data-component="tooltip-v2-trigger"]'),
    ];
    // One per rendered entry plus its measuring twin; both must avoid phrasing
    // containers. The measure strip is `visibility: hidden`, so its copy takes
    // no tab stop in a browser.
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      assertNoPhrasingAncestor(trigger, container);
      expect(trigger.getAttribute("tabindex")).toBe("0");
    }

    const trigger = entries[0]?.querySelector<HTMLElement>('[data-component="tooltip-v2-trigger"]');
    if (trigger == null) throw new Error("visible entry is missing its alias tooltip trigger");
    trigger.focus();
    await flush();
    const id = trigger.getAttribute("aria-describedby");
    if (id === null) throw new Error("alias trigger is missing its described tooltip id");
    const tooltip = document.getElementById(id);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    for (const line of DETAILS) {
      expect(tooltip?.textContent).toContain(line);
    }
    dispose();
    container.remove();
  });
});

describe("session chart alias surface", () => {
  it("carries the summary in aria-valuetext and the overlay, without a trigger", async () => {
    const steps: StepPoint[] = [
      {
        sessionId: "ses_focus",
        messageId: "msg-1",
        atMs: 1_700_000_000_000,
        branch: 0,
        stack: stack(500),
        contextTokens: 500,
        totalTokens: 500,
        model: ALIAS_IDENTITY,
      },
      {
        sessionId: "ses_focus",
        messageId: "msg-2",
        atMs: 1_700_000_100_000,
        branch: 0,
        stack: stack(800),
        contextTokens: 800,
        totalTokens: 800,
        model: { providerId: "claude-agent", modelId: "sonnet", effort: "high" },
      },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(
      () => createComponent(SessionChart, { snapshot: snapshot(steps), variant: "focus" }),
      container,
    );

    const slider = container.querySelector<HTMLElement>('.qg-chart__surface[role="slider"]');
    if (slider === null) throw new Error("chart slider is missing");
    slider.focus();
    await flush();

    expect(slider.getAttribute("aria-valuetext")).toContain(SUMMARY);
    const overlay = container.querySelector<HTMLElement>(".qg-tooltip--session");
    if (overlay === null) throw new Error("session chart overlay is missing after focus");
    expect(overlay.querySelector(".qg-tooltip__alias")?.textContent).toBe(SUMMARY);
    expect(overlay.querySelector(".qg-model-identity")).not.toBeNull();
    // The overlay is transient and pointer-events:none: no trigger may live there.
    expect(overlay.querySelector('[data-component="tooltip-v2-trigger"]')).toBeNull();
    expect(overlay.querySelector(".qg-alias-pricing-trigger")).toBeNull();
    dispose();
    container.remove();
  });
});

describe("desktop cache pill model identity", () => {
  it("renders a plain label because the observer supplies no pricing alias", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(
      () =>
        createComponent(NativeModelIdentityLabel, {
          identity: { providerID: "claude-agent", id: "opus", variant: "medium" },
        }),
      container,
    );
    expect(container.querySelector('[data-component="tooltip-v2-trigger"]')).toBeNull();
    expect(container.querySelector(".qg-alias-pricing-trigger")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
    const mark = container.querySelector<HTMLElement>(".qg-model-identity");
    expect(mark?.textContent).toBe("opus#medium");
    expect(mark?.getAttribute("title")).toBe("claude-agent/opus#medium");
    dispose();
    container.remove();
  });
});
