import type { JSX } from "solid-js";
import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsGroupSnapshot,
  AnalyticsSeries,
  CostedTokens,
} from "../../contracts/dashboard";
import { createChartInspection } from "../chart-inspection";
import { createChartLayout } from "../chart-layout";
import {
  axisRangeCaption,
  formatApiEquivalentCostTick,
  formatBucketEnd,
  formatBucketRange,
  formatBucketTick,
  formatExactCount,
  formatTokenCount,
} from "../format";
import {
  combineEstimates,
  costValueTitle,
  disambiguatedIdentityLabel,
  entityKey,
  estimateNote,
  estimateNoteTitle,
  formatCostText,
  oppositeDimension,
  rankSeries,
  seriesColorVar,
  seriesKey,
} from "../model-analytics";
import {
  buildChildCompositionSlices,
  buildParentCompositionSlices,
  type CompositionSlice,
} from "../model-chart-composition";
import { buildModelChartGeometry, DEFAULT_MODEL_USAGE_SIZE } from "../model-chart-geometry";
import { buildModelCostOverlayGeometry } from "../model-cost-overlay";
import type { SeriesChildSelection, SeriesParentSelection } from "../series-inspection";
import { createChartTooltipLayout } from "../tooltip-layout";
import { ChartShell } from "./chart-shell";
import { EstimateNote } from "./cost-estimate";
import { ProviderLogo } from "./provider-logo";
import { EmptyNotice, ErrorCard, Skeleton } from "./states";

/**
 * Grouped model/provider token chart.
 *
 * One stacked bar per range bucket; each segment is one ranked series. The
 * series order is token-only and always independent of the breakdown's sort.
 * A thin API-equivalent cost line shares the bucket slots on a right axis, with
 * unpriced buckets left as gaps. The line is always the bucket total across all
 * visible series; legend hover/focus emphasizes the bars and rows and quiets
 * the line's stroke so a small highlighted bar stays legible. While a parent
 * series is active, its buckets subdivide into opposite-dimension children in
 * the parent's own colour; Other instead reveals its exact hidden
 * same-dimension parents from the server's sparse parent buckets. The parent
 * envelope never moves. The
 * legend reuses the daily token-usage legend: native toggle buttons with a
 * swatch, label and metric, and a visible focus ring. Emphasis uses opacity
 * so it never depends on colour alone.
 */
