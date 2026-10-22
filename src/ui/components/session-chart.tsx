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
import { formatExactCount, formatTimestamp, formatTokenCount } from "../format";
import { createChartTooltipLayout } from "../tooltip-layout";

/**
 * Session graphs (design spec §3; owner 13–17).
 *
 * One shared chart for root sessions and subsessions. The blue context series
 * is the focus session only — never a zig-zag of child contexts — while the
 * orange cumulative series covers the whole scoped tree. The two have separate
 * y axes; compaction markers annotate the tree scope without resetting either
 * series.
 *
 * The x axis is the 1-based chronological rendered step sequence: plain
 * numbers, no dates and no fabricated zero. Pointer movement selects the
 * nearest rendered step immediately and drives a live vertical crosshair and
 * the shared custom tooltip; a keyboard slider exposes the same inspection
 * without timers or native `<title>` popups.
 */
export function SessionChart(props: { snapshot: SessionSnapshot }): JSX.Element {
  const inspection = createChartInspection();
  const active = inspection.active;
  const { size, ref } = createChartLayout(DEFAULT_SESSION_SIZE);
  const geometry = createMemo(() => buildSessionChartGeometry(props.snapshot, size));
  const own = () => props.snapshot.ownSummary;
  const tree = () => props.snapshot.treeTotals;
  const timeZone = () => props.snapshot.timeZone;

  const compactionAt = (index: number): SessionCompactionTick[] =>
    geometry().compaction.filter((marker) => marker.stepIndex === index);

  const contextValue = (index: number) => geometry().contextValues[index];
  const activeStep = () => {
    const index = active();
    return index === undefined ? undefined : props.snapshot.steps[index];
  };
  const activeCompactions = (): SessionCompactionTick[] => {
    const index = active();
    return index === undefined ? [] : compactionAt(index);
  };

  const tooltipLayout = createChartTooltipLayout(() => {
    const index = active();
    return index === undefined ? 0 : geometry().stepX(index) / size.width;
  });

  const stepText = (index: number): string => {
    const step = props.snapshot.steps[index];
    if (!step) return `Step ${index + 1}`;
    const context = contextValue(index);
    return [
      `Step ${index + 1}`,
      formatTimestamp(step.atMs, timeZone()),
      `Context ${context === undefined ? "—" : formatExactCount(context)}`,
      `Cumulative ${formatExactCount(geometry().cumulativeValues[index] ?? 0)}`,
    ].join(", ");
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

  return (
    <div class="qg-usage qg-usage--session">
      <header class="qg-usage__headline">
        <div>
          <span class="qg-summary-label">Tree total tokens</span>
          <strong class="qg-summary-number">{formatExactCount(tree().total)}</strong>
        </div>
        <div>
          <span class="qg-summary-label">This session · own tokens</span>
          <span class="qg-summary-cost">{formatExactCount(own().total)}</span>
        </div>
      </header>
      <div
        ref={(element) => {
          ref(element);
          tooltipLayout.chartRef(element);
        }}
        class="qg-chart"
      >
        <Show
          when={geometry().stepCount > 0}
          fallback={<p class="qg-empty">No completed steps in this session tree yet.</p>}
        >
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={`Step series for ${props.snapshot.focusSessionId}: focus-session context on the left axis and cumulative tree consumption on the right axis over ${geometry().stepCount} completed steps.`}
          >
            <text
              class="qg-chart__axis-title qg-chart__axis-title--context"
              x={geometry().plot.left}
              y={geometry().plot.top - 12}
              text-anchor="start"
            >
              Context tokens
            </text>
            <text
              class="qg-chart__axis-title qg-chart__axis-title--total"
              x={geometry().plot.right}
              y={geometry().plot.top - 12}
              text-anchor="end"
            >
              Total consumption
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

            <For each={geometry().total.ticks}>
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

            <Show when={geometry().total.areaPath}>
              <path class="qg-chart__area qg-chart__area--total" d={geometry().total.areaPath} />
            </Show>
            <Show when={geometry().context.areaPath}>
              <path
                class="qg-chart__area qg-chart__area--context"
                d={geometry().context.areaPath}
              />
            </Show>

            <Show when={geometry().total.points.length > 0}>
              <path class="qg-chart__line qg-chart__line--total" d={geometry().total.linePath} />
            </Show>
            <Show when={geometry().context.points.length > 0}>
              <path
                class="qg-chart__line qg-chart__line--context"
                d={geometry().context.linePath}
              />
            </Show>

            <Show
              when={geometry().total.points.length === 1 ? geometry().total.points[0] : undefined}
            >
              {(point) => (
                <circle
                  class="qg-chart__point qg-chart__point--total"
                  cx={point().x}
                  cy={point().y}
                  r="2.5"
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
                  r="2.5"
                />
              )}
            </Show>

            <Show when={active() !== undefined}>
              <line
                class="qg-chart__cursor"
                x1={geometry().stepX(active() ?? 0)}
                x2={geometry().stepX(active() ?? 0)}
                y1={geometry().plot.top}
                y2={geometry().plot.bottom}
              />
            </Show>

            <For each={geometry().labelIndexes}>
              {(index) => {
                const step = () => props.snapshot.steps[index];
                return (
                  <Show when={step()}>
                    <text
                      class="qg-chart__axis-label qg-chart__axis-label--step"
                      x={geometry().stepX(index)}
                      y={geometry().plot.bottom + 14}
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
              y={size.height - 4}
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
              top: `${(geometry().plot.top / size.height) * 100}%`,
              bottom: `${((size.height - geometry().plot.bottom) / size.height) * 100}%`,
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
                  <span>Step {(active() ?? 0) + 1}</span>
                </p>
                <p class="qg-tooltip__meta">{formatTimestamp(step().atMs, timeZone())}</p>
                <div class="qg-totals__row qg-tooltip__row">
                  <span
                    class="qg-tooltip__swatch"
                    aria-hidden="true"
                    style={{ "--qg-swatch": "var(--qg-chart-context)" }}
                  />
                  <span class="qg-totals__label">Context · focus session</span>
                  <span class="qg-totals__value">
                    {contextValue(active() ?? 0) === undefined
                      ? "—"
                      : formatExactCount(contextValue(active() ?? 0) as number)}
                  </span>
                </div>
                <div class="qg-totals__row qg-tooltip__row">
                  <span
                    class="qg-tooltip__swatch"
                    aria-hidden="true"
                    style={{ "--qg-swatch": "var(--qg-chart-total)" }}
                  />
                  <span class="qg-totals__label">Cumulative · session tree</span>
                  <span class="qg-totals__value">
                    {formatExactCount(geometry().cumulativeValues[active() ?? 0] ?? 0)}
                  </span>
                </div>
                <Show when={activeCompactions().length > 0}>
                  <div class="qg-totals__row qg-tooltip__row qg-tooltip__row--note">
                    <span class="qg-totals__label">Compaction</span>
                    <span class="qg-totals__value">
                      {activeCompactions()
                        .map((marker) => formatTimestamp(marker.atMs, timeZone()))
                        .join(", ")}
                    </span>
                  </div>
                </Show>
              </output>
            )}
          </Show>
        </Show>
      </div>

      <Show when={geometry().stepCount > 0 && geometry().focusStepCount === 0}>
        <p class="qg-chart__note">
          No completed steps in the focus session yet; the orange line still covers this session
          tree.
        </p>
      </Show>

      <aside class="qg-usage__aside">
        <div class="qg-totals">
          <div class="qg-totals__row">
            <span class="qg-totals__label">Steps (own)</span>
            <span class="qg-totals__value">{formatExactCount(own().stepCount)}</span>
          </div>
          <div class="qg-totals__row">
            <span class="qg-totals__label">Steps (tree)</span>
            <span class="qg-totals__value">{formatExactCount(props.snapshot.steps.length)}</span>
          </div>
          <div class="qg-totals__row">
            <span class="qg-totals__label">Compactions (focus session)</span>
            <span class="qg-totals__value">
              {formatExactCount(props.snapshot.compactionMarkers.length)}
            </span>
          </div>
        </div>

        <div class="qg-legend">
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-context)" }}>
            <span class="qg-legend__swatch" aria-hidden="true" />
            <span class="qg-legend__label">Context · focus session</span>
          </div>
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-chart-total)" }}>
            <span class="qg-legend__swatch" aria-hidden="true" />
            <span class="qg-legend__label">Total consumption · this session tree</span>
          </div>
        </div>
      </aside>

      <div class="sr-only">
        <table>
          <caption>
            Completed steps in this session tree. Context is the focus session only; cumulative
            total covers this session tree.
          </caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Session</th>
              <th scope="col">Branch</th>
              <th scope="col">At</th>
              <th scope="col">Context tokens (focus)</th>
              <th scope="col">Cumulative total tokens (tree)</th>
              <th scope="col">Compaction</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.snapshot.steps}>
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
                  <td>{formatExactCount(geometry().cumulativeValues[index()] ?? 0)}</td>
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
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
