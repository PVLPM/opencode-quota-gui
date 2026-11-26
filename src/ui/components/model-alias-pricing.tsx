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

const UNAVAILABLE_COPY = {
  ambiguous:
    "The observed alias evidence does not identify one pricing target; pricing needs a single unambiguous match.",
  missing: "No confirmed target could be verified for this alias.",
} as const;

const UNAVAILABLE_SUMMARY = {
  ambiguous: "unresolved target",
  missing: "no confirmed target",
} as const;

const SOURCE_LABELS: Record<
  Exclude<ClaudeAgentAliasPricingProvenance["state"], "unavailable">,
  string
> = {
  catalog: "OpenCode model catalog + models.dev",
  "last-confirmed": "last confirmed OpenCode model catalog evidence + models.dev",
  "static-fallback": "static alias fallback + models.dev",
};

const SUMMARY_STATE_LABELS: Record<
  Exclude<ClaudeAgentAliasPricingProvenance["state"], "unavailable">,
  string
> = {
  catalog: "current catalog target",
  "last-confirmed": "last confirmed",
  "static-fallback": "static fallback",
};

/**
 * One line for surfaces that already show the model (session-chart readout,
 * Desktop pill description). Truthful about an unresolved price.
 */
export function modelAliasPricingSummary(alias: ClaudeAgentAliasPricingProvenance): string {
  if (alias.state === "unavailable") {
    return `Pricing: not estimated (${UNAVAILABLE_SUMMARY[alias.unavailableReason ?? "missing"]})`;
  }
  const label = targetLabel(alias);
  if (alias.priced !== true) {
    return `Pricing: target ${label}, rates unavailable; not estimated; historical version unknown`;
  }
  return `Pricing: ${label} (${SUMMARY_STATE_LABELS[alias.state]}); historical version unknown`;
}

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
        UNAVAILABLE_COPY[alias.unavailableReason ?? "missing"],
      );
      break;
  }
  lines.push(
    alias.state === "unavailable"
      ? "Pricing: Not estimated"
      : alias.priced === true
        ? "Pricing: API-equivalent estimate"
        : "Pricing: Not estimated (no rate is available for this target)",
  );
  if (alias.state !== "unavailable") {
    lines.push(`Source: ${SOURCE_LABELS[alias.state]}`);
  }
  lines.push(
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
