import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Bucket, Usage } from "../../contracts/dashboard";
import {
  buildUsageGeometry,
  DEFAULT_USAGE_SIZE,
  type StackBand,
  toBandPath,
} from "../chart-geometry";
import { createChartLayout } from "../chart-layout";
import {
  formatApiEquivalentCost,
  formatBucketTick,
  formatExactCount,
  formatTokenCount,
  pluralize,
  TOKEN_CATEGORIES,
} from "../format";
import { createChartTooltipLayout } from "../tooltip-layout";

/**
 * A series whose band never leaves its lower boundary carries no visible area;
 * flagging it keeps the hairline stroke from drawing a zero series into
 * existence as a white line.
 */
function bandIsZeroThickness(band: StackBand): boolean {
  return band.lower.every((value, index) => Math.abs((band.upper[index] ?? value) - value) < 0.001);
}

/**
 * Usage — stacked area chart (design spec §6, §10; R31, R32, R48).
 *
 * Five additive token categories stack in a fixed order and no series with a
 * nonzero range total can be hidden; the cache-write series is omitted from the
 * graph and its legend while its range total is zero, so no flat zero area is
 * drawn. Transient hover/focus highlights a segment and the tooltip reports all
 * five plus the total. Zero and tiny categories retain their true thickness.
 * A visually hidden table duplicates the series for screen readers.
 */
export function UsageChart(props: { usage: Usage }): JSX.Element {
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
  // The hover/focus layers, the aria labels and the sr-only table keep reporting
  // every category; only the drawn series and its legend entry may be omitted.
  const omitCacheWrite = () => props.usage.totals.cacheWrite === 0;
  const bands = createMemo(() =>
    omitCacheWrite()
      ? geometry().bands.filter((band) => band.key !== "cacheWrite")
      : geometry().bands,
  );
  const categoryTotals = createMemo(() =>
    TOKEN_CATEGORIES.filter((category) => !omitCacheWrite() || category.key !== "cacheWrite").map(
      (category) => ({
        ...category,
        value: props.usage.totals[category.key],
      }),
    ),
  );

  const activeBucket = (): Bucket | undefined => {
    const index = active();
    return index === undefined ? undefined : props.usage.buckets[index];
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      setHoveredBucket(undefined);
      setFocusedBucket(undefined);
      setHoveredCategory(undefined);
      setFocusedCategory(undefined);
    }
  }

  return (
    <div class="qg-usage">
      <header class="qg-usage__headline">
        <div>
          <span class="qg-summary-label">Total tokens</span>
          <strong class="qg-summary-number">{formatExactCount(props.usage.totals.total)}</strong>
        </div>
        <div>
          <span class="qg-summary-label">API-equivalent estimate</span>
          <span class="qg-summary-cost">
            {formatApiEquivalentCost(props.usage.totals.apiEquivalentCostUsd)}
          </span>
        </div>
        <span class="qg-section__meta">
          {pluralize(props.usage.stepCount, "step")} ·{" "}
          {pluralize(props.usage.sessionCount, "session")} · UTC
        </span>
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
          aria-label={`Token usage over ${props.usage.range}, ${props.usage.bucketUnit} buckets.`}
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

          <For each={bands()}>
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
                      {formatBucketTick(value().startMs, props.usage.bucketUnit)}
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
          five categories plus the total, and the only interactive layer — the
          SVG above stays a picture for assistive technology.
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
                aria-label={`${formatBucketTick(bucket.startMs, props.usage.bucketUnit)} UTC: total ${formatExactCount(bucket.tokens.total)} tokens, ${TOKEN_CATEGORIES.map((category) => `${category.label} ${formatExactCount(bucket.tokens[category.key])}`).join(", ")}`}
                style={{
                  left: `${((geometry().slotX(index()) - geometry().plot.left) / geometry().plot.width) * 100}%`,
                  width: `${(Math.max(geometry().slot, 1) / geometry().plot.width) * 100}%`,
                }}
                onPointerEnter={() => setHoveredBucket(index())}
                onPointerLeave={() => setHoveredBucket(undefined)}
                onFocus={() => setFocusedBucket(index())}
                onBlur={() => setFocusedBucket(undefined)}
                onKeyDown={onKeyDown}
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
                  {formatBucketTick(bucket().startMs, props.usage.bucketUnit)} –{" "}
                  {formatBucketTick(bucket().endMs, props.usage.bucketUnit)} UTC
                </span>
                <span class="qg-tooltip__total">{formatExactCount(bucket().tokens.total)}</span>
              </p>
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
        <div class="qg-usage__details">
          <p class="qg-totals__notes">
            <Show
              when={props.usage.totals.unpricedTokens > 0 || props.usage.totals.unknownTokens > 0}
            >
              <span>
                {formatExactCount(props.usage.totals.unpricedTokens)} unpriced ·{" "}
                {formatExactCount(props.usage.totals.unknownTokens)} unknown tokens are outside the
                estimate
              </span>
            </Show>
            <span>
              Per {props.usage.bucketUnit}, {pluralize(props.usage.buckets.length, "bucket")}
            </span>
          </p>
        </div>

        <div class="qg-legend">
          <For each={categoryTotals()}>
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
                onKeyDown={onKeyDown}
              >
                <span class="qg-legend__swatch" aria-hidden="true" />
                <span class="qg-legend__label">{category.label}</span>
                <span class="qg-legend__value">{formatTokenCount(category.value)}</span>
              </button>
            )}
          </For>
        </div>
      </aside>

      <div class="sr-only">
        <table>
          <caption>Token usage per {props.usage.bucketUnit}</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <For each={TOKEN_CATEGORIES}>
                {(category) => <th scope="col">{category.label}</th>}
              </For>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.usage.buckets}>
              {(bucket) => (
                <tr>
                  <th scope="row">{new Date(bucket.startMs).toISOString()}</th>
                  <For each={TOKEN_CATEGORIES}>
                    {(category) => <td>{formatExactCount(bucket.tokens[category.key])}</td>}
                  </For>
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
