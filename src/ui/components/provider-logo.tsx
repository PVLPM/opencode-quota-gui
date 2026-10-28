import type { JSX } from "solid-js";
import { resolveProviderPresentation } from "../provider-catalog";

/**
 * A decorative, monochrome provider mark. The SVG is applied through a CSS mask
 * so its own colors never leak into the dashboard and the mark inherits the
 * surrounding text color. The visible provider label beside it carries the
 * accessible name; this element is hidden from assistive technology.
 */
export function ProviderLogo(props: { providerId: string; class?: string }): JSX.Element {
  const presentation = () => resolveProviderPresentation(props.providerId);
  const className = () =>
    props.class === undefined ? "qg-provider-logo" : `qg-provider-logo ${props.class}`;

  return (
    <span
      class={className()}
      style={{ "--qg-provider-logo": `url("${presentation().logoSrc}")` }}
      data-provider-logo={presentation().logoKey}
      aria-hidden="true"
    />
  );
}
