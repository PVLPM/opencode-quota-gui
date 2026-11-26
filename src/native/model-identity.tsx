import { type JSX, Show } from "solid-js";
import type { ClaudeAgentAliasPricingProvenance } from "../contracts/dashboard";
import { ModelAliasPricingDetails } from "../ui/components/model-alias-pricing";
import { ModelIdentityMark } from "../ui/components/model-identity-mark";
import { ProviderLogo } from "./provider-logo";
import { Tooltip } from "./ui";

/** The runtime model identity carried by cache-observer session metadata. */
export interface NativeModelIdentity {
  providerID: string;
  id: string;
  variant?: string;
  pricingAlias?: ClaudeAgentAliasPricingProvenance;
}

function nativeLogo(providerId: string): JSX.Element {
  return <ProviderLogo providerId={providerId} class="qg-model-identity__logo" />;
}

/** Compact model label for the Desktop surfaces, with the native logo source. */
export function NativeModelIdentityLabel(props: {
  identity: NativeModelIdentity;
  class?: string;
}): JSX.Element {
  const mark = () => (
    <ModelIdentityMark
      providerId={props.identity.providerID}
      modelId={props.identity.id}
      effort={props.identity.variant}
      renderLogo={nativeLogo}
      class={props.class}
    />
  );
  return (
    <Show when={props.identity.pricingAlias} fallback={mark()}>
      {(alias) => (
        <Tooltip
          value={
            <ModelAliasPricingDetails
              model={{
                providerId: props.identity.providerID,
                modelId: props.identity.id,
                effort: props.identity.variant,
              }}
              pricingAlias={alias()}
            />
          }
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
