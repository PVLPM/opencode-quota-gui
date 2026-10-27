import type { JSX } from "solid-js";
import { createEffect, createSignal, Show } from "solid-js";
import type { AnalyticsDimension, AnalyticsGroupSnapshot } from "../../contracts/dashboard";
import { AnalyticsBreakdown } from "../components/analytics-breakdown";
import { ChartSummary, type ChartSummaryItem } from "../components/chart-shell";
import { CostInfo, EstimateNote } from "../components/cost-estimate";
import { ModelUsageChart } from "../components/model-usage-chart";
import { formatApiEquivalentCostText, formatExactCount } from "../format";
import { type BreakdownSort, rankSeries, seriesKey, usageTitle } from "../model-analytics";
import { SegmentedControl, SegmentedControlItem } from "../opencode-ui";
import { createSeriesInspection } from "../series-inspection";

/**
 * Models surface (design spec §2).
 *
 * The chart is token-volume stacked bars, with Model | Provider opposite the
 * contextual heading. Breakdown sorting is deliberately local to the three
 * columns and cannot re-rank the chart. The frame stays mounted while a
 * dimension query is pending or failed, so the control keeps focus and the
 * chosen sort survives the switch.
 */
export function ModelsView(props: {
  snapshot?: AnalyticsGroupSnapshot;
  dimension: AnalyticsDimension;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onDimensionChange: (dimension: AnalyticsDimension) => void;
}): JSX.Element {
  const [sortMode, setSortMode] = createSignal<BreakdownSort>("cost");
  const inspection = createSeriesInspection();
  // Match the chart's own rank order, so a row swatch and its bar cannot drift.
  const seriesKeys = () =>
    rankSeries(props.snapshot?.series ?? []).map((entry) =>
      seriesKey(entry, props.snapshot?.dimension ?? props.dimension),
    );
  const activeSeries = () => {
    const key = inspection.active();
    return key !== undefined && seriesKeys().includes(key) ? key : undefined;
  };
  const activeChild = () => {
    const child = inspection.activeChild();
    return child !== undefined && activeSeries() === child.seriesKey ? child : undefined;
  };
  const summaryItems = (): ChartSummaryItem[] | undefined => {
    const snapshot = props.snapshot;
    if (snapshot === undefined) return undefined;
    return [
      {
        label: "Processed tokens",
        value: formatExactCount(snapshot.totals.total),
        emphasis: "primary",
      },
      {
        label: "API-equivalent estimate",
        value: formatApiEquivalentCostText(
          snapshot.totals.apiEquivalentCostUsd,
          snapshot.totals.total,
        ),
        info: <CostInfo />,
        note: <EstimateNote totals={snapshot.totals} />,
        title:
          snapshot.totals.apiEquivalentCostUsd === null
            ? "No priced tokens in this range."
            : `API-equivalent estimate: USD ${snapshot.totals.apiEquivalentCostUsd.toFixed(6)}.`,
      },
    ];
  };

  // A new grouping invalidates row/legend emphasis, never the dimension control.
  createEffect(() => {
    void props.dimension;
    inspection.clearPointer();
    inspection.clearFocus();
    inspection.clearPinned();
  });

  // A refetch can replace the ranked series without changing the dimension. Drop
  // only keys that disappeared, so valid keyboard/pointer emphasis survives.
  createEffect(() => {
    inspection.reconcile(new Set(seriesKeys()));
  });

  return (
    <>
      <ModelUsageChart
        snapshot={props.snapshot}
        title={usageTitle(props.dimension)}
        headingId="qg-models-usage"
        loading={props.loading}
        error={props.error}
        onRetry={props.onRetry}
        summary={<Show when={summaryItems()}>{(items) => <ChartSummary items={items()} />}</Show>}
        actions={
          <SegmentedControl
            class="qg-sort qg-dimension"
            aria-label="Group usage by"
            value={props.dimension}
            onChange={(value) => {
              if (value === "model" || value === "provider") props.onDimensionChange(value);
            }}
          >
            <SegmentedControlItem value="model">Model</SegmentedControlItem>
            <SegmentedControlItem value="provider">Provider</SegmentedControlItem>
          </SegmentedControl>
        }
        activeSeries={activeSeries()}
        activeChild={activeChild()}
        pinnedSeries={inspection.pinned()}
        onPointerSeries={inspection.inspectPointer}
        onFocusSeries={inspection.inspectFocus}
        onTogglePinnedSeries={inspection.togglePinned}
        onClearPinnedSeries={inspection.clearPinned}
      />
      <Show when={props.snapshot}>
        {(snapshot) => (
          <AnalyticsBreakdown
            headingId="qg-models-breakdown"
            rows={snapshot().rows}
            dimension={snapshot().dimension}
            range={snapshot().range}
            sort={sortMode()}
            onSortChange={setSortMode}
            seriesKeys={seriesKeys()}
            modelsGroup={snapshot().dimension}
            activeSeries={activeSeries()}
            activeChild={activeChild()}
            onPointerSeries={inspection.inspectPointer}
            onFocusSeries={inspection.inspectFocus}
            onPointerChild={inspection.inspectPointerChild}
            onFocusChild={inspection.inspectFocusChild}
          />
        )}
      </Show>
    </>
  );
}
