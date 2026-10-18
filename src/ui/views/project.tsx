import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { ProjectSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { EmptyNotice, StaleNotice } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import { formatApiEquivalentCost, formatExactCount, formatTokenCount, pluralize } from "../format";
import { formatHash } from "../routing";

/**
 * Project page (design spec §10; R24).
 *
 * Header with the project name, the shared worktree basename when every root
 * agrees on one, the totals strip, and the usage chart; then one row per root
 * with exactly three columns — title, muted worktree basename, tokens. No step
 * count and no latest-activity column: the server already ordered the rows by
 * latest activity, so the frontend never re-sorts.
 */
export function ProjectView(props: {
  snapshot: ProjectSnapshot;
  range: RangeKey;
  stale?: boolean;
}): JSX.Element {
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
      <Show when={props.stale}>
        <StaleNotice message="Showing the last good snapshot for this project." />
      </Show>
      <nav class="qg-breadcrumbs" aria-label="Breadcrumb">
        <a href={formatHash({ name: "home" }, props.range)}>Home</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{props.snapshot.name}</span>
      </nav>
      <section class="qg-section" aria-labelledby="qg-project-head">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-project-head">
            {props.snapshot.name}
          </h2>
          <span class="qg-section__meta">
            <Show when={sharedWorktree()}>{(worktree) => <span>{worktree()} · </span>}</Show>
            {formatExactCount(props.snapshot.totals.total)} tokens ·{" "}
            {formatApiEquivalentCost(props.snapshot.totals.apiEquivalentCostUsd)} ·{" "}
            {pluralize(props.snapshot.totals.sessionCount, "session")}
          </span>
        </header>
        <Show
          when={props.snapshot.usage.buckets.length > 0}
          fallback={<EmptyNotice message="No activity in this range." />}
        >
          <UsageChart usage={props.snapshot.usage} />
        </Show>
      </section>

      <section class="qg-section" aria-labelledby="qg-project-roots">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-project-roots">
            Sessions
          </h2>
          <span class="qg-section__meta">
            {pluralize(props.snapshot.roots.length, "root session")}
          </span>
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
            <For each={props.snapshot.roots}>
              {(root) => (
                <a
                  class="qg-list__row"
                  data-clickable="true"
                  href={formatHash({ name: "session", sessionId: root.sessionId }, props.range)}
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
