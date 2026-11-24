import type { JSX } from "solid-js";
import { Show } from "solid-js";
import {
  API_EQUIVALENT_TOOLTIP,
  type CostBearingTokens,
  costValueTitle,
  estimateNote,
  estimateNoteTitle,
  formatCostText,
} from "../model-analytics";
import { Icon, Tooltip } from "../opencode-ui";

/**
 * One exact explanation for the API-equivalent estimate, shared by the
 * Models family. The extra exclusion counts live in the note's title instead
 * of changing this required sentence.
 */
export function CostInfo(): JSX.Element {
  return (
    <Tooltip
      value={API_EQUIVALENT_TOOLTIP}
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-row__tooltip"
    >
      <span class="sr-only">About the API-equivalent estimate</span>
      <span class="qg-row__info" aria-hidden="true">
        <Icon name="info" size="small" />
      </span>
    </Tooltip>
  );
}

/**
 * Models-family cost value. `Free` is reserved for a wholly zero-priced total;
 * `Unpriced` remains the single visible word for usage with no priced tokens.
 * An empty total shows an em dash rather than a currency claim.
 */
export function CostValue(props: { tokens: CostBearingTokens; class?: string }): JSX.Element {
  const unpriced = () => props.tokens.total > 0 && props.tokens.apiEquivalentCostUsd === null;
  return (
    <span
      class={props.class}
      data-cost-status={unpriced() ? "unpriced" : undefined}
      title={costValueTitle(props.tokens)}
    >
      {formatCostText(props.tokens)}
    </span>
  );
}

/** Visible qualification: no colour-only signal, and no note for an empty total. */
export function EstimateNote(props: {
  totals: CostBearingTokens;
  /** Set false when a separate estimate affordance already explains exclusions. */
  showExclusionTitle?: boolean;
}): JSX.Element {
  return (
    <Show when={estimateNote(props.totals) === "Partial estimate"}>
      <span
        class="qg-partial"
        title={props.showExclusionTitle === false ? undefined : estimateNoteTitle(props.totals)}
      >
        Partial estimate
      </span>
    </Show>
  );
}
