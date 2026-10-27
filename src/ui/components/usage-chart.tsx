import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Bucket, Usage } from "../../contracts/dashboard";
import { buildUsageGeometry, cacheHitRate, DEFAULT_USAGE_SIZE } from "../chart-geometry";
import { createChartInspection } from "../chart-inspection";
import { createChartLayout } from "../chart-layout";
import {
  axisRangeCaption,
  formatApiEquivalentCost,
  formatBucketEnd,
  formatBucketRange,
  formatBucketTick,
  formatExactCount,
  formatPercentExact,
  formatPercentTick,
  formatTokenCount,
  usageChartTitle,
} from "../format";
import { createChartTooltipLayout } from "../tooltip-layout";
import { ChartShell, ChartSummary, type ChartSummaryItem } from "./chart-shell";
import { EstimateInfo } from "./estimate";
import { EmptyNotice } from "./states";

/**
 * Usage — shared stacked vertical bars (design spec §2; owner 6–12).
 *
 * Five additive token categories stack bottom-to-top in a fixed order. Only
 * categories with a nonzero total in the current range render at all, so a
 * zero series leaves no phantom segment, legend row, tooltip row or gap. Every
 * nonzero segment keeps its truthful height and is separated by external
 * chart-background space, never by a stroke painted over colored ink. The
 * small corner radius is constrained by each segment's width and height.
 *
 * A derived cache-hit-rate line (right axis, fixed 0–100%) overlays the stack;
 * it is not a token series and a bucket with no input-side traffic is a gap.
 * Pointer and keyboard inspection share the immediate custom tooltip with the
 * Session chart; this chart deliberately has no vertical crosshair.
 */
