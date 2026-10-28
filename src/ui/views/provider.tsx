import type { JSX } from "solid-js";
import { createMemo, createSignal, Show } from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupSnapshot,
} from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { AnalyticsBreakdown } from "../components/analytics-breakdown";
import { ChartSummary, type ChartSummaryItem } from "../components/chart-shell";
import { CostInfo, EstimateNote } from "../components/cost-estimate";
import { ModelUsageChart } from "../components/model-usage-chart";
import { ProviderLogo } from "../components/provider-logo";
import { formatExactCount } from "../format";
import {
  type BreakdownSort,
  costValueTitle,
  entityKey,
  formatCostText,
  identityLabel,
  rankSeries,
  seriesKey,
  usageTitle,
} from "../model-analytics";
import { formatPath } from "../routing";
import { createSeriesInspection } from "../series-inspection";

/**
 * Provider detail (design spec §2), symmetric with Model detail.
 *
 * The fourth metric is the number of distinct model rows the grouped contract
 * actually returned. No cache rate is invented merely to fill the slot.
 */
export function ProviderDetailView(props: {
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
  const otherParentKeys = createMemo(() => {
    const keys = new Set<string>();
    for (const entry of props.snapshot.series) {
      if (entry.kind !== "other") continue;
      for (const bucket of entry.parentBuckets ?? []) {
        for (const parent of bucket) keys.add(entityKey(props.snapshot.dimension, parent.identity));
      }
    }
    return keys;
  });
  const activeParent = () => {
    const parent = inspection.activeParent();
    return parent !== undefined &&
      inspection.active() === parent.seriesKey &&
      otherParentKeys().has(parent.parentKey)
      ? parent
      : undefined;
  };
  const label = () => identityLabel(props.identity, "provider");
  const rawLabel = () => {
    if (props.identity.kind !== "known" || props.identity.id.trim().length === 0) return undefined;
    return label() === props.identity.id ? undefined : props.identity.id;
  };
  const summaryItems = (): ChartSummaryItem[] => [
    {
      label: "Total tokens",
      value: formatExactCount(props.snapshot.totals.total),
      emphasis: "primary",
    },
    {
      label: "API-equivalent estimate",
      value: formatCostText(props.snapshot.totals),
      info: <CostInfo />,
      note: <EstimateNote totals={props.snapshot.totals} />,
      title: costValueTitle(props.snapshot.totals),
    },
    {
      label: "Sessions",
      value: formatExactCount(props.snapshot.sessionCount),
    },
    {
      label: "Models",
      value: formatExactCount(props.snapshot.rows.length),
    },
  ];

  return (
    <div class="qg-detail">
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatPath({ name: "analytics" }, props.range)}>Analytics</a>
        <span aria-hidden="true">›</span>
        <a
          href={formatPath(
            { name: "models", dimension: props.modelsGroup ?? "provider" },
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
        <h2 class="qg-page-title qg-breakable" id="qg-provider-head">
          <ProviderLogo
            providerId={props.identity.kind === "known" ? props.identity.id : ""}
            class="qg-page-head__logo"
          />
          {label()}
        </h2>
        <Show when={rawLabel()}>
          {(raw) => (
            <span class="qg-page-head__meta">
              <span class="qg-page-head__meta-label">Provider ID</span>
              {raw()}
            </span>
          )}
        </Show>
      </header>
      <ModelUsageChart
        snapshot={props.snapshot}
        title={usageTitle(props.snapshot.dimension)}
        headingId="qg-provider-usage"
        summary={<ChartSummary items={summaryItems()} />}
        activeSeries={inspection.active()}
        activeParent={activeParent()}
        pinnedSeries={inspection.pinned()}
        onPointerSeries={inspection.inspectPointer}
        onFocusSeries={inspection.inspectFocus}
        onTogglePinnedSeries={inspection.togglePinned}
        onClearPinnedSeries={inspection.clearPinned}
      />
      <AnalyticsBreakdown
        headingId="qg-provider-breakdown"
        rows={props.snapshot.rows}
        dimension={props.snapshot.dimension}
        range={props.range}
        sort={sortMode()}
        onSortChange={setSortMode}
        showChildren={false}
        seriesKeys={seriesKeys()}
        modelsGroup={props.modelsGroup ?? "provider"}
        activeSeries={inspection.active()}
        otherParentKeys={otherParentKeys()}
        activeParent={activeParent()}
        onPointerSeries={inspection.inspectPointer}
        onFocusSeries={inspection.inspectFocus}
        onPointerParent={inspection.inspectPointerParent}
        onFocusParent={inspection.inspectFocusParent}
      />
    </div>
  );
}
