import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ProjectSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { ChartSummary, type ChartSummaryItem } from "../components/chart-shell";
import { EstimateNote } from "../components/cost-estimate";
import { EstimateInfo } from "../components/estimate";
import { SortControl } from "../components/sort-control";
import { EmptyNotice } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import { formatExactCount, formatTokenCount, usageChartTitle } from "../format";
import { formatCostText } from "../model-analytics";
import { formatPath } from "../routing";
import { sortRootRows } from "../sorting";

/**
 * Project page (design spec §10; R24).
 *
 * The header identifies the project (name and the shared worktree basename when
 * every root agrees); the actual metrics live once in the compact summary strip
 * below it. Usage keeps the five-series chart; roots are one row per root with
 * exactly three columns — title, muted worktree, tokens.
 */
export function ProjectView(props: {
  snapshot: ProjectSnapshot;
  range: RangeKey;
  stale?: boolean;
}): JSX.Element {
  const [sortMode, setSortMode] = createSignal<"activity" | "tokens">("activity");
  const roots = createMemo(() => sortRootRows(props.snapshot.roots, sortMode()));
  const sharedWorktree = (): string | undefined => {
    const labels = props.snapshot.roots
      .map((root) => root.worktreeLabel)
      .filter((label): label is string => label !== undefined && label.length > 0);
    if (labels.length === 0) return undefined;
    const [first] = labels;
    return labels.every((label) => label === first) ? first : undefined;
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
      info: <EstimateInfo totals={props.snapshot.totals} />,
      note: <EstimateNote totals={props.snapshot.totals} showExclusionTitle={false} />,
    },
    {
      label: "Sessions",
      value: formatExactCount(props.snapshot.totals.sessionCount),
    },
  ];

  return (
    <>
      <div class="qg-detail">
        <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
          <a href={formatPath({ name: "analytics" }, props.range)}>Analytics</a>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{props.snapshot.name}</span>
        </nav>
        <header class="qg-page-head">
          <h2 class="qg-page-title" id="qg-project-head">
            {props.snapshot.name}
          </h2>
          <Show when={sharedWorktree()}>
            {(worktree) => (
              <span class="qg-page-head__meta">
                <span class="qg-page-head__meta-label">Worktree</span>
                {worktree()}
              </span>
            )}
          </Show>
        </header>
        <UsageChart
          usage={props.snapshot.usage}
          title={usageChartTitle(props.snapshot.usage.bucketUnit)}
          headingId="qg-project-usage"
          summary={<ChartSummary items={summaryItems()} />}
          emptyMessage="No activity in this range."
        />
      </div>

      <section class="qg-section" aria-labelledby="qg-project-roots">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-project-roots">
            Sessions
          </h2>
          <SortControl label="sessions" value={sortMode()} onChange={setSortMode} />
        </header>
        <Show
          when={props.snapshot.roots.length > 0}
          fallback={<EmptyNotice message="No sessions had activity in this range." />}
        >
          <div class="qg-list qg-list--roots">
            <div class="qg-list__head" aria-hidden="true">
              <span>Name</span>
              <span>Worktree</span>
              <span>Tokens</span>
            </div>
            <For each={roots()}>
              {(root) => (
                <a
                  class="qg-list__row"
                  data-clickable="true"
                  href={formatPath({ name: "session", sessionId: root.sessionId }, props.range)}
                >
                  <span class="qg-list__title" title={root.title}>
                    {root.title}
                  </span>
                  <span class="qg-list__worktree">{root.worktreeLabel ?? ""}</span>
                  <span class="qg-list__tokens" title={formatExactCount(root.tokens.total)}>
                    {formatTokenCount(root.tokens.total)}
                  </span>
                </a>
              )}
            </For>
          </div>
        </Show>
      </section>
    </>
  );
}
