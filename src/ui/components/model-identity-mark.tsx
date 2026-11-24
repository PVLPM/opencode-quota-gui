import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { formatModelIdentity } from "../format";
import { resolveProviderPresentation } from "../provider-catalog";

/**
 * Shared compact model label used by both surfaces. The surface supplies its
 * own `ProviderLogo` element, so the web and Desktop builds keep their own
 * resource strategy while the accessible/fallback markup stays identical.
 *
 * A known provider replaces the text prefix with its mark. An unknown provider
 * keeps the full `provider/model#effort` text so no generic mark loses
 * identity. The same full text stays in `title` and in the accessible name.
 */
export function ModelIdentityMark(props: {
  providerId: string;
  modelId: string;
  effort?: string;
  renderLogo: (providerId: string) => JSX.Element;
  class?: string;
}): JSX.Element {
  const full = () => formatModelIdentity(props);
  const short = () => `${props.modelId}${props.effort ? `#${props.effort}` : ""}`;
  const presentation = () => resolveProviderPresentation(props.providerId);
  const className = () =>
    props.class === undefined ? "qg-model-identity" : `qg-model-identity ${props.class}`;

  return (
    <Show
      when={presentation().hasSpecificLogo}
      fallback={
        <span class={className()} title={full()}>
          {full()}
        </span>
      }
    >
      <span
        class={className()}
        role="img"
        aria-label={`${presentation().label}: ${full()}`}
        title={full()}
      >
        {props.renderLogo(props.providerId)}
        <span class="qg-model-identity__id">{short()}</span>
      </span>
    </Show>
  );
}
