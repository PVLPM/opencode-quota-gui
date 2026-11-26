import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Bucket, CostedTokens, TokenStack, Usage } from "../../contracts/dashboard";
import type { UsageBarSegment } from "../chart-geometry";
import { buildUsageGeometry, cacheHitRate, DEFAULT_USAGE_SIZE } from "../chart-geometry";
import { createChartInspection } from "../chart-inspection";
import { createChartLayout, plotInsetStyle, slotHitStyle } from "../chart-layout";
import {
  axisRangeCaption,
  formatBucketEnd,
  formatBucketRange,
  formatBucketTick,
  formatExactCount,
  formatPercentExact,
  formatPercentTick,
  formatTokenCount,
  usageChartTitle,
} from "../format";
import { estimateNote, formatCostText } from "../model-analytics";
import {
  compositionBucket,
  compositionTokenShare,
  costContribution,
  type ProjectChartComposition,
} from "../project-composition";
import { createChartTooltipLayout } from "../tooltip-layout";
import { ChartShell, ChartSummary, type ChartSummaryItem } from "./chart-shell";
import { EstimateNote } from "./cost-estimate";
import { EstimateInfo } from "./estimate";
import { EmptyNotice } from "./states";

/** Shared geometry attributes for a base segment and its composition overlay. */
function segmentRectProps(
  segment: Pick<UsageBarSegment, "x" | "y" | "width" | "height" | "radius" | "colorVar">,
): { x: number; y: number; width: number; height: number; rx: number; ry: number; fill: string } {
  return {
    x: segment.x,
    y: segment.y,
    width: segment.width,
    height: segment.height,
    rx: segment.radius,
    ry: segment.radius,
    fill: `var(${segment.colorVar})`,
  };
}

