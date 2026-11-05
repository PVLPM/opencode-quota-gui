import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { createProviderReview, type ProviderReviewState } from "./agent-provider-review-state.js";
import type { NativeDashboardClient } from "./dashboard-client.js";

/** Native-only: agents can propose definitions but cannot approve or activate them. */
export function AgentProviderReview(props: {
  client: NativeDashboardClient;
  stale: boolean;
}): JSX.Element {
  const [state, setState] = createSignal<ProviderReviewState>({ busy: false });
  const review = createProviderReview(props.client, setState);
  onMount(() => {
    void review.refresh();
  });
  const unsubscribe = props.client.subscribe((event) => {
    if (event.topic === "settings.changed") {
      review.invalidate();
      void review.refresh();
    }
  });
  const unsubscribeReconnect = props.client.onReconnect(() => {
    review.invalidate();
    void review.refresh();
  });
  onCleanup(() => {
    review.invalidate();
    unsubscribe();
    unsubscribeReconnect();
  });

  return (
    <details class="qg-native-provider-review">
      <summary>
        Agent-proposed providers{" "}
        <Show when={state().snapshot}>{(snapshot) => `(${snapshot().providers.length})`}</Show>
      </summary>
      <div class="qg-native-provider-review__body">
        <p>
          Review each definition before approving it. Approval does not enable a provider; enabling
          is a separate action. Changes to its connection, identity, or mappings require approval
          again.
        </p>
        <Show when={props.stale}>
          <output>Settings may be out of date. Reconnect before making changes.</output>
        </Show>
        <Show when={state().error}>
          <p role="alert">{state().error}</p>
        </Show>
        <Show when={!state().snapshot && !state().busy}>
          <button type="button" class="qg-stale__retry" onClick={() => void review.refresh()}>
            Reload proposals
          </button>
        </Show>
        <Show when={state().busy}>
          <output>Loading or saving proposals…</output>
        </Show>
        <Show when={state().snapshot?.providers.length === 0}>
          <p>No agent-proposed providers.</p>
        </Show>
        <For each={state().snapshot?.providers}>
          {(provider) => (
            <section
              class="qg-native-provider-review__proposal"
              aria-label={`Proposal ${provider.id}`}
            >
              <strong>{provider.id}</strong>
              <p>
                {provider.approved ? "Approved" : "Needs approval"} ·{" "}
                {provider.approved && provider.enabled ? "Enabled" : "Disabled"}
              </p>
              <p>Definition (environment variable names are references, not secret values):</p>
              <pre>{JSON.stringify(provider.definition, null, 2)}</pre>
              <div class="qg-field__control">
                <Show when={!provider.approved}>
                  <button
                    type="button"
                    class="qg-stale__retry"
                    disabled={state().busy || props.stale}
                    onClick={() => void review.approve(provider.id)}
                  >
                    Approve definition
                  </button>
                </Show>
                <Show when={provider.approved}>
                  <button
                    type="button"
                    class="qg-stale__retry"
                    disabled={state().busy || props.stale}
                    onClick={() => void review.enable(provider.id, !provider.enabled)}
                  >
                    {provider.enabled ? "Disable provider" : "Enable provider"}
                  </button>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </details>
  );
}
