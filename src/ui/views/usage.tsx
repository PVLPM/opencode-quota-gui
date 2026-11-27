import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { UsageSnapshot } from "../../contracts/usage";
import type { DisplayPreferences } from "../components/quota-card";
import { EmptyNotice, Skeleton } from "../components/states";
import { UsageAccountCard } from "../components/usage-account";
import { UsageImportedSection } from "../components/usage-imported";
import { formatTimestampMinutes, pluralize } from "../format";
import { ATTRIBUTION_DISCLOSURE, harnessLabel } from "../usage-model";

/**
 * Usage is a Quota-area view, not Analytics: it reads the stored observation
 * history the existing poll collected, so opening it performs no provider
 * request. Every account owns one card; every quota window stacks full-width
 * inside that card on all screen widths.
 */
export function UsageView(props: {
  snapshot: UsageSnapshot;
  preferences: DisplayPreferences;
}): JSX.Element {
  const enabledImports = () => props.snapshot.imports.filter((entry) => entry.enabled);

  return (
    <section class="qg-section qg-usage-view" aria-label="Usage">
      <header class="qg-section__head">
        <h2 class="qg-section__title">Usage</h2>
        <span class="qg-section__meta">
          {pluralize(props.snapshot.accounts.length, "account")} ·{" "}
          {pluralize(
            props.snapshot.accounts.reduce((total, account) => total + account.windows.length, 0),
            "quota window",
          )}
        </span>
      </header>

      <Show when={props.snapshot.activityUnavailable}>
        <output class="qg-usage-view__notice">
          Recorded activity is not ready for this range. Quota history is still valid, but model
          attribution is unavailable.
        </output>
      </Show>

      <section class="qg-legend qg-usage-legend" aria-label="Usage chart legend">
        <span class="qg-legend__item">
          <span class="qg-legend__swatch" aria-hidden="true" />
          <span class="qg-legend__label">Observed</span>
        </span>
        <span class="qg-legend__item">
          <span class="qg-legend__swatch qg-legend__swatch--dashed" aria-hidden="true" />
          <span class="qg-legend__label">Monitoring gap (unobserved)</span>
        </span>
        <span class="qg-legend__item">
          <span class="qg-usage-legend__marker" aria-hidden="true" />
          <span class="qg-legend__label">Reset / boundary</span>
        </span>
        <span class="qg-legend__item">
          <span class="qg-usage-legend__unavailable" aria-hidden="true" />
          <span class="qg-legend__label">No history</span>
        </span>
      </section>

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
                index={index()}
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

      <Show when={enabledImports().length > 0}>
        <p class="qg-usage-view__imports">
          Imports:{" "}
          {enabledImports()
            .map((entry) => {
              const last =
                entry.lastImportedAtMs === undefined
                  ? "no import yet"
                  : `last ${formatTimestampMinutes(entry.lastImportedAtMs, props.snapshot.timeZone)}`;
              return `${harnessLabel(entry.harness)} (${entry.status}, ${last})`;
            })
            .join(" · ")}
        </p>
      </Show>

      <p class="qg-usage-view__note">{ATTRIBUTION_DISCLOSURE}</p>
      <footer class="qg-quota__meta">
        Local observation history · generated{" "}
        {formatTimestampMinutes(props.snapshot.generatedAtMs, props.snapshot.timeZone)} · this view
        never requests provider data
      </footer>
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
