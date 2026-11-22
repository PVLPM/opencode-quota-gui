/**
 * Anthropic provider: the Anthropic API-key connection only.
 *
 * Subscription quota belongs to Claude Agent. An ordinary API key exposes no spend, balance or
 * quota endpoint, so this card shows only per-minute rate limits passively observed on real
 * OpenCode API-key Messages traffic (see `../lib/anthropic-api-rate-limits.ts`).
 */

import type { AnthropicQuotaResult } from "../lib/anthropic.js";
import { resolveAnthropicApiKey } from "../lib/anthropic-api-auth.js";
import {
  ANTHROPIC_RATE_LIMIT_METERS,
  type AnthropicApiObservation,
  type AnthropicRateLimitMeter,
  digestAnthropicApiKey,
  readAnthropicApiObservation,
} from "../lib/anthropic-api-rate-limits.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export function getAnthropicNoDataMessage(): string {
  return "No Anthropic API key configured";
}

const ANTHROPIC_API_KEY_MISSING_MESSAGE = "No Anthropic API key is configured.";
const ANTHROPIC_NO_OBSERVATION_TEXT = "No rate-limit headers observed yet";

/**
 * Map subscription quota returned for the Claude Agent CLI login.
 */
export function anthropicQuotaEntries(
  quota: AnthropicQuotaResult,
  params: {
    group: string;
    acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"];
    sourceId?: string;
  },
): QuotaToastEntry[] {
  const { group } = params;
  const accounting = {
    resultType: "quota" as const,
    acquisitionMethod: params.acquisitionMethod,
    ownership: "maintained" as const,
    authority: "provider_reported" as const,
    ...(params.sourceId !== undefined ? { sourceId: params.sourceId } : {}),
  };
  const entries: QuotaToastEntry[] = [];
  for (const [label, window, rowKey] of [
    ["5h", quota.five_hour, "window:five_hour"],
    ["Weekly", quota.seven_day, "window:week"],
  ] as const) {
    if (!window) continue;
    entries.push({
      accounting: { ...accounting },
      name: `${group} ${label}`,
      group,
      label: `${label}:`,
      rowKey,
      percentRemaining: window.percentRemaining,
      resetTimeIso: window.resetTimeIso,
      ...(window.fixedWindow ? { fixedWindow: { ...window.fixedWindow } } : {}),
    });
  }
  if (quota.extra_usage) {
    entries.push({
      accounting: { ...accounting },
      name: `${group} Usage Credits`,
      group: `${group} Usage Credits`,
      label: "Monthly:",
      rowKey: "window:month",
      percentRemaining: quota.extra_usage.percentRemaining,
    });
  }
  if (quota.fable_weekly) {
    entries.push({
      accounting: { ...accounting },
      name: `${group} Fable Weekly`,
      group,
      label: "Fable:",
      semantic: {
        metric: { kind: "named", name: "Fable weekly" },
        prominence: "primary",
      },
      percentRemaining: quota.fable_weekly.percentRemaining,
      resetTimeIso: quota.fable_weekly.resetTimeIso,
    });
  }
  return entries;
}

const ANTHROPIC_GROUP = "Anthropic";
const RATE_LIMIT_INFO =
  "Anthropic API rate limit (per minute) observed on your API-key requests. Not subscription quota, spend or balance.";

const METER_LABELS = {
  requests: "Requests",
  tokens: "Tokens",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
} as const;

function numberText(value: number): string {
  return value.toLocaleString("en-US");
}

function meterValueText(meter: AnthropicRateLimitMeter): string | undefined {
  if (meter.remaining !== undefined && meter.limit !== undefined) {
    return `${numberText(meter.remaining)} of ${numberText(meter.limit)} remaining`;
  }
  if (meter.remaining !== undefined) return `${numberText(meter.remaining)} remaining`;
  if (meter.limit !== undefined) return `Limit ${numberText(meter.limit)}`;
  return undefined;
}

