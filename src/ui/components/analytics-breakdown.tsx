import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupRow,
} from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { formatApiEquivalentCost, formatExactCount, formatTokenCount } from "../format";
import {
  type BreakdownSort,
  disambiguatedIdentityLabel,
  entityKey,
  exactCostTitle,
  identityTitle,
  rowSeriesKey,
  seriesColorForKey,
  sortBreakdownRows,
} from "../model-analytics";
import { SegmentedControl, SegmentedControlItem } from "../opencode-ui";
import { formatPath } from "../routing";
import { CostInfo, EstimateNote } from "./cost-estimate";
import { ProviderLogo } from "./provider-logo";
import { EmptyNotice } from "./states";

/** Unknown and empty identities share the local generic mark, never no mark. */
function providerIdFor(identity: AnalyticsEntityIdentity): string {
  return identity.kind === "known" ? identity.id : "";
}

/**
 * The Models breakdown: exactly Name, Cost, Tokens.
 *
 * Cost | Tokens reorders each hierarchy level only. Parent rows are ranked
 * globally; children are always rendered, including a singleton, sorted within
 * their own parent. Links carry the exact tagged identity and current range.
 */
export function AnalyticsBreakdown(props: {
  headingId: string;
  rows: readonly AnalyticsGroupRow[];
  dimension: AnalyticsDimension;
  range: RangeKey;
  sort: BreakdownSort;
  onSortChange: (sort: BreakdownSort) => void;
  showChildren?: boolean;
  /** Chart series keys, so rows outside the top five emphasize Other. */
  seriesKeys?: readonly string[];
  /** Models grouping to restore if this row opens a detail page. */
  modelsGroup?: AnalyticsDimension;
  activeSeries?: string;
  onPointerSeries?: (key: string | undefined) => void;
  onFocusSeries?: (key: string | undefined) => void;
  emptyMessage?: string;
}): JSX.Element {
  const rows = createMemo(() => sortBreakdownRows(props.rows, props.sort));
  const activeKey = () => props.activeSeries;
  const inactive = (key: string): string | undefined =>
    activeKey() === undefined ? undefined : activeKey() === key ? undefined : "true";
  const active = (key: string): string | undefined =>
    activeKey() !== undefined && activeKey() === key ? "true" : undefined;

  return (
    <section class="qg-section" aria-labelledby={props.headingId}>
      <header class="qg-section__head">
        <h2 class="qg-section__title" id={props.headingId}>
          Breakdown
        </h2>
        <SegmentedControl
          class="qg-sort"
          aria-label="Sort breakdown"
          value={props.sort}
          onChange={(value) => {
            if (value === "cost" || value === "tokens") props.onSortChange(value);
          }}
        >
          <SegmentedControlItem value="cost">Cost</SegmentedControlItem>
          <SegmentedControlItem value="tokens">Tokens</SegmentedControlItem>
        </SegmentedControl>
      </header>
      <Show
        when={rows().length > 0}
        fallback={<EmptyNotice message={props.emptyMessage ?? "No usage in this range."} />}
      >
        <div class="qg-breakdown">
          <div class="qg-breakdown__head">
            <span>Name</span>
            <span class="qg-breakdown__costhead">
              Cost
              <CostInfo />
            </span>
            <span>Tokens</span>
          </div>
          <For each={rows()}>
            {(row) => {
              const rowKey = () => entityKey(props.dimension, row.identity);
              const activationKey = () =>
                rowSeriesKey(props.dimension, row.identity, props.seriesKeys);
              const peers = () => props.rows.map((peer) => peer.identity);
              const label = () =>
                disambiguatedIdentityLabel(row.identity, props.dimension, peers());
              const children = () => sortBreakdownRows(row.children, props.sort);
              const childPeers = () => row.children.map((child) => child.identity);
              const childDim: AnalyticsDimension =
                props.dimension === "model" ? "provider" : "model";
              return (
                <div class="qg-breakdown__group" data-series-key={rowKey()}>
                  <a
                    class="qg-breakdown__row"
                    href={formatPath(
                      props.dimension === "model"
                        ? {
                            name: "model",
                            identity: row.identity,
                            modelsGroup: props.modelsGroup,
                          }
                        : {
                            name: "provider",
                            identity: row.identity,
                            modelsGroup: props.modelsGroup,
                          },
                      props.range,
                    )}
                    title={identityTitle(row.identity, props.dimension)}
                    data-highlighted={active(activationKey())}
                    data-dimmed={inactive(activationKey())}
                    onPointerEnter={() => props.onPointerSeries?.(activationKey())}
                    onPointerLeave={() => props.onPointerSeries?.(undefined)}
                    onFocus={() => props.onFocusSeries?.(activationKey())}
                    onBlur={() => props.onFocusSeries?.(undefined)}
                  >
                    <span class="qg-breakdown__name">
                      <Show when={props.dimension === "provider"}>
                        <span
                          class="qg-breakdown__swatch"
                          aria-hidden="true"
                          style={{
                            "--qg-swatch": `var(${seriesColorForKey(activationKey(), props.seriesKeys)})`,
                          }}
                        />
                        <ProviderLogo
                          providerId={providerIdFor(row.identity)}
                          class="qg-breakdown__logo"
                        />
                      </Show>
                      <span class="qg-breakdown__label">{label()}</span>
                    </span>
                    <span class="qg-breakdown__cost">
                      <span class="qg-breakdown__costvalue" title={exactCostTitle(row.tokens)}>
                        {formatApiEquivalentCost(row.tokens.apiEquivalentCostUsd)}
                      </span>
                      <EstimateNote totals={row.tokens} />
                    </span>
                    <span
                      class="qg-breakdown__tokens"
                      title={`${formatExactCount(row.tokens.total)} tokens`}
                    >
                      {formatTokenCount(row.tokens.total)}
                    </span>
                  </a>
                  <Show when={props.showChildren !== false}>
                    <For each={children()}>
                      {(child) => (
                        <a
                          class="qg-breakdown__row qg-breakdown__row--child"
                          href={formatPath(
                            childDim === "model"
                              ? {
                                  name: "model",
                                  identity: child.identity,
                                  modelsGroup: props.modelsGroup,
                                }
                              : {
                                  name: "provider",
                                  identity: child.identity,
                                  modelsGroup: props.modelsGroup,
                                },
                            props.range,
                          )}
                          title={identityTitle(child.identity, childDim)}
                          data-dimmed={inactive(activationKey())}
                        >
                          <span class="qg-breakdown__name">
                            <Show when={childDim === "provider"}>
                              <span
                                class="qg-breakdown__swatch"
                                aria-hidden="true"
                                style={{
                                  "--qg-swatch": `var(${seriesColorForKey(activationKey(), props.seriesKeys)})`,
                                }}
                              />
                              <ProviderLogo
                                providerId={providerIdFor(child.identity)}
                                class="qg-breakdown__logo"
                              />
                            </Show>
                            <span class="qg-breakdown__label">
                              {disambiguatedIdentityLabel(child.identity, childDim, childPeers())}
                            </span>
                          </span>
                          <span class="qg-breakdown__cost">
                            <span
                              class="qg-breakdown__costvalue"
                              title={exactCostTitle(child.tokens)}
                            >
                              {formatApiEquivalentCost(child.tokens.apiEquivalentCostUsd)}
                            </span>
                            <EstimateNote totals={child.tokens} />
                          </span>
                          <span
                            class="qg-breakdown__tokens"
                            title={`${formatExactCount(child.tokens.total)} tokens`}
                          >
                            {formatTokenCount(child.tokens.total)}
                          </span>
                        </a>
                      )}
                    </For>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
