import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import {
  buildSessionChartGeometry,
  DEFAULT_SESSION_SIZE,
  type SessionCompactionTick,
} from "../chart-geometry";
import { chartIndexAt, createChartInspection } from "../chart-inspection";
import { createChartLayout } from "../chart-layout";
import {
  axisRangeCaption,
  formatDateOnly,
  formatElapsed,
  formatExactCount,
  formatModelIdentity,
  formatPercentExact,
  formatTimeOnly,
  formatTimestamp,
  formatTokenCount,
} from "../format";
import {
  formatCacheReuse,
  SESSION_GAP_LABELS,
  type SessionGap,
  type StepTiming,
  sessionGapMetrics,
  stepTimings,
} from "../session-gaps";
import { modelTransitions } from "../session-timing";
import { createChartTooltipLayout } from "../tooltip-layout";
import { ChartShell, ChartSummary, type ChartSummaryItem } from "./chart-shell";
import { ModelIdentityLabel } from "./model-identity";

/**
 * Session graphs (design spec §3; owner 13–17).
 *
 * One shared chart. The main-session variant plots only the orchestrator's own
 * steps: blue context, gold Cache Rate, turquoise own cumulative and the orange
 * tree cumulative aligned to those same step positions. Subagents contribute
 * only to the tree fold. The focus variant is one session's individual chart:
 * its own context, own cumulative and Cache Rate, with no descendants at all.
 *
 * Both cumulative series share one right-axis scale, while context keeps its
 * own left axis. Compaction markers annotate the main variant without resetting
 * either cumulative series.
 *
 * The x axis is the 1-based chronological rendered step sequence: plain
 * numbers, no dates and no fabricated zero. Pointer movement selects the
 * nearest rendered step immediately and drives a live vertical crosshair and
 * the shared custom tooltip; a keyboard slider exposes the same inspection
 * without timers or native `<title>` popups.
 */