/**
 * Rows for one passive observation. Plain value rows: a percentage is never computed, so no
 * quota alert, runway or reset-notice logic can treat a per-minute rate limit as quota.
 */
function anthropicApiRateLimitEntries(
  observation: AnthropicApiObservation,
  nowMs: number,
): QuotaToastEntry[] {
  const accounting = {
    resultType: "rate_limit" as const,
    acquisitionMethod: "remote_api" as const,
    ownership: "maintained" as const,
    authority: "provider_reported" as const,
    observedAtIso: new Date(observation.observedAtMs).toISOString(),
  };
  const entries: QuotaToastEntry[] = [];
  for (const [, name] of ANTHROPIC_RATE_LIMIT_METERS) {
    const observed = observation.meters[name];
    if (!observed) continue;
    // A passed reset means the observed remaining count is stale; only the limit still applies.
    const expired = observed.resetAtIso !== undefined && Date.parse(observed.resetAtIso) <= nowMs;
    const meter: AnthropicRateLimitMeter = expired ? { limit: observed.limit } : observed;
    const value = meterValueText(meter);
    if (value === undefined) continue;
    entries.push({
      kind: "value",
      accounting: { ...accounting },
      name: `${ANTHROPIC_GROUP} ${METER_LABELS[name]}`,
      group: ANTHROPIC_GROUP,
      label: `${METER_LABELS[name]}:`,
      info: RATE_LIMIT_INFO,
      rowKey: `rate_limit:${name}`,
      value,
      ...(meter.resetAtIso !== undefined ? { resetTimeIso: meter.resetAtIso } : {}),
    });
  }
  if (
    observation.retryAfterSeconds !== undefined &&
    observation.observedAtMs + observation.retryAfterSeconds * 1000 > nowMs
  ) {
    entries.push({
      kind: "value",
      accounting: { ...accounting },
      name: `${ANTHROPIC_GROUP} Retry after`,
      group: ANTHROPIC_GROUP,
      label: "Retry after:",
      info: RATE_LIMIT_INFO,
      rowKey: "rate_limit:retry_after",
      value: `${numberText(observation.retryAfterSeconds)} s (last rate-limited response)`,
    });
  }
  return entries;
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (ctx.config?.onlyCurrentModel === true) {
      const selected =
        ctx.config.currentProviderID ??
        resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config.currentModel ?? "" })
          ?.providerId;
      return selected?.trim().toLowerCase() === "anthropic";
    }
    return (await resolveAnthropicApiKey()) !== null;
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const apiKey = await resolveAnthropicApiKey();
    if (apiKey === null) {
      return withStatusDetails(
        ctx.config?.onlyCurrentModel
          ? attemptedErrorResult(ANTHROPIC_GROUP, ANTHROPIC_API_KEY_MISSING_MESSAGE)
          : notAttemptedResult(),
        statusDetailsFromRecord({ api_key: "(none)" }),
      );
    }
    const observation = readAnthropicApiObservation(digestAnthropicApiKey(apiKey));
    const entries = observation ? anthropicApiRateLimitEntries(observation, Date.now()) : [];
    // Configured but nothing observed yet is a truthful status, neither an error nor a zero.
    const result = attemptedResult(
      entries.length > 0
        ? entries
        : [
            {
              kind: "value",
              accounting: {
                resultType: "status",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
              },
              name: `${ANTHROPIC_GROUP} Rate limits`,
              group: ANTHROPIC_GROUP,
              label: "Rate limits:",
              info: RATE_LIMIT_INFO,
              rowKey: "rate_limit:none",
              value: ANTHROPIC_NO_OBSERVATION_TEXT,
            },
          ],
    );
    return withStatusDetails(
      result,
      statusDetailsFromRecord({
        api_key: "(configured)",
        observed: observation ? "true" : "false",
      }),
    );
  },
};
