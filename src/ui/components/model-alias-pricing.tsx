import { For, type JSX } from "solid-js";
import type { ClaudeAgentAliasPricingProvenance } from "../../contracts/dashboard";
import { formatModelIdentity } from "../format";

export interface ModelAliasPricingModel {
  providerId: string;
  modelId: string;
  effort?: string;
}

function targetLabel(alias: ClaudeAgentAliasPricingProvenance): string {
  if (alias.targetName) return alias.targetName;
  if (alias.targetProviderId && alias.targetModelId) {
    return `${alias.targetProviderId}/${alias.targetModelId}`;
  }
  return alias.alias;
}

const SOURCE_LABELS: Record<ClaudeAgentAliasPricingProvenance["state"], string> = {
  catalog: "OpenCode model catalog + models.dev",
  "last-confirmed": "last confirmed OpenCode model catalog evidence + models.dev",
  "static-fallback": "static alias fallback + models.dev",
  unavailable: "OpenCode model catalog + models.dev (no unique match)",
};

/**
 * One wording for both surfaces. The alias is always the stored identity; only
 * the resolution metadata changes with the evidence state.
 */
export function modelAliasPricingLines(
  model: ModelAliasPricingModel,
  alias: ClaudeAgentAliasPricingProvenance,
): string[] {
  const lines = [`Model: ${formatModelIdentity(model)}`];
  switch (alias.state) {
    case "catalog":
      lines.push(`Current alias target: ${targetLabel(alias)}`);
      break;
    case "last-confirmed":
      lines.push(`Last confirmed alias target: ${targetLabel(alias)}`);
      break;
    case "static-fallback":
      lines.push(
        `Static fallback target: ${targetLabel(alias)}`,
        "Not confirmed as the current native model.",
      );
      break;
    case "unavailable":
      lines.push(
        "Pricing target unavailable",
        alias.unavailableReason === "ambiguous"
          ? "More than one catalog model matches this alias."
          : "No catalog model matches this alias.",
      );
      break;
  }
  lines.push(
    alias.state === "unavailable" ? "Pricing: Not estimated" : "Pricing: API-equivalent estimate",
    `Source: ${SOURCE_LABELS[alias.state]}`,
    "Historical model version: unknown — usage was recorded under the alias and may predate the current pricing target.",
  );
  return lines;
}

/** Shared tooltip body; each surface supplies its own Tooltip wrapper. */
export function ModelAliasPricingDetails(props: {
  model: ModelAliasPricingModel;
  pricingAlias: ClaudeAgentAliasPricingProvenance;
}): JSX.Element {
  return (
    <For each={modelAliasPricingLines(props.model, props.pricingAlias)}>
      {(line) => <p>{line}</p>}
    </For>
  );
}
