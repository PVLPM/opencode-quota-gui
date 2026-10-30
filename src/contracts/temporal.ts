/**
 * Browser-safe temporal pricing DTO.
 *
 * The core evaluator (`src/lib/modelsdev-temporal.ts`) reads its bundled
 * snapshot with `node:fs`, so it never reaches the browser. The server computes
 * these already-evaluated statuses and the dashboard only formats them. Times
 * are epoch milliseconds: the browser renders them in the user's local zone.
 */

export type TemporalPhase = "peak" | "offpeak" | "mixed" | "unknown";

export type TemporalModelPhase = "peak" | "offpeak" | "unknown";

/** What a temporal rule changes: API price, or Z.ai's plan quota points. */
export type TemporalEffectUnit = "api_price" | "quota_points";

export interface TemporalEffect {
  /** Effective multiplier over the provider's base rate (1 means unchanged). */
  factor: number;
  direction: "peak" | "offpeak" | "unchanged";
  unit: TemporalEffectUnit;
}

/** One exact half-open `[startMs, endMs)` pricing window for one model. */
export interface TemporalModelInterval {
  startMs: number;
  endMs: number;
  phase: TemporalModelPhase;
  effect?: TemporalEffect;
  reason?: string;
}

export interface TemporalModelStatus {
  /** Exact models.dev model id; never inferred from a display label. */
  modelId: string;
  /** Server-computed state at `TemporalStatusSnapshot.generatedAtMs`. */
  state: TemporalModelPhase;
  effect?: TemporalEffect;
  /** Next state/rule change, absent when no further transition is known. */
  nextChangeAtMs?: number;
  /** Upcoming exact windows, for live client-side state and local schedules. */
  intervals: TemporalModelInterval[];
  /** Why a policy is unresolved or unsupported; omitted for supported states. */
  reason?: string;
}

export type TemporalHoliday = "CN" | "US" | "CA";

export interface TemporalHolidayInterval {
  jurisdiction: TemporalHoliday;
  id: string;
  /** Inclusive civil date in the jurisdiction's own time zone. */
  localStart: string;
  /** Exclusive civil date in the jurisdiction's own time zone. */
  localEnd: string;
  startMs: number;
  endMs: number;
}

export interface TemporalPolicySource {
  label: string;
  url: string;
  accessedAt: string;
}

export interface TemporalProviderStatus {
  providerId: string;
  providerLabel: string;
  /** True when this quota cycle discovered an account/card for the provider. */
  discovered: boolean;
  /** `mixed` means at least one exact model is peak while another is off-peak. */
  phase: TemporalPhase;
  models: TemporalModelStatus[];
  /** Upcoming public-holiday exceptions referenced by this provider's policies. */
  holidays: TemporalHolidayInterval[];
  /** Provenance for a provider-maintained policy outside models.dev. */
  source?: TemporalPolicySource;
}

export interface TemporalStatusSnapshot {
  generatedAtMs: number;
  /** Every temporal-capable provider, with account discovery marked per entry. */
  providers: TemporalProviderStatus[];
  /** Pinned models.dev snapshot identity used for this evaluation. */
  snapshot: {
    revision: string;
    generatedAtMs: number;
  };
}