export function ModelUsageChart(props: {
  snapshot?: AnalyticsGroupSnapshot;
  title: string;
  headingId: string;
  summary?: JSX.Element;
  actions?: JSX.Element;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  activeSeries?: string;
  /** Transient child emphasis that follows the active parent series. */
  activeChild?: SeriesChildSelection;
  /** Exact hidden same-dimension parent inside Other, shared with its rows. */
  activeParent?: SeriesParentSelection;
  /** Legend entry pinned by click; hover/focus still take precedence. */
  pinnedSeries?: string;
  onPointerSeries?: (key: string | undefined) => void;
  onFocusSeries?: (key: string | undefined) => void;
  onTogglePinnedSeries?: (key: string) => void;
  onClearPinnedSeries?: () => void;
}): JSX.Element {
  const ranked = createMemo(() => {
    const snapshot = props.snapshot;
    return snapshot === undefined ? [] : rankSeries(snapshot.series);
  });
  const dimension = (): AnalyticsDimension => props.snapshot?.dimension ?? "model";
  const buckets = () => props.snapshot?.buckets ?? [];
  const inspection = createChartInspection();
  const activeBucket = inspection.active;
  const { size, ref } = createChartLayout(DEFAULT_MODEL_USAGE_SIZE);
  const geometry = createMemo(() => buildModelChartGeometry(ranked(), buckets(), size));
  // The cost line is always the visible bucket total, never narrowed by legend
  // hover/focus; the popup remains the place to inspect per-series cost.
  const costOverlay = createMemo(() =>
    buildModelCostOverlayGeometry(ranked(), buckets(), geometry()),
  );
  const tooltipLayout = createChartTooltipLayout(
    () => {
      const index = activeBucket();
      return index === undefined ? 0 : (geometry().slotX(index) + geometry().slot / 2) / size.width;
    },
    () => geometry().barWidth / 2 + 12,
  );
  const timeZone = () => props.snapshot?.timeZone ?? "UTC";
  const bucketUnit = () => props.snapshot?.bucketUnit ?? "hour";
  const activatePointer = (key: string | undefined): void => props.onPointerSeries?.(key);
  const activateFocus = (key: string | undefined): void => props.onFocusSeries?.(key);
  const activeKey = () => props.activeSeries;
  let legendElement: HTMLUListElement | undefined;
  onMount(() => {
    if (typeof document === "undefined") return;
    const onDocumentClick = (event: MouseEvent) => {
      if (props.pinnedSeries === undefined) return;
      const target = event.target;
      if (target instanceof Node && legendElement?.contains(target)) return;
      props.onClearPinnedSeries?.();
    };
    document.addEventListener("click", onDocumentClick);
    onCleanup(() => document.removeEventListener("click", onDocumentClick));
  });
  const errorMessage = () => (props.loading === true ? undefined : props.error);
  const highlighted = (key: string): string | undefined =>
    activeKey() === undefined ? undefined : activeKey() === key ? "true" : "false";
  /**
   * Known and unknown provider entity series both carry a mark. Unknown and
   * empty ids pass "" so ProviderLogo resolves the shared local generic mark;
   * the chart-only Other series has no provider identity and no mark.
   */
  const providerMarkId = (entry: AnalyticsSeries): string | undefined =>
    entry.kind === "entity"
      ? entry.identity.kind === "known"
        ? entry.identity.id
        : ""
      : undefined;
  const entityPeers = () =>
    ranked().flatMap((entry) => (entry.kind === "entity" ? [entry.identity] : []));
  const labelFor = (entry: AnalyticsSeries): string =>
    entry.kind === "other"
      ? "Other"
      : disambiguatedIdentityLabel(entry.identity, dimension(), entityPeers());

  const activeChildSelection = createMemo((): SeriesChildSelection | undefined => {
    const key = activeKey();
    const selection = props.activeChild;
    if (key === undefined || selection?.seriesKey !== key) return undefined;
    const entry = ranked().find((candidate) => seriesKey(candidate, dimension()) === key);
    const childDimension = oppositeDimension(dimension());
    const exists = entry?.childBuckets?.some((bucket) =>
      bucket.some((child) => entityKey(childDimension, child.identity) === selection.childKey),
    );
    return exists === true ? selection : undefined;
  });
  const activeParentSelection = createMemo((): SeriesParentSelection | undefined => {
    const key = activeKey();
    const selection = props.activeParent;
    if (key === undefined || selection?.seriesKey !== key) return undefined;
    const entry = ranked().find((candidate) => seriesKey(candidate, dimension()) === key);
    if (entry?.kind !== "other") return undefined;
    const exists = entry.parentBuckets?.some((bucket) =>
      bucket.some((parent) => entityKey(dimension(), parent.identity) === selection.parentKey),
    );
    return exists === true ? selection : undefined;
  });
  const childEmphasis = (): string | undefined =>
    activeChildSelection() === undefined ? undefined : "true";
  const parentEmphasis = (): string | undefined =>
    activeParentSelection() === undefined ? undefined : "true";

  const bucketEntries = (index: number) =>
    ranked()
      .map((entry, seriesIndex) => {
        const tokens = entry.buckets[index];
        const partial = tokens !== undefined && estimateNote(tokens) === "Partial estimate";
        return {
          entry,
          seriesIndex,
          key: seriesKey(entry, dimension()),
          label: labelFor(entry),
          tokens,
          total: tokens?.total ?? 0,
          cost: tokens?.apiEquivalentCostUsd ?? null,
          partial,
          costTitle:
            tokens === undefined
              ? "No usage in this bucket."
              : tokens.apiEquivalentCostUsd === null || partial
                ? estimateNoteTitle(tokens)
                : costValueTitle(tokens),
        };
      })
      .filter((row) => row.total > 0);

  const bucketEstimate = (index: number) => {
    const tokens = ranked()
      .map((entry) => entry.buckets[index])
      .filter((entry): entry is CostedTokens => entry !== undefined);
    return combineEstimates(tokens);
  };

  const activeBoundary = () => {
    const index = activeBucket();
    return index === undefined ? undefined : buckets()[index];
  };

  const bucketRange = (index: number): string => {
    const boundary = buckets()[index];
    return formatBucketRange(
      boundary?.startMs ?? 0,
      boundary?.endMs ?? 0,
      bucketUnit(),
      timeZone(),
      " to ",
    );
  };

  const bucketLabel = (index: number): string => {
    const estimate = bucketEstimate(index);
    const parts = bucketEntries(index).map(
      (row) => `${row.label} ${formatExactCount(row.total)} tokens, ${formatCostText(row.tokens)}`,
    );
    return [
      bucketRange(index),
      `total ${formatExactCount(estimate.total)} tokens`,
      ...parts,
      `API-equivalent total ${formatCostText(estimate)}`,
      estimateNote(estimate) === "Partial estimate" ? "Partial estimate" : "",
    ]
      .filter((part) => part.length > 0)
      .join(", ");
  };
  const rangeEndCaption = (): string | undefined => {
    const all = buckets();
    const last = all.at(-1);
    if (!last) return undefined;
    return axisRangeCaption(
      formatBucketEnd(last.startMs, last.endMs, bucketUnit(), timeZone()),
      all.length,
      geometry().labelIndexes,
    );
  };

  return (
    <ChartShell
      title={props.title}
      headingId={props.headingId}
      actions={props.actions}
      summary={props.summary}
      bodyClass="qg-usage qg-model-chart"
      aside={
        <Show when={ranked().length > 0}>
          <ul
            class="qg-legend"
            aria-label={`${dimension()} series`}
            ref={(element) => {
              legendElement = element;
            }}
          >
            <For each={ranked()}>
              {(entry, index) => {
                const key = () => seriesKey(entry, dimension());
                const label = () => labelFor(entry);
                return (
                  <li class="qg-legend__entry">
                    <button
                      type="button"
                      class="qg-legend__item"
                      data-series-key={key()}
                      data-active={activeKey() === key() ? "true" : undefined}
                      data-pinned={props.pinnedSeries === key() ? "true" : undefined}
                      data-pinnable="true"
                      aria-label={`Highlight ${label()}, ${formatExactCount(entry.tokens.total)} tokens`}
                      aria-pressed={props.pinnedSeries === key() ? "true" : "false"}
                      style={{ "--qg-swatch": `var(${seriesColorVar(index(), entry.kind)})` }}
                      title={
                        entry.kind === "other"
                          ? "Every entity outside the top five, combined exactly; usage and known cost are never dropped."
                          : undefined
                      }
                      onPointerEnter={() => activatePointer(key())}
                      onPointerLeave={() => activatePointer(undefined)}
                      onFocus={() => activateFocus(key())}
                      onBlur={() => activateFocus(undefined)}
                      onClick={() => props.onTogglePinnedSeries?.(key())}
                    >
                      <span class="qg-legend__swatch" aria-hidden="true" />
                      <Show
                        when={dimension() === "provider" && providerMarkId(entry) !== undefined}
                      >
                        <ProviderLogo
                          providerId={providerMarkId(entry) ?? ""}
                          class="qg-legend__logo"
                        />
                      </Show>
                      <Show when={dimension() === "provider" && entry.kind === "other"}>
                        <span class="qg-legend__logo qg-legend__logo--empty" aria-hidden="true" />
                      </Show>
                      <span class="qg-legend__label qg-breakable">{label()}</span>
                      <span class="qg-legend__value">{formatTokenCount(entry.tokens.total)}</span>
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      }
    >
      <Show
        when={props.snapshot}
        fallback={
          <Show
            when={errorMessage()}
            fallback={<Skeleton label={props.loading ? "Loading models" : "Loading usage"} />}
          >
            {(message) => (
              <ErrorCard message={message()} retryable onRetry={() => props.onRetry?.()} />
            )}
          </Show>
        }
      >
        <Show
          when={ranked().length > 0 && buckets().length > 0}
          fallback={<EmptyNotice message="No activity in this range." />}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the plot click only dismisses a pinned legend selection; contained controls carry the actions. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: dismissal is pointer-only; keyboard users can clear the pin from the legend. */}
          <div
            ref={(element) => {
              ref(element);
              tooltipLayout.chartRef(element);
            }}
            class="qg-chart qg-model-chart__plot"
            data-highlight={activeKey() === undefined ? undefined : "true"}
            data-child-highlight={childEmphasis()}
            data-parent-highlight={parentEmphasis()}
            onClick={() => props.onClearPinnedSeries?.()}
          >
            <svg
              viewBox={`0 0 ${size.width} ${size.height}`}
              role="img"
              aria-label={`${props.title}. Stacked token usage by ${dimension()}, with API-equivalent cost on the right axis.`}
            >
              <For each={geometry().ticks}>
                {(tick) => (
                  <>
                    <line
                      class="qg-chart__grid-line"
                      x1={geometry().plot.left}
                      x2={geometry().plot.right}
                      y1={tick.y}
                      y2={tick.y}
                    />
                    <text
                      class="qg-chart__axis-label"
                      x={geometry().plot.left - 8}
                      y={tick.y + 3}
                      text-anchor="end"
                    >
                      {formatTokenCount(tick.value)}
                    </text>
                  </>
                )}
              </For>
              <text
                class="qg-chart__axis-title"
                x={geometry().plot.left}
                y={geometry().plot.top - 6}
                text-anchor="start"
              >
                TOKEN USAGE
              </text>

              <Show when={costOverlay().hasNumeric}>
                <text
                  class="qg-chart__axis-title qg-chart__axis-title--cost"
                  x={geometry().plot.right}
                  y={geometry().plot.top - 6}
                  text-anchor="end"
                >
                  API-EQUIVALENT ($)
                </text>
                <For each={costOverlay().ticks}>
                  {(tick) => (
                    <>
                      <line
                        class="qg-chart__tick-mark"
                        x1={geometry().plot.right}
                        x2={geometry().plot.right + 4}
                        y1={tick.y}
                        y2={tick.y}
                      />
                      <text
                        class="qg-chart__axis-label qg-chart__axis-label--cost"
                        x={geometry().plot.right + 8}
                        y={tick.y + 3}
                        text-anchor="start"
                      >
                        {formatApiEquivalentCostTick(tick.value, costOverlay().tickStep)}
                      </text>
                    </>
                  )}
                </For>
              </Show>

              <For each={geometry().bars}>
                {(bar) => (
                  <For each={bar.segments}>
                    {(segment) => {
                      const entry = (): AnalyticsSeries | undefined =>
                        ranked()[segment.seriesIndex];
                      const key = (): string =>
                        entry() === undefined
                          ? "other"
                          : seriesKey(entry() as AnalyticsSeries, dimension());
                      const composition = createMemo(
                        (): {
                          kind: "child" | "parent";
                          slices: CompositionSlice[];
                          selectedKey?: string;
                          envelopeEmphasis?: string;
                        } => {
                          const parent = entry();
                          if (parent === undefined || activeKey() !== key()) {
                            return { kind: "child", slices: [] };
                          }
                          // New snapshots carry exact hidden parents for Other;
                          // an older snapshot without them keeps the previous
                          // opposite-dimension child composition.
                          if (parent.kind === "other" && parent.parentBuckets !== undefined) {
                            const selection = activeParentSelection();
                            const parents = parent.parentBuckets[segment.bucketIndex];
                            const slices = buildParentCompositionSlices({
                              segment,
                              parentTokens: parent.buckets[segment.bucketIndex],
                              parents,
                              dimension: dimension(),
                            });
                            const selectedKey =
                              selection !== undefined && selection.seriesKey === key()
                                ? selection.parentKey
                                : undefined;
                            // A sole parent cannot be subdivided into slices, so
                            // emphasize its envelope instead. If several parents
                            // exist but cannot be sliced, never leave the whole
                            // aggregate looking like the exact match.
                            const soleKey =
                              parents !== undefined &&
                              parents.length === 1 &&
                              parents[0] !== undefined
                                ? entityKey(dimension(), parents[0].identity)
                                : undefined;
                            const envelopeEmphasis =
                              selectedKey !== undefined && slices.length === 0
                                ? soleKey === selectedKey
                                  ? "true"
                                  : "false"
                                : undefined;
                            return {
                              kind: "parent",
                              slices,
                              selectedKey,
                              envelopeEmphasis,
                            };
                          }
                          const selection = activeChildSelection();
                          return {
                            kind: "child",
                            slices: buildChildCompositionSlices({
                              segment,
                              parentTokens: parent.buckets[segment.bucketIndex],
                              children: parent.childBuckets?.[segment.bucketIndex],
                              dimension: dimension(),
                            }),
                            selectedKey:
                              selection !== undefined && selection.seriesKey === key()
                                ? selection.childKey
                                : undefined,
                          };
                        },
                      );
                      const slices = (): CompositionSlice[] => composition().slices;
                      const selectedSliceKey = (): string | undefined => composition().selectedKey;
                      return (
                        <>
                          <rect
                            class="qg-chart__segment"
                            data-series-key={key()}
                            data-bucket-index={segment.bucketIndex}
                            data-highlighted={composition().envelopeEmphasis ?? highlighted(key())}
                            x={segment.x}
                            y={segment.y}
                            width={segment.width}
                            height={segment.height}
                            rx={segment.radius}
                            ry={segment.radius}
                            fill={`var(${seriesColorVar(segment.seriesIndex, entry()?.kind ?? "other")})`}
                            fill-opacity={slices().length > 0 ? "0.32" : undefined}
                          />
                          <For each={slices()}>
                            {(slice) => (
                              <rect
                                class="qg-chart__child-slice"
                                data-slice-kind={composition().kind}
                                data-series-key={key()}
                                data-bucket-index={segment.bucketIndex}
                                data-child-key={
                                  composition().kind === "child" ? slice.key : undefined
                                }
                                data-parent-key={
                                  composition().kind === "parent" ? slice.key : undefined
                                }
                                data-highlighted={
                                  selectedSliceKey() === undefined
                                    ? undefined
                                    : selectedSliceKey() === slice.key
                                      ? "true"
                                      : "false"
                                }
                                x={slice.x}
                                y={slice.y}
                                width={slice.width}
                                height={slice.height}
                                fill={`var(${seriesColorVar(segment.seriesIndex, entry()?.kind ?? "other")})`}
                                fill-opacity={slice.fillOpacity}
                              />
                            )}
                          </For>
                        </>
                      );
                    }}
                  </For>
                )}
              </For>

              <For each={costOverlay().runs}>
                {(run) => (
                  <path
                    class="qg-chart__cost-line"
                    data-partial={run.partial ? "true" : undefined}
                    d={run.path}
                  />
                )}
              </For>
              <For each={costOverlay().isolated}>
                {(point) => (
                  <line
                    class="qg-chart__cost-line qg-chart__cost-isolated"
                    data-status={point.status}
                    data-bucket-index={point.bucketIndex}
                    x1={point.x - 3}
                    x2={point.x + 3}
                    y1={point.y ?? geometry().plot.bottom}
                    y2={point.y ?? geometry().plot.bottom}
                  />
                )}
              </For>

              <For each={geometry().labelIndexes}>
                {(index) => {
                  const boundary = () => buckets()[index];
                  return (
                    <Show when={boundary()}>
                      {(value) => (
                        <text
                          class="qg-chart__axis-label"
                          x={geometry().slotX(index) + geometry().slot / 2}
                          y={size.height - 8}
                          text-anchor="middle"
                        >
                          {formatBucketTick(value().startMs, bucketUnit(), timeZone())}
                        </text>
                      )}
                    </Show>
                  );
                }}
              </For>
            </svg>

            <ul
              class="qg-chart__hits"
              aria-label={`${props.title} buckets`}
              style={{
                top: `${(geometry().plot.top / size.height) * 100}%`,
                bottom: `${((size.height - geometry().plot.bottom) / size.height) * 100}%`,
                left: `${(geometry().plot.left / size.width) * 100}%`,
                right: `${((size.width - geometry().plot.right) / size.width) * 100}%`,
              }}
              onPointerLeave={inspection.clearPointer}
            >
              <For each={buckets()}>
                {(_, index) => (
                  <li
                    class="qg-chart__hit qg-model-chart__hit"
                    aria-label={`Inspect ${bucketLabel(index())}`}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: a bucket is a focus-only inspection target; its label carries the data, so there is no activation action.
                    tabIndex={0}
                    style={{
                      left: `${((geometry().slotX(index()) - geometry().plot.left) / geometry().plot.width) * 100}%`,
                      width: `${(Math.max(geometry().slot, 1) / geometry().plot.width) * 100}%`,
                    }}
                    onPointerEnter={() => inspection.inspectPointer(index())}
                    onFocus={() => inspection.inspectFocus(index())}
                    onBlur={inspection.clearFocus}
                  />
                )}
              </For>
            </ul>

            <Show when={activeBoundary()}>
              {(boundary) => {
                const estimate = () => bucketEstimate(activeBucket() ?? 0);
                return (
                  <output
                    ref={tooltipLayout.tooltipRef}
                    class="qg-tooltip qg-model-tooltip"
                    style={{
                      left: `${tooltipLayout.position().left}px`,
                      top: `${tooltipLayout.position().top}px`,
                      "max-width": `${tooltipLayout.position().maxWidth}px`,
                      "max-height": `${tooltipLayout.position().maxHeight}px`,
                      visibility: tooltipLayout.position().visible ? "visible" : "hidden",
                    }}
                  >
                    <p class="qg-tooltip__head">
                      <span>
                        {formatBucketRange(
                          boundary().startMs,
                          boundary().endMs,
                          bucketUnit(),
                          timeZone(),
                        )}
                      </span>
                      <span class="qg-tooltip__total">{formatExactCount(estimate().total)}</span>
                    </p>
                    <For each={bucketEntries(activeBucket() ?? 0)}>
                      {(row) => (
                        <div class="qg-totals__row qg-tooltip__row qg-model-tooltip__row">
                          <span
                            class="qg-tooltip__swatch"
                            aria-hidden="true"
                            style={{
                              "--qg-swatch": `var(${seriesColorVar(row.seriesIndex, row.entry.kind)})`,
                            }}
                          />
                          <span class="qg-totals__label">{row.label}</span>
                          <span
                            class="qg-model-tooltip__tokens"
                            title={`${formatExactCount(row.total)} tokens`}
                          >
                            {formatExactCount(row.total)}
                          </span>
                          <span
                            class="qg-model-tooltip__cost"
                            data-cost-status={
                              row.cost === null && row.total > 0 ? "unpriced" : undefined
                            }
                            title={row.costTitle}
                          >
                            {formatCostText(row.tokens)}
                            <Show when={row.partial}>
                              <span class="qg-model-tooltip__qualifier">partial</span>
                            </Show>
                          </span>
                        </div>
                      )}
                    </For>
                    <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--note qg-model-tooltip__footer">
                      <span class="qg-totals__label">
                        <span class="qg-model-tooltip__total-long">API-equivalent total</span>
                        <span class="qg-model-tooltip__total-short" aria-hidden="true">
                          Total
                        </span>
                      </span>
                      <span class="qg-totals__value" title={costValueTitle(estimate())}>
                        {formatCostText(estimate())}
                      </span>
                      <EstimateNote totals={estimate()} />
                    </div>
                  </output>
                );
              }}
            </Show>
          </div>

          <Show when={rangeEndCaption()}>
            {(caption) => <p class="qg-chart__axis-caption">{caption()}</p>}
          </Show>

          <div class="sr-only">
            <table>
              <caption>
                {props.title} per {bucketUnit()}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Bucket</th>
                  <For each={ranked()}>{(entry) => <th scope="col">{labelFor(entry)}</th>}</For>
                  <th scope="col">API-equivalent</th>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                <For each={buckets()}>
                  {(boundary, index) => {
                    const estimate = () => bucketEstimate(index());
                    return (
                      <tr>
                        <th scope="row">
                          {formatBucketTick(boundary.startMs, bucketUnit(), timeZone())}
                        </th>
                        <For each={ranked()}>
                          {(entry) => (
                            <td>{formatExactCount(entry.buckets[index()]?.total ?? 0)}</td>
                          )}
                        </For>
                        <td>
                          {formatCostText(estimate())}
                          <Show when={estimateNote(estimate()) === "Partial estimate"}>
                            {" Partial estimate"}
                          </Show>
                        </td>
                        <td>{formatExactCount(estimate().total)}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </ChartShell>
  );
}
