import type { JSX } from "solid-js";
import { ModelIdentityMark } from "../ui/components/model-identity-mark";
import { ProviderLogo } from "./provider-logo";

/** The runtime model identity carried by cache-observer session metadata. */
export interface NativeModelIdentity {
  providerID: string;
  id: string;
  variant?: string;
}

function nativeLogo(providerId: string): JSX.Element {
  return <ProviderLogo providerId={providerId} class="qg-model-identity__logo" />;
}

/** Compact model label for the Desktop surfaces, with the native logo source. */
export function NativeModelIdentityLabel(props: {
  identity: NativeModelIdentity;
  class?: string;
}): JSX.Element {
  return (
    <ModelIdentityMark
      providerId={props.identity.providerID}
      modelId={props.identity.id}
      effort={props.identity.variant}
      renderLogo={nativeLogo}
      class={props.class}
    />
  );
}
