import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { HomeSnapshot } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { type DisplayPreferences, QuotaCardView } from "../components/quota-card";
import { EmptyNotice } from "../components/states";
import { UsageChart } from "../components/usage-chart";
import { formatExactCount, formatTimestamp, formatTokenCount, pluralize } from "../format";
import { formatHash } from "../routing";
import {
  describeEmptyActivity,
  describeNoProviders,
  usageHasActivity,
  visibleCards,
} from "../view-model";

/**
 * Home (design spec §10): quota cards → usage → projects, in that fixed order.
 *
 * Cards are one per provider account in provider-registration order; usage is
 * the stacked area chart; projects are exactly two columns — name and tokens —
 * in the server's latest-activity order, which the frontend never re-sorts.
 */
export function HomeView(props: {
  snapshot: HomeSnapshot;
  preferences: DisplayPreferences;
  hiddenCards: string[];
  hiddenRows: string[];
  stale: boolean;
  range: RangeKey;
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
            Polled {formatTimestamp(props.snapshot.providers.polledAtMs)} ·{" "}
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
                />
              )}
            </For>
          </div>
        </Show>
      </section>

      <section class="qg-section" aria-labelledby="qg-home-usage">
        <header class="qg-section__head">
          <h2 class="qg-section__title" id="qg-home-usage">
            Usage
          </h2>
          <span class="qg-section__meta qg-bucket-label">
            {props.snapshot.usage.range} · per {props.snapshot.usage.bucketUnit} · UTC
          </span>
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
          <span class="qg-section__meta">
            {pluralize(props.snapshot.projects.length, "project")} with in-range activity
          </span>
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
            <For each={props.snapshot.projects}>
              {(project) => (
                <a
                  class="qg-list__row"
                  data-clickable="true"
                  href={formatHash({ name: "project", projectId: project.projectId }, props.range)}
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
