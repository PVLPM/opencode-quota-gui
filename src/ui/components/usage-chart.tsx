import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Bucket, Usage } from "../../contracts/dashboard";
import { buildUsageGeometry, DEFAULT_USAGE_SIZE, toBandPath } from "../chart-geometry";
import { createChartLayout } from "../chart-layout";
import {
  formatApiEquivalentCost,
  formatBucketTick,
  formatExactCount,
  formatPercent,
  formatTokenCount,
  TOKEN_CATEGORIES,
  usageChartTitle,
} from "../format";
import { createChartTooltipLayout } from "../tooltip-layout";
import { EstimateInfo } from "./estimate";

/**
 * A series whose band never leaves its lower boundary carries no visible area;
 * flagging it keeps the hairline stroke from drawing a zero series into
 * existence as a white line.
 */
function bandIsZeroThickness(
  band: ReturnType<typeof buildUsageGeometry>["bands"][number],
): boolean {
  return band.lower.every((value, index) => Math.abs((band.upper[index] ?? value) - value) < 0.001);
}

/**
 * Usage — stacked area chart (design spec §6, §10; R31, R32, R48).
 *
 * Five additive token categories always stack in a fixed order; a zero
 * category stays a true zero-thickness layer. After the fills, every non-zero
 * category's cumulative boundary is redrawn in that category's colour so a tiny
 * series stays distinguishable beside a huge one without inflating its area.
 *
 * A derived cache-hit-rate line (right axis, fixed 0–100%) overlays the stack;
 * it is not a sixth token series, and a bucket with no input-side traffic is a
 * gap rather than 0%. Transient hover/focus highlights a segment; no click
 * state is kept. A visually hidden table duplicates the series for screen
 * readers.
 */