export function SessionChart(props: {
  snapshot: SessionSnapshot;
  /** `main` is the project Session chart; `focus` is one session's individual chart. */
  variant: "main" | "focus";
  title?: string;
  /** Anchor for the shell heading; the view keeps its page identity separate. */
  headingId?: string;
}): JSX.Element {
  const inspection = createChartInspection();
  const active = inspection.active;
  const { size, ref } = createChartLayout(DEFAULT_SESSION_SIZE);
  const geometry = createMemo(() => buildSessionChartGeometry(props.snapshot, size));
  /** The plotted steps: this session's own rows, never its descendants'. */
  const steps = createMemo(() =>
    props.snapshot.steps.filter((step) => step.sessionId === props.snapshot.focusSessionId),
  );
  const transitions = createMemo(() => modelTransitions(steps(), props.snapshot.focusSessionId));
  const transitionAt = (index: number) => transitions().find((entry) => entry.stepIndex === index);
  /** Distinct model+variant identities; a single-model chart omits the per-step line. */
  const modelIdentities = createMemo(() => {
    const seen = new Set<string>();
    const identities: string[] = [];
    for (const step of steps()) {
      if (!step.model) continue;
      const identity = formatModelIdentity(step.model);
      if (seen.has(identity)) continue;
      seen.add(identity);
      identities.push(identity);
    }
    return identities;
  });
  const rateAt = (index: number): number | null => geometry().cache.rates[index] ?? null;
  const timings = createMemo(() => stepTimings(steps()));
  const timingAt = (index: number) => timings()[index];
  /** A stored 0 with an unknown counter is missing data, not a measured zero. */
  const cacheReadAt = (index: number): number | undefined => {
    const step = steps()[index];
    return step === undefined || step.cacheReadUnknown ? undefined : step.stack.cacheRead;
  };
  // Own-session sequencing, so gap step numbers match the plotted axis.
  const gaps = createMemo(() => sessionGapMetrics({ ...props.snapshot, steps: steps() }));
  const own = () => props.snapshot.ownSummary;
  const tree = () => props.snapshot.treeTotals;
  const timeZone = () => props.snapshot.timeZone;
  /** Only the main chart carries the tree series; individual charts never show descendants. */
  const showsTree = () => props.variant === "main" && geometry().hasDescendants;
  // The main chart disambiguates its two cumulative series; an individual chart
  // is the session itself, so its labels stay plain.
  const isMain = () => props.variant === "main";
  const contextSeriesLabel = () => (isMain() ? "Context · Main session" : "Context");
  const ownSeriesLabel = () => (isMain() ? "Cumulative · Main session" : "Cumulative");
  const cacheSeriesLabel = () => (isMain() ? "Cache Rate · Main session" : "Cache Rate");
  const stepsLabel = () => (isMain() ? "Steps (own)" : "Steps");
  const compactionsLabel = () => (isMain() ? "Compactions (focus session)" : "Compactions");
  /**
   * Prompt markers name their writer: the owner on the main chart or the root's
   * own view, the parent agent on a child's individual chart. No prompt text.
   */
  const focusIsRoot = () =>
    props.snapshot.nodes.find((node) => node.sessionId === props.snapshot.focusSessionId)
      ?.parentId === undefined;
  const inputMarkerLabel = () =>
    isMain() || focusIsRoot() ? "User prompt" : "Orchestrator message";
  const inputMarkerIndexes = createMemo(() =>
    steps().flatMap((step, index) => (step.inputMarker === true ? [index] : [])),
  );
  /**
   * Dates appear only when they add information: a cross-midnight step shows
   * both timestamps, and a multi-day session anchors Created. Otherwise the
   * tooltip stays time-only.
   */
  const multiDaySteps = createMemo(() => {
    const list = steps();
    const first = list[0];
    const last = list[list.length - 1];
    return (
      first !== undefined &&
      last !== undefined &&
      formatDateOnly(first.atMs, timeZone()) !== formatDateOnly(last.atMs, timeZone())
    );
  });
  const crossesMidnight = (timing: StepTiming): boolean =>
    timing.createdAtMs !== undefined &&
    formatDateOnly(timing.createdAtMs, timeZone()) !==
      formatDateOnly(timing.completedAtMs, timeZone());
  const createdText = (timing: StepTiming): string =>
    timing.createdAtMs === undefined
      ? "—"
      : crossesMidnight(timing) || multiDaySteps()
        ? formatTimestamp(timing.createdAtMs, timeZone())
        : formatTimeOnly(timing.createdAtMs, timeZone());
  const completedText = (timing: StepTiming): string =>
    crossesMidnight(timing)
      ? formatTimestamp(timing.completedAtMs, timeZone())
      : formatTimeOnly(timing.completedAtMs, timeZone());
  /** Descendant tokens after the last plotted main step; these never become a fake point. */
  const trailingTreeTokens = (): number => {
    if (!showsTree() || geometry().stepCount === 0) return 0;
    return Math.max(0, tree().total - (geometry().treeCumulativeValues.at(-1) ?? 0));
  };
  const compactionCount = () =>
    props.snapshot.compactionMarkers.filter(
      (marker) => marker.sessionId === props.snapshot.focusSessionId,
    ).length;
  const gapItem = (label: string, gap: SessionGap | null): ChartSummaryItem => {
    const item: ChartSummaryItem = {
      label,
      // The idle span and the reuse share share one card but never one line:
      // Cache reuse sits on its own row so the summary stays narrow.
      value: gap === null ? SESSION_GAP_LABELS.unavailable : formatElapsed(gap.idleMs),
      // Honest basis: stored message times, never an HTTP request interval or a cache lifetime.
      title:
        gap === null
          ? SESSION_GAP_LABELS.gapBasis
          : `${SESSION_GAP_LABELS.gapBasis} (steps ${gap.fromStepIndex + 1} → ${gap.toStepIndex + 1})`,
    };
    if (gap !== null) item.note = formatCacheReuse(gap.cacheReusePct);
    return item;
  };
  const gapItems = (): ChartSummaryItem[] => [
    gapItem(SESSION_GAP_LABELS.longestIdleGap, gaps().longestIdle),
    gapItem(SESSION_GAP_LABELS.longestHighReuseGap, gaps().longestHighReuse),
  ];
  const summaryItems = (): ChartSummaryItem[] => [
    ...(showsTree()
      ? [
          {
            label: "Tree total tokens",
            value: formatExactCount(tree().total),
            emphasis: "primary" as const,
          },
          {
            label: "This session · own tokens",
            value: formatExactCount(own().total),
          },
        ]
      : [
          {
            label: "Total tokens · this session",
            value: formatExactCount(own().total),
            emphasis: "primary" as const,
          },
        ]),
    ...gapItems(),
  ];

  const compactionAt = (index: number): SessionCompactionTick[] =>
    geometry().compaction.filter((marker) => marker.stepIndex === index);

  const contextValue = (index: number) => geometry().contextValues[index];
  const activeStep = () => {
    const index = active();
    return index === undefined ? undefined : steps()[index];
  };
  const activeCompactions = (): SessionCompactionTick[] => {
    const index = active();
    return index === undefined ? [] : compactionAt(index);
  };

  const tooltipLayout = createChartTooltipLayout(() => {
    const index = active();
    return index === undefined ? 0 : geometry().stepX(index) / size.width;
  });
  /** One style object keeps the Session overlay separate from the shared tooltip. */
  const tooltipStyle = (): JSX.CSSProperties => {
    const position = tooltipLayout.position();
    return {
      left: `${position.left}px`,
      top: `${position.top}px`,
      "min-width": `min(280px, ${position.maxWidth}px)`,
      "max-width": `${position.maxWidth}px`,
      "max-height": `${position.maxHeight}px`,
      visibility: position.visible ? "visible" : "hidden",
    };
  };

  const formatReuseWords = (rate: number | null): string =>
    rate === null ? SESSION_GAP_LABELS.unavailable : formatPercentExact(rate);

  const stepText = (index: number): string => {
    const step = steps()[index];
    if (!step) return `Step ${index + 1}`;
    const context = contextValue(index);
    const contextText =
      context === undefined ? "Context —" : `Context ${formatExactCount(context)}`;
    const parts = [
      `Step ${index + 1}`,
      formatTimestamp(step.atMs, timeZone()),
      contextText,
      `${ownSeriesLabel()} ${formatExactCount(geometry().ownCumulativeValues[index] ?? 0)}`,
    ];
    if (step.inputMarker) parts.push(`Input ${inputMarkerLabel()}`);
    if (showsTree()) {
      parts.push(
        `Cumulative · Session tree ${formatExactCount(geometry().treeCumulativeValues[index] ?? 0)}`,
      );
    }
    const rate = rateAt(index);
    parts.push(`${SESSION_GAP_LABELS.cacheReuse} ${formatReuseWords(rate)}`);
    const timing = timingAt(index);
    if (timing) {
      if (timing.durationMs !== undefined) {
        parts.push(`${SESSION_GAP_LABELS.messageDuration} ${formatElapsed(timing.durationMs)}`);
      }
      if (timing.overlap) parts.push(SESSION_GAP_LABELS.overlapsPrevious);
      else if (timing.idleMs !== undefined) {
        parts.push(`${SESSION_GAP_LABELS.idleSincePrevious} ${formatElapsed(timing.idleMs)}`);
      }
    }
    const change = transitionAt(index);
    if (change) {
      parts.push(
        `${change.kind === "model" ? "Model changed" : "Effort changed"} from ${formatModelIdentity(change.from)} to ${formatModelIdentity(change.to)}`,
      );
    }
    return parts.join(", ");
  };

  const pointerAt = (event: PointerEvent) => {
    const surface = event.currentTarget as HTMLElement | null;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const plot = geometry().plot;
    const x = plot.left + ((event.clientX - rect.left) / rect.width) * plot.width;
    inspection.inspectPointer(
      chartIndexAt({
        x,
        left: plot.left,
        width: plot.width,
        count: geometry().stepCount,
      }),
    );
  };

  const keyAt = (event: KeyboardEvent) => {
    const count = geometry().stepCount;
    if (count <= 0) return;
    const current = active() ?? 0;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = Math.min(count - 1, current + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = Math.max(0, current - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = count - 1;
    }
    if (next === undefined) return;
    event.preventDefault();
    // Keyboard inspection takes over from a lingering pointer position.
    inspection.clearPointer();
    inspection.inspectFocus(next);
  };

  /** Fractional token ticks stay readable instead of all rounding to “0”. */
  const formatAxisToken = (value: number): string => {
    if (!Number.isFinite(value)) return "—";
    if (value === 0) return "0";
    if (Math.abs(value) < 100) return Number(value.toPrecision(3)).toString();
    return formatTokenCount(value);
  };
  /**
   * Both headings share one row above the plot. At the narrow 9px size the
   * full pair needs about 204 chart units; 210 leaves a clear gap. Below that,
   * drop the repeated word "tokens" rather than let the two headings collide.
   * The chart's accessible name still spells out both axes in full.
   */
  const compactHeadings = (): boolean => geometry().plot.width < 210;
  const rangeEndCaption = (): string | undefined => {
    const count = geometry().stepCount;
    if (count <= 0) return undefined;
    return axisRangeCaption(`step ${count}`, count, geometry().labelIndexes);
  };

  return (
    <ChartShell
      title={props.title ?? "Usage by step"}
      headingId={props.headingId}
      summary={<ChartSummary items={summaryItems()} />}
      bodyClass="qg-usage qg-usage--session"
      aside={
        <>
          <div class="qg-totals">
            <div class="qg-totals__row">
              <span class="qg-totals__label">{stepsLabel()}</span>
              <span class="qg-totals__value">{formatExactCount(own().stepCount)}</span>
            </div>
            <Show when={showsTree()}>
              <div class="qg-totals__row">
                <span class="qg-totals__label">Steps (tree)</span>
                <span class="qg-totals__value">
                  {formatExactCount(props.snapshot.steps.length)}
                </span>
              </div>
            </Show>
            <div class="qg-totals__row">
              <span class="qg-totals__label">{compactionsLabel()}</span>
              <span class="qg-totals__value">{formatExactCount(compactionCount())}</span>
            </div>
          </div>

          <div class="qg-legend">
            <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-context)" }}>
              <span class="qg-legend__swatch" aria-hidden="true" />
              <span class="qg-legend__label">{contextSeriesLabel()}</span>
            </div>
            <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-own)" }}>
              <span class="qg-legend__swatch qg-legend__swatch--dashed" aria-hidden="true" />
              <span class="qg-legend__label">{ownSeriesLabel()}</span>
            </div>
            <Show when={showsTree()}>
              <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-total)" }}>
                <span class="qg-legend__swatch qg-legend__swatch--dashed" aria-hidden="true" />
                <span class="qg-legend__label">Cumulative · Session tree</span>
              </div>
            </Show>
            <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-rate)" }}>
              <span class="qg-legend__swatch" aria-hidden="true" />
              <span class="qg-legend__label">{cacheSeriesLabel()}</span>
            </div>
            <Show when={transitions().some((entry) => entry.kind === "model")}>
              <div class="qg-legend__item">
                <span class="qg-legend__mark qg-legend__mark--model" aria-hidden="true" />
                <span class="qg-legend__label">Model change</span>
              </div>
            </Show>
            <Show when={transitions().some((entry) => entry.kind === "effort")}>
              <div class="qg-legend__item">
                <span class="qg-legend__mark qg-legend__mark--effort" aria-hidden="true" />
                <span class="qg-legend__label">Effort change</span>
              </div>
            </Show>
            <Show when={inputMarkerIndexes().length > 0}>
              <div class="qg-legend__item">
                <span class="qg-legend__mark qg-legend__mark--input" aria-hidden="true" />
                <span class="qg-legend__label">{inputMarkerLabel()}</span>
              </div>
            </Show>
          </div>
        </>
      }
    >
      <div
        ref={(element) => {
          ref(element);
          tooltipLayout.chartRef(element);
        }}
        class="qg-chart"
      >
        <Show
          when={geometry().stepCount > 0}
          fallback={
            <p class="qg-empty">
              No completed steps in the {props.variant === "main" ? "main session" : "session"} yet.
            </p>
          }
        >
          <svg
            viewBox={`0 0 ${size.width} ${geometry().viewHeight}`}
            role="img"
            aria-label={`Step series for ${props.snapshot.focusSessionId}: ${props.variant === "main" ? "main-session" : "focus-session"} context on the left axis and cumulative consumption ${
              showsTree() ? "for this session and its session tree" : "for this session"
            } on the right axis, plus Cache rate from 0 to 100 percent of the plot height, over ${geometry().stepCount} completed ${
              geometry().stepCount === 1 ? "step" : "steps"
            }.${
              trailingTreeTokens() > 0
                ? " The orange Session tree line ends at the last step shown; descendants that ran later are counted only in the final tree total in the summary."
                : ""
            }`}
          >
            <text
              class="qg-chart__axis-title qg-chart__axis-title--context"
              x={geometry().plot.left}
              y={geometry().plot.top - 12}
              text-anchor="start"
            >
              {compactHeadings() ? "Context" : "Context tokens"}
            </text>
            <text
              class="qg-chart__axis-title qg-chart__axis-title--total"
              x={geometry().plot.right}
              y={geometry().plot.top - 12}
              text-anchor="end"
            >
              {compactHeadings() ? "Cumulative" : "Cumulative tokens"}
            </text>

            <For each={geometry().context.ticks}>
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
                    class="qg-chart__axis-label qg-chart__axis-label--context"
                    x={geometry().plot.left - 8}
                    y={tick.y + 3}
                    text-anchor="end"
                  >
                    {formatAxisToken(tick.value)}
                  </text>
                </>
              )}
            </For>

            <For each={geometry().cumulativeTicks}>
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
                    class="qg-chart__axis-label qg-chart__axis-label--total"
                    x={geometry().plot.right + 8}
                    y={tick.y + 3}
                    text-anchor="start"
                  >
                    {formatAxisToken(tick.value)}
                  </text>
                </>
              )}
            </For>

            <For each={geometry().compaction}>
              {(marker) => (
                <line
                  class="qg-chart__marker"
                  x1={marker.x}
                  x2={marker.x}
                  y1={geometry().plot.top}
                  y2={geometry().plot.bottom}
                />
              )}
            </For>

            <Show when={showsTree() && geometry().tree.areaPath}>
              <path class="qg-chart__area qg-chart__area--total" d={geometry().tree.areaPath} />
            </Show>
            <Show when={geometry().own.areaPath}>
              <path class="qg-chart__area qg-chart__area--own" d={geometry().own.areaPath} />
            </Show>
            <Show when={geometry().context.areaPath}>
              <path
                class="qg-chart__area qg-chart__area--context"
                d={geometry().context.areaPath}
              />
            </Show>

            <Show when={showsTree() && geometry().tree.points.length > 0}>
              <path class="qg-chart__line qg-chart__line--total" d={geometry().tree.linePath} />
            </Show>
            <Show when={geometry().own.points.length > 0}>
              <path class="qg-chart__line qg-chart__line--own" d={geometry().own.linePath} />
            </Show>
            <Show when={geometry().context.points.length > 0}>
              <path
                class="qg-chart__line qg-chart__line--context"
                d={geometry().context.linePath}
              />
            </Show>

            <Show
              when={
                showsTree() && geometry().tree.points.length === 1
                  ? geometry().tree.points[0]
                  : undefined
              }
            >
              {(point) => (
                <circle
                  class="qg-chart__point qg-chart__point--total"
                  cx={point().x}
                  cy={point().y}
                  r="4.5"
                />
              )}
            </Show>
            <Show
              when={
                geometry().context.points.length === 1 ? geometry().context.points[0] : undefined
              }
            >
              {(point) => (
                <circle
                  class="qg-chart__point qg-chart__point--context"
                  cx={point().x}
                  cy={point().y}
                  r="3.5"
                />
              )}
            </Show>
            <Show when={geometry().own.points.length === 1 ? geometry().own.points[0] : undefined}>
              {(point) => (
                <circle
                  class="qg-chart__point qg-chart__point--own"
                  cx={point().x}
                  cy={point().y}
                  r="2.5"
                />
              )}
            </Show>

            {/* Cache Rate: fixed 0–100% of the plot height, above the token series. */}
            <For each={geometry().cache.paths}>
              {(path) => <path class="qg-chart__rate-line qg-chart__rate-line--session" d={path} />}
            </For>
            <For each={geometry().cache.singles}>
              {(point) => <circle class="qg-chart__rate-point" cx={point.x} cy={point.y} r="2.5" />}
            </For>
            <For each={transitions()}>
              {(entry) => (
                <path
                  class={`qg-chart__transition qg-chart__transition--${entry.kind}`}
                  d={
                    entry.kind === "model"
                      ? `M ${geometry().stepX(entry.stepIndex)} ${geometry().plot.top + 1} l 4 4 l -4 4 l -4 -4 Z`
                      : `M ${geometry().stepX(entry.stepIndex) - 3.5} ${geometry().plot.top + 1} h 7 v 7 h -7 Z`
                  }
                />
              )}
            </For>
            <For each={inputMarkerIndexes()}>
              {(index) => (
                <path
                  class="qg-chart__transition qg-chart__transition--input"
                  d={`M ${geometry().stepX(index) - 3.5} ${geometry().plot.top + 10} h 7 v 7 h -7 Z`}
                />
              )}
            </For>

            <Show when={active() !== undefined}>
              <line
                class="qg-chart__cursor"
                x1={geometry().stepX(active() ?? 0)}
                x2={geometry().stepX(active() ?? 0)}
                y1={geometry().plot.top}
                y2={geometry().plot.bottom}
              />
              <Show when={rateAt(active() ?? 0) !== null}>
                <circle
                  class="qg-chart__rate-point qg-chart__rate-point--active"
                  cx={geometry().stepX(active() ?? 0)}
                  cy={
                    geometry().plot.bottom -
                    (Math.min(Math.max(rateAt(active() ?? 0) ?? 0, 0), 100) / 100) *
                      geometry().plot.height
                  }
                  r="3"
                />
              </Show>
            </Show>

            <For each={geometry().labelIndexes}>
              {(index) => {
                const step = () => steps()[index];
                return (
                  <Show when={step()}>
                    <text
                      class="qg-chart__axis-label qg-chart__axis-label--step"
                      x={geometry().stepX(index)}
                      y={geometry().axisLabelY}
                      text-anchor="middle"
                    >
                      {index + 1}
                    </text>
                  </Show>
                );
              }}
            </For>
            <text
              class="qg-chart__axis-title qg-chart__axis-title--steps"
              x={geometry().plot.left}
              y={geometry().viewHeight - 4}
              text-anchor="start"
            >
              Steps
            </text>
          </svg>

          <div
            class="qg-chart__surface"
            role="slider"
            tabIndex={0}
            aria-label="Inspect session steps"
            aria-orientation="horizontal"
            aria-valuemin={1}
            aria-valuemax={Math.max(1, geometry().stepCount)}
            aria-valuenow={(active() ?? 0) + 1}
            aria-valuetext={stepText(active() ?? 0)}
            style={{
              top: `${(geometry().plot.top / geometry().viewHeight) * 100}%`,
              bottom: `${((geometry().viewHeight - geometry().plot.bottom) / geometry().viewHeight) * 100}%`,
              left: `${(geometry().plot.left / size.width) * 100}%`,
              right: `${((size.width - geometry().plot.right) / size.width) * 100}%`,
            }}
            onPointerMove={pointerAt}
            onPointerLeave={inspection.clearPointer}
            onFocus={() => inspection.inspectFocus(active() ?? 0)}
            onBlur={inspection.clearFocus}
            onKeyDown={keyAt}
          />

          <Show when={activeStep()}>
            {(step) => (
              <output
                ref={tooltipLayout.tooltipRef}
                class="qg-tooltip qg-tooltip--session"
                style={tooltipStyle()}
              >
                <p class="qg-tooltip__head">
                  <span>Step {(active() ?? 0) + 1}</span>
                </p>
                <div class="qg-tooltip__group qg-tooltip__group--series">
                  <div class="qg-tooltip__grid-row">
                    <span
                      class="qg-tooltip__swatch"
                      aria-hidden="true"
                      style={{ "--qg-swatch": "var(--qg-chart-context)" }}
                    />
                    <span class="qg-tooltip__label">{contextSeriesLabel()}</span>
                    <span class="qg-tooltip__value">
                      {contextValue(active() ?? 0) === undefined
                        ? "—"
                        : formatExactCount(contextValue(active() ?? 0) as number)}
                    </span>
                  </div>
                  <div class="qg-tooltip__grid-row">
                    <span
                      class="qg-tooltip__swatch"
                      aria-hidden="true"
                      style={{ "--qg-swatch": "var(--qg-chart-own)" }}
                    />
                    <span class="qg-tooltip__label">{ownSeriesLabel()}</span>
                    <span class="qg-tooltip__value">
                      {formatExactCount(geometry().ownCumulativeValues[active() ?? 0] ?? 0)}
                    </span>
                  </div>
                  <Show when={showsTree()}>
                    <div class="qg-tooltip__grid-row">
                      <span
                        class="qg-tooltip__swatch"
                        aria-hidden="true"
                        style={{ "--qg-swatch": "var(--qg-chart-total)" }}
                      />
                      <span class="qg-tooltip__label">Cumulative · Session tree</span>
                      <span class="qg-tooltip__value">
                        {formatExactCount(geometry().treeCumulativeValues[active() ?? 0] ?? 0)}
                      </span>
                    </div>
                  </Show>
                  <div class="qg-tooltip__grid-row">
                    <span
                      class="qg-tooltip__swatch"
                      aria-hidden="true"
                      style={{ "--qg-swatch": "var(--qg-chart-rate)" }}
                    />
                    <span class="qg-tooltip__label">{cacheSeriesLabel()}</span>
                    <span class="qg-tooltip__value">
                      {rateAt(active() ?? 0) === null
                        ? SESSION_GAP_LABELS.unavailable
                        : formatPercentExact(rateAt(active() ?? 0))}
                    </span>
                  </div>
                  <Show when={cacheReadAt(active() ?? 0) !== undefined}>
                    <div class="qg-tooltip__grid-row qg-tooltip__grid-row--detail">
                      <span class="qg-tooltip__swatch-spacer" aria-hidden="true" />
                      <span class="qg-tooltip__label">{SESSION_GAP_LABELS.cacheReadTokens}</span>
                      <span class="qg-tooltip__value">
                        {formatExactCount(cacheReadAt(active() ?? 0) as number)}
                      </span>
                    </div>
                  </Show>
                  <Show when={steps()[active() ?? 0]?.inputMarker}>
                    <div class="qg-tooltip__grid-row">
                      <span
                        class="qg-tooltip__swatch qg-tooltip__swatch--input"
                        aria-hidden="true"
                      />
                      <span class="qg-tooltip__label">Input</span>
                      <span class="qg-tooltip__value">{inputMarkerLabel()}</span>
                    </div>
                  </Show>
                  <Show when={active() === geometry().stepCount - 1 && trailingTreeTokens() > 0}>
                    <div class="qg-tooltip__grid-row">
                      <span class="qg-tooltip__swatch-spacer" aria-hidden="true" />
                      <span class="qg-tooltip__label">Session tree total</span>
                      <span class="qg-tooltip__value">{formatExactCount(tree().total)}</span>
                    </div>
                    <p class="qg-tooltip__note">
                      Descendants ran later; the tree line ends at this step.
                    </p>
                  </Show>
                  <Show when={activeCompactions().length > 0}>
                    <p class="qg-tooltip__note">
                      Compaction{" "}
                      {activeCompactions()
                        .map((marker) =>
                          multiDaySteps()
                            ? formatTimestamp(marker.atMs, timeZone())
                            : formatTimeOnly(marker.atMs, timeZone()),
                        )
                        .join(", ")}
                    </p>
                  </Show>
                </div>
                <Show when={modelIdentities().length > 1 ? step().model : undefined}>
                  {(model) => (
                    <div class="qg-tooltip__group qg-tooltip__group--model">
                      <ModelIdentityLabel identity={model()} class="qg-tooltip__model" />
                      <Show when={transitionAt(active() ?? 0)}>
                        {(entry) => (
                          <span class="qg-tooltip__note">
                            {entry().kind === "model" ? "Model changed" : "Effort changed"} from{" "}
                            {formatModelIdentity(entry().from)} to {formatModelIdentity(entry().to)}
                          </span>
                        )}
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={timingAt(active() ?? 0)}>
                  {(timing) => (
                    <div class="qg-tooltip__group qg-tooltip__group--timing">
                      <Show when={timing().createdAtMs !== undefined}>
                        <div class="qg-tooltip__grid-row">
                          <span class="qg-tooltip__label">{SESSION_GAP_LABELS.messageCreated}</span>
                          <span class="qg-tooltip__value">{createdText(timing())}</span>
                        </div>
                      </Show>
                      <div class="qg-tooltip__grid-row">
                        <span class="qg-tooltip__label">{SESSION_GAP_LABELS.messageCompleted}</span>
                        <span class="qg-tooltip__value">{completedText(timing())}</span>
                      </div>
                      <Show when={timing().durationMs !== undefined}>
                        <div class="qg-tooltip__grid-row">
                          <span class="qg-tooltip__label">
                            {SESSION_GAP_LABELS.messageDuration}
                          </span>
                          <span class="qg-tooltip__value">
                            {formatElapsed(timing().durationMs)}
                          </span>
                        </div>
                      </Show>
                      <Show when={timing().overlap || timing().idleMs !== undefined}>
                        <div class="qg-tooltip__grid-row">
                          <span class="qg-tooltip__label">
                            {timing().overlap
                              ? SESSION_GAP_LABELS.overlapsPrevious
                              : SESSION_GAP_LABELS.idleSincePrevious}
                          </span>
                          <span class="qg-tooltip__value">
                            {timing().overlap
                              ? timing().overlapMs === undefined
                                ? "Yes"
                                : formatElapsed(timing().overlapMs)
                              : formatElapsed(timing().idleMs)}
                          </span>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </output>
            )}
          </Show>
        </Show>
      </div>

      <Show when={rangeEndCaption()}>
        {(caption) => <p class="qg-chart__axis-caption">{caption()}</p>}
      </Show>

      <Show when={geometry().stepCount > 0 && trailingTreeTokens() > 0}>
        <p class="qg-chart__note">
          Descendants added {formatExactCount(trailingTreeTokens())} tokens after the last main
          session step; the orange Session tree line ends there. Tree total tokens in the summary is
          the final total.
        </p>
      </Show>

      <div class="sr-only">
        <table>
          <caption>
            Completed steps in the {props.variant === "main" ? "main session" : "session"}. Context
            is this session's own; the cumulative total covers this session.
            {showsTree()
              ? " The Session tree cumulative is folded at these step positions only and ends at the last step; descendant activity that ran later appears only in the final tree total summary."
              : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Session</th>
              <th scope="col">Branch</th>
              <th scope="col">At</th>
              <th scope="col">Context tokens</th>
              <th scope="col">
                {isMain() ? "Cumulative tokens (Main session)" : "Cumulative tokens"}
              </th>
              <Show when={showsTree()}>
                <th scope="col">Cumulative tokens (Session tree)</th>
              </Show>
              <th scope="col">{cacheSeriesLabel()}</th>
              <th scope="col">Compaction</th>
              <th scope="col">Input</th>
            </tr>
          </thead>
          <tbody>
            <For each={steps()}>
              {(step, index) => (
                <tr>
                  <th scope="row">{index() + 1}</th>
                  <td>{step.sessionId}</td>
                  <td>{step.branch}</td>
                  <td>{formatTimestamp(step.atMs, timeZone())}</td>
                  <td>
                    {contextValue(index()) === undefined
                      ? "—"
                      : formatExactCount(contextValue(index()) as number)}
                  </td>
                  <td>{formatExactCount(geometry().ownCumulativeValues[index()] ?? 0)}</td>
                  <Show when={showsTree()}>
                    <td>{formatExactCount(geometry().treeCumulativeValues[index()] ?? 0)}</td>
                  </Show>
                  <td>{formatReuseWords(rateAt(index()))}</td>
                  <td>
                    {compactionAt(index()).length === 0
                      ? "—"
                      : compactionAt(index())
                          .map(
                            (marker) =>
                              `${marker.sessionId} at ${formatTimestamp(marker.atMs, timeZone())}`,
                          )
                          .join("; ")}
                  </td>
                  <td>{step.inputMarker ? inputMarkerLabel() : "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </ChartShell>
  );
}
