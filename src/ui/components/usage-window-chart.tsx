import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type {
  UsageInterval,
  UsageLink,
  UsageModelKey,
  UsageRangeKey,
  UsageWindowSeries,
} from "../../contracts/usage";
import type { ChartSize } from "../chart-geometry";
import { createChartInspection, nextInspectionIndex, pointerPlotX } from "../chart-inspection";
import { createChartLayout, plotInsetStyle } from "../chart-layout";
import { formatClock, formatDay, formatPercent, formatPercentExact } from "../format";
import { plotRect } from "../plot-rect";
import { chartTooltipStyle, createChartTooltipLayout } from "../tooltip-layout";
import { buildUsageStepGeometry } from "../usage-chart-geometry";
import {
  displayPercent,
  formatPp,
  observedChangeText,
  percentModeLabel,
  type QuotaPercentMode,
} from "../usage-model";
import { type UsageRunwayHint, usageRunwayProjection } from "../usage-runway";

/**
 * One compact quota-window plot. The header carries the few numbers the view
 * needs; the chart keeps only observed runs, gaps, boundaries and the runway
 * projection. Caveat prose lives in the view's single info popover.
 */
const WINDOW_CHART_SIZE: ChartSize = {
  width: 900,
  height: 132,
  padding: { top: 8, right: 16, bottom: 20, left: 34 },
};

const PERCENT_TICKS = [100, 50, 0] as const;
const AXIS_FRACTIONS = [0, 0.5, 1] as const;
const TIME_ONLY_SPAN_MS = 36 * 60 * 60 * 1_000;

function axisTickLabel(ms: number, span: number, timeZone: string): string {
  return span <= TIME_ONLY_SPAN_MS ? formatClock(ms, timeZone) : formatDay(ms, timeZone);
}

function inspectionTimes(
  startMs: number,
  endMs: number,
  axisSpanMs: number,
  timeZone: string,
): string {
  const longAxis = axisSpanMs > TIME_ONLY_SPAN_MS;
  const startDay = formatDay(startMs, timeZone);
  const endDay = formatDay(endMs, timeZone);
  const sameClock = formatClock(startMs, timeZone) === formatClock(endMs, timeZone);
  const datePrefix = longAxis || startDay !== endDay;
  const start = `${datePrefix ? `${startDay} ` : ""}${formatClock(startMs, timeZone)}`;
  if (sameClock) return start;
  const end = `${startDay !== endDay ? `${endDay} ` : ""}${formatClock(endMs, timeZone)}`;
  return `${start}–${end}`;
}

/** The short reason a boundary or gap shows; never a sentence. */
function stateLabel(link: UsageLink | undefined): string | undefined {
  if (link?.kind === "unobserved") return "Monitoring gap";
  if (link?.kind !== "boundary") return undefined;
  switch (link.boundary) {
    case "reset":
      return link.atMs === undefined ? "Reset time unknown" : "Reset";
    case "replenished":
      return "Replenished";
    case "identity-change":
      return "Identity change";
    default:
      return "Uncertain boundary";
  }
}

/** Interval activity when the server supplied it; a measured point otherwise. */
interface ActiveView {
  startMs: number;
  endMs: number;
  remaining: number;
  burnPercentPoints: number | null;
  attributed: number;
  linkKind: UsageLink["kind"];
  /** Boundary link for this interval, when one exists. */
  link: UsageLink | undefined;
}

function viewFromInterval(interval: UsageInterval, link: UsageLink | undefined): ActiveView {
  return {
    startMs: interval.startMs,
    endMs: interval.endMs,
    remaining: interval.currentRemainingPercent,
    burnPercentPoints: interval.burnPercentPoints,
    attributed: interval.attributedBurnPercentPoints,
    linkKind: interval.link,
    link,
  };
}

