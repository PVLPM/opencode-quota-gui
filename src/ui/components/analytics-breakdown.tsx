import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupRow,
} from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { formatExactCount, formatTokenCount } from "../format";
import {
  type BreakdownSort,
  disambiguatedIdentityLabel,
  entityKey,
  identityTitle,
  rowSeriesKey,
  seriesColorForKey,
  sortBreakdownRows,
} from "../model-analytics";
import { SegmentedControl, SegmentedControlItem } from "../opencode-ui";
import { formatPath } from "../routing";
import type { SeriesChildSelection, SeriesParentSelection } from "../series-inspection";
import { CostInfo, CostValue, EstimateNote } from "./cost-estimate";
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
 * A row outside the chart's top five maps to Other, but when the server sent
 * that exact hidden parent it selects only that parent's Other slice.
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
  /** Child emphasis shared with the chart, scoped to its parent series. */
  activeChild?: SeriesChildSelection;
  /**
   * Same-dimension hidden parents that Other actually carries. A row outside
   * the chart's top five is only singled out when its exact key is present, so
   * an older snapshot without parent buckets keeps the aggregate behaviour.
   */
  otherParentKeys?: ReadonlySet<string>;
  /** Exact hidden-parent emphasis shared with the chart's Other slices. */
  activeParent?: SeriesParentSelection;
  onPointerSeries?: (key: string | undefined) => void;
  onFocusSeries?: (key: string | undefined) => void;
  onPointerChild?: (selection: SeriesChildSelection | undefined) => void;
  onFocusChild?: (selection: SeriesChildSelection | undefined) => void;
  onPointerParent?: (selection: SeriesParentSelection | undefined) => void;
  onFocusParent?: (selection: SeriesParentSelection | undefined) => void;
  emptyMessage?: string;
}): JSX.Element {
  const rows = createMemo(() => sortBreakdownRows(props.rows, props.sort));
  // Children under Other are an aggregate of several parents, so they cannot
  // truthfully point at one chart slice. Their emphasis stays local; a normal
  // parent shares its child selection with the chart through `props.activeChild`.
  const [localChild, setLocalChild] = createSignal<SeriesChildSelection | undefined>();
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
              // Children are never chart series: provider leaves keep only the
              // neutral identity mark, and model leaves under a provider group
              // have no mark at all.
              const childShowsLogo = childDim === "provider";
              // Other can be subdivided only by the hidden same-dimension
              // parents the server actually sent. Without those keys it stays
              // one aggregate series, exactly as before.
              const canSelectOtherParent = (): boolean =>
                activationKey() === "other" && props.otherParentKeys?.has(rowKey()) === true;
              const otherParentSelection = (): SeriesParentSelection | undefined => {
                if (activationKey() !== "other") return undefined;
                const selection = props.activeParent;
                return selection?.seriesKey === "other" &&
                  props.otherParentKeys?.has(selection.parentKey) === true
                  ? selection
                  : undefined;
              };
              const selectedOtherParent = (): boolean =>
                otherParentSelection()?.parentKey === rowKey();
              const otherParentEmphasis = (): boolean => otherParentSelection() !== undefined;
              const inspectRowPointer = (): void => {
                setLocalChild(undefined);
                if (canSelectOtherParent() && props.onPointerParent !== undefined) {
                  props.onPointerParent({ seriesKey: "other", parentKey: rowKey() });
                  return;
                }
                props.onPointerSeries?.(activationKey());
              };
              const leaveRowPointer = (): void => {
                if (canSelectOtherParent() && props.onPointerParent !== undefined) {
                  props.onPointerParent(undefined);
                  return;
                }
                props.onPointerSeries?.(undefined);
              };
              const inspectRowFocus = (): void => {
                setLocalChild(undefined);
                if (canSelectOtherParent() && props.onFocusParent !== undefined) {
                  props.onFocusParent({ seriesKey: "other", parentKey: rowKey() });
                  return;
                }
                props.onFocusSeries?.(activationKey());
              };
              const leaveRowFocus = (): void => {
                if (canSelectOtherParent() && props.onFocusParent !== undefined) {
                  props.onFocusParent(undefined);
                  return;
                }
                props.onFocusSeries?.(undefined);
              };
              const sharedChild = (): SeriesChildSelection | undefined => {
                const selection = props.activeChild;
                if (selection?.seriesKey !== activationKey()) return undefined;
                return row.children.some(
                  (child) => entityKey(childDim, child.identity) === selection.childKey,
                )
                  ? selection
                  : undefined;
              };
              const localChildForParent = (): SeriesChildSelection | undefined => {
                const selection = localChild();
                if (selection?.seriesKey !== activationKey()) return undefined;
                return row.children.some(
                  (child) => entityKey(childDim, child.identity) === selection.childKey,
                )
                  ? selection
                  : undefined;
              };
              const activeChildForParent = (): SeriesChildSelection | undefined =>
                sharedChild() ?? localChildForParent();
              const childActive = (childKey: string): boolean =>
                activeChildForParent()?.childKey === childKey;
              const parentHasActiveChild = (): boolean => activeChildForParent() !== undefined;
              const inspectChildPointer = (selection: SeriesChildSelection | undefined): void => {
                if (activationKey() !== "other" && props.onPointerChild !== undefined) {
                  props.onPointerChild(selection);
                  return;
                }
                setLocalChild(selection);
              };
              const inspectChildFocus = (selection: SeriesChildSelection | undefined): void => {
                if (activationKey() !== "other" && props.onFocusChild !== undefined) {
                  props.onFocusChild(selection);
                  return;
                }
                setLocalChild(selection);
              };
              const leaveChildPointer = (childKey: string): void => {
                if (activationKey() !== "other" && props.onPointerChild !== undefined) {
                  props.onPointerChild(undefined);
                  return;
                }
                setLocalChild((current) =>
                  current?.seriesKey === activationKey() && current.childKey === childKey
                    ? undefined
                    : current,
                );
              };
              const leaveChildFocus = (childKey: string): void => {
                if (activationKey() !== "other" && props.onFocusChild !== undefined) {
                  props.onFocusChild(undefined);
                  return;
                }
                setLocalChild((current) =>
                  current?.seriesKey === activationKey() && current.childKey === childKey
                    ? undefined
                    : current,
                );
              };
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
                    data-highlighted={
                      parentHasActiveChild()
                        ? undefined
                        : selectedOtherParent()
                          ? "true"
                          : otherParentEmphasis()
                            ? undefined
                            : active(activationKey())
                    }
                    data-dimmed={
                      parentHasActiveChild()
                        ? undefined
                        : selectedOtherParent()
                          ? undefined
                          : otherParentEmphasis()
                            ? "true"
                            : inactive(activationKey())
                    }
                    onPointerEnter={inspectRowPointer}
                    onPointerLeave={leaveRowPointer}
                    onFocus={inspectRowFocus}
                    onBlur={leaveRowFocus}
                  >
                    <span class="qg-breakdown__name">
                      <span
                        class="qg-breakdown__swatch"
                        aria-hidden="true"
                        style={{
                          "--qg-swatch": `var(${seriesColorForKey(activationKey(), props.seriesKeys)})`,
                        }}
                      />
                      <Show when={props.dimension === "provider"}>
                        <ProviderLogo
                          providerId={providerIdFor(row.identity)}
                          class="qg-breakdown__logo"
                        />
                      </Show>
                      <span class="qg-breakdown__label">{label()}</span>
                    </span>
                    <span class="qg-breakdown__cost">
                      <CostValue class="qg-breakdown__costvalue" tokens={row.tokens} />
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
                      {(child) => {
                        const childKey = () => entityKey(childDim, child.identity);
                        const childSelection = (): SeriesChildSelection => ({
                          seriesKey: activationKey(),
                          childKey: childKey(),
                        });
                        return (
                          <a
                            class={
                              childShowsLogo
                                ? "qg-breakdown__row qg-breakdown__row--child"
                                : "qg-breakdown__row qg-breakdown__row--child qg-breakdown__row--plain"
                            }
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
                            data-child-key={childKey()}
                            data-highlighted={
                              childActive(childKey())
                                ? "true"
                                : selectedOtherParent()
                                  ? "true"
                                  : otherParentEmphasis()
                                    ? undefined
                                    : parentHasActiveChild()
                                      ? undefined
                                      : active(activationKey())
                            }
                            data-dimmed={
                              childActive(childKey())
                                ? undefined
                                : selectedOtherParent()
                                  ? undefined
                                  : otherParentEmphasis()
                                    ? "true"
                                    : parentHasActiveChild()
                                      ? "true"
                                      : inactive(activationKey())
                            }
                            onPointerEnter={() => inspectChildPointer(childSelection())}
                            onPointerLeave={() => leaveChildPointer(childKey())}
                            onFocus={() => inspectChildFocus(childSelection())}
                            onBlur={() => leaveChildFocus(childKey())}
                          >
                            <span class="qg-breakdown__name">
                              <Show when={childShowsLogo}>
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
                              <CostValue class="qg-breakdown__costvalue" tokens={child.tokens} />
                              <EstimateNote totals={child.tokens} />
                            </span>
                            <span
                              class="qg-breakdown__tokens"
                              title={`${formatExactCount(child.tokens.total)} tokens`}
                            >
                              {formatTokenCount(child.tokens.total)}
                            </span>
                          </a>
                        );
                      }}
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
