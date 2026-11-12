/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import type {
  AnthropicDiagnostics,
  AnthropicQuotaResult,
  AnthropicResult,
} from "../lib/anthropic.js";
import {
  fingerprintAccessToken,
  getAnthropicDiagnostics,
  getClaudeCodeAccountDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuotaWithOAuth,
} from "../lib/anthropic.js";
import { type ResolvedAnthropicOAuth, resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
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
  return "Quota unavailable via local Claude CLI or OAuth credentials";
}

const CLAUDE_CODE_RUNTIME_IDS = ["claude-agent", "claude-code"] as const;

const CLAUDE_CODE_ACCOUNT_ID = "claude-code-cli";
const CLAUDE_CODE_ACCOUNT_GROUP = "Claude Code";
const CLAUDE_CODE_USAGE_UNAVAILABLE_MESSAGE = "Claude Code usage is unavailable.";
const ANTHROPIC_SIGN_IN_MISSING_MESSAGE =
  "Anthropic sign-in is not configured in OpenCode. Run `opencode auth login anthropic`.";

function safeDiagnosticMessage(diagnostics: AnthropicDiagnostics): string {
  if (diagnostics.failureCategory === "provider_api") return "Anthropic quota request failed.";
  if (diagnostics.failureCategory === "credentials")
    return "Anthropic sign-in could not be used. Run `opencode auth login anthropic`.";
  if (!diagnostics.installed) return "Claude CLI is unavailable.";
  if (diagnostics.authStatus === "unauthenticated")
    return "Claude is not authenticated. Run `claude auth login` and try again.";
  if (diagnostics.authStatus === "unknown")
    return "Claude authentication could not be verified. Run `claude auth login` and try again.";
  return CLAUDE_CODE_USAGE_UNAVAILABLE_MESSAGE;
}

