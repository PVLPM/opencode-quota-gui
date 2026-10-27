import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { CostedTokens } from "../../contracts/dashboard";
import { formatApiEquivalentCostText } from "../format";
import {
  API_EQUIVALENT_TOOLTIP,
  estimateNote,
  estimateNoteTitle,
  exactCostTitle,
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
 * Models-family cost value. `Unpriced` is the single visible word for a total
 * with usage but no priced tokens, so it is never mistaken for `≈ USD 0.00`.
 * An empty total shows an em dash rather than a currency claim.
 */
export function CostValue(props: {
  tokens: Pick<CostedTokens, "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">;
  class?: string;
}): JSX.Element {
  const unpriced = () => props.tokens.total > 0 && props.tokens.apiEquivalentCostUsd === null;
  const title = () =>
    unpriced()
      ? estimateNoteTitle(props.tokens)
      : props.tokens.total > 0
        ? exactCostTitle(props.tokens)
        : "No usage in this total.";
  return (
    <span
      class={props.class}
      data-cost-status={unpriced() ? "unpriced" : undefined}
      title={title()}
    >
      {formatApiEquivalentCostText(props.tokens.apiEquivalentCostUsd, props.tokens.total)}
    </span>
  );
}

/** Visible qualification: no colour-only signal, and no note for an empty total. */
export function EstimateNote(props: {
  totals: Pick<CostedTokens, "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">;
}): JSX.Element {
  return (
    <Show when={estimateNote(props.totals) === "Partial estimate"}>
      <span class="qg-partial" title={estimateNoteTitle(props.totals)}>
        Partial estimate
      </span>
    </Show>
  );
}
