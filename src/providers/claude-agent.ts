/**
 * Claude Agent provider: OpenCode's native Claude Agent integration, backed by the installed Claude
 * CLI login. It is independent of OpenCode's Anthropic logins (see `./anthropic.ts`); it is the
 * only provider that launches the Claude CLI.
 */

import type { BankedResetAvailability } from "../contracts/openai-quota.js";
import { CLAUDE_AGENT_RESETS_ROW_KEY } from "../contracts/openai-quota.js";
import type { AnthropicDiagnostics } from "../lib/anthropic.js";
import { getAnthropicDiagnostics, hasAnthropicCredentialsConfigured } from "../lib/anthropic.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { QUOTA_FORCE_REFRESH } from "../lib/entries.js";
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import { anthropicQuotaEntries } from "./anthropic.js";
import {
  attemptedErrorResult,
  attemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

/** `claude-agent` is OpenCode's native integration; `claude-code` is its legacy runtime alias. */
export const CLAUDE_AGENT_RUNTIME_IDS = ["claude-agent", "claude-code"] as const;

const CLAUDE_AGENT_GROUP = "Claude Agent";

/** Always the OAuth-reported value: even beside CLI-local windows, resets come from the usage API. */
function claudeAgentResetsEntry(resets: BankedResetAvailability): QuotaToastEntry {
  return {
    kind: "value",
    accounting: {
      resultType: "status",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: `${CLAUDE_AGENT_GROUP} Resets`,
    group: CLAUDE_AGENT_GROUP,
    label: "Resets:",
    rowKey: CLAUDE_AGENT_RESETS_ROW_KEY,
    value: `${resets.availableCount} available`,
    bankedResets: {
      availableCount: resets.availableCount,
      credits: resets.credits.map((credit) => ({
        ...(credit.expiresAtIso !== undefined ? { expiresAtIso: credit.expiresAtIso } : {}),
      })),
    },
  };
}

export function getClaudeAgentNoDataMessage(): string {
  return "Quota unavailable via local Claude CLI";
}

function safeDiagnosticMessage(diagnostics: AnthropicDiagnostics): string {
  if (diagnostics.failureCategory === "provider_api") return "Claude quota request failed.";
  // "credentials" is only assigned after the CLI reported a verified login, so this is the usage
  // endpoint rejecting the stored token, not proof that the login is invalid.
  if (diagnostics.failureCategory === "credentials")
    return "Claude CLI reports you are signed in, but the usage request was rejected. Retry; if it persists, run `claude auth login`.";
  if (!diagnostics.installed) return "Claude CLI is unavailable.";
  if (diagnostics.authStatus === "unauthenticated")
    return "Claude is not authenticated. Run `claude auth login` and try again.";
  if (diagnostics.authStatus === "unknown")
    return "Claude authentication could not be verified. Run `claude auth login` and try again.";
  return "Claude Agent usage is unavailable.";
}

/** The Claude Agent route selected by `onlyCurrentModel`, if any. */
export function getClaudeAgentRuntimeProviderId(
  ctx: QuotaProviderContext,
): (typeof CLAUDE_AGENT_RUNTIME_IDS)[number] | undefined {
  if (ctx.config?.onlyCurrentModel !== true) return undefined;

  const currentProviderId = (
    ctx.config?.currentProviderID ??
    resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
      ?.providerId
  )
    ?.trim()
    .toLowerCase();
  return currentProviderId &&
    CLAUDE_AGENT_RUNTIME_IDS.includes(
      currentProviderId as (typeof CLAUDE_AGENT_RUNTIME_IDS)[number],
    )
    ? (currentProviderId as (typeof CLAUDE_AGENT_RUNTIME_IDS)[number])
    : undefined;
}

/**
 * OpenCode registers Claude Agent independently of the external login; provider presence alone
 * cannot report its auth or quota. The independent CLI probe supplies what it can; it does not
 * establish account equivalence from a matching email or plan.
 */
export async function isClaudeAgentRuntimeDetected(ctx: QuotaProviderContext): Promise<boolean> {
  if (ctx.client?.integration) {
    try {
      const { data } = await ctx.client.integration.list();
      if (Array.isArray(data)) {
        const agent = data.find((integration) => integration.id === "claude-agent");
        if (agent && Array.isArray(agent.connections)) {
          if (
            agent.connections.some(
              (connection) => connection.type === "credential" && connection.method === "external",
            )
          ) {
            return true;
          }
          return await isAnyProviderIdAvailable({
            ctx,
            candidateIds: ["claude-code"],
            fallbackOnError: false,
          });
        }
      }
    } catch {
      // Older hosts or an unavailable integration service use legacy provider detection.
    }
  }
  return await isAnyProviderIdAvailable({
    ctx,
    candidateIds: CLAUDE_AGENT_RUNTIME_IDS,
    fallbackOnError: false,
  });
}

export const claudeAgentProvider: QuotaProvider = {
  id: "claude-agent",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (ctx.config?.onlyCurrentModel === true) {
      // A selected Claude Agent route stays visible; its CLI probe runs in fetch, so a missing or
      // signed-out CLI shows as an error instead of disappearing.
      return getClaudeAgentRuntimeProviderId(ctx) !== undefined;
    }
    const runtimeAvailable = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: CLAUDE_AGENT_RUNTIME_IDS,
      fallbackOnError: false,
    });
    if (!runtimeAvailable) return false;
    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
      operationCache: ctx.operationCache,
    });
  },

  async isDiscovered(ctx: QuotaProviderContext): Promise<boolean> {
    // Dashboard-only: a detected Claude Agent runtime stays visible while its CLI is not ready, and
    // fetch says why.
    if (ctx.config?.onlyCurrentModel === true) return false;
    return await isClaudeAgentRuntimeDetected(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    const normalized = model.toLowerCase();
    return CLAUDE_AGENT_RUNTIME_IDS.some((id) => normalized.startsWith(`${id}/`));
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const forceRefresh = ctx.operationCache?.get(QUOTA_FORCE_REFRESH) === true;
    let diagnostics: AnthropicDiagnostics;
    try {
      diagnostics = await getAnthropicDiagnostics({
        binaryPath: ctx.config?.anthropicBinaryPath,
        ...(ctx.operationCache ? { operationCache: ctx.operationCache } : {}),
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
    } catch {
      return withStatusDetails(
        attemptedErrorResult(CLAUDE_AGENT_GROUP, "Claude CLI probe failed."),
        statusDetailsFromRecord({ cli_installed: "false", message: "Failed to probe Claude CLI." }),
      );
    }

    const statusDetails = statusDetailsFromRecord({
      cli_installed: diagnostics.installed ? "true" : "false",
      cli_version:
        diagnostics.version && /^\d+\.\d+\.\d+$/.test(diagnostics.version)
          ? diagnostics.version
          : "(none)",
      binary_path: diagnostics.binaryPath ? "(detected)" : "(none)",
      auth_status: diagnostics.authStatus,
      quota_supported: diagnostics.quotaSupported ? "true" : "false",
      quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
      oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
      checked_commands: diagnostics.checkedCommands.length ? "(checked)" : "(none)",
      message: diagnostics.message === undefined ? undefined : safeDiagnosticMessage(diagnostics),
      five_hour_remaining: diagnostics.quota?.five_hour
        ? `${diagnostics.quota.five_hour.percentRemaining}% reset_at=${diagnostics.quota.five_hour.resetTimeIso ?? "(none)"}`
        : undefined,
      seven_day_remaining: diagnostics.quota?.seven_day
        ? `${diagnostics.quota.seven_day.percentRemaining}% reset_at=${diagnostics.quota.seven_day.resetTimeIso ?? "(none)"}`
        : undefined,
      fable_weekly_remaining: diagnostics.quota?.fable_weekly
        ? `${diagnostics.quota.fable_weekly.percentRemaining}% reset_at=${diagnostics.quota.fable_weekly.resetTimeIso ?? "(none)"}`
        : undefined,
    });

    if (diagnostics.quotaSupported && diagnostics.quota) {
      const acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"] =
        diagnostics.quotaSource === "claude-auth-status-json" ? "local_cli" : "remote_api";
      const credits = diagnostics.quota.saved_resets?.credits.filter(
        (credit) => credit.expiresAtIso == null || Date.parse(credit.expiresAtIso) > Date.now(),
      );
      const savedResets = credits?.length ? { availableCount: credits.length, credits } : undefined;
      const result = attemptedResult([
        ...anthropicQuotaEntries(diagnostics.quota, {
          group: CLAUDE_AGENT_GROUP,
          acquisitionMethod,
        }),
        ...(savedResets && savedResets.availableCount > 0
          ? [claudeAgentResetsEntry(savedResets)]
          : []),
      ]);
      return withStatusDetails(
        diagnostics.planLabel === undefined
          ? result
          : { ...result, planLabel: diagnostics.planLabel },
        statusDetails,
      );
    }

    return withStatusDetails(
      attemptedErrorResult(CLAUDE_AGENT_GROUP, safeDiagnosticMessage(diagnostics), {
        ...(diagnostics.failureCategory !== undefined
          ? { failureCategory: diagnostics.failureCategory }
          : {}),
        ...(diagnostics.retryAtMs !== undefined
          ? { retryable: true, retryAtMs: diagnostics.retryAtMs }
          : {}),
      }),
      statusDetails,
    );
  },
};
