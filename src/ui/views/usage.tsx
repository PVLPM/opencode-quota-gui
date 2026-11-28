import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { ProviderCard } from "../../contracts/dashboard";
import type { UsageSnapshot } from "../../contracts/usage";
import type { DisplayPreferences } from "../components/quota-card";
import { EmptyNotice, Skeleton } from "../components/states";
import { UsageAccountCard } from "../components/usage-account";
import { UsageImportedSection } from "../components/usage-imported";
import { Icon, Tooltip } from "../opencode-ui";
import { ATTRIBUTION_DISCLOSURE } from "../usage-model";
import { usageRunwayIndex } from "../usage-runway";

/** The view's one caveat trigger; it seats in the first account header. */
function UsageInfo(): JSX.Element {
  return (
    <Tooltip
      class="qg-usage-info"
      value={
        <span class="qg-usage-caveats__body">
          <span>Dashed grey is a monitoring gap.</span>
          <span>Amber dashes are the quota card's projected runway.</span>
          <span>{ATTRIBUTION_DISCLOSURE}</span>
        </span>
      }
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-usage-caveats"
    >
      <span class="sr-only">About usage history</span>
      <span class="qg-usage-info__icon" aria-hidden="true">
        <Icon name="info" size="small" />
      </span>
    </Tooltip>
  );
}

/**
 * Usage is a Quota-area view, not Analytics: it reads the stored observation
 * history the existing poll collected, so opening it performs no provider
 * request. One compact card per account; the tab already names the view, so the
 * page keeps no heading, counts, legend or footer prose. Everything a reader
 * needs to interpret the plots lives in the one info popover.
 */
export function UsageView(props: {
  snapshot: UsageSnapshot;
  preferences: DisplayPreferences;
  /** Already-loaded quota cards supply the same runway data the cards show. */
  cards?: readonly ProviderCard[];
  /** A stale quota payload suppresses that runway, exactly as the cards do. */
  cardsStale?: boolean;
}): JSX.Element {
  const runway = createMemo(() => usageRunwayIndex(props.cards, { stale: props.cardsStale }));

  return (
    <section class="qg-section qg-usage-view" aria-label="Usage">
      <Show when={props.snapshot.historyUnavailable}>
        <output class="qg-usage-view__notice">
          Usage history could not be read. Existing observations are unavailable until the history
          database is readable again.
        </output>
      </Show>

      <Show when={props.snapshot.activityUnavailable}>
        <output class="qg-usage-view__notice">
          Recorded activity is not ready for this range, so model attribution is unavailable.
        </output>
      </Show>

      <Show
        when={props.snapshot.accounts.length > 0}
        fallback={
          <EmptyNotice message="No usage history has been collected yet. Open Quota and let the existing provider poll record observations." />
        }
      >
        <div class="qg-usage-accounts">
          <For each={props.snapshot.accounts}>
            {(account, index) => (
              <UsageAccountCard
                account={account}
                models={props.snapshot.models}
                mode={props.preferences.percentMode}
                timeZone={props.snapshot.timeZone}
                range={props.snapshot.range}
                nowMs={props.snapshot.generatedAtMs}
                runwayIndex={runway()}
                index={index()}
                info={index() === 0 ? <UsageInfo /> : undefined}
              />
            )}
          </For>
        </div>
      </Show>

      <div class="qg-usage-imported-activity">
        <For each={props.snapshot.importedActivity}>
          {(activity) => (
            <UsageImportedSection activity={activity} timeZone={props.snapshot.timeZone} />
          )}
        </For>
      </div>
    </section>
  );
}

export function UsageLoading(): JSX.Element {
  return (
    <section class="qg-section" aria-label="Usage">
      <Skeleton label="Loading usage history" />
    </section>
  );
}