function highlightAttr(active: string | undefined, key: string): "true" | undefined {
  return active === undefined || active === key ? "true" : undefined;
}

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
  /** One project's aligned contribution, shown transiently over the stack. */
  composition?: ProjectChartComposition;
  /** The active bucket pointer changed; `undefined` clears the contribution. */
  onCompositionPointerChange?: (projectId: string | undefined) => void;
  /** The active bucket focus changed; `undefined` clears the contribution. */
  onCompositionFocusChange?: (projectId: string | undefined) => void;
}): JSX.Element {
  const inspection = createChartInspection();
  const [hoveredCategory, setHoveredCategory] = createSignal<string | undefined>();
  const [focusedCategory, setFocusedCategory] = createSignal<string | undefined>();
  const [pinnedCategory, setPinnedCategory] = createSignal<string | undefined>();
  const active = inspection.active;
  const highlight = () => hoveredCategory() ?? focusedCategory() ?? pinnedCategory();
  const clearPinned = (): void => setPinnedCategory(undefined);
  const togglePinned = (key: string): void => {
    if (pinnedCategory() === key) {
      setPinnedCategory(undefined);
      // Clear this badge's transient sources too, so clicking it again visibly
      // resets the bars instead of leaving hover/focus emphasis in place.
      setHoveredCategory((current) => (current === key ? undefined : current));
      setFocusedCategory((current) => (current === key ? undefined : current));
      return;
    }
    setPinnedCategory(key);
  };
  let legendElement: HTMLUListElement | undefined;
  onMount(() => {
    if (typeof document === "undefined") return;
    const onDocumentClick = (event: MouseEvent) => {
      if (pinnedCategory() === undefined) return;
      const target = event.target;
      if (target instanceof Node && legendElement?.contains(target)) return;
      setPinnedCategory(undefined);
    };
    document.addEventListener("click", onDocumentClick);
    onCleanup(() => document.removeEventListener("click", onDocumentClick));
  });

  const { size, ref } = createChartLayout(DEFAULT_USAGE_SIZE);
  const geometry = createMemo(() => buildUsageGeometry(props.usage.buckets, size));
  // A refetch can hide a category. Drop only the emphasis keys that vanished so
  // a stale pin cannot dim the whole chart with no badge left to click.
  createEffect(() => {
    const keys = new Set<string>(geometry().visibleCategories.map((category) => category.key));
    setHoveredCategory((current) =>
      current !== undefined && !keys.has(current) ? undefined : current,
    );
    setFocusedCategory((current) =>
      current !== undefined && !keys.has(current) ? undefined : current,
    );
    setPinnedCategory((current) =>
      current !== undefined && !keys.has(current) ? undefined : current,
    );
  });
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
  /** The selected project's slice of every visible category segment. */
  const compositionOverlays = createMemo(() => {
    const overlays: {
      key: keyof TokenStack;
      colorVar: string;
      bucketIndex: number;
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
    }[] = [];
    const composition = props.composition;
    if (composition === undefined) return overlays;
    for (const bar of geometry().bars) {
      for (const segment of bar.segments) {
        const bucket = compositionBucket(composition, segment.bucketIndex);
        if (bucket === undefined) continue;
        const share = compositionTokenShare(bucket[segment.key], segment.value);
        if (share === undefined) continue;
        const height = segment.height * share;
        if (!(height > 0)) continue;
        overlays.push({
          key: segment.key,
          colorVar: segment.colorVar,
          bucketIndex: segment.bucketIndex,
          x: segment.x,
          y: segment.y + segment.height - height,
          width: segment.width,
          height,
          radius: Math.min(segment.radius, height / 2),
        });
      }
    }
    return overlays;
  });
  const compositionSummary = (): ChartSummaryItem | undefined => {
    const composition = props.composition;
    if (composition === undefined) return undefined;
    const tokenShare = compositionTokenShare(composition.totals.total, props.usage.totals.total);
    const contribution = costContribution(composition.totals, props.usage.totals);
    const costShareText =
      contribution.share === undefined
        ? undefined
        : `${formatPercentExact(contribution.share * 100)} of estimate`;
    return {
      label: composition.label,
      value: `${formatTokenCount(composition.totals.total)} tokens · ${formatPercentExact(tokenShare === undefined ? undefined : tokenShare * 100)}`,
      info: <EstimateInfo totals={composition.totals} />,
      emphasis: "secondary",
      note: (
        <span class="qg-composition-summary">
          <span>{formatCostText(composition.totals)}</span>
          <Show
            when={costShareText}
            fallback={
              <>
                <Show when={contribution.partial}>
                  <EstimateNote totals={composition.totals} showExclusionTitle={false} />
                </Show>
                <Show
                  when={
                    !contribution.partial &&
                    !contribution.unpriced &&
                    !contribution.complete &&
                    composition.totals.total > 0
                  }
                >
                  <span>Cost share unavailable: estimate incomplete.</span>
                </Show>
              </>
            }
          >
            {(text) => <span>· {text()}</span>}
          </Show>
        </span>
      ),
    };
  };
  const summaryItems = (): ChartSummaryItem[] => {
    const items: ChartSummaryItem[] = [
      {
        label: "Total tokens",
        value: formatExactCount(props.usage.totals.total),
        emphasis: "primary",
      },
      {
        label: "API-equivalent estimate",
        value: formatCostText(props.usage.totals),
        info: <EstimateInfo totals={props.usage.totals} />,
        note: <EstimateNote totals={props.usage.totals} showExclusionTitle={false} />,
      },
    ];
    const project = compositionSummary();
    if (project !== undefined) items.push(project);
    return items;
  };
  const activeBucket = (): Bucket | undefined => {
    const index = active();
    return index === undefined ? undefined : props.usage.buckets[index];
  };
  const activeCompositionBucket = (): CostedTokens | undefined => {
    const index = active();
    return index === undefined ? undefined : compositionBucket(props.composition, index);
  };
  const rateText = (value: number | null | undefined): string => formatPercentExact(value);
  const activeRate = (): number | null | undefined => {
    const bucket = activeBucket();
    return bucket === undefined ? undefined : cacheHitRate(bucket.tokens);
  };
  const bucketLabel = (bucket: Bucket, index: number): string => {
    const rate = cacheHitRate(bucket.tokens);
    const categories = geometry()
      .visibleCategories.map(
        (category) => `${category.label} ${formatExactCount(bucket.tokens[category.key])}`,
      )
      .join(", ");
    const project = compositionBucket(props.composition, index);
    const composition =
      project === undefined
        ? ""
        : `, ${props.composition?.label ?? "Project"} ${formatExactCount(project.total)} tokens, API-equivalent ${formatCostText(project)}`;
    return `${formatBucketTick(bucket.startMs, props.usage.bucketUnit, timeZone())}: total ${formatExactCount(bucket.tokens.total)} tokens${categories.length > 0 ? `, ${categories}` : ""}, cache rate ${rateText(rate)}${composition}`;
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
        <ul
          class="qg-legend"
          ref={(element) => {
            legendElement = element;
          }}
        >
          <For each={geometry().visibleCategories}>
            {(category) => (
              <li class="qg-legend__entry">
                <button
                  type="button"
                  class="qg-legend__item"
                  aria-label={`Highlight ${category.label}`}
                  aria-pressed={pinnedCategory() === category.key ? "true" : "false"}
                  style={{ "--qg-swatch": `var(${category.colorVar})` }}
                  data-pinned={pinnedCategory() === category.key ? "true" : undefined}
                  data-pinnable="true"
                  onPointerEnter={() => setHoveredCategory(category.key)}
                  onPointerLeave={() => setHoveredCategory(undefined)}
                  onFocus={() => setFocusedCategory(category.key)}
                  onBlur={() => setFocusedCategory(undefined)}
                  onClick={() => togglePinned(category.key)}
                >
                  <span class="qg-legend__swatch" aria-hidden="true" />
                  <span class="qg-legend__label">{category.label}</span>
                  <span class="qg-legend__value">
                    {formatTokenCount(props.usage.totals[category.key])}
                  </span>
                </button>
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the plot click only dismisses a pinned legend selection; contained controls carry the actions. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: dismissal is pointer-only; keyboard users can clear the pin from the legend. */}
        <div
          ref={(element) => {
            ref(element);
            tooltipLayout.chartRef(element);
          }}
          class="qg-chart"
          data-highlight={highlight() === undefined ? undefined : "true"}
          onClick={clearPinned}
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
                      data-composition={props.composition === undefined ? undefined : "base"}
                      data-highlighted={highlightAttr(highlight(), segment.key)}
                      {...segmentRectProps(segment)}
                    />
                  )}
                </For>
              )}
            </For>

            <For each={compositionOverlays()}>
              {(segment) => (
                <rect
                  class="qg-chart__composition"
                  data-category={segment.key}
                  data-bucket={segment.bucketIndex}
                  data-highlighted={highlightAttr(highlight(), segment.key)}
                  {...segmentRectProps(segment)}
                />
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
            data-composition-target="chart"
            style={plotInsetStyle(geometry().plot, size)}
            onPointerLeave={() => {
              inspection.clearPointer();
              props.onCompositionPointerChange?.(undefined);
            }}
          >
            <For each={props.usage.buckets}>
              {(bucket, index) => (
                <button
                  type="button"
                  class="qg-chart__hit"
                  aria-label={bucketLabel(bucket, index())}
                  style={slotHitStyle(geometry().plot, geometry().slotX(index()), geometry().slot)}
                  onPointerEnter={() => {
                    inspection.inspectPointer(index());
                    if (props.composition !== undefined) {
                      props.onCompositionPointerChange?.(props.composition.projectId);
                    }
                  }}
                  onFocus={() => {
                    inspection.inspectFocus(index());
                    if (props.composition !== undefined) {
                      props.onCompositionFocusChange?.(props.composition.projectId);
                    }
                  }}
                  onBlur={() => {
                    inspection.clearFocus();
                    props.onCompositionFocusChange?.(undefined);
                  }}
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
                <Show when={activeCompositionBucket()}>
                  {(part) => (
                    <>
                      <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--project">
                        <span
                          class="qg-tooltip__swatch qg-tooltip__swatch--project"
                          aria-hidden="true"
                        />
                        <span class="qg-totals__label">{props.composition?.label}</span>
                        <span
                          class="qg-totals__value"
                          data-cost-status={
                            part().total > 0 && part().apiEquivalentCostUsd === null
                              ? "unpriced"
                              : undefined
                          }
                        >
                          {formatExactCount(part().total)} · {formatCostText(part())}
                        </span>
                      </div>
                      <Show when={estimateNote(part()) === "Partial estimate"}>
                        <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--note">
                          <EstimateNote totals={part()} showExclusionTitle={false} />
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
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
                <Show when={props.composition}>
                  {(composition) => <th scope="col">{composition().label} tokens</th>}
                </Show>
                <th scope="col">Cache rate</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.usage.buckets}>
                {(bucket, index) => (
                  <tr>
                    <th scope="row">
                      {formatBucketTick(bucket.startMs, props.usage.bucketUnit, timeZone())}
                    </th>
                    <For each={geometry().visibleCategories}>
                      {(category) => <td>{formatExactCount(bucket.tokens[category.key])}</td>}
                    </For>
                    <Show when={props.composition}>
                      {(composition) => (
                        <td>
                          {formatExactCount(compositionBucket(composition(), index())?.total ?? 0)}
                        </td>
                      )}
                    </Show>
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
