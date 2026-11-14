/**
 * Anthropic provider: OpenCode's own Anthropic logins only.
 *
 * Each OpenCode Anthropic OAuth login row is queried for its quota windows. This provider never
 * launches or reads the Claude CLI; that login belongs to the separate Claude Agent provider.
 * API-key logins expose no comparable quota, so they are not reported here.
 */

import type { AnthropicQuotaResult } from "../lib/anthropic.js";
import { queryAnthropicQuotaWithOAuth } from "../lib/anthropic.js";
import { type ResolvedAnthropicOAuth, resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { QUOTA_FORCE_REFRESH } from "../lib/entries.js";
import {
  type CredentialRow,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export function getAnthropicNoDataMessage(): string {
  return "Quota unavailable via OpenCode Anthropic sign-in";
}

const ANTHROPIC_SIGN_IN_MISSING_MESSAGE =
  "Anthropic sign-in is not configured in OpenCode. Run `opencode auth login anthropic`.";

/**
 * The quota rows of one Anthropic subscription login. Pure mapping shared with the Claude Agent
 * provider; each provider passes its own group, source and acquisition method.
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

/**
 * Every OpenCode Anthropic OAuth login row with its resolved state, in OpenCode's row order. The
 * provider emits the configured and failed ones; the cache identity covers every row.
 */
export async function readOpenCodeAnthropicLogins(): Promise<
  { row: CredentialRow; auth: ResolvedAnthropicOAuth }[]
> {
  return (await readCredentialRows(["anthropic"], { methods: ["oauth"] })).flatMap((row) => {
    if (row.integrationId !== "anthropic") return [];
    const auth = resolveAnthropicOAuth({
      anthropic: credentialRowAuthEntry(row),
    } as AuthData);
    return [{ row, auth }];
  });
}

/** Logins this provider reports: configured ones and ones that failed to resolve (shown as errors). */
async function readReportedLogins(): Promise<
  { row: CredentialRow; auth: ResolvedAnthropicOAuth }[]
> {
  try {
    return (await readOpenCodeAnthropicLogins()).filter(
      ({ auth }) => auth.state === "configured" || auth.state === "failed",
    );
  } catch {
    return [];
  }
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
    const providerAvailable = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: ["anthropic"],
      fallbackOnError: false,
    });
    if (!providerAvailable) return false;
    return (await readReportedLogins()).length > 0;
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const forceRefresh = ctx.operationCache?.get(QUOTA_FORCE_REFRESH) === true;
    const logins = await readReportedLogins();
    const statusDetails = statusDetailsFromRecord({
      oauth_credential_source: logins.length > 0 ? "opencode-auth" : "(none)",
      opencode_logins: String(logins.length),
    });

    if (logins.length === 0) {
      // A selected anthropic route says why it has no data; otherwise there is nothing to show.
      return withStatusDetails(
        ctx.config?.onlyCurrentModel
          ? attemptedErrorResult("Claude", ANTHROPIC_SIGN_IN_MISSING_MESSAGE, {
              failureCategory: "credentials",
            })
          : notAttemptedResult(),
        statusDetails,
      );
    }

    const results = await Promise.all(
      logins.map(async ({ row, auth }) => ({
        row,
        result:
          auth.state === "configured"
            ? await queryAnthropicQuotaWithOAuth(
                auth.accessToken,
                ctx.config?.requestTimeoutMs,
                ...(forceRefresh ? [ctx.operationCache] : []),
              )
            : {
                success: false as const,
                error: "Anthropic sign-in could not be read. Run `opencode auth login anthropic`.",
                failureCategory: "credentials" as const,
              },
      })),
    );
    const names = formatCredentialDisplayNames(
      "Claude",
      results.map(({ row }) => ({ row, fallbackName: "Claude" })),
    );
    const accounts = results.map(({ row }, index) => ({
      sourceId: row.id,
      label: names[index] ?? "Claude",
      active: row.active,
    }));
    const entries: QuotaToastEntry[] = [];
    const errors: QuotaProviderResult["errors"] = [];
    for (const [index, { row, result }] of results.entries()) {
      const group = names[index] ?? "Claude";
      if (!result?.success) {
        if (result) {
          errors.push({
            label: group,
            message:
              result.failureCategory === "credentials"
                ? "Anthropic sign-in could not be used. Run `opencode auth login anthropic`."
                : "Anthropic quota request failed.",
            sourceId: row.id,
            failureCategory: result.failureCategory,
          });
        }
        continue;
      }
      entries.push(
        ...anthropicQuotaEntries(result, {
          group,
          acquisitionMethod: "remote_api",
          sourceId: row.id,
        }),
      );
    }
    return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, statusDetails);
  },
};
