/**
 * Mistral Vibe subscription provider wrapper.
 *
 * Reads the Vibe subscription budget (and the pay-as-you-go API budget when it
 * is enabled) for every distinct Mistral credential, using only credentials the
 * user already has: `MISTRAL_API_KEY`, `<VIBE_HOME>/.env`, or an OpenCode Mistral
 * login. Nothing is installed, logged into or browsed.
 */

import {
  MISTRAL_VIBE_API_BUDGET_INFO,
  MISTRAL_VIBE_API_BUDGET_LABEL,
  MISTRAL_VIBE_API_BUDGET_METRIC_NAME,
  MISTRAL_VIBE_BUDGET_INFO,
  MISTRAL_VIBE_BUDGET_LABEL,
  MISTRAL_VIBE_BUDGET_METRIC_NAME,
} from "../contracts/mistral-vibe-quota.js";
import type {
  AccountingMetadata,
  AccountingPercentageBasis,
  AccountingUnit,
  QuotaPercentEntry,
  QuotaProvider,
  QuotaProviderAccount,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  type MistralVibeBudget,
  type MistralVibeQuotaResult,
  queryMistralVibeQuota,
} from "../lib/mistral-vibe.js";
import {
  hasMistralVibeCredential,
  type MistralVibeCredential,
  resolveMistralVibeCredentials,
} from "../lib/mistral-vibe-auth.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

/** The Vibe allowance is spend against a budget, reported by the platform. */
const MISTRAL_VIBE_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

/** Shown when the platform answers successfully but reports no budget at all. */
const MISTRAL_VIBE_NO_BUDGET_MESSAGE = "Mistral reported no Vibe or API budget for this account.";

function magnitude(value: number): string {
  return accountingDecimalFromNumber(value);
}

/**
 * Structured percentage basis for one budget row.
 *
 * `limit` is the reported allowance; `used` and `remaining` are derived from the
 * reported percentage because the platform reports no absolute used value. The
 * basis is omitted when the platform reports no currency, since an amount with
 * no unit would be invented.
 */
function budgetBasis(budget: MistralVibeBudget): AccountingPercentageBasis | undefined {
  if (!budget.currency) return undefined;
  const unit: AccountingUnit = { kind: "currency", code: budget.currency };
  const used = Math.max(0, (budget.usagePercentage / 100) * budget.initialBudget);
  const remaining = Math.max(0, budget.initialBudget - used);
  return {
    used: { quantity: { decimal: magnitude(used), unit }, authority: "locally_derived" },
    limit: {
      quantity: { decimal: magnitude(budget.initialBudget), unit },
      authority: "provider_reported",
    },
    remaining: { quantity: { decimal: magnitude(remaining), unit }, authority: "locally_derived" },
  };
}

function budgetRow(params: {
  budget: MistralVibeBudget;
  metricName: string;
  label: string;
  info: string;
  prominence: "primary" | "supplementary";
  group: string;
  sourceId: string;
  observedAtIso: string;
}): QuotaPercentEntry {
  const basis = budgetBasis(params.budget);
  return {
    accounting: {
      ...MISTRAL_VIBE_ACCOUNTING,
      sourceId: params.sourceId,
      observedAtIso: params.observedAtIso,
    },
    name: `${params.group} ${params.label}`,
    group: params.group,
    label: `${params.label}:`,
    info: params.info,
    percentRemaining: Math.min(100, Math.max(0, 100 - params.budget.usagePercentage)),
    ...(basis ? { basis } : {}),
    // `reset_at` is an exact provider timestamp; nothing here is derived.
    ...(params.budget.resetTimeIso
      ? { resetTimeIso: params.budget.resetTimeIso, resetPrecision: "exact" as const }
      : {}),
    semantic: { metric: { kind: "named", name: params.metricName }, prominence: params.prominence },
  };
}

