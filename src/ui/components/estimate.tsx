import type { JSX } from "solid-js";
import type { CostedTokens } from "../../contracts/dashboard";
import { formatExactCount } from "../format";
import { Icon, Tooltip } from "../opencode-ui";

/**
 * The estimate stays a normal secondary metric; its exclusions live behind one
 * restrained info affordance instead of a warning row in the summary body.
 */
export function estimateExplanation(
  totals: Pick<CostedTokens, "unpricedTokens" | "unknownTokens">,
): string {
  const parts = ["API-equivalent estimate from list prices, not actual subscription spend."];
  if (totals.unknownTokens > 0) {
    parts.push(
      `${formatExactCount(totals.unknownTokens)} unknown tokens are excluded from the estimate.`,
    );
  }
  if (totals.unpricedTokens > 0) {
    parts.push(
      `${formatExactCount(totals.unpricedTokens)} unpriced tokens are excluded from the estimate.`,
    );
  }
  if (totals.unknownTokens === 0 && totals.unpricedTokens === 0) {
    parts.push("All reported tokens are priced; the figure is still an estimate.");
  }
  return parts.join(" ");
}

export function EstimateInfo(props: {
  totals: Pick<CostedTokens, "unpricedTokens" | "unknownTokens">;
}): JSX.Element {
  return (
    <Tooltip
      value={estimateExplanation(props.totals)}
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-row__tooltip"
    >
      <span class="sr-only">About the API-equivalent estimate</span>
      <span class="qg-row__info" aria-hidden="true">
        <Icon name="info" size="small" />
      </span>
    </Tooltip>
  );
}
