import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { UsageImportedActivity } from "../../contracts/usage";
import {
  formatExactCount,
  formatModelIdentity,
  formatTimestampMinutes,
  formatTokenCount,
} from "../format";
import { effortLabel, harnessLabel } from "../usage-model";
import { CostValue } from "./cost-estimate";

/**
 * Imported harness activity is recorded evidence only: it is never merged into
 * quota attribution weights and never appears inside a quota-window interval.
 * The header stays as quiet as an account card; the full qualification is its
 * accessible name.
 */
export function UsageImportedSection(props: {
  activity: UsageImportedActivity;
  timeZone: string;
}): JSX.Element {
  const title = (): string =>
    `Imported from ${harnessLabel(props.activity.harness)} — recorded activity, not attributed to quota`;

  return (
    <section class="qg-card qg-usage-imported" aria-label={title()}>
      <header class="qg-card__head">
        <div class="qg-card__identity">
          <h2 class="qg-card__provider">{harnessLabel(props.activity.harness)}</h2>
          <span class="qg-card__account">imported</span>
        </div>
      </header>

      <p class="qg-usage-view__note">
        {formatExactCount(props.activity.stepCount)} steps ·{" "}
        {formatTokenCount(props.activity.totals.total)} tokens ·{" "}
        <CostValue tokens={props.activity.totals} /> API-equivalent
        <Show when={props.activity.incomplete}>
          <span title="Some tokens are unpriced, so the total is partial"> · partial</span>
        </Show>
      </p>

      <For each={props.activity.models}>
        {(model) => (
          <details class="qg-usage-breakdown__model">
            <summary>
              <span class="qg-usage-breakdown__model-name">{formatModelIdentity(model)}</span>
              <span class="qg-usage-breakdown__tokens" title={formatExactCount(model.tokens.total)}>
                {formatTokenCount(model.tokens.total)} tokens
              </span>
              <CostValue tokens={model.tokens} class="qg-usage-breakdown__cost" />
            </summary>
            <div class="qg-usage-breakdown__body">
              <p class="qg-usage-breakdown__meta">{formatExactCount(model.stepCount)} steps</p>
              <For each={model.efforts}>
                {(effort) => (
                  <div class="qg-usage-breakdown__effort">
                    <span class="qg-usage-breakdown__effort-name">
                      {effortLabel(effort.effort)}
                    </span>
                    <span
                      class="qg-usage-breakdown__tokens"
                      title={formatExactCount(effort.tokens.total)}
                    >
                      {formatTokenCount(effort.tokens.total)} tokens
                    </span>
                    <CostValue tokens={effort.tokens} class="qg-usage-breakdown__cost" />
                    <span class="qg-usage-breakdown__meta">
                      {formatExactCount(effort.stepCount)} steps
                    </span>
                  </div>
                )}
              </For>
            </div>
          </details>
        )}
      </For>

      <Show when={props.activity.models.length === 0}>
        <p class="qg-usage-account__empty">No imported token activity in this range.</p>
      </Show>
    </section>
  );
}