/**
 * Rows for one successfully read account. The Vibe budget is the primary row;
 * the API budget is supplementary and only present when PAYG is enabled.
 */
export function buildMistralVibeEntries(params: {
  result: Extract<MistralVibeQuotaResult, { success: true }>;
  group: string;
  sourceId: string;
}): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];
  if (params.result.vibeBudget) {
    entries.push(
      budgetRow({
        budget: params.result.vibeBudget,
        metricName: MISTRAL_VIBE_BUDGET_METRIC_NAME,
        label: MISTRAL_VIBE_BUDGET_LABEL,
        info: MISTRAL_VIBE_BUDGET_INFO,
        prominence: "primary",
        group: params.group,
        sourceId: params.sourceId,
        observedAtIso: params.result.observedAtIso,
      }),
    );
  }
  if (params.result.apiBudget) {
    entries.push(
      budgetRow({
        budget: params.result.apiBudget,
        metricName: MISTRAL_VIBE_API_BUDGET_METRIC_NAME,
        label: MISTRAL_VIBE_API_BUDGET_LABEL,
        info: MISTRAL_VIBE_API_BUDGET_INFO,
        prominence: "supplementary",
        group: params.group,
        sourceId: params.sourceId,
        observedAtIso: params.result.observedAtIso,
      }),
    );
  }
  return entries;
}

function accountDescriptor(credential: MistralVibeCredential): QuotaProviderAccount {
  return {
    sourceId: credential.sourceId,
    identityKey: credential.identityKey,
    label: credential.label,
    ...(credential.active === undefined ? {} : { active: credential.active }),
  };
}

export const mistralVibeProvider: QuotaProvider = {
  id: "mistral",

  async isAvailable(): Promise<boolean> {
    return await hasMistralVibeCredential();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "mistral");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const resolution = await resolveMistralVibeCredentials({});
    const statusDetails = statusDetailsFromRecord({
      credential_count: String(resolution.credentials.length),
      credential_sources:
        resolution.credentials.map((entry) => entry.source).join(" | ") || "(none)",
      vibe_env_path: resolution.checkedPaths.join(" | ") || "(none)",
      credential_database_paths: resolution.credentialDatabasePaths.join(" | ") || "(none)",
    });

    if (resolution.credentials.length === 0) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
      ? ctx.config.requestTimeoutMs
      : undefined;
    const results = await Promise.all(
      resolution.credentials.map(async (credential) => ({
        credential,
        result: await queryMistralVibeQuota({
          apiKey: credential.key,
          ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        }),
      })),
    );

    const entries: QuotaToastEntry[] = [];
    const errors: QuotaProviderResult["errors"] = [];
    const accounts: QuotaProviderAccount[] = [];

    for (const { credential, result } of results) {
      accounts.push(
        result.success
          ? {
              ...accountDescriptor(credential),
              ...(result.subscription?.planLabel
                ? { planLabel: result.subscription.planLabel }
                : {}),
            }
          : accountDescriptor(credential),
      );

      if (!result.success) {
        errors.push({
          label: credential.label,
          message: result.error,
          sourceId: credential.sourceId,
          ...(result.failureCategory !== undefined
            ? { failureCategory: result.failureCategory }
            : {}),
        });
        continue;
      }

      const accountEntries = buildMistralVibeEntries({
        result,
        group: credential.label,
        sourceId: credential.sourceId,
      });
      if (accountEntries.length === 0) {
        // A successful read that reports no budget is a visible state, not a
        // failure: an unclassified row so it can never raise an error alert.
        errors.push({
          label: credential.label,
          message: MISTRAL_VIBE_NO_BUDGET_MESSAGE,
          sourceId: credential.sourceId,
        });
        continue;
      }
      entries.push(...accountEntries);
    }

    return withStatusDetails(
      {
        ...attemptedResult(entries, errors, { singleWindowShowRight: true }),
        accounts,
      },
      statusDetails,
    );
  },
};