/** Claude Code route selected by `onlyCurrentModel`; its only credential is the Claude CLI login. */
export function getClaudeCodeRuntimeProviderId(
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

function claudeCodeAccountEntries(
  quota: AnthropicQuotaResult,
  acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"],
): QuotaToastEntry[] {
  const accounting = {
    resultType: "quota" as const,
    acquisitionMethod,
    ownership: "maintained" as const,
    authority: "provider_reported" as const,
    sourceId: CLAUDE_CODE_ACCOUNT_ID,
  };
  const entries: QuotaToastEntry[] = [];
  for (const [label, window, rowKey] of [
    ["5h", quota.five_hour, "window:five_hour"],
    ["Weekly", quota.seven_day, "window:week"],
  ] as const) {
    if (!window) continue;
    entries.push({
      accounting,
      name: `${CLAUDE_CODE_ACCOUNT_GROUP} ${label}`,
      group: CLAUDE_CODE_ACCOUNT_GROUP,
      label: `${label}:`,
      rowKey,
      percentRemaining: window.percentRemaining,
      resetTimeIso: window.resetTimeIso,
      ...(window.fixedWindow ? { fixedWindow: { ...window.fixedWindow } } : {}),
    });
  }
  if (quota.extra_usage) {
    entries.push({
      accounting,
      name: `${CLAUDE_CODE_ACCOUNT_GROUP} Usage Credits`,
      group: `${CLAUDE_CODE_ACCOUNT_GROUP} Usage Credits`,
      label: "Monthly:",
      rowKey: "window:month",
      percentRemaining: quota.extra_usage.percentRemaining,
    });
  }
  if (quota.fable_weekly) {
    entries.push({
      accounting,
      name: `${CLAUDE_CODE_ACCOUNT_GROUP} Fable Weekly`,
      group: CLAUDE_CODE_ACCOUNT_GROUP,
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

/** Whether OpenCode itself detects a Claude Code runtime (the dashboard's discovery signal). */
export async function isClaudeCodeRuntimeDetected(ctx: QuotaProviderContext): Promise<boolean> {
  return await isAnyProviderIdAvailable({
    ctx,
    candidateIds: CLAUDE_CODE_RUNTIME_IDS,
    fallbackOnError: false,
  });
}

/**
 * Every OpenCode Anthropic OAuth login row with its resolved state, in OpenCode's row order. The
 * route emits the configured and failed ones; the cache identity covers every row.
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

/**
 * The Claude Code login beside OpenCode's Anthropic accounts: its quota rows, or its own error
 * row when its usage probe fails. Null when the login is absent or already shown as an OpenCode account.
 */
async function readClaudeCodeAccount(
  options: { binaryPath?: string; requestTimeoutMs?: number },
  excludedFingerprints: readonly string[],
  reportUnready: boolean,
): Promise<{
  entries: QuotaToastEntry[];
  errors: QuotaProviderResult["errors"];
  planLabel?: string;
} | null> {
  let diagnostics: AnthropicDiagnostics | null;
  try {
    diagnostics = await getClaudeCodeAccountDiagnostics(options, excludedFingerprints, {
      reportUnready,
    });
  } catch {
    // A failed probe is this account's own error row; OpenCode's rows are unaffected.
    return {
      entries: [],
      errors: [
        {
          label: CLAUDE_CODE_ACCOUNT_GROUP,
          message: "Claude CLI probe failed.",
          sourceId: CLAUDE_CODE_ACCOUNT_ID,
        },
      ],
    };
  }
  if (!diagnostics) return null;
  if (diagnostics.quotaSupported && diagnostics.quota) {
    const acquisitionMethod: QuotaToastEntry["accounting"]["acquisitionMethod"] =
      diagnostics.quotaSource === "claude-auth-status-json" ? "local_cli" : "remote_api";
    return {
      entries: claudeCodeAccountEntries(diagnostics.quota, acquisitionMethod),
      errors: [],
      ...(diagnostics.planLabel === undefined ? {} : { planLabel: diagnostics.planLabel }),
    };
  }
  return {
    entries: [],
    errors: [
      {
        label: CLAUDE_CODE_ACCOUNT_GROUP,
        message: safeDiagnosticMessage(diagnostics),
        sourceId: CLAUDE_CODE_ACCOUNT_ID,
        ...(diagnostics.failureCategory !== undefined
          ? { failureCategory: diagnostics.failureCategory }
          : {}),
      },
    ],
  };
}

function withClaudeCodeAccount(
  base: QuotaProviderResult,
  claudeCode: { entries: QuotaToastEntry[]; errors: QuotaProviderResult["errors"] } | null,
): QuotaProviderResult {
  if (!claudeCode) return base;
  return {
    ...base,
    attempted: true,
    entries: [...base.entries, ...claudeCode.entries],
    errors: [...(base.errors ?? []), ...claudeCode.errors],
  };
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (getClaudeCodeRuntimeProviderId(ctx)) {
      // A selected Claude Code route stays visible. Its CLI probe runs in fetch, so a missing or
      // signed-out CLI shows as an error instead of disappearing.
      return true;
    }

    const providerAvailable = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: ctx.config?.onlyCurrentModel
        ? ["anthropic"]
        : ["anthropic", ...CLAUDE_CODE_RUNTIME_IDS],
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    return await hasAnthropicCredentialsConfigured({ binaryPath: ctx.config?.anthropicBinaryPath });
  },

  async isDiscovered(ctx: QuotaProviderContext): Promise<boolean> {
    // Dashboard-only: a detected Claude Code runtime stays visible while its CLI is not ready, and
    // fetch says why. A selected onlyCurrentModel route has no Claude Code account to discover.
    if (ctx.config?.onlyCurrentModel === true) return false;
    return await isClaudeCodeRuntimeDetected(ctx);
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
    // OpenCode's own login, when present, is the OpenCode account; the Claude CLI login is shown
    // beside it as a separate account rather than replacing or merging into it.
    let openCodeLoginPresent = false;
    let openCodeFingerprints: string[] = [];
    // The Claude CLI login's plan from the probe; forwarded only when that login is the route's account.
    let cliPlanLabel: string | undefined;
    // A failed login stays in the list so it shows as its own error row.
    const databaseCredentials = claudeCodeRuntimeId
      ? []
      : (await readOpenCodeAnthropicLogins()).flatMap(({ row, auth }) =>
          auth.state === "configured" || auth.state === "failed" ? [{ row, auth }] : [],
        );
    try {
      const diagnostics = await getAnthropicDiagnostics(options);
      openCodeLoginPresent = diagnostics.oauthCredentialSource === "opencode-auth";
      if (openCodeLoginPresent && diagnostics.credentialFingerprint !== undefined) {
        openCodeFingerprints = [diagnostics.credentialFingerprint];
      }
      cliPlanLabel = diagnostics.planLabel;
      const quota = diagnostics.quotaSupported ? diagnostics.quota : undefined;
      // On a selected OpenCode route without OpenCode's login, the probe answered for the Claude CLI
      // login, which is not this route's account. Its quota and credential details are never reported
      // here; the route says it has no login instead.
      const probeIsForeign =
        ctx.config?.onlyCurrentModel === true &&
        claudeCodeRuntimeId === undefined &&
        !openCodeLoginPresent;
      const routeQuota = probeIsForeign ? undefined : quota;
      if (claudeCodeRuntimeId === undefined && !openCodeLoginPresent) {
        // Without OpenCode's login, the Claude CLI login is not this route's account. It is shown only
        // as the labeled Claude Code account. A selected anthropic route says why it has no data.
        quotaResult = ctx.config?.onlyCurrentModel
          ? {
              success: false,
              error: ANTHROPIC_SIGN_IN_MISSING_MESSAGE,
              failureCategory: "credentials",
            }
          : null;
      } else if (diagnostics.quotaSupported) {
        quotaResult = quota ?? null;
      } else if (
        claudeCodeRuntimeId !== undefined ||
        (openCodeLoginPresent && diagnostics.message)
      ) {
        // A selected Claude Code route always shows its failure, even when the probe gave no message.
        quotaResult = {
          success: false,
          error: safeDiagnosticMessage(diagnostics),
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
        cli_version:
          diagnostics.version && /^\d+\.\d+\.\d+$/.test(diagnostics.version)
            ? diagnostics.version
            : "(none)",
        binary_path: diagnostics.binaryPath ? "(detected)" : "(none)",
        auth_status: diagnostics.authStatus,
        quota_supported: !probeIsForeign && diagnostics.quotaSupported ? "true" : "false",
        quota_source:
          probeIsForeign || diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
        oauth_credential_source: probeIsForeign
          ? "(none)"
          : (diagnostics.oauthCredentialSource ?? "(none)"),
        checked_commands: diagnostics.checkedCommands.length ? "(checked)" : "(none)",
        message: diagnostics.message === undefined ? undefined : safeDiagnosticMessage(diagnostics),
        five_hour_remaining: routeQuota?.five_hour
          ? `${routeQuota.five_hour.percentRemaining}% reset_at=${routeQuota.five_hour.resetTimeIso ?? "(none)"}`
          : undefined,
        seven_day_remaining: routeQuota?.seven_day
          ? `${routeQuota.seven_day.percentRemaining}% reset_at=${routeQuota.seven_day.resetTimeIso ?? "(none)"}`
          : undefined,
        fable_weekly_remaining: routeQuota?.fable_weekly
          ? `${routeQuota.fable_weekly.percentRemaining}% reset_at=${routeQuota.fable_weekly.resetTimeIso ?? "(none)"}`
          : undefined,
      });
    } catch {
      quotaResult = {
        success: false,
        error: "Claude CLI probe failed.",
      };
      statusDetails = statusDetailsFromRecord({
        cli_installed: "false",
        message: "Failed to probe Claude CLI.",
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
                  error:
                    "Anthropic sign-in could not be read. Run `opencode auth login anthropic`.",
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
            ...(window.fixedWindow ? { fixedWindow: { ...window.fixedWindow } } : {}),
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
      // A selected anthropic route under onlyCurrentModel is OpenCode's account alone.
      const claudeCode = ctx.config?.onlyCurrentModel
        ? null
        : await readClaudeCodeAccount(
            options,
            databaseCredentials.flatMap(({ auth }) =>
              auth.state === "configured" ? [fingerprintAccessToken(auth.accessToken)] : [],
            ),
            await isClaudeCodeRuntimeDetected(ctx),
          );
      if (claudeCode) {
        accounts.push({
          sourceId: CLAUDE_CODE_ACCOUNT_ID,
          label: CLAUDE_CODE_ACCOUNT_GROUP,
          active: false,
          ...(claudeCode.planLabel ? { planLabel: claudeCode.planLabel } : {}),
        });
      }
      return withStatusDetails(
        withClaudeCodeAccount({ ...attemptedResult(entries, errors), accounts }, claudeCode),
        statusDetails,
      );
    }

    // Without OpenCode's login, the Claude CLI login is still shown as the Claude Code account.
    const claudeCode = ctx.config?.onlyCurrentModel
      ? null
      : await readClaudeCodeAccount(
          options,
          openCodeFingerprints,
          await isClaudeCodeRuntimeDetected(ctx),
        );
    const result = quotaResult;
    if (!result) {
      // With no OpenCode login the Claude CLI login is the only account, so its plan is shown on this
      // provider-scope result. Never set beside OpenCode accounts.
      const cliOnly = withClaudeCodeAccount(notAttemptedResult(), claudeCode);
      return withStatusDetails(
        claudeCode?.planLabel && !openCodeLoginPresent
          ? { ...cliOnly, planLabel: claudeCode.planLabel }
          : cliOnly,
        statusDetails,
      );
    }

    if (!result.success) {
      return withStatusDetails(
        withClaudeCodeAccount(
          attemptedErrorResult("Claude", result.error, {
            failureCategory: result.failureCategory,
          }),
          claudeCode,
        ),
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
        ...(result.five_hour.fixedWindow
          ? { fixedWindow: { ...result.five_hour.fixedWindow } }
          : {}),
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
        ...(result.seven_day.fixedWindow
          ? { fixedWindow: { ...result.seven_day.fixedWindow } }
          : {}),
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

    // A selected Claude Code route answers only for the CLI login, so its plan is that login's. With
    // OpenCode's login present the probe belongs to that login, so no plan is forwarded here.
    const routePlanLabel =
      claudeCodeRuntimeId !== undefined && !openCodeLoginPresent ? cliPlanLabel : undefined;
    const successResult = withClaudeCodeAccount(attemptedResult(entries), claudeCode);
    return withStatusDetails(
      routePlanLabel === undefined
        ? successResult
        : { ...successResult, planLabel: routePlanLabel },
      statusDetails,
    );
  },
};
