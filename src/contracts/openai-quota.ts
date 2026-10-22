/**
 * Browser-safe OpenAI banked-reset and Credits contract (additive).
 *
 * This is a source-backed, private first-party behavior, not a stable public
 * WHAM API guarantee. The ordinary usage response owns the available count and
 * Credits; only optional expiry metadata comes from the reset-detail endpoint.
 */

/** One available banked reset. Provider reset ids/descriptions stay server-side. */
export interface BankedResetCredit {
  /** Optional provider title; sanitized before it reaches this contract. */
  title?: string;
  /**
   * `null` means the provider explicitly reports no expiry. Absent means the
   * detail was unknown or unavailable; callers must not invent a countdown.
   */
  expiresAtIso?: string | null;
}

/** Summary count authority plus the known available-expiry records. */
export interface BankedResetAvailability {
  availableCount: number;
  credits: BankedResetCredit[];
}

/** Stable row identity keys; never display labels or account identities. */
export const OPENAI_RESETS_ROW_KEY = "openai:resets";
export const OPENAI_CREDITS_ROW_KEY = "openai:credits";

/** Result types are part of the stable row id (`resultType:kind` suffix). */
export const OPENAI_RESETS_ROW_RESULT_TYPE = "status";
export const OPENAI_CREDITS_ROW_RESULT_TYPE = "balance";

export const OPENAI_RESETS_ROW_LABEL = "Resets";
export const OPENAI_CREDITS_ROW_LABEL = "Credits";

/** Exact owner-approved info copy, shown immediately next to the row label. */
export const OPENAI_RESETS_INFO =
  "Shown only when OpenAI reports one or more available banked resets.";
export const OPENAI_CREDITS_INFO =
  "Shown only when OpenAI reports a positive credit balance or unlimited credits.";
