import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
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
  formatApiEquivalentCost,
  formatBucketEnd,
  formatBucketRange,
  formatBucketTick,
  formatExactCount,
  formatTokenCount,
} from "../format";
import {
  combineEstimates,
  disambiguatedIdentityLabel,
  estimateNote,
  rankSeries,
  seriesColorVar,
  seriesKey,
} from "../model-analytics";
import { buildModelChartGeometry, DEFAULT_MODEL_USAGE_SIZE } from "../model-chart-geometry";
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
 * The legend sits below the plot, is reachable with Tab, and highlights its
 * matching bars and breakdown rows while focused. Emphasis uses opacity and a
 * border/underline change, so it never depends on colour alone.
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
  onPointerSeries?: (key: string | undefined) => void;
  onFocusSeries?: (key: string | undefined) => void;
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

  const bucketEntries = (index: number) =>
    ranked()
      .map((entry, seriesIndex) => ({
        entry,
        seriesIndex,
        key: seriesKey(entry, dimension()),
        label: labelFor(entry),
        tokens: entry.buckets[index],
        total: entry.buckets[index]?.total ?? 0,
      }))
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

  const bucketLabel = (index: number): string => {
    const boundary = buckets()[index];
    const estimate = bucketEstimate(index);
    const parts = bucketEntries(index).map((row) => `${row.label} ${formatExactCount(row.total)}`);
    return [
      formatBucketRange(
        boundary?.startMs ?? 0,
        boundary?.endMs ?? 0,
        bucketUnit(),
        timeZone(),
        " to ",
      ),
      `total ${formatExactCount(estimate.total)} tokens`,
      ...parts,
      `API-equivalent ${formatApiEquivalentCost(estimate.apiEquivalentCostUsd)}`,
      estimateNote(estimate) ?? "",
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
          <ul class="qg-legend qg-model-legend" aria-label={`${dimension()} series`}>
            <For each={ranked()}>
              {(entry, index) => {
                const key = () => seriesKey(entry, dimension());
                const label = () => labelFor(entry);
                return (
                  <li
                    class="qg-legend__item qg-legend__item--series"
                    data-series-key={key()}
                    data-active={activeKey() === key() ? "true" : undefined}
                    aria-label={`Highlight ${label()}, ${formatExactCount(entry.tokens.total)} tokens`}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the legend entry is a keyboard focus target for series emphasis, not an activation action.
                    tabIndex={0}
                    onPointerEnter={() => activatePointer(key())}
                    onPointerLeave={() => activatePointer(undefined)}
                    onFocus={() => activateFocus(key())}
                    onBlur={() => activateFocus(undefined)}
                  >
                    <span
                      class="qg-legend__swatch"
                      aria-hidden="true"
                      style={{ "--qg-swatch": `var(${seriesColorVar(index(), entry.kind)})` }}
                    />
                    <Show when={dimension() === "provider" && providerMarkId(entry) !== undefined}>
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
          <div
            ref={(element) => {
              ref(element);
              tooltipLayout.chartRef(element);
            }}
            class="qg-chart qg-model-chart__plot"
            data-highlight={activeKey() === undefined ? undefined : "true"}
          >
            <svg
              viewBox={`0 0 ${size.width} ${size.height}`}
              role="img"
              aria-label={`${props.title}. Stacked token usage by ${dimension()}.`}
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
                      return (
                        <rect
                          class="qg-chart__segment"
                          data-series-key={key()}
                          data-highlighted={highlighted(key())}
                          x={segment.x}
                          y={segment.y}
                          width={segment.width}
                          height={segment.height}
                          rx={segment.radius}
                          ry={segment.radius}
                          fill={`var(${seriesColorVar(segment.seriesIndex, entry()?.kind ?? "other")})`}
                        />
                      );
                    }}
                  </For>
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
                          <span class="qg-totals__value" title={formatExactCount(row.total)}>
                            {formatExactCount(row.total)}
                          </span>
                        </div>
                      )}
                    </For>
                    <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--note qg-model-tooltip__footer">
                      <span class="qg-totals__label">API-equivalent</span>
                      <span
                        class="qg-totals__value"
                        title={
                          estimate().apiEquivalentCostUsd === null
                            ? "No priced tokens in this bucket."
                            : `API-equivalent estimate: USD ${(estimate().apiEquivalentCostUsd ?? 0).toFixed(6)}.`
                        }
                      >
                        {formatApiEquivalentCost(estimate().apiEquivalentCostUsd)}
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
                          {formatApiEquivalentCost(estimate().apiEquivalentCostUsd)}
                          <Show when={estimateNote(estimate())}>{(note) => <> {note()}</>}</Show>
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
