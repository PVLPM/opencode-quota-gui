import { type JSX, Show } from "solid-js";
import type { ModelIdentity } from "../../contracts/dashboard";
import { Tooltip } from "../opencode-ui";
import { ModelAliasPricingDetails } from "./model-alias-pricing";
import { ModelIdentityMark } from "./model-identity-mark";
import { ProviderLogo } from "./provider-logo";

function webLogo(providerId: string): JSX.Element {
  return <ProviderLogo providerId={providerId} class="qg-model-identity__logo" />;
}

/** Compact `provider/model#effort` label for the web dashboard. */
export function ModelIdentityLabel(props: {
  identity: ModelIdentity;
  class?: string;
  /**
   * The transient session-chart overlay is `pointer-events: none` and unmounts
   * on blur, so its label must not own a focusable trigger. The overlay shows
   * `modelAliasPricingSummary` as plain text instead.
   */
  showAliasTooltip?: boolean;
}): JSX.Element {
  const mark = () => (
    <ModelIdentityMark
      providerId={props.identity.providerId}
      modelId={props.identity.modelId}
      effort={props.identity.effort}
      renderLogo={webLogo}
      class={props.class}
    />
  );
  return (
    <Show
      when={props.showAliasTooltip === false ? undefined : props.identity.pricingAlias}
      fallback={mark()}
    >
      {(alias) => (
        <Tooltip
          value={<ModelAliasPricingDetails model={props.identity} pricingAlias={alias()} />}
          triggerTabIndex={0}
          appearance="large"
          class="qg-alias-pricing-trigger"
          contentClass="qg-alias-pricing"
        >
          {mark()}
        </Tooltip>
      )}
    </Show>
  );
}
