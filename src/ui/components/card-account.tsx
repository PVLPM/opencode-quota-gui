import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { inlineAccountLabel } from "../quota-semantics";

/**
 * The "· plan · account" tail that every card header prints after the provider
 * name. Quota cards and Usage account cards share one identity line, so this is
 * the single implementation of its separator, muted colour and the account
 * label that only disambiguates when it adds information.
 */
export function CardAccountMeta(props: {
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
}): JSX.Element {
  return (
    <>
      <Show when={props.planLabel}>
        {(plan) => (
          <span class="qg-card__account">
            <span aria-hidden="true">· </span>
            {plan()}
          </span>
        )}
      </Show>
      <Show when={props.accountLabel}>
        {(account) => (
          <span class="qg-card__account">
            <span aria-hidden="true">· </span>
            {inlineAccountLabel(props.providerLabel, account())}
          </span>
        )}
      </Show>
    </>
  );
}