export function UsageChart(props: {
  usage: Usage;
  title?: string;
  /** Projects keep their totals in the page-level summary strip, not in this headline. */
  showSummary?: boolean;
}): JSX.Element {
  const [hoveredBucket, setHoveredBucket] = createSignal<number | undefined>();
  const [focusedBucket, setFocusedBucket] = createSignal<number | undefined>();
  const [hoveredCategory, setHoveredCategory] = createSignal<string | undefined>();
  const [focusedCategory, setFocusedCategory] = createSignal<string | undefined>();
  const active = () => hoveredBucket() ?? focusedBucket();
  const highlight = () => hoveredCategory() ?? focusedCategory();

  const { size, ref } = createChartLayout(DEFAULT_USAGE_SIZE);
  const geometry = createMemo(() => buildUsageGeometry(props.usage.buckets, size));
  const tooltipLayout = createChartTooltipLayout(
    () => (geometry().slotX(active() ?? 0) + geometry().slot / 2) / size.width,
  );
  const timeZone = () => props.usage.timeZone;
  const title = () => props.title ?? usageChartTitle(props.usage.bucketUnit);
  const activeBucket = (): Bucket | undefined => {
    const index = active();
    return index === undefined ? undefined : props.usage.buckets[index];
  };
  const activeRate = (): number | null | undefined => {
    const bucket = activeBucket();
    if (bucket === undefined) return undefined;
    const denominator = bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite;
    return denominator > 0 ? (bucket.tokens.cacheRead / denominator) * 100 : null;
  };
  const rateText = (value: number | null | undefined): string =>
    value === undefined || value === null ? "—" : formatPercent(value);

  return (
    <div class="qg-usage">
      <header class="qg-usage__headline">
        <Show when={props.title}>
          {(visibleTitle) => <span class="qg-chart__title">{visibleTitle()}</span>}
        </Show>
        <Show when={props.showSummary ?? true}>
          <div>
            <span class="qg-summary-label">Total tokens</span>
            <strong class="qg-summary-number">{formatExactCount(props.usage.totals.total)}</strong>
          </div>
          <div>
            <span class="qg-summary-label qg-estimate-label">
              API-equivalent estimate
              <EstimateInfo totals={props.usage.totals} />
            </span>
            <span class="qg-summary-cost">
              {formatApiEquivalentCost(props.usage.totals.apiEquivalentCostUsd)}
            </span>
          </div>
        </Show>
      </header>
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
          aria-label={`${title()}. Five stacked token categories with a cache hit rate on the right axis.`}
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
            class="qg-chart__axis-title qg-chart__axis-title--rate"
            x={geometry().plot.right}
            y={geometry().plot.top - 6}
            text-anchor="end"
          >
            Cache hit rate
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
                  {formatPercent(tick.value)}
                </text>
              </>
            )}
          </For>

          <For each={geometry().bands}>
            {(band) => (
              <path
                class="qg-chart__segment"
                data-highlighted={
                  highlight() === undefined || highlight() === band.key ? "true" : undefined
                }
                data-thin={bandIsZeroThickness(band) ? "true" : undefined}
                d={toBandPath(band)}
                fill={`var(${band.colorVar})`}
                fill-opacity="0.72"
              />
            )}
          </For>

          <For each={geometry().boundaries}>
            {(boundary) => (
              <path
                class="qg-chart__boundary"
                data-category={boundary.key}
                d={boundary.path}
                stroke={`var(${boundary.colorVar})`}
              />
            )}
          </For>

          <Show when={geometry().cacheRatePath}>
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

          <Show when={active() !== undefined}>
            <line
              class="qg-chart__cursor"
              x1={geometry().slotX(active() ?? 0) + geometry().slot / 2}
              x2={geometry().slotX(active() ?? 0) + geometry().slot / 2}
              y1={geometry().plot.top}
              y2={geometry().plot.bottom}
            />
          </Show>
        </svg>

        {/*
          Real buttons, one per bucket: keyboard reachable, labelled with all
          five categories plus the total and the cache rate, and the only
          interactive layer — the SVG above stays a picture for assistive tech.
        */}
        <div
          class="qg-chart__hits"
          style={{
            top: `${(geometry().plot.top / size.height) * 100}%`,
            bottom: `${((size.height - geometry().plot.bottom) / size.height) * 100}%`,
            left: `${(geometry().plot.left / size.width) * 100}%`,
            right: `${((size.width - geometry().plot.right) / size.width) * 100}%`,
          }}
        >
          <For each={props.usage.buckets}>
            {(bucket, index) => (
              <button
                type="button"
                class="qg-chart__hit"
                aria-label={`${formatBucketTick(bucket.startMs, props.usage.bucketUnit, timeZone())}: total ${formatExactCount(bucket.tokens.total)} tokens, ${TOKEN_CATEGORIES.map((category) => `${category.label} ${formatExactCount(bucket.tokens[category.key])}`).join(", ")}, cache rate ${rateText(
                  bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite > 0
                    ? (bucket.tokens.cacheRead /
                        (bucket.tokens.input +
                          bucket.tokens.cacheRead +
                          bucket.tokens.cacheWrite)) *
                        100
                    : null,
                )}`}
                style={{
                  left: `${((geometry().slotX(index()) - geometry().plot.left) / geometry().plot.width) * 100}%`,
                  width: `${(Math.max(geometry().slot, 1) / geometry().plot.width) * 100}%`,
                }}
                onPointerEnter={() => setHoveredBucket(index())}
                onPointerLeave={() => setHoveredBucket(undefined)}
                onFocus={() => setFocusedBucket(index())}
                onBlur={() => setFocusedBucket(undefined)}
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
                  {formatBucketTick(bucket().startMs, props.usage.bucketUnit, timeZone())} –{" "}
                  {formatBucketTick(bucket().endMs, props.usage.bucketUnit, timeZone())}
                </span>
                <span class="qg-tooltip__total">{formatExactCount(bucket().tokens.total)}</span>
              </p>
              <div class="qg-totals__row">
                <span class="qg-totals__label">Cache rate</span>
                <span class="qg-totals__value">{rateText(activeRate())}</span>
              </div>
              <For each={TOKEN_CATEGORIES}>
                {(category) => (
                  <div class="qg-totals__row">
                    <span class="qg-totals__label">{category.label}</span>
                    <span class="qg-totals__value">
                      {formatExactCount(bucket().tokens[category.key])}
                    </span>
                  </div>
                )}
              </For>
            </output>
          )}
        </Show>
      </div>

      <aside class="qg-usage__aside">
        <div class="qg-legend">
          <For each={TOKEN_CATEGORIES}>
            {(category) => (
              <button
                type="button"
                class="qg-legend__item"
                aria-label={`Highlight ${category.label}`}
                style={{ "--qg-swatch": `var(${category.colorVar})` }}
                onPointerEnter={() => setHoveredCategory(category.key)}
                onPointerLeave={() => setHoveredCategory(undefined)}
                onFocus={() => setFocusedCategory(category.key)}
                onBlur={() => setFocusedCategory(undefined)}
              >
                <span class="qg-legend__swatch" aria-hidden="true" />
                <span class="qg-legend__label">{category.label}</span>
                <span class="qg-legend__value">
                  {formatTokenCount(props.usage.totals[category.key])}
                </span>
              </button>
            )}
          </For>
          <div class="qg-legend__item qg-legend__item--overlay" aria-hidden="true">
            <span class="qg-legend__swatch qg-legend__swatch--line" aria-hidden="true" />
            <span class="qg-legend__label">Cache hit rate</span>
            <span class="qg-legend__value">right axis</span>
          </div>
        </div>
      </aside>

      <div class="sr-only">
        <table>
          <caption>
            {title()} per {props.usage.bucketUnit}
          </caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <For each={TOKEN_CATEGORIES}>
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
                  <For each={TOKEN_CATEGORIES}>
                    {(category) => <td>{formatExactCount(bucket.tokens[category.key])}</td>}
                  </For>
                  <td>
                    {rateText(
                      bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite > 0
                        ? (bucket.tokens.cacheRead /
                            (bucket.tokens.input +
                              bucket.tokens.cacheRead +
                              bucket.tokens.cacheWrite)) *
                            100
                        : null,
                    )}
                  </td>
                  <td>{formatExactCount(bucket.tokens.total)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
