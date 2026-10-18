/**
 * xAI SuperGrok provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { AuthData } from "../lib/types.js";
import {
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiOAuth,
  type XaiPeriodKind,
} from "../lib/xai.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

/** Stable explicit row key for the single percent row (never the display label). */
function xaiWindowRowKey(kind: XaiPeriodKind): string {
  switch (kind) {
    case "weekly":
      return "window:week";
    case "monthly":
      return "window:month";
    case "daily":
      return "window:day";
    default:
      return "named:period";
  }
}

export const xaiProvider: QuotaProvider = {
  id: "xai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xai",
      fallbackOnError: false,
    });
    if (providerAvailable) return hasXaiOAuthCached({ maxAgeMs: 0 });

    return hasXaiOAuthCached({ maxAgeMs: DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    // A failed login stays in the list so it shows as its own error row.
    const credentials = (await readCredentialRows(["xai"], { methods: ["oauth"] })).flatMap(
      (row) => {
        if (row.integrationId !== "xai") return [];
        const auth = resolveXaiOAuth({ xai: credentialRowAuthEntry(row) } as AuthData);
        return auth.state === "none" ? [] : [{ row, auth }];
      },
    );
    if (credentials.length > 0) {
      const results = await Promise.all(
        credentials.map(async ({ row, auth }) => ({
          row,
          result: await queryXaiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs, auth }),
        })),
      );
      const names = formatCredentialDisplayNames(
        "xAI",
        results.map(({ row, result }) => ({
          row,
          fallbackName: result?.success ? result.label : "xAI",
        })),
      );
      const accounts = results.map(({ row }, index) => ({
        sourceId: row.id,
        label: names[index] ?? "xAI",
        active: row.active,
      }));
      const entries: QuotaProviderResult["entries"] = [];
      const errors: QuotaProviderResult["errors"] = [];
      for (const [index, { row, result }] of results.entries()) {
        const group = names[index] ?? "xAI";
        const mapped = mapNullableProviderResult(result, {
          errorLabel: group,
          onSuccess: (result) => {
            const period = periodKindLabel(result.window.kind);
            return attemptedResult([
              {
                accounting: {
                  resultType: "quota",
                  acquisitionMethod: "remote_api",
                  ownership: "maintained",
                  authority: "provider_reported",
                  sourceId: row.id,
                },
                name: `${group} ${period}`,
                group,
                label: `${period}:`,
                rowKey: xaiWindowRowKey(result.window.kind),
                percentRemaining: result.window.percentRemaining,
                resetTimeIso: result.window.resetTimeIso,
              },
            ]);
          },
        });
        entries.push(...mapped.entries);
        errors.push(...mapped.errors.map((error) => ({ ...error, sourceId: row.id })));
      }
      return { ...attemptedResult(entries, errors), accounts };
    }
    const result = await queryXaiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "xAI",
      onSuccess: (result) => {
        const period = periodKindLabel(result.window.kind);
        return attemptedResult(
          [
            {
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
              },
              name: `${result.label} ${period}`,
              group: result.label,
              label: `${period}:`,
              rowKey: xaiWindowRowKey(result.window.kind),
              percentRemaining: result.window.percentRemaining,
              resetTimeIso: result.window.resetTimeIso,
              ...(result.window.fixedWindow
                ? { fixedWindow: { ...result.window.fixedWindow } }
                : {}),
            },
          ],
          [],
          { singleWindowDisplayName: result.label },
        );
      },
    });
  },
};
