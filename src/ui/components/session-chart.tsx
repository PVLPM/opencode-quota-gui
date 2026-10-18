import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { SessionSnapshot } from "../../contracts/dashboard";
import { buildStepGeometry, DEFAULT_SESSION_SIZE, toLinePath } from "../chart-geometry";
import { createChartLayout } from "../chart-layout";
import { formatDay, formatExactCount, formatTimestamp, formatTokenCount } from "../format";

/**
 * Session graphs (design spec §6, §10; R25–R27).
 *
 * Two series over every completed step of the opened session *and all* its
 * descendants: context size (`input + cacheRead + cacheWrite`) and total
 * consumption (all five categories). A branch's context line breaks at a
 * session or branch change instead of implying one summed global context, and
 * compaction markers are ticks on the axis, never steps.
 */
export function SessionChart(props: { snapshot: SessionSnapshot }): JSX.Element {
  const { size, ref } = createChartLayout(DEFAULT_SESSION_SIZE);
  const geometry = createMemo(() =>
    buildStepGeometry(props.snapshot.steps, props.snapshot.compactionMarkers, size),
  );
  const own = () => props.snapshot.ownSummary;
  const tree = () => props.snapshot.treeTotals;

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
        <span class="qg-section__meta">Completed steps · UTC</span>
      </header>
      <div ref={ref} class="qg-chart">
        <Show
          when={geometry().stepCount > 0}
          fallback={<p class="qg-empty">No completed steps in this session tree yet.</p>}
        >
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={`Step series for ${props.snapshot.focusSessionId}: context size and total consumption over ${geometry().stepCount} completed steps.`}
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

            <For each={geometry().compaction}>
              {(marker) => (
                <line
                  class="qg-chart__marker"
                  x1={marker.x}
                  x2={marker.x}
                  y1={geometry().plot.top}
                  y2={geometry().plot.bottom}
                >
                  <title>{`Compaction at ${formatTimestamp(marker.atMs)}`}</title>
                </line>
              )}
            </For>

            <For each={geometry().contextRuns}>
              {(run) => (
                <path
                  d={toLinePath(run.points)}
                  fill="none"
                  stroke="var(--qg-token-input)"
                  stroke-width="1.5"
                />
              )}
            </For>
            <For each={geometry().totalRuns}>
              {(run) => (
                <path
                  d={toLinePath(run.points)}
                  fill="none"
                  stroke="var(--qg-token-output)"
                  stroke-width="1.5"
                  stroke-dasharray="4 2"
                />
              )}
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
                        {formatDay(value().atMs)}
                      </text>
                    )}
                  </Show>
                );
              }}
            </For>
          </svg>
        </Show>
      </div>

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
            <span class="qg-totals__label">Compactions</span>
            <span class="qg-totals__value">
              {formatExactCount(props.snapshot.compactionMarkers.length)}
            </span>
          </div>
        </div>

        <div class="qg-legend">
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-token-input)" }}>
            <span class="qg-legend__swatch" aria-hidden="true" />
            <span class="qg-legend__label">Context (input + cache read + cache write)</span>
          </div>
          <div class="qg-legend__item" style={{ "--qg-swatch": "var(--qg-token-output)" }}>
            <span class="qg-legend__swatch" aria-hidden="true" />
            <span class="qg-legend__label">Total consumption (all five categories)</span>
          </div>
        </div>

        <Show when={props.snapshot.compactionMarkers.length > 0}>
          <div class="qg-compaction-list">
            <span class="qg-muted">Compaction markers</span>
            <For each={props.snapshot.compactionMarkers}>
              {(marker) => (
                <span>
                  {formatTimestamp(marker.atMs)} · {marker.sessionId}
                </span>
              )}
            </For>
          </div>
        </Show>
      </aside>

      <div class="sr-only">
        <table>
          <caption>Completed steps in this session tree</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Session</th>
              <th scope="col">Branch</th>
              <th scope="col">At</th>
              <th scope="col">Context tokens</th>
              <th scope="col">Total tokens</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.snapshot.steps}>
              {(step, index) => (
                <tr>
                  <th scope="row">{index() + 1}</th>
                  <td>{step.sessionId}</td>
                  <td>{step.branch}</td>
                  <td>{new Date(step.atMs).toISOString()}</td>
                  <td>{formatExactCount(step.contextTokens)}</td>
                  <td>{formatExactCount(step.totalTokens)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
