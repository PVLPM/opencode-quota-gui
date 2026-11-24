import type { JSX } from "solid-js";
import type { ModelIdentity } from "../../contracts/dashboard";
import { ModelIdentityMark } from "./model-identity-mark";
import { ProviderLogo } from "./provider-logo";

function webLogo(providerId: string): JSX.Element {
  return <ProviderLogo providerId={providerId} class="qg-model-identity__logo" />;
}

/** Compact `provider/model#effort` label for the web dashboard. */
export function ModelIdentityLabel(props: {
  identity: ModelIdentity;
  class?: string;
}): JSX.Element {
  return (
    <ModelIdentityMark
      providerId={props.identity.providerId}
      modelId={props.identity.modelId}
      effort={props.identity.effort}
      renderLogo={webLogo}
      class={props.class}
    />
  );
}
