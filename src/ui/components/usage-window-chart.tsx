import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { UsageModelKey, UsageWindowSeries } from "../../contracts/usage";
import type { ChartSize } from "../chart-geometry";
import { createChartInspection, nextInspectionIndex, pointerPlotX } from "../chart-inspection";
import { createChartLayout, plotInsetStyle } from "../chart-layout";
import {
  formatClock,
  formatDateOnly,
  formatDay,
  formatElapsed,
  formatExactCount,
  formatModelIdentity,
  formatPercentExact,
  formatTimestamp,
  formatTimestampMinutes,
  formatTokenCount,
} from "../format";
import { formatCostText } from "../model-analytics";
import { plotRect } from "../plot-rect";
import { chartTooltipStyle, createChartTooltipLayout } from "../tooltip-layout";
import { buildUsageStepGeometry } from "../usage-chart-geometry";
import {
  ATTRIBUTION_DISCLOSURE,
  attributedText,
  coveragePercent,
  displayPercent,
  formatPp,
  intervalStateLabel,
  measurementLabel,
  observedChangeText,
  percentModeLabel,
  type QuotaPercentMode,
  UNATTRIBUTED_REASON_LABELS,
} from "../usage-model";
import { ChartSummary, type ChartSummaryItem } from "./chart-shell";

/** Compact one-window plot; the account card stacks these full-width. */
const WINDOW_CHART_SIZE: ChartSize = {
  width: 900,
  height: 220,
  padding: { top: 14, right: 18, bottom: 30, left: 46 },
};

const PERCENT_TICKS = [100, 75, 50, 25, 0] as const;

function axisTickLabel(ms: number, span: number, timeZone: string): string {
  if (span <= 36 * 60 * 60 * 1_000) return formatClock(ms, timeZone);
  if (span <= 14 * 24 * 60 * 60 * 1_000) return formatDay(ms, timeZone);
  return formatDateOnly(ms, timeZone);
}

function percentValue(value: number, mode: QuotaPercentMode): string {
  return `${percentModeLabel(mode)} ${formatPercentExact(value)}`;
}

