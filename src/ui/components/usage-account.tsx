import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { CostedTokens } from "../../contracts/dashboard";
import type {
  UsageAccount,
  UsageBreakdownRow,
  UsageModelKey,
  UsageRangeKey,
} from "../../contracts/usage";
import {
  formatElapsed,
  formatExactCount,
  formatModelIdentity,
  formatTokenCount,
  TOKEN_CATEGORIES,
} from "../format";
import { inlineAccountLabel } from "../quota-semantics";
import {
  attributedText,
  coveragePercent,
  effortLabel,
  formatPp,
  type QuotaPercentMode,
  UNATTRIBUTED_REASON_LABELS,
} from "../usage-model";
import { type UsageRunwayHint, usageRunwayKey } from "../usage-runway";
import { CostValue } from "./cost-estimate";
import { ProviderLogo } from "./provider-logo";
import { UsageWindowChart } from "./usage-window-chart";

function categoryLine(tokens: CostedTokens): JSX.Element {
  const categories = TOKEN_CATEGORIES.filter((category) => tokens[category.key] > 0);
  return (
    <Show
      when={categories.length > 0}
      fallback={<span class="qg-usage-breakdown__categories">No recorded tokens</span>}
    >
      <span class="qg-usage-breakdown__categories">
        <For each={categories}>
          {(category) => (
            <span title={formatExactCount(tokens[category.key])}>
              {category.label} {formatTokenCount(tokens[category.key])}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}

function BreakdownModelRow(props: { row: UsageBreakdownRow }): JSX.Element {
  return (
    <details class="qg-usage-breakdown__model">
      <summary>
        <span class="qg-usage-breakdown__model-name">
          {formatModelIdentity({ providerId: props.row.providerId, modelId: props.row.modelId })}
        </span>
        <span class="qg-usage-breakdown__tokens" title={formatExactCount(props.row.tokens.total)}>
          {formatTokenCount(props.row.tokens.total)} tokens
        </span>
        <CostValue tokens={props.row.tokens} class="qg-usage-breakdown__cost" />
        <span class="qg-usage-breakdown__estimate">
          {props.row.estimatedBurnPercentPoints === undefined
            ? "Not attributed"
            : attributedText(props.row.estimatedBurnPercentPoints)}
        </span>
      </summary>
      <div class="qg-usage-breakdown__body">
        <p class="qg-usage-breakdown__meta">
          {formatExactCount(props.row.stepCount)} steps · {categoryLine(props.row.tokens)}
        </p>
        <For each={props.row.efforts}>
          {(effort) => (
            <div class="qg-usage-breakdown__effort">
              <span class="qg-usage-breakdown__effort-name">{effortLabel(effort.effort)}</span>
              <span
                class="qg-usage-breakdown__tokens"
                title={formatExactCount(effort.tokens.total)}
              >
                {formatTokenCount(effort.tokens.total)} tokens
              </span>
              <CostValue tokens={effort.tokens} class="qg-usage-breakdown__cost" />
              <span class="qg-usage-breakdown__estimate">
                {effort.estimatedBurnPercentPoints === undefined
                  ? "Not attributed"
                  : attributedText(effort.estimatedBurnPercentPoints)}
              </span>
              <span class="qg-usage-breakdown__meta">
                {formatExactCount(effort.stepCount)} steps · {categoryLine(effort.tokens)}
              </span>
            </div>
          )}
        </For>
      </div>
    </details>
  );
}

/**
 * One Usage card per account, using the Quota card's compact identity header.
 * Every quota window stacks full-width; one collapsible model-first breakdown
 * lets the reader switch which window's recorded activity it explains.
 */
export function UsageAccountCard(props: {
  account: UsageAccount;
  models: UsageModelKey[];
  mode: QuotaPercentMode;
  timeZone: string;
  range: UsageRangeKey;
  nowMs: number;
  runwayIndex?: ReadonlyMap<string, UsageRunwayHint>;
  index: number;
  /** The view's single caveat trigger, seated in the first card's header. */
  info?: JSX.Element;
}): JSX.Element {
  const [selectedRowId, setSelectedRowId] = createSignal<string>();
  const windows = () => props.account.windows;
  const selectedWindow = () =>
    windows().find((window) => window.rowId === selectedRowId()) ?? windows()[0];
  const selectId = () => `qg-usage-breakdown-window-${props.index}`;
  const titleId = () => `qg-usage-account-${props.index}`;
  const reasons = createMemo(() => {
    const unique = new Set<string>();
    for (const interval of selectedWindow()?.intervals ?? []) {
      if (interval.unattributedReason !== undefined) {
        unique.add(UNATTRIBUTED_REASON_LABELS[interval.unattributedReason]);
      }
    }
    return [...unique];
  });
  const runwayFor = (rowId: string): UsageRunwayHint | undefined =>
    props.runwayIndex?.get(usageRunwayKey(props.account.accountKey, rowId));

  return (
    <article class="qg-card qg-usage-account" aria-labelledby={titleId()}>
      <header class="qg-card__head">
        <div class="qg-card__identity">
          <ProviderLogo providerId={props.account.providerId} class="qg-card__logo" />
          <h2 class="qg-card__provider qg-usage-account__title" id={titleId()}>
            {props.account.providerLabel}
          </h2>
          <Show when={props.account.planLabel}>
            {(plan) => (
              <span class="qg-card__account">
                <span aria-hidden="true">· </span>
                {plan()}
              </span>
            )}
          </Show>
          <Show when={props.account.accountLabel}>
            {(account) => (
              <span class="qg-card__account">
                <span aria-hidden="true">· </span>
                {inlineAccountLabel(props.account.providerLabel, account())}
              </span>
            )}
          </Show>
        </div>
        <Show when={props.info}>{props.info}</Show>
      </header>

      <Show
        when={windows().length > 0}
        fallback={
          <p class="qg-usage-account__empty">
            No quota windows have been observed for this account yet.
          </p>
        }
      >
        <div class="qg-usage-account__windows">
          <For each={windows()}>
            {(window, index) => (
              <UsageWindowChart
                window={window}
                models={props.models}
                accountLabel={props.account.accountLabel ?? props.account.providerLabel}
                mode={props.mode}
                timeZone={props.timeZone}
                range={props.range}
                nowMs={props.nowMs}
                runway={runwayFor(window.rowId)}
                headingId={`qg-usage-window-${props.index}-${index()}`}
              />
            )}
          </For>
        </div>

        <Show when={selectedWindow()}>
          {(window) => (
            <details class="qg-usage-breakdown">
              <summary>Model breakdown</summary>
              <div class="qg-usage-breakdown__content">
                <div class="qg-usage-breakdown__controls">
                  <label for={selectId()}>Window</label>
                  <select
                    id={selectId()}
                    class="qg-input qg-usage-breakdown__select"
                    value={window().rowId}
                    onChange={(event) => setSelectedRowId(event.currentTarget.value)}
                  >
                    <For each={windows()}>
                      {(entry) => <option value={entry.rowId}>{entry.label}</option>}
                    </For>
                  </select>
                  <span class="qg-usage-breakdown__coverage">
                    {coveragePercent(window()).toFixed(0)}% observed ·{" "}
                    {formatElapsed(window().coverage.observedMs)} ·{" "}
                    {formatExactCount(window().coverage.sampleCount)} samples
                  </span>
                </div>

                <For each={window().breakdown}>{(row) => <BreakdownModelRow row={row} />}</For>
                <Show when={window().breakdown.length === 0}>
                  <p class="qg-usage-account__empty">
                    No recorded model activity is attributed to this window.
                  </p>
                </Show>

                <div class="qg-usage-breakdown__unattributed">
                  <span class="qg-usage-breakdown__model-name">Unattributed</span>
                  <span class="qg-usage-breakdown__tokens">
                    {formatPp(window().totals.unattributedBurnPercentPoints)}
                  </span>
                  <span class="qg-usage-breakdown__reason">
                    {reasons().length > 0 ? reasons().join(" · ") : "No unassigned observed change"}
                  </span>
                </div>
              </div>
            </details>
          )}
        </Show>
      </Show>
    </article>
  );
}
