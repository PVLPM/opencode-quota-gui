import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { CostedTokens } from "../../contracts/dashboard";
import { API_EQUIVALENT_TOOLTIP, estimateNote, estimateNoteTitle } from "../model-analytics";
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

/** Visible qualification: no colour-only signal, and no note for an empty total. */
export function EstimateNote(props: {
  totals: Pick<CostedTokens, "total" | "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">;
}): JSX.Element {
  return (
    <Show when={estimateNote(props.totals)}>
      {(note) => (
        <span class="qg-partial" title={estimateNoteTitle(props.totals)}>
          {note()}
        </span>
      )}
    </Show>
  );
}
