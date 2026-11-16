/**
 * Anthropic provider: OpenCode's own Anthropic logins only.
 *
 * Subscription quota belongs to Claude Agent. API credentials expose no comparable quota here.
 */

import type { AnthropicQuotaResult } from "../lib/anthropic.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import {
  attemptedErrorResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export function getAnthropicNoDataMessage(): string {
  return "Anthropic API quota unavailable";
}

const ANTHROPIC_API_QUOTA_UNAVAILABLE_MESSAGE = "Anthropic API quota is unavailable.";

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
    return false;
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    return withStatusDetails(
      ctx.config?.onlyCurrentModel
        ? attemptedErrorResult("Anthropic", ANTHROPIC_API_QUOTA_UNAVAILABLE_MESSAGE)
        : notAttemptedResult(),
      statusDetailsFromRecord({}),
    );
  },
};
