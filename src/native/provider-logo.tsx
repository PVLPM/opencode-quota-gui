import type { JSX } from "solid-js";
import { PROVIDER_LOGO_FALLBACK_KEY, resolveProviderPresentation } from "../ui/provider-catalog";

/**
 * Provider marks for the Desktop bundle (Stage 4).
 *
 * The web build serves the SVGs from `/assets/providers/`, a path that does
 * not exist inside the Desktop process. Each shipped mark is inlined as a data
 * URL instead, so the mask, the label and the `data-provider-logo` identity are
 * exactly what the shared catalog resolves — only the resource location moves.
 */
const SOURCES = import.meta.glob("../ui/assets/provider-logos/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function dataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const LOGO_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SOURCES).map(([file, svg]) => [
    file.slice(file.lastIndexOf("/") + 1, -".svg".length),
    dataUrl(svg),
  ]),
);

const FALLBACK_URL = LOGO_URLS[PROVIDER_LOGO_FALLBACK_KEY];

export function ProviderLogo(props: { providerId: string; class?: string }): JSX.Element {
  const presentation = () => resolveProviderPresentation(props.providerId);
  const className = () =>
    props.class === undefined ? "qg-provider-logo" : `qg-provider-logo ${props.class}`;
  const source = () => LOGO_URLS[presentation().logoKey] ?? FALLBACK_URL;

  return (
    <span
      class={className()}
      style={{ "--qg-provider-logo": `url("${source()}")` }}
      data-provider-logo={presentation().logoKey}
      aria-hidden="true"
    />
  );
}
