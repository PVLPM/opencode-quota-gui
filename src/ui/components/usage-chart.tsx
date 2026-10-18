import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Bucket, Usage } from "../../contracts/dashboard";
import {
  buildTotalsBand,
  buildUsageGeometry,
  DEFAULT_USAGE_SIZE,
  shouldUseTotalsFallback,
  toBandPath,
  toLinePath,
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

/**
 * Usage — stacked area chart (design spec §6, §10; R31, R32, R48).
 *
 * Five additive token categories stack in a fixed order and no segment can be
 * hidden; transient hover/focus highlights a segment and the tooltip reports all
 * five plus the total. When stacking would be visually meaningless (a single
 * category, or a sliver invisible in every bucket) the chart falls back to one
 * totals series — a frontend rendering choice, never a setting or a payload
 * change. A visually hidden table duplicates the series for screen readers.
 */
export function UsageChart(props: { usage: Usage }): JSX.Element {
  const [active, setActive] = createSignal<number | undefined>(undefined);
  const [highlight, setHighlight] = createSignal<string | undefined>(undefined);

  const { size, ref } = createChartLayout(DEFAULT_USAGE_SIZE);
  const geometry = createMemo(() => buildUsageGeometry(props.usage.buckets, size));
  const totalsOnly = createMemo(() => shouldUseTotalsFallback(props.usage.buckets));
  const categoryTotals = createMemo(() =>
    TOKEN_CATEGORIES.map((category) => ({
      ...category,
      value: props.usage.totals[category.key],
    })),
  );

  const activeBucket = (): Bucket | undefined => {
    const index = active();
    return index === undefined ? undefined : props.usage.buckets[index];
  };

  function detach(): void {
    setActive(undefined);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      setActive(undefined);
      setHighlight(undefined);
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
        ref={ref}
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

          <Show
            when={!totalsOnly()}
            fallback={
              <path
                class="qg-chart__segment"
                data-highlighted="true"
                d={toBandPath(buildTotalsBand(geometry()))}
                fill="var(--qg-token-total)"
                fill-opacity="0.28"
                stroke="var(--qg-token-total)"
                stroke-width="1.5"
              />
            }
          >
            <For each={geometry().bands}>
              {(band) => (
                <path
                  class="qg-chart__segment"
                  data-highlighted={
                    highlight() === undefined || highlight() === band.key ? "true" : undefined
                  }
                  d={toBandPath(band)}
                  fill={`var(${band.colorVar})`}
                  fill-opacity="0.62"
                  stroke={`var(${band.colorVar})`}
                  stroke-width="1"
                />
              )}
            </For>
            <path
              class="qg-chart__total-line"
              d={toLinePath(geometry().totalLine)}
              fill="none"
              stroke="var(--qg-text-muted)"
              stroke-width="1"
              stroke-dasharray="2 3"
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
                onPointerEnter={() => setActive(index())}
                onPointerLeave={detach}
                onFocus={() => setActive(index())}
                onBlur={detach}
                onKeyDown={onKeyDown}
              />
            )}
          </For>
        </div>

        <Show when={activeBucket()}>
          {(bucket) => (
            <output
              class="qg-tooltip"
              style={{
                left: `clamp(min(120px, 50%), ${((geometry().slotX(active() ?? 0) + geometry().slot / 2) / size.width) * 100}%, max(50%, calc(100% - 120px)))`,
                top: "0%",
                transform: "translate(-50%, -100%)",
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
              {totalsOnly() ? " · totals series (stacking would be unreadable)" : ""}
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
                onPointerEnter={() => setHighlight(category.key)}
                onPointerLeave={() => setHighlight(undefined)}
                onFocus={() => setHighlight(category.key)}
                onBlur={() => setHighlight(undefined)}
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
