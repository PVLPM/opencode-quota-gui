import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ProjectSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { EstimateInfo } from "../components/estimate";
import { SortControl } from "../components/sort-control";
import { EmptyNotice } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import {
  formatApiEquivalentCost,
  formatExactCount,
  formatTokenCount,
  usageChartTitle,
} from "../format";
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

  return (
    <>
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatPath({ name: "analytics" }, props.range)}>Analytics</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{props.snapshot.name}</span>
      </nav>
      <section class="qg-section" aria-labelledby="qg-project-head">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-project-head">
            {props.snapshot.name}
          </h2>
          <Show when={sharedWorktree()}>
            {(worktree) => <span class="qg-section__meta">{worktree()}</span>}
          </Show>
        </header>
        <div class="qg-summary">
          <div class="qg-summary__item">
            <span class="qg-summary-label">Total tokens</span>
            <strong class="qg-summary__value">
              {formatExactCount(props.snapshot.totals.total)}
            </strong>
          </div>
          <div class="qg-summary__item">
            <span class="qg-summary-label qg-estimate-label">
              API-equivalent estimate
              <EstimateInfo totals={props.snapshot.totals} />
            </span>
            <span class="qg-summary__value qg-summary__value--secondary">
              {formatApiEquivalentCost(props.snapshot.totals.apiEquivalentCostUsd)}
            </span>
          </div>
          <div class="qg-summary__item">
            <span class="qg-summary-label">Sessions</span>
            <span class="qg-summary__value qg-summary__value--secondary">
              {formatExactCount(props.snapshot.totals.sessionCount)}
            </span>
          </div>
        </div>
        <Show
          when={props.snapshot.usage.buckets.length > 0}
          fallback={<EmptyNotice message="No activity in this range." />}
        >
          <UsageChart
            usage={props.snapshot.usage}
            title={usageChartTitle(props.snapshot.usage.bucketUnit)}
            showSummary={false}
          />
        </Show>
      </section>

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
              <span>Session</span>
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