export function UsageChart(props: {
  usage: Usage;
  title?: string;
  /** Anchor for the shell heading; pages pass their existing section id. */
  headingId?: string;
  /** Replaces the default totals summary, e.g. Project adds its session count. */
  summary?: JSX.Element;
  /** Shown inside the panel when a page has no buckets to plot. */
  emptyMessage?: string;
}): JSX.Element {
  const inspection = createChartInspection();
  const [hoveredCategory, setHoveredCategory] = createSignal<string | undefined>();
  const [focusedCategory, setFocusedCategory] = createSignal<string | undefined>();
  const active = inspection.active;
  const highlight = () => hoveredCategory() ?? focusedCategory();

  const { size, ref } = createChartLayout(DEFAULT_USAGE_SIZE);
  const geometry = createMemo(() => buildUsageGeometry(props.usage.buckets, size));
  const tooltipLayout = createChartTooltipLayout(
    () => {
      const index = active();
      return index === undefined ? 0 : (geometry().slotX(index) + geometry().slot / 2) / size.width;
    },
    // Clear the active bar, not just its centre, before starting the overlay.
    () => geometry().barWidth / 2 + 12,
  );
  const timeZone = () => props.usage.timeZone;
  const title = () => props.title ?? usageChartTitle(props.usage.bucketUnit);
  const summaryItems = (): ChartSummaryItem[] => [
    {
      label: "Total tokens",
      value: formatExactCount(props.usage.totals.total),
      emphasis: "primary",
    },
    {
      label: "API-equivalent estimate",
      value: formatApiEquivalentCost(props.usage.totals.apiEquivalentCostUsd),
      info: <EstimateInfo totals={props.usage.totals} />,
    },
  ];
  const activeBucket = (): Bucket | undefined => {
    const index = active();
    return index === undefined ? undefined : props.usage.buckets[index];
  };
  const rateText = (value: number | null | undefined): string => formatPercentExact(value);
  const activeRate = (): number | null | undefined => {
    const bucket = activeBucket();
    return bucket === undefined ? undefined : cacheHitRate(bucket.tokens);
  };
  const bucketLabel = (bucket: Bucket): string => {
    const rate = cacheHitRate(bucket.tokens);
    const categories = geometry()
      .visibleCategories.map(
        (category) => `${category.label} ${formatExactCount(bucket.tokens[category.key])}`,
      )
      .join(", ");
    return `${formatBucketTick(bucket.startMs, props.usage.bucketUnit, timeZone())}: total ${formatExactCount(bucket.tokens.total)} tokens${categories.length > 0 ? `, ${categories}` : ""}, cache rate ${rateText(rate)}`;
  };
  const rangeEndCaption = (): string | undefined => {
    const buckets = props.usage.buckets;
    const last = buckets.at(-1);
    if (!last) return undefined;
    return axisRangeCaption(
      formatBucketEnd(last.startMs, last.endMs, props.usage.bucketUnit, timeZone()),
      buckets.length,
      geometry().labelIndexes,
    );
  };

  return (
    <ChartShell
      title={title()}
      headingId={props.headingId}
      summary={props.summary ?? <ChartSummary items={summaryItems()} />}
      aside={
        <ul class="qg-legend">
          <For each={geometry().visibleCategories}>
            {(category) => (
              <li
                class="qg-legend__item"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the legend entry is a keyboard focus target for series emphasis, not an activation action.
                tabIndex={0}
                aria-label={`Highlight ${category.label}`}
                style={{ "--qg-swatch": `var(${category.colorVar})` }}
                onPointerEnter={() => setHoveredCategory(category.key)}
                onPointerLeave={() => {
                  setHoveredCategory(undefined);
                  setFocusedCategory(undefined);
                }}
                onFocus={() => setFocusedCategory(category.key)}
                onBlur={() => setFocusedCategory(undefined)}
              >
                <span class="qg-legend__swatch" aria-hidden="true" />
                <span class="qg-legend__label">{category.label}</span>
                <span class="qg-legend__value">
                  {formatTokenCount(props.usage.totals[category.key])}
                </span>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <Show
        when={props.emptyMessage === undefined || props.usage.buckets.length > 0}
        fallback={<EmptyNotice message={props.emptyMessage ?? ""} />}
      >
        <div
          ref={(element) => {
            ref(element);
            tooltipLayout.chartRef(element);
          }}
          class="qg-chart"
          data-highlight={highlight() === undefined ? undefined : "true"}
        >
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={`${title()}. Stacked token usage with a cache hit rate on the right axis.`}
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
              class="qg-chart__axis-title qg-chart__axis-title--tokens"
              x={geometry().plot.left}
              y={geometry().plot.top - 6}
              text-anchor="start"
            >
              TOKEN USAGE
            </text>
            <text
              class="qg-chart__axis-title qg-chart__axis-title--rate"
              x={geometry().plot.right}
              y={geometry().plot.top - 6}
              text-anchor="end"
            >
              CACHE HIT RATE
            </text>
            <For each={geometry().cacheRateTicks}>
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
                    class="qg-chart__axis-label qg-chart__axis-label--rate"
                    x={geometry().plot.right + 8}
                    y={tick.y + 3}
                    text-anchor="start"
                  >
                    {formatPercentTick(tick.value)}
                  </text>
                </>
              )}
            </For>

            <For each={geometry().bars}>
              {(bar) => (
                <For each={bar.segments}>
                  {(segment) => (
                    <rect
                      class="qg-chart__segment"
                      data-category={segment.key}
                      data-highlighted={
                        highlight() === undefined || highlight() === segment.key
                          ? "true"
                          : undefined
                      }
                      x={segment.x}
                      y={segment.y}
                      width={segment.width}
                      height={segment.height}
                      rx={segment.radius}
                      ry={segment.radius}
                      fill={`var(${segment.colorVar})`}
                    />
                  )}
                </For>
              )}
            </For>

            <Show when={geometry().cacheRatePath.length > 0}>
              <path class="qg-chart__rate-line" d={geometry().cacheRatePath} />
            </Show>
            <Show when={geometry().cacheRatePoints.length === 1}>
              <circle
                class="qg-chart__rate-point"
                cx={geometry().cacheRatePoints[0]?.x}
                cy={geometry().cacheRatePoints[0]?.y}
                r="2"
              />
            </Show>

            <For each={geometry().labelIndexes}>
              {(index) => {
                const bucket = () => props.usage.buckets[index];
                return (
                  <Show when={bucket()}>
                    {(value) => (
                      <text
                        class="qg-chart__axis-label"
                        x={geometry().slotX(index) + geometry().slot / 2}
                        y={size.height - 8}
                        text-anchor="middle"
                      >
                        {formatBucketTick(value().startMs, props.usage.bucketUnit, timeZone())}
                      </text>
                    )}
                  </Show>
                );
              }}
            </For>
          </svg>

          {/*
          Real buttons, one per bucket: keyboard reachable, labelled with the
          visible categories, the total and the exact cache rate. The SVG above
          stays a picture for assistive tech.
        */}
          <div
            class="qg-chart__hits"
            style={{
              top: `${(geometry().plot.top / size.height) * 100}%`,
              bottom: `${((size.height - geometry().plot.bottom) / size.height) * 100}%`,
              left: `${(geometry().plot.left / size.width) * 100}%`,
              right: `${((size.width - geometry().plot.right) / size.width) * 100}%`,
            }}
            onPointerLeave={inspection.clearPointer}
          >
            <For each={props.usage.buckets}>
              {(bucket, index) => (
                <button
                  type="button"
                  class="qg-chart__hit"
                  aria-label={bucketLabel(bucket)}
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
          </div>

          <Show when={activeBucket()}>
            {(bucket) => (
              <output
                ref={tooltipLayout.tooltipRef}
                class="qg-tooltip"
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
                      bucket().startMs,
                      bucket().endMs,
                      props.usage.bucketUnit,
                      timeZone(),
                    )}
                  </span>
                  <span class="qg-tooltip__total">{formatExactCount(bucket().tokens.total)}</span>
                </p>
                <For each={geometry().visibleCategories}>
                  {(category) => (
                    <div class="qg-totals__row qg-tooltip__row">
                      <span
                        class="qg-tooltip__swatch"
                        aria-hidden="true"
                        style={{ "--qg-swatch": `var(${category.colorVar})` }}
                      />
                      <span class="qg-totals__label">{category.label}</span>
                      <span class="qg-totals__value">
                        {formatExactCount(bucket().tokens[category.key])}
                      </span>
                    </div>
                  )}
                </For>
                <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--rate">
                  <span class="qg-tooltip__swatch qg-tooltip__swatch--line" aria-hidden="true" />
                  <span class="qg-totals__label">Cache rate</span>
                  <span class="qg-totals__value">{rateText(activeRate())}</span>
                </div>
              </output>
            )}
          </Show>
        </div>

        <Show when={rangeEndCaption()}>
          {(caption) => <p class="qg-chart__axis-caption">{caption()}</p>}
        </Show>

        <div class="sr-only">
          <table>
            <caption>
              {title()} per {props.usage.bucketUnit}
            </caption>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <For each={geometry().visibleCategories}>
                  {(category) => <th scope="col">{category.label}</th>}
                </For>
                <th scope="col">Cache rate</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.usage.buckets}>
                {(bucket) => (
                  <tr>
                    <th scope="row">
                      {formatBucketTick(bucket.startMs, props.usage.bucketUnit, timeZone())}
                    </th>
                    <For each={geometry().visibleCategories}>
                      {(category) => <td>{formatExactCount(bucket.tokens[category.key])}</td>}
                    </For>
                    <td>{rateText(cacheHitRate(bucket.tokens))}</td>
                    <td>{formatExactCount(bucket.tokens.total)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </ChartShell>
  );
}