export function UsageWindowChart(props: {
  window: UsageWindowSeries;
  models?: UsageModelKey[];
  accountLabel: string;
  mode: QuotaPercentMode;
  timeZone: string;
  range: UsageRangeKey;
  nowMs: number;
  runway?: UsageRunwayHint;
  headingId: string;
}): JSX.Element {
  const inspection = createChartInspection();
  const active = inspection.active;
  // The compact height holds at every width: the narrow legacy layout doubled
  // it to 220px, which made the phone view taller than the desktop one.
  const { size, ref } = createChartLayout(WINDOW_CHART_SIZE, {
    narrowHeight: WINDOW_CHART_SIZE.height,
  });

  const latestPoint = () => props.window.points.at(-1);
  const projection = createMemo(() =>
    usageRunwayProjection({
      last: latestPoint(),
      hint: props.runway,
      axis: props.window.axis,
      range: props.range,
      nowMs: props.nowMs,
    }),
  );
  // Current extends its axis to include the projection; every other range draws
  // only one that already fits. History bands still stop at the requested axis
  // end, so future time is not shaded as missing history.
  const renderAxis = createMemo(() => {
    const axis = props.window.axis;
    const projected = projection();
    return projected !== undefined && projected.endMs > axis.endMs
      ? { startMs: axis.startMs, endMs: projected.endMs }
      : axis;
  });
  const axisSpanMs = () => renderAxis().endMs - renderAxis().startMs;

  const geometry = createMemo(() =>
    buildUsageStepGeometry({
      axis: renderAxis(),
      plot: plotRect(size),
      mode: props.mode,
      points: props.window.points,
      links: props.window.links,
      intervals: props.window.intervals,
      ...(props.window.conflicts !== undefined ? { conflicts: props.window.conflicts } : {}),
      historyEndMs: props.window.axis.endMs,
      ...(projection() === undefined
        ? {}
        : {
            projection: {
              fromMs: latestPoint()?.endMs ?? props.window.axis.startMs,
              fromRemainingPercent: latestPoint()?.remainingPercent ?? 100,
              toMs: projection()?.endMs ?? props.window.axis.endMs,
              ...(projection()?.toRemainingPercent === undefined
                ? {}
                : { toRemainingPercent: projection()?.toRemainingPercent }),
            },
          }),
    }),
  );
  const activeUnit = () => {
    const index = active();
    return index === undefined ? undefined : geometry().units[index];
  };

  const activeView = (): ActiveView | undefined => {
    const unit = activeUnit();
    if (unit === undefined) return undefined;
    const interval = props.window.intervals[unit.intervalIndex];
    if (interval !== undefined) {
      return viewFromInterval(interval, props.window.links[interval.fromPoint]);
    }
    const point = props.window.points[unit.intervalIndex];
    if (point !== undefined) {
      return {
        startMs: point.startMs,
        endMs: point.endMs,
        remaining: point.remainingPercent,
        burnPercentPoints: 0,
        attributed: 0,
        linkKind: "observed",
        link: undefined,
      };
    }
    const linkIndex = unit.intervalIndex - props.window.points.length;
    const link = props.window.links[linkIndex];
    const from = props.window.points[linkIndex];
    const to = props.window.points[linkIndex + 1];
    if (link === undefined || from === undefined || to === undefined) return undefined;
    return {
      startMs: Math.max(from.endMs, props.window.axis.startMs),
      endMs: Math.min(to.startMs, props.window.axis.endMs),
      remaining: to.remainingPercent,
      burnPercentPoints:
        link.kind === "boundary" ? null : Math.max(0, from.remainingPercent - to.remainingPercent),
      attributed: 0,
      linkKind: link.kind,
      link,
    };
  };

  const tooltipLayout = createChartTooltipLayout(
    () => {
      const unit = activeUnit();
      if (unit === undefined) return 0;
      return geometry().xForMs(unit.anchorMs) / size.width;
    },
    undefined,
    () => {
      const view = activeView();
      return view === undefined ? 0 : geometry().yForPercent(view.remaining);
    },
  );
  const tooltipStyle = (): JSX.CSSProperties =>
    chartTooltipStyle(tooltipLayout.position(), { minWidth: 150 });

  const axisTicks = createMemo(() => {
    const { startMs, endMs } = renderAxis();
    const span = endMs - startMs;
    return AXIS_FRACTIONS.map((fraction) => startMs + span * fraction);
  });

  const latestRemaining = () => latestPoint()?.remainingPercent;
  const latestPercent = () =>
    latestRemaining() === undefined
      ? undefined
      : displayPercent(latestRemaining() as number, props.mode);
  const latestText = () =>
    latestPercent() === undefined ? "No history" : formatPercent(latestPercent());

  const stateNote = (): string | undefined => {
    const view = activeView();
    if (view === undefined || view.linkKind === "observed") return undefined;
    return stateLabel(view.link);
  };

  const intervalTime = (): string => {
    const view = activeView();
    return view === undefined
      ? ""
      : inspectionTimes(view.startMs, view.endMs, axisSpanMs(), props.timeZone);
  };

  const ariaText = (): string => {
    const view = activeView();
    const unit = activeUnit();
    if (view === undefined || unit === undefined) return "No usage intervals in this range";
    const parts = [
      props.window.label,
      inspectionTimes(view.startMs, view.endMs, axisSpanMs(), props.timeZone),
      `${percentModeLabel(props.mode)} ${formatPercentExact(displayPercent(view.remaining, props.mode))}`,
    ];
    if (view.burnPercentPoints !== null && view.burnPercentPoints > 0) {
      parts.push(`observed change ${observedChangeText(view.burnPercentPoints, props.mode)}`);
    }
    if (view.attributed > 0) {
      parts.push(`estimated ${formatPp(view.attributed)}`);
    }
    const note = stateNote();
    parts.push(note ?? "Observed");
    return parts.join(", ");
  };

  const chartAriaLabel = (): string => {
    const axis = renderAxis();
    const estimate = projection() === undefined ? "" : " An amber dashed line projects runway.";
    return `${props.accountLabel} ${props.window.label}: ${percentModeLabel(props.mode).toLowerCase()} percent from ${formatDay(axis.startMs, props.timeZone)} to ${formatDay(axis.endMs, props.timeZone)}. Dashed connectors mark monitoring gaps; shaded bands have no history.${estimate}`;
  };

  const pointerAt = (event: PointerEvent): void => {
    const x = pointerPlotX(event, geometry().plot);
    if (x === undefined) return;
    inspection.inspectPointer(geometry().unitAtX(x));
  };

  const keyAt = (event: KeyboardEvent): void => {
    const next = nextInspectionIndex(event, geometry().units.length, active() ?? 0);
    if (next === undefined) return;
    event.preventDefault();
    inspection.clearPointer();
    inspection.inspectFocus(next);
  };

  return (
    <section class="qg-usage-window" aria-labelledby={props.headingId}>
      <header class="qg-usage-window__head">
        <h3 class="qg-usage-window__title" id={props.headingId}>
          {props.window.label}
          <Show when={props.window.measurement === "locally-estimated"}>
            <span
              class="qg-usage-window__estimate-tag"
              title="Locally estimated, not a provider measurement"
            >
              est.
            </span>
          </Show>
        </h3>
        <div class="qg-usage-window__stats">
          <span class="qg-usage-window__value" title="Latest observed reading">
            {latestText()}
            <Show when={latestPercent() !== undefined}>
              <span class="qg-usage-window__mode">
                {" "}
                {percentModeLabel(props.mode).toLowerCase()}
              </span>
            </Show>
          </span>
          <span
            class="qg-usage-window__change"
            title="Observed change across this range, from measured endpoints"
          >
            {observedChangeText(props.window.totals.observedBurnPercentPoints, props.mode)}
          </span>
          <Show when={props.window.totals.attributedBurnPercentPoints > 0}>
            <span
              class="qg-usage-window__estimate"
              title="Estimated share of the observed change from recorded OpenCode activity"
            >
              est. {formatPp(props.window.totals.attributedBurnPercentPoints)}
            </span>
          </Show>
        </div>
      </header>

      <div
        ref={(element) => {
          ref(element);
          tooltipLayout.chartRef(element);
        }}
        class="qg-chart qg-usage-chart"
      >
        <svg
          class="qg-usage-chart__plot"
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={chartAriaLabel()}
        >
          <For each={geometry().unavailable}>
            {(band) => (
              <rect
                class="qg-usage-chart__unavailable"
                x={geometry().xForMs(band.startMs)}
                y={geometry().plot.top}
                width={Math.max(0, geometry().xForMs(band.endMs) - geometry().xForMs(band.startMs))}
                height={geometry().plot.height}
              />
            )}
          </For>

          <For each={PERCENT_TICKS}>
            {(value) => {
              const y = () => geometry().yForPercent(props.mode === "used" ? 100 - value : value);
              return (
                <>
                  <line
                    class="qg-chart__grid-line"
                    x1={geometry().plot.left}
                    x2={geometry().plot.right}
                    y1={y()}
                    y2={y()}
                  />
                  <text
                    class="qg-chart__axis-label"
                    x={geometry().plot.left - 6}
                    y={y() + 3}
                    text-anchor="end"
                  >
                    {value}%
                  </text>
                </>
              );
            }}
          </For>

          <For each={axisTicks()}>
            {(ms) => (
              <text
                class="qg-chart__axis-label"
                x={geometry().xForMs(ms)}
                y={size.height - 6}
                text-anchor="middle"
              >
                {axisTickLabel(ms, axisSpanMs(), props.timeZone)}
              </text>
            )}
          </For>

          <For each={geometry().solidPaths}>
            {(path) => <path class="qg-usage-chart__line" d={path} />}
          </For>
          <For each={geometry().unobservedPaths}>
            {(path) => <path class="qg-usage-chart__gap" d={path} />}
          </For>
          <For each={geometry().isolated}>
            {(point) => <circle class="qg-usage-chart__sample" cx={point.x} cy={point.y} r="1.6" />}
          </For>

          <Show when={geometry().projectionPath}>
            {(path) => <path class="qg-usage-chart__projection" d={path()} />}
          </Show>

          <Show when={geometry().latest}>
            {(point) => (
              <circle class="qg-usage-chart__latest" cx={point().x} cy={point().y} r="2.6" />
            )}
          </Show>

          <Show when={geometry().projectionEnd}>
            {(point) => (
              <Show when={projection()?.toRemainingPercent !== undefined}>
                <circle
                  class="qg-usage-chart__projection-end"
                  cx={point().x}
                  cy={point().y}
                  r="2"
                />
              </Show>
            )}
          </Show>

          <For each={geometry().markers}>
            {(marker) => (
              <g class="qg-usage-chart__boundary" data-boundary={marker.boundary}>
                <line
                  class="qg-usage-chart__reset"
                  x1={marker.x}
                  x2={marker.x}
                  y1={geometry().plot.top}
                  y2={geometry().plot.bottom}
                />
                <rect
                  class="qg-usage-chart__reset-mark"
                  x={marker.x - 3}
                  y={geometry().plot.top + 2}
                  width="6"
                  height="6"
                  transform={`rotate(45 ${marker.x} ${geometry().plot.top + 5})`}
                />
              </g>
            )}
          </For>

          <Show when={activeView()}>
            {(view) => {
              const unit = activeUnit();
              const x = unit === undefined ? 0 : geometry().xForMs(unit.anchorMs);
              return (
                <>
                  <line
                    class="qg-chart__cursor"
                    x1={x}
                    x2={x}
                    y1={geometry().plot.top}
                    y2={geometry().plot.bottom}
                  />
                  <circle
                    class="qg-usage-chart__active-point"
                    cx={x}
                    cy={geometry().yForPercent(view().remaining)}
                    r="2.2"
                  />
                </>
              );
            }}
          </Show>
        </svg>

        <Show when={props.window.points.length === 0}>
          <p class="qg-usage-chart__empty">No history in this range.</p>
        </Show>

        <div
          class="qg-chart__surface"
          role="slider"
          tabIndex={0}
          aria-label={`Inspect ${props.accountLabel} ${props.window.label} usage`}
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, geometry().units.length)}
          aria-valuenow={(active() ?? 0) + 1}
          aria-valuetext={ariaText()}
          style={plotInsetStyle(geometry().plot, size)}
          onPointerMove={pointerAt}
          onPointerLeave={inspection.clearPointer}
          onFocus={() => inspection.inspectFocus(active() ?? 0)}
          onBlur={inspection.clearFocus}
          onKeyDown={keyAt}
        />

        <Show when={activeView()}>
          {(view) => (
            <output
              ref={tooltipLayout.tooltipRef}
              class="qg-tooltip qg-usage-chart__tooltip"
              style={tooltipStyle()}
            >
              <div class="qg-usage-tooltip__time">{intervalTime()}</div>
              <div class="qg-usage-tooltip__row">
                <span>{percentModeLabel(props.mode)}</span>
                <span>{formatPercentExact(displayPercent(view().remaining, props.mode))}</span>
              </div>
              <Show when={view().burnPercentPoints !== null && (view().burnPercentPoints ?? 0) > 0}>
                <div class="qg-usage-tooltip__row">
                  <span>Change</span>
                  <span>{observedChangeText(view().burnPercentPoints as number, props.mode)}</span>
                </div>
              </Show>
              <Show when={view().attributed > 0}>
                <div class="qg-usage-tooltip__row">
                  <span>Est.</span>
                  <span>{formatPp(view().attributed)}</span>
                </div>
              </Show>
              <Show when={stateNote()}>
                {(note) => <p class="qg-usage-tooltip__note">{note()}</p>}
              </Show>
            </output>
          )}
        </Show>
      </div>
    </section>
  );
}
