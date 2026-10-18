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
 * hidden; hover/focus highlights a segment and the tooltip always reports all
 * five plus the total. When stacking would be visually meaningless (a single
 * category, or a sliver invisible in every bucket) the chart falls back to one
 * totals series — a frontend rendering choice, never a setting or a payload
 * change. A visually hidden table duplicates the series for screen readers.
 */
export function UsageChart(props: { usage: Usage }): JSX.Element {
  const [active, setActive] = createSignal<number | undefined>(undefined);
  const [pinned, setPinned] = createSignal(false);
  const [highlight, setHighlight] = createSignal<string | undefined>(undefined);

  const size = DEFAULT_USAGE_SIZE;
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
    if (pinned()) return;
    setActive(undefined);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      setPinned(false);
      setActive(undefined);
    }
  }

  return (
    <div class="qg-usage">
      <div class="qg-chart" data-highlight={highlight() === undefined ? undefined : "true"}>
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
                aria-pressed={active() === index() ? "true" : "false"}
                aria-label={`${formatBucketTick(bucket.startMs, props.usage.bucketUnit)}: total ${formatExactCount(bucket.tokens.total)} tokens, ${TOKEN_CATEGORIES.map((category) => `${category.label} ${formatExactCount(bucket.tokens[category.key])}`).join(", ")}`}
                style={{
                  left: `${((geometry().slotX(index()) - geometry().plot.left) / geometry().plot.width) * 100}%`,
                  width: `${(Math.max(geometry().slot, 1) / geometry().plot.width) * 100}%`,
                }}
                onPointerEnter={() => setActive(index())}
                onPointerLeave={detach}
                onFocus={() => setActive(index())}
                onBlur={detach}
                onClick={() => {
                  setActive(index());
                  setPinned(true);
                }}
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
                left: `${((geometry().slotX(active() ?? 0) + geometry().slot / 2) / size.width) * 100}%`,
                top: "0%",
                transform: "translate(-50%, -100%)",
              }}
            >
              <p class="qg-tooltip__head">
                <span>
                  {formatBucketTick(bucket().startMs, props.usage.bucketUnit)} –{" "}
                  {formatBucketTick(bucket().endMs, props.usage.bucketUnit)}
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
              <Show when={pinned()}>
                <p class="qg-tooltip__hint">Pinned — press Escape to dismiss</p>
              </Show>
            </output>
          )}
        </Show>
      </div>

      <aside class="qg-usage__aside">
        <div class="qg-totals">
          <div class="qg-totals__row">
            <span class="qg-totals__label">Total tokens</span>
            <span class="qg-totals__value qg-totals__value--total qg-num">
              {formatExactCount(props.usage.totals.total)}
            </span>
          </div>
          <For each={categoryTotals()}>
            {(category) => (
              <div class="qg-totals__row">
                <span class="qg-totals__label">{category.label}</span>
                <span class="qg-totals__value">{formatExactCount(category.value)}</span>
              </div>
            )}
          </For>
          <div class="qg-totals__row">
            <span class="qg-totals__label">API-equivalent</span>
            <span class="qg-totals__value">
              {formatApiEquivalentCost(props.usage.totals.apiEquivalentCostUsd)}
            </span>
          </div>
          <p class="qg-totals__notes">
            <span>
              {pluralize(props.usage.stepCount, "step")} across{" "}
              {pluralize(props.usage.sessionCount, "session")}
            </span>
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
                aria-pressed={highlight() === category.key ? "true" : "false"}
                style={{ "--qg-swatch": `var(${category.colorVar})` }}
                onPointerEnter={() => setHighlight(category.key)}
                onPointerLeave={() => setHighlight(undefined)}
                onFocus={() => setHighlight(category.key)}
                onBlur={() => setHighlight(undefined)}
                onClick={() =>
                  setHighlight(highlight() === category.key ? undefined : category.key)
                }
              >
                <span class="qg-legend__swatch" aria-hidden="true" />
                <span class="qg-legend__label">{category.label}</span>
                <span class="qg-legend__value">{formatTokenCount(category.value)}</span>
              </button>
            )}
          </For>
        </div>
      </aside>

      <table class="sr-only">
        <caption>Token usage per {props.usage.bucketUnit}</caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <For each={TOKEN_CATEGORIES}>{(category) => <th scope="col">{category.label}</th>}</For>
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
  );
}