export function UsageWindowChart(props: {
  window: UsageWindowSeries;
  models: UsageModelKey[];
  accountLabel: string;
  mode: QuotaPercentMode;
  timeZone: string;
  headingId: string;
}): JSX.Element {
  const inspection = createChartInspection();
  const active = inspection.active;
  const { size, ref } = createChartLayout(WINDOW_CHART_SIZE);

  const geometry = createMemo(() =>
    buildUsageStepGeometry({
      axis: props.window.axis,
      plot: plotRect(size),
      mode: props.mode,
      points: props.window.points,
      links: props.window.links,
      intervals: props.window.intervals,
      ...(props.window.conflicts !== undefined ? { conflicts: props.window.conflicts } : {}),
    }),
  );
  const activeUnit = () => {
    const index = active();
    return index === undefined ? undefined : geometry().units[index];
  };
  const activeInterval = () => {
    const unit = activeUnit();
    return unit === undefined ? undefined : props.window.intervals[unit.intervalIndex];
  };
  const activeLink = () => {
    const interval = activeInterval();
    return interval === undefined ? undefined : props.window.links[interval.fromPoint];
  };
  const missingPreciseReset = () => {
    const link = activeLink();
    return link?.kind === "boundary" && link.atMs === undefined;
  };
  const activeState = () => {
    const interval = activeInterval();
    return interval === undefined ? "" : intervalStateLabel(interval, activeLink(), props.timeZone);
  };

  const tooltipLayout = createChartTooltipLayout(() => {
    const unit = activeUnit();
    if (unit === undefined) return 0;
    return geometry().xForMs((unit.startMs + unit.endMs) / 2) / size.width;
  });
  const tooltipStyle = (): JSX.CSSProperties => chartTooltipStyle(tooltipLayout.position());

  const axisTicks = createMemo(() => {
    const { startMs, endMs } = props.window.axis;
    const span = endMs - startMs;
    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => startMs + span * fraction);
  });

  const coverage = () => coveragePercent(props.window);
  const reasons = createMemo(() => {
    const unique = new Set<string>();
    for (const interval of props.window.intervals) {
      if (interval.unattributedReason !== undefined) {
        unique.add(UNATTRIBUTED_REASON_LABELS[interval.unattributedReason]);
      }
    }
    return [...unique];
  });

  const summaryItems = (): ChartSummaryItem[] => {
    const totals = props.window.totals;
    const first = props.window.coverage.firstObservedAtMs;
    const last = props.window.coverage.lastObservedAtMs;
    return [
      {
        label: "Observed change",
        value: formatPp(totals.observedBurnPercentPoints),
        emphasis: "primary",
        note: "Measured endpoints, not an estimate",
      },
      {
        label: "Estimated attribution",
        value: attributedText(totals.attributedBurnPercentPoints),
        note: "Estimated from recorded activity",
      },
      {
        label: "Unattributed",
        value: formatPp(totals.unattributedBurnPercentPoints),
        note: reasons().length > 0 ? reasons().join(" · ") : "No unassigned change",
      },
      {
        label: "History span",
        value: first === undefined ? "No history" : formatTimestampMinutes(first, props.timeZone),
        title:
          first === undefined
            ? undefined
            : `First observation ${formatTimestamp(first, props.timeZone)}`,
        note: last === undefined ? undefined : `to ${formatTimestampMinutes(last, props.timeZone)}`,
      },
      {
        label: "Observed coverage",
        value: `${coverage().toFixed(0)}% of axis`,
        note: `${formatElapsed(props.window.coverage.observedMs)} observed · ${formatExactCount(props.window.coverage.sampleCount)} samples`,
      },
    ];
  };

  const activityText = (): string => {
    const interval = activeInterval();
    if (interval === undefined) return "";
    const rows = interval.activity.map((activity) => {
      const model = props.models[activity.model];
      const identity = model === undefined ? "Unknown model" : formatModelIdentity(model);
      const estimate =
        activity.estimatedBurnPercentPoints === undefined
          ? ""
          : `, ${formatPp(activity.estimatedBurnPercentPoints)} estimated`;
      return `${identity}, ${formatExactCount(activity.tokens.total)} tokens${estimate}`;
    });
    return rows.join("; ");
  };

  const ariaText = (): string => {
    const interval = activeInterval();
    const unit = activeUnit();
    if (interval === undefined || unit === undefined) return "No usage intervals in this range";
    const parts = [
      props.window.label,
      `${formatTimestamp(interval.startMs, props.timeZone)} to ${formatTimestamp(interval.endMs, props.timeZone)}`,
      activeState(),
      percentValue(displayPercent(interval.currentRemainingPercent, props.mode), props.mode),
    ];
    if (interval.burnPercentPoints !== null) {
      parts.push(`observed change ${observedChangeText(interval.burnPercentPoints, props.mode)}`);
    }
    if (interval.attributedBurnPercentPoints > 0) {
      parts.push(`estimated attribution ${formatPp(interval.attributedBurnPercentPoints)}`);
    }
    if (interval.unattributedBurnPercentPoints > 0) {
      parts.push(`unattributed ${formatPp(interval.unattributedBurnPercentPoints)}`);
    }
    const activity = activityText();
    if (activity.length > 0) parts.push(activity);
    return parts.join(", ");
  };

  const chartAriaLabel = (): string => {
    const { axis } = props.window;
    return `${props.accountLabel} ${props.window.label}: ${percentModeLabel(props.mode).toLowerCase()} percent from ${formatTimestampMinutes(axis.startMs, props.timeZone)} to ${formatTimestampMinutes(axis.endMs, props.timeZone)}. ${props.window.points.length} observed runs, ${coverage().toFixed(0)}% observed coverage. Dashed connectors mark unobserved monitoring gaps; shaded bands have no history.`;
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
    <section class="qg-chart-shell qg-usage-window" aria-labelledby={props.headingId}>
      <header class="qg-chart-shell__head">
        <h3 class="qg-chart-shell__title" id={props.headingId}>
          <span class="qg-chart__title">{props.window.label}</span>
        </h3>
        <div class="qg-chart-shell__actions">
          <span
            class="qg-usage-badge"
            data-measurement={props.window.measurement}
            title={measurementLabel(props.window.measurement)}
          >
            {props.window.measurement === "provider-observed" ? "Observed" : "Estimated"}
          </span>
        </div>
      </header>
      <div class="qg-chart-shell__panel">
        <ChartSummary items={summaryItems()} />
        <div class="qg-usage qg-usage--quota">
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
                    width={Math.max(
                      0,
                      geometry().xForMs(band.endMs) - geometry().xForMs(band.startMs),
                    )}
                    height={geometry().plot.height}
                  />
                )}
              </For>

              <For each={PERCENT_TICKS}>
                {(value) => {
                  const y = () =>
                    geometry().yForPercent(props.mode === "used" ? 100 - value : value);
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
                        class="qg-chart__axis-label qg-usage-chart__axis-label"
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
              <text
                class="qg-chart__axis-title"
                x={geometry().plot.left}
                y={geometry().plot.top - 2}
              >
                {percentModeLabel(props.mode)}
              </text>

              <For each={axisTicks()}>
                {(ms) => (
                  <text
                    class="qg-chart__axis-label"
                    x={geometry().xForMs(ms)}
                    y={size.height - 8}
                    text-anchor="middle"
                  >
                    {axisTickLabel(
                      ms,
                      props.window.axis.endMs - props.window.axis.startMs,
                      props.timeZone,
                    )}
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
                {(point) => (
                  <circle class="qg-usage-chart__sample" cx={point.x} cy={point.y} r="2" />
                )}
              </For>

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

              <Show when={activeUnit()}>
                {(unit) => (
                  <line
                    class="qg-chart__cursor"
                    x1={geometry().xForMs((unit().startMs + unit().endMs) / 2)}
                    x2={geometry().xForMs((unit().startMs + unit().endMs) / 2)}
                    y1={geometry().plot.top}
                    y2={geometry().plot.bottom}
                  />
                )}
              </Show>
            </svg>

            <Show when={props.window.points.length === 0}>
              <p class="qg-usage-chart__empty">
                No observed history yet. The requested axis stays visible; shaded bands have no
                history.
              </p>
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

            <Show when={activeInterval()}>
              {(interval) => (
                <output
                  ref={tooltipLayout.tooltipRef}
                  class="qg-tooltip qg-usage-chart__tooltip"
                  style={tooltipStyle()}
                >
                  <div class="qg-tooltip__head">
                    <span>
                      {formatTimestamp(interval().startMs, props.timeZone)} –{" "}
                      {formatTimestamp(interval().endMs, props.timeZone)}
                    </span>
                    <span class="qg-usage-chart__state">{activeState()}</span>
                  </div>
                  <div class="qg-tooltip__group qg-tooltip__group--series">
                    <div class="qg-tooltip__grid-row">
                      <span class="qg-tooltip__label">Previous</span>
                      <span class="qg-tooltip__value">
                        {percentValue(
                          displayPercent(interval().previousRemainingPercent, props.mode),
                          props.mode,
                        )}
                      </span>
                    </div>
                    <div class="qg-tooltip__grid-row">
                      <span class="qg-tooltip__label">Current</span>
                      <span class="qg-tooltip__value">
                        {percentValue(
                          displayPercent(interval().currentRemainingPercent, props.mode),
                          props.mode,
                        )}
                      </span>
                    </div>
                    <div class="qg-tooltip__grid-row">
                      <span class="qg-tooltip__label">Observed change</span>
                      <span class="qg-tooltip__value">
                        {interval().burnPercentPoints === null
                          ? "—"
                          : observedChangeText(interval().burnPercentPoints as number, props.mode)}
                      </span>
                    </div>
                    <Show when={interval().link !== "observed"}>
                      <p class="qg-tooltip__note">
                        {intervalStateLabel(interval(), activeLink(), props.timeZone)}
                        {missingPreciseReset() ? " — no precise reset time is available." : ""}
                      </p>
                    </Show>
                  </div>

                  <Show when={interval().activity.length > 0}>
                    <div class="qg-tooltip__group">
                      <For each={interval().activity}>
                        {(activity) => {
                          const model = () => props.models[activity.model];
                          return (
                            <div class="qg-tooltip__row qg-usage-chart__activity">
                              <span class="qg-usage-chart__activity-model">
                                {model() === undefined
                                  ? "Unknown model"
                                  : formatModelIdentity(model() as UsageModelKey)}
                              </span>
                              <span class="qg-totals__value">
                                {formatTokenCount(activity.tokens.total)} tokens ·{" "}
                                {formatCostText(activity.tokens)} API-equivalent
                                <Show when={activity.estimatedBurnPercentPoints !== undefined}>
                                  {" · "}
                                  {attributedText(activity.estimatedBurnPercentPoints as number)}
                                </Show>
                              </span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={interval().burnPercentPoints !== null}>
                    <div class="qg-tooltip__group qg-tooltip__group--timing">
                      <div class="qg-tooltip__grid-row">
                        <span class="qg-tooltip__label">Estimated attribution</span>
                        <span class="qg-tooltip__value">
                          {attributedText(interval().attributedBurnPercentPoints)}
                        </span>
                      </div>
                      <div class="qg-tooltip__grid-row">
                        <span class="qg-tooltip__label">Unattributed</span>
                        <span class="qg-tooltip__value">
                          {formatPp(interval().unattributedBurnPercentPoints)}
                        </span>
                      </div>
                      <Show when={interval().unattributedReason}>
                        {(reason) => (
                          <p class="qg-tooltip__note">{UNATTRIBUTED_REASON_LABELS[reason()]}</p>
                        )}
                      </Show>
                      <p class="qg-tooltip__note">{ATTRIBUTION_DISCLOSURE}</p>
                    </div>
                  </Show>
                </output>
              )}
            </Show>
          </div>
        </div>
      </div>
    </section>
  );
}
