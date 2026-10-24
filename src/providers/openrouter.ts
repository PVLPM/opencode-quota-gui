/**
 * OpenRouter provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import { scrubCredentialErrorText } from "../lib/opencode-auth.js";
import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterAuth,
} from "../lib/openrouter.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  notAttemptedResult,
  simpleApiKeyStatusDetails,
  withStatusDetails,
} from "./result-helpers.js";

export const openRouterProvider: QuotaProvider = {
  id: "openrouter",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasOpenRouterApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "openrouter");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = await resolveOpenRouterAuth();
    const statusDetails = simpleApiKeyStatusDetails({
      configured: auth.accounts.some((account) => Boolean(account.resolved?.key)),
      source: auth.source,
      checkedPaths: auth.checkedPaths,
      credentialDatabasePaths: auth.credentialDatabasePaths,
    });

    if (auth.accounts.length === 0) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    const queryable = auth.accounts.flatMap((account) =>
      account.resolved?.key ? [{ account, resolved: account.resolved }] : [],
    );
    const errors: QuotaToastError[] = auth.accounts.flatMap((account) =>
      account.error
        ? [
            {
              label: account.label,
              message: scrubCredentialErrorText(account.error),
              ...(account.sourceId ? { sourceId: account.sourceId } : {}),
            },
          ]
        : [],
    );

    const results = await Promise.all(
      queryable.map(async ({ account, resolved }) => {
        try {
          return {
            account,
            result: await queryOpenRouterQuota({
              requestTimeoutMs: ctx.config?.requestTimeoutMs,
              resolved,
              label: account.groupLabel ?? account.label,
              sourceId: account.sourceId,
            }),
            error: null as string | null,
          };
        } catch {
          // Underlying fetches normally return a safe error; an unexpected
          // throw stays local to this account instead of failing the provider.
          return { account, result: null, error: "OpenRouter request failed" };
        }
      }),
    );

    const entries: QuotaToastEntry[] = [];
    for (const { account, result, error } of results) {
      if (error) {
        errors.push({
          label: account.label,
          message: error,
          ...(account.sourceId ? { sourceId: account.sourceId } : {}),
        });
        continue;
      }
      if (!result) continue;
      if (!result.success) {
        errors.push({
          label: account.label,
          message: result.error,
          ...(account.sourceId ? { sourceId: account.sourceId } : {}),
        });
        continue;
      }
      entries.push(...result.entries);
      for (const message of result.rowErrors ?? []) {
        errors.push({
          label: account.label,
          message,
          ...(account.sourceId ? { sourceId: account.sourceId } : {}),
        });
      }
    }

    const accounts = auth.accounts.flatMap((account) =>
      account.sourceId
        ? [{ sourceId: account.sourceId, label: account.label, active: account.active }]
        : [],
    );

    return withStatusDetails(
      {
        ...attemptedResult(entries, errors, { singleWindowShowRight: true }),
        ...(accounts.length > 0 ? { accounts } : {}),
      },
      statusDetails,
    );
  },
};
