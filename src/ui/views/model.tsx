import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupSnapshot,
} from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { cacheHitRate } from "../chart-geometry";
import { AnalyticsBreakdown } from "../components/analytics-breakdown";
import { ChartSummary, type ChartSummaryItem } from "../components/chart-shell";
import { CostInfo, EstimateNote } from "../components/cost-estimate";
import { ModelUsageChart } from "../components/model-usage-chart";
import { formatApiEquivalentCostText, formatExactCount, formatPercentExact } from "../format";
import {
  type BreakdownSort,
  identityLabel,
  rankSeries,
  seriesKey,
  usageTitle,
} from "../model-analytics";
import { formatPath } from "../routing";
import { createSeriesInspection } from "../series-inspection";

/**
 * Model detail (design spec §2).
 *
 * Exactly the metrics the contract can support: total tokens, API-equivalent
 * estimate, sessions and — only when the existing cache-hit semantics yield a
 * denominator — a cache rate. The chart groups the selected model by provider;
 * the breakdown is that provider list, not a model-provider pair page.
 */
export function ModelDetailView(props: {
  snapshot: AnalyticsGroupSnapshot;
  identity: AnalyticsEntityIdentity;
  range: RangeKey;
  modelsGroup?: AnalyticsDimension;
}): JSX.Element {
  const [sortMode, setSortMode] = createSignal<BreakdownSort>("cost");
  const inspection = createSeriesInspection();
  // Match the chart's own rank order, so a row swatch and its bar cannot drift.
  const seriesKeys = () =>
    rankSeries(props.snapshot.series).map((entry) => seriesKey(entry, props.snapshot.dimension));
  const rate = () => cacheHitRate(props.snapshot.totals);
  const summaryItems = (): ChartSummaryItem[] => {
    const items: ChartSummaryItem[] = [
      {
        label: "Total tokens",
        value: formatExactCount(props.snapshot.totals.total),
        emphasis: "primary",
      },
      {
        label: "API-equivalent estimate",
        value: formatApiEquivalentCostText(
          props.snapshot.totals.apiEquivalentCostUsd,
          props.snapshot.totals.total,
        ),
        info: <CostInfo />,
        note: <EstimateNote totals={props.snapshot.totals} />,
        title:
          props.snapshot.totals.apiEquivalentCostUsd === null
            ? "No priced tokens in this range."
            : `API-equivalent estimate: USD ${props.snapshot.totals.apiEquivalentCostUsd.toFixed(6)}.`,
      },
      {
        label: "Sessions",
        value: formatExactCount(props.snapshot.sessionCount),
      },
    ];
    const value = rate();
    if (value !== null) {
      items.push({ label: "Cache hit rate", value: formatPercentExact(value) });
    }
    return items;
  };
  const label = () => identityLabel(props.identity, "model");

  return (
    <div class="qg-detail">
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatPath({ name: "analytics" }, props.range)}>Analytics</a>
        <span aria-hidden="true">›</span>
        <a
          href={formatPath(
            { name: "models", dimension: props.modelsGroup ?? "model" },
            props.range,
          )}
        >
          Models
        </a>
        <span aria-hidden="true">›</span>
        <span aria-current="page" class="qg-breakable">
          {label()}
        </span>
      </nav>
      <header class="qg-page-head">
        <h2 class="qg-page-title qg-breakable" id="qg-model-head">
          {label()}
        </h2>
      </header>
      <ModelUsageChart
        snapshot={props.snapshot}
        title={usageTitle(props.snapshot.dimension)}
        headingId="qg-model-usage"
        summary={<ChartSummary items={summaryItems()} />}
        activeSeries={inspection.active()}
        pinnedSeries={inspection.pinned()}
        onPointerSeries={inspection.inspectPointer}
        onFocusSeries={inspection.inspectFocus}
        onTogglePinnedSeries={inspection.togglePinned}
        onClearPinnedSeries={inspection.clearPinned}
      />
      <AnalyticsBreakdown
        headingId="qg-model-breakdown"
        rows={props.snapshot.rows}
        dimension={props.snapshot.dimension}
        range={props.range}
        sort={sortMode()}
        onSortChange={setSortMode}
        showChildren={false}
        seriesKeys={seriesKeys()}
        modelsGroup={props.modelsGroup}
        activeSeries={inspection.active()}
        onPointerSeries={inspection.inspectPointer}
        onFocusSeries={inspection.inspectFocus}
      />
    </div>
  );
}
