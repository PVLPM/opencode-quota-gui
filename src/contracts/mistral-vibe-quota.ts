/**
 * Browser-safe Mistral Vibe subscription row contract.
 *
 * The row ids below are the emitted identity of the two budget rows, so the
 * Settings Visibility declaration and the provider mapping cannot drift apart:
 * both import these constants. Identity is the typed `named` metric, never a
 * display label or an array position.
 */

/** Stable row key of the Vibe budget (the subscription allowance). */
export const MISTRAL_VIBE_BUDGET_ROW_KEY = "named:Vibe budget";
/** Stable row key of the pay-as-you-go API budget. */
export const MISTRAL_VIBE_API_BUDGET_ROW_KEY = "named:API budget";

/** Named metric the rows carry; the row key above is its rendered id. */
export const MISTRAL_VIBE_BUDGET_METRIC_NAME = "Vibe budget";
export const MISTRAL_VIBE_API_BUDGET_METRIC_NAME = "API budget";

export const MISTRAL_VIBE_BUDGET_LABEL = "Vibe budget";
export const MISTRAL_VIBE_API_BUDGET_LABEL = "API budget";

/** Both rows are percent budgets, so their declared control is a percent row. */
export const MISTRAL_VIBE_ROW_RESULT_TYPE = "budget";
export const MISTRAL_VIBE_ROW_KIND = "percent";

export const MISTRAL_VIBE_BUDGET_INFO =
  "Your Vibe subscription allowance for the current billing period, as reported by Mistral.";
export const MISTRAL_VIBE_API_BUDGET_INFO =
  "Your Mistral API (pay-as-you-go) budget, shown only when pay-as-you-go billing is enabled.";
