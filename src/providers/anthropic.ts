/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import type { AnthropicResult } from "../lib/anthropic.js";
import {
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuotaWithOAuth,
} from "../lib/anthropic.js";
import { resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
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
  return "Quota unavailable via local Claude CLI or OAuth credentials";
}

const CLAUDE_CODE_RUNTIME_IDS = ["claude-agent", "claude-code"] as const;

function getClaudeCodeRuntimeProviderId(
  ctx: QuotaProviderContext,
): (typeof CLAUDE_CODE_RUNTIME_IDS)[number] | undefined {
  if (ctx.config?.onlyCurrentModel !== true) return undefined;

  const currentProviderId = (
    ctx.config?.currentProviderID ??
    resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
      ?.providerId
  )
    ?.trim()
    .toLowerCase();
  return currentProviderId &&
    CLAUDE_CODE_RUNTIME_IDS.includes(currentProviderId as (typeof CLAUDE_CODE_RUNTIME_IDS)[number])
    ? (currentProviderId as (typeof CLAUDE_CODE_RUNTIME_IDS)[number])
    : undefined;
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const claudeCodeRuntimeId = getClaudeCodeRuntimeProviderId(ctx);
    const candidateIds = claudeCodeRuntimeId
      ? [claudeCodeRuntimeId]
      : ctx.config?.onlyCurrentModel
        ? ["anthropic"]
        : ["anthropic", ...CLAUDE_CODE_RUNTIME_IDS];
    const providerAvailable = await isAnyProviderIdAvailable({
      ctx,
      candidateIds,
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
      ...(claudeCodeRuntimeId ? { useClaudeCodeCredentials: true } : {}),
    });
  },

  matchesCurrentModel(model: string): boolean {
    const normalized = model.toLowerCase();
    return ["anthropic", ...CLAUDE_CODE_RUNTIME_IDS].some((id) => normalized.startsWith(`${id}/`));
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const claudeCodeRuntimeId = getClaudeCodeRuntimeProviderId(ctx);
    const options = {
      binaryPath: ctx.config?.anthropicBinaryPath,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
      ...(claudeCodeRuntimeId ? { useClaudeCodeCredentials: true } : {}),
    };
    let statusDetails;
    let quotaResult: AnthropicResult = null;
    let acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"] = "local_cli";
    // A failed login stays in the list so it shows as its own error row.
    const databaseCredentials = claudeCodeRuntimeId
      ? []
      : (await readCredentialRows(["anthropic"], { methods: ["oauth"] })).flatMap((row) => {
          if (row.integrationId !== "anthropic") return [];
          const auth = resolveAnthropicOAuth({
            anthropic: credentialRowAuthEntry(row),
          } as AuthData);
          return auth.state === "configured" || auth.state === "failed" ? [{ row, auth }] : [];
        });
    try {
      const diagnostics = await getAnthropicDiagnostics(options);
      const quota = diagnostics.quotaSupported ? diagnostics.quota : undefined;
      if (diagnostics.quotaSupported) {
        quotaResult = quota ?? null;
      } else if (
        (diagnostics.authStatus === "authenticated" ||
          diagnostics.oauthCredentialSource !== undefined) &&
        diagnostics.message
      ) {
        quotaResult = {
          success: false,
          error: diagnostics.message,
          ...(diagnostics.failureCategory !== undefined
            ? { failureCategory: diagnostics.failureCategory }
            : {}),
        };
      }
      if (diagnostics.quotaSupported && diagnostics.quotaSource !== "claude-auth-status-json") {
        acquisitionMethod = "remote_api";
      }
      statusDetails = statusDetailsFromRecord({
        cli_installed: diagnostics.installed ? "true" : "false",
        cli_version: diagnostics.version ?? "(none)",
        binary_path: diagnostics.binaryPath ?? "(none)",
        auth_status: diagnostics.authStatus,
        quota_supported: diagnostics.quotaSupported ? "true" : "false",
        quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
        oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
        checked_commands: diagnostics.checkedCommands.join(" | ") || "(none)",
        message: diagnostics.message,
        five_hour_remaining: quota?.five_hour
          ? `${quota.five_hour.percentRemaining}% reset_at=${quota.five_hour.resetTimeIso ?? "(none)"}`
          : undefined,
        seven_day_remaining: quota?.seven_day
          ? `${quota.seven_day.percentRemaining}% reset_at=${quota.seven_day.resetTimeIso ?? "(none)"}`
          : undefined,
        fable_weekly_remaining: quota?.fable_weekly
          ? `${quota.fable_weekly.percentRemaining}% reset_at=${quota.fable_weekly.resetTimeIso ?? "(none)"}`
          : undefined,
      });
    } catch (error) {
      const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
      quotaResult = {
        success: false,
        error: `Claude CLI probe failed: ${message}`,
      };
      statusDetails = statusDetailsFromRecord({
        cli_installed: "false",
        message: `failed to probe Claude CLI: ${message}`,
      });
    }

    if (databaseCredentials.length > 0) {
      const results = await Promise.all(
        databaseCredentials.map(async ({ row, auth }) => ({
          row,
          result:
            auth.state === "failed"
              ? {
                  success: false as const,
                  error: `Anthropic sign-in could not be read: ${auth.error}. Run \`opencode auth login anthropic\`.`,
                  failureCategory: "credentials" as const,
                }
              : await queryAnthropicQuotaWithOAuth(auth.accessToken, options.requestTimeoutMs),
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
              message: result.error,
              sourceId: row.id,
              failureCategory: result.failureCategory,
            });
          }
          continue;
        }
        const windows = [
          ...(result.five_hour
            ? [{ label: "5h", window: result.five_hour, rowKey: "window:five_hour" }]
            : []),
          ...(result.seven_day
            ? [{ label: "Weekly", window: result.seven_day, rowKey: "window:week" }]
            : []),
        ];
        entries.push(
          ...windows.map(({ label, window, rowKey }) => ({
            accounting: {
              resultType: "quota" as const,
              acquisitionMethod: "remote_api" as const,
              ownership: "maintained" as const,
              authority: "provider_reported" as const,
              sourceId: row.id,
            },
            name: `${group} ${label}`,
            group,
            label: `${label}:`,
            rowKey,
            percentRemaining: window.percentRemaining,
            resetTimeIso: window.resetTimeIso,
          })),
        );
        if (result.extra_usage) {
          entries.push({
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: row.id,
            },
            name: `${group} Usage Credits`,
            group: `${group} Usage Credits`,
            label: "Monthly:",
            rowKey: "window:month",
            percentRemaining: result.extra_usage.percentRemaining,
          });
        }
        if (result.fable_weekly) {
          entries.push({
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: row.id,
            },
            name: `${group} Fable Weekly`,
            group,
            label: "Fable:",
            semantic: {
              metric: { kind: "named", name: "Fable weekly" },
              prominence: "primary",
            },
            percentRemaining: result.fable_weekly.percentRemaining,
            resetTimeIso: result.fable_weekly.resetTimeIso,
          });
        }
      }
      return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, statusDetails);
    }

    const result = quotaResult;
    if (!result) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (!result.success) {
      return withStatusDetails(
        attemptedErrorResult("Claude", result.error, {
          failureCategory: result.failureCategory,
        }),
        statusDetails,
      );
    }

    const entries: QuotaToastEntry[] = [];
    if (result.five_hour) {
      entries.push({
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: result.five_hour.percentRemaining,
        resetTimeIso: result.five_hour.resetTimeIso,
      });
    }
    if (result.seven_day) {
      entries.push({
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: result.seven_day.percentRemaining,
        resetTimeIso: result.seven_day.resetTimeIso,
      });
    }

    if (result.extra_usage) {
      entries.push({
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude Usage Credits",
        group: "Claude Usage Credits",
        label: "Monthly:",
        rowKey: "window:month",
        percentRemaining: result.extra_usage.percentRemaining,
      });
    }

    if (result.fable_weekly) {
      entries.push({
        accounting: {
          resultType: "quota",
          acquisitionMethod,
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Claude Fable Weekly",
        group: "Claude",
        label: "Fable:",
        semantic: {
          metric: { kind: "named", name: "Fable weekly" },
          prominence: "primary",
        },
        percentRemaining: result.fable_weekly.percentRemaining,
        resetTimeIso: result.fable_weekly.resetTimeIso,
      });
    }

    return withStatusDetails(attemptedResult(entries), statusDetails);
  },
};
