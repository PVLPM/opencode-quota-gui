import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { HomeSnapshot, QuotaSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { type DisplayPreferences, QuotaCardView } from "../components/quota-card";
import { SortControl } from "../components/sort-control";
import { EmptyNotice, Skeleton } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import {
  formatExactCount,
  formatTimestampMinutes,
  formatTokenCount,
  pluralize,
  usageChartTitle,
} from "../format";
import { formatPath } from "../routing";
import { sortProjectRows } from "../sorting";
import {
  describeEmptyActivity,
  describeNoProviders,
  usageHasActivity,
  visibleCards,
} from "../view-model";

/**
 * Quota is the default independent surface. Analytics below uses the compatible
 * HomeSnapshot for usage and projects only; it never renders provider cards.
 *
 * Cards are one per provider account in provider-registration order; usage is
 * the stacked area chart; projects are exactly two columns — name and tokens —
 * in the server's latest-activity order, which the frontend never re-sorts.
 */
export function QuotaView(props: {
  snapshot: QuotaSnapshot;
  preferences: DisplayPreferences;
  hiddenCards: string[];
  hiddenRows: string[];
  stale: boolean;
}): JSX.Element {
  const shown = () => visibleCards(props.snapshot.providers.cards, props.hiddenCards);

  return (
    <>
      <section class="qg-section" aria-labelledby="qg-home-quota">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-home-quota">
            Quota
          </h2>
          <span class="qg-section__meta">
            Polled{" "}
            {formatTimestampMinutes(props.snapshot.providers.polledAtMs, props.snapshot.timeZone)} ·{" "}
            {props.snapshot.providers.enabledProviders === "auto"
              ? "automatic provider selection"
              : pluralize(props.snapshot.providers.enabledProviders.length, "enabled provider")}
          </span>
        </header>
        <Show
          when={shown().length > 0}
          fallback={
            <EmptyNotice
              message={
                props.snapshot.providers.cards.length > 0
                  ? "Every provider card is hidden. Use the eye toggles in Settings to bring one back."
                  : describeNoProviders(props.snapshot.providers.enabledProviders)
              }
            />
          }
        >
          <div class="qg-card-grid">
            <For each={shown()}>
              {(card) => (
                <QuotaCardView
                  card={card}
                  preferences={props.preferences}
                  hiddenRows={props.hiddenRows}
                  stale={props.stale}
                  timeZone={props.snapshot.timeZone}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </>
  );
}

export function QuotaLoading(): JSX.Element {
  return (
    <section class="qg-section" aria-labelledby="qg-loading-quota">
      <header class="qg-section__head">
        <h2 class="qg-section__title" id="qg-loading-quota">
          Quota
        </h2>
      </header>
      <div class="qg-card-grid">
        <Skeleton label="Loading providers" />
      </div>
    </section>
  );
}

export function HomeView(props: { snapshot: HomeSnapshot; range: RangeKey }): JSX.Element {
  const [sortMode, setSortMode] = createSignal<"activity" | "tokens">("activity");
  const projects = createMemo(() => sortProjectRows(props.snapshot.projects, sortMode()));
  return (
    <>
      <section class="qg-section" aria-labelledby="qg-home-usage">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-home-usage">
            {usageChartTitle(props.snapshot.usage.bucketUnit)}
          </h2>
        </header>
        <Show
          when={props.snapshot.usage.buckets.length > 0}
          fallback={
            <EmptyNotice message={describeEmptyActivity(usageHasActivity(props.snapshot.usage))} />
          }
        >
          <UsageChart usage={props.snapshot.usage} />
        </Show>
      </section>

      <section class="qg-section" aria-labelledby="qg-home-projects">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-home-projects">
            Projects
          </h2>
          <SortControl label="projects" value={sortMode()} onChange={setSortMode} />
        </header>
        <Show
          when={props.snapshot.projects.length > 0}
          fallback={
            <EmptyNotice message="No activity in this range. Widen the range to see earlier projects." />
          }
        >
          <div class="qg-list">
            <div class="qg-list__head" aria-hidden="true">
              <span>Project</span>
              <span>Tokens</span>
            </div>
            <For each={projects()}>
              {(project) => (
                <a
                  class="qg-list__row"
                  data-clickable="true"
                  href={formatPath({ name: "project", projectId: project.projectId }, props.range)}
                >
                  <span class="qg-list__title" title={project.name}>
                    {project.name}
                  </span>
                  <span class="qg-list__tokens" title={formatExactCount(project.tokens.total)}>
                    {formatTokenCount(project.tokens.total)}
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
