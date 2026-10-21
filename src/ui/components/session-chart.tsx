import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import {
  buildSessionChartGeometry,
  DEFAULT_SESSION_SIZE,
  type SessionCompactionTick,
} from "../chart-geometry";
import { createChartLayout } from "../chart-layout";
import { formatDay, formatExactCount, formatTimestamp, formatTokenCount } from "../format";

/**
 * Session graphs (design spec §6, §10; R25–R27).
 *
 * One shared chart for root sessions and subsessions. The blue context series
 * is the focus session only — never a zig-zag of child contexts — while the
 * gold cumulative series covers the whole scoped tree. The two have separate
 * y axes; compaction markers annotate the tree scope without resetting either
 * series.
 */
export function SessionChart(props: { snapshot: SessionSnapshot }): JSX.Element {
  const { size, ref } = createChartLayout(DEFAULT_SESSION_SIZE);
  const geometry = createMemo(() => buildSessionChartGeometry(props.snapshot, size));
  const own = () => props.snapshot.ownSummary;
  const tree = () => props.snapshot.treeTotals;
  const timeZone = () => props.snapshot.timeZone;

  const compactionAt = (index: number): SessionCompactionTick[] =>
    geometry().compaction.filter((marker) => marker.stepIndex === index);

  const hover = (index: number) => {
    const plot = geometry().plot;
    const count = geometry().stepCount;
    if (count <= 1) return { x: plot.left, width: plot.width };
    const slot = plot.width / (count - 1);
    const x = Math.max(plot.left, geometry().stepX(index) - slot / 2);
    return { x, width: Math.min(slot, plot.right - x) };
  };

  const contextValue = (index: number) => geometry().contextValues[index];

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
      <div ref={ref} class="qg-chart">
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
                >
                  <title>{`Compaction in this session at ${formatTimestamp(marker.atMs, timeZone())}`}</title>
                </line>
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

            <For each={props.snapshot.steps}>
              {(step, index) => {
                const markers = () => compactionAt(index());
                const cumulative = () => geometry().cumulativeValues[index()] ?? 0;
                return (
                  <rect
                    class="qg-chart__hover"
                    x={hover(index()).x}
                    y={geometry().plot.top}
                    width={hover(index()).width}
                    height={geometry().plot.height}
                  >
                    <title>
                      {[
                        `Step ${index() + 1} · ${formatTimestamp(step.atMs, timeZone())}`,
                        `Context (focus session): ${contextValue(index()) === undefined ? "—" : formatExactCount(contextValue(index()) as number)}`,
                        `Cumulative (session tree): ${formatExactCount(cumulative())}`,
                        ...markers().map(
                          (marker) =>
                            `Compaction in this session at ${formatTimestamp(marker.atMs, timeZone())}`,
                        ),
                      ].join("\n")}
                    </title>
                  </rect>
                );
              }}
            </For>

            <For each={geometry().labelIndexes}>
              {(index) => {
                const step = () => props.snapshot.steps[index];
                return (
                  <Show when={step()}>
                    {(value) => (
                      <text
                        class="qg-chart__axis-label"
                        x={geometry().stepX(index)}
                        y={size.height - 8}
                        text-anchor="middle"
                      >
                        {formatDay(value().atMs, timeZone())}
                      </text>
                    )}
                  </Show>
                );
              }}
            </For>
          </svg>
        </Show>
      </div>

      <Show when={geometry().stepCount > 0 && geometry().focusStepCount === 0}>
        <p class="qg-chart__note">
          No completed steps in the focus session yet; the gold line still covers this session tree.
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
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-token-cache-read)" }}>
            <span class="qg-legend__swatch" aria-hidden="true" />
            <span class="qg-legend__label">Context · focus session</span>
          </div>
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-token-output)" }}>
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
