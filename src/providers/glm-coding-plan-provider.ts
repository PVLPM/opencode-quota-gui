import type {
  AccountingMetadata,
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
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-metadata.js";
import type { AuthData } from "../lib/types.js";
import {
  apiKeyStatusDetails,
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type GlmQuotaWindow = {
  percentRemaining: number;
  resetTimeIso?: string;
};

type GlmQuotaResult = {
  success: true;
  label: string;
  windows: {
    fiveHour?: GlmQuotaWindow;
    weekly?: GlmQuotaWindow;
    mcp?: GlmQuotaWindow;
  };
};

const GLM_WINDOW_ROW_KEYS = {
  fiveHour: "window:five_hour",
  weekly: "window:week",
  mcp: "window:mcp",
} as const;

/**
 * Percent-only window rows carry no typed `semantic`, so they get stable
 * explicit `rowKey`s (metric + window) instead of label-derived ids.
 */
function windowEntriesWithRowKeys(params: {
  group: string;
  accounting: AccountingMetadata;
  windows: GlmQuotaResult["windows"];
}): QuotaToastEntry[] {
  const specs: Array<{ window?: GlmQuotaWindow; suffix: string; label: string }> = [];
  const rowKeys: string[] = [];
  if (params.windows.fiveHour) {
    specs.push({ window: params.windows.fiveHour, suffix: "5h", label: "5h:" });
    rowKeys.push(GLM_WINDOW_ROW_KEYS.fiveHour);
  }
  if (params.windows.weekly) {
    specs.push({ window: params.windows.weekly, suffix: "Weekly", label: "Weekly:" });
    rowKeys.push(GLM_WINDOW_ROW_KEYS.weekly);
  }
  if (params.windows.mcp) {
    specs.push({ window: params.windows.mcp, suffix: "MCP", label: "MCP:" });
    rowKeys.push(GLM_WINDOW_ROW_KEYS.mcp);
  }

  return groupedPercentWindowEntries({
    group: params.group,
    accounting: params.accounting,
    windows: specs,
  }).map((entry, index) => ({
    ...entry,
    // groupedPercentWindowEntries emits one aggregate fallback row when no window exists.
    rowKey: rowKeys[index] ?? "aggregate",
  }));
}

export function createGlmCodingPlanProvider(params: {
  id: "zai" | "zhipu";
  providerId: CanonicalQuotaProviderId;
  errorLabel: string;
  authCacheMaxAgeMs: number;
  resolveAuth: (params: { maxAgeMs: number }) => Promise<{ state: string }>;
  resolveCredentialAuth: (
    auth: AuthData,
  ) =>
    | { state: "configured"; apiKey: string }
    | { state: "none" }
    | { state: "invalid"; error: string };
  credentialIntegrationIds: readonly string[];
  getAuthDiagnostics: (params: { maxAgeMs: number }) => Promise<{
    state: string;
    source: string | null;
    checkedPaths: string[];
    credentialDatabasePaths: string[];
    error?: string;
  }>;
  queryQuota: (params: {
    requestTimeoutMs?: number;
    apiKey?: string;
  }) => Promise<GlmQuotaResult | { success: false; error: string } | null>;
  matchesCurrentModel: (model: string) => boolean;
}): QuotaProvider {
  return {
    id: params.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: params.providerId,
        fallbackOnError: false,
      });
      if (!providerAvailable) return false;

      const auth = await params.resolveAuth({ maxAgeMs: params.authCacheMaxAgeMs });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel: params.matchesCurrentModel,

    async fetch(ctx: QuotaProviderContext) {
      const diagnostics = await params.getAuthDiagnostics({ maxAgeMs: params.authCacheMaxAgeMs });
      const authDetails = apiKeyStatusDetails(diagnostics);
      if (diagnostics.source === "opencode.db") {
        const credentials = (
          await readCredentialRows(params.credentialIntegrationIds, { methods: ["key"] })
        ).flatMap((row) => {
          if (!params.credentialIntegrationIds.includes(row.integrationId)) return [];
          const auth = params.resolveCredentialAuth({
            [row.integrationId]: credentialRowAuthEntry(row),
          } as AuthData);
          // An invalid login stays in the list so it shows as its own error row.
          return auth.state === "none" ? [] : [{ row, auth }];
        });
        if (credentials.length > 0) {
          const results = await Promise.all(
            credentials.map(async ({ row, auth }) => ({
              row,
              result:
                auth.state === "invalid"
                  ? { success: false as const, error: auth.error }
                  : await params.queryQuota({
                      requestTimeoutMs: ctx.config?.requestTimeoutMs,
                      apiKey: auth.apiKey,
                    }),
            })),
          );
          const names = formatCredentialDisplayNames(
            params.errorLabel,
            results.map(({ row, result }) => ({
              row,
              fallbackName: result?.success ? result.label : params.errorLabel,
            })),
          );
          const accounts = results.map(({ row }, index) => ({
            sourceId: row.id,
            label: names[index] ?? params.errorLabel,
            active: row.active,
          }));
          const entries: QuotaToastEntry[] = [];
          const errors: QuotaProviderResult["errors"] = [];
          for (const [index, { row, result }] of results.entries()) {
            const group = names[index] ?? params.errorLabel;
            const mapped = mapNullableProviderResult(result, {
              errorLabel: group,
              onSuccess: (quota) =>
                attemptedResult(
                  windowEntriesWithRowKeys({
                    group,
                    accounting: {
                      resultType: "quota",
                      acquisitionMethod: "remote_api",
                      ownership: "maintained",
                      authority: "provider_reported",
                      sourceId: row.id,
                    },
                    windows: quota.windows,
                  }),
                ),
            });
            entries.push(...mapped.entries);
            errors.push(...mapped.errors.map((error) => ({ ...error, sourceId: row.id })));
          }
          return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, authDetails);
        }
      }
      const result = await params.queryQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
      const providerResult = mapNullableProviderResult(result, {
        errorLabel: params.errorLabel,
        onSuccess: (quota) =>
          attemptedResult(
            windowEntriesWithRowKeys({
              group: quota.label,
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
              },
              windows: quota.windows,
            }),
            [],
            { singleWindowDisplayName: quota.label },
          ),
      });
      const windows = result?.success ? result.windows : {};
      const formatWindow = (window: GlmQuotaWindow | undefined): string | undefined =>
        window
          ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
          : undefined;
      return withStatusDetails(providerResult, [
        ...authDetails,
        ...statusDetailsFromRecord({
          live_fetch_error: !result
            ? `${params.errorLabel} API key became unavailable before fetch`
            : result.success
              ? undefined
              : result.error,
          five_hour_remaining: formatWindow(windows.fiveHour),
          weekly_remaining: formatWindow(windows.weekly),
          mcp_remaining: formatWindow(windows.mcp),
          live_state:
            result?.success && !windows.fiveHour && !windows.weekly && !windows.mcp
              ? `no reportable ${params.errorLabel} quota windows`
              : undefined,
        }),
      ]);
    },
  };
}
