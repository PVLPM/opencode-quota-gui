/**
 * Chutes AI quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.chutes.ai/users/me/quota_usage/me
 */

import { providerFailureCategoryForHttpStatus } from "../contracts/provider-failure.js";
import {
  type ChutesKeySource,
  getChutesKeyDiagnostics,
  hasChutesApiKey,
  resolveChutesApiKey,
} from "./chutes-config.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import type { ChutesResult } from "./types.js";

interface ChutesQuotaResponse {
  quota: number;
  used: number;
}

function getNextDailyResetUtc(): string {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return reset.toISOString();
}

const CHUTES_QUOTA_URL = "https://api.chutes.ai/users/me/quota_usage/me";

export {
  type ChutesKeySource,
  getChutesKeyDiagnostics,
  hasChutesApiKey as hasChutesApiKeyConfigured,
} from "./chutes-config.js";

export async function queryChutesQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<ChutesResult> {
  const resolved = await resolveChutesApiKey();
  if (!resolved) return null;

  let responseStatus: number | undefined;
  try {
    return await fetchWithTimeout(CHUTES_QUOTA_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resolved.key}`,
          "User-Agent": "opencode-quota-gui/1.0",
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp): Promise<Exclude<ChutesResult, null>> => {
        responseStatus = resp.status;
        if (!resp.ok) {
          const text = await resp.text();
          return {
            success: false,
            error: `Chutes API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
            failureCategory: providerFailureCategoryForHttpStatus(resp.status),
          };
        }

        const data = (await resp.json()) as ChutesQuotaResponse;
        if (
          typeof data.used !== "number" ||
          !Number.isFinite(data.used) ||
          typeof data.quota !== "number" ||
          !Number.isFinite(data.quota)
        ) {
          return {
            success: false,
            error: "Chutes API response returned an unexpected response shape",
            failureCategory: "provider_api",
          };
        }

        // Chutes returns used and quota.
        const used = data.used;
        const quota = data.quota;
        const percentRemaining = quota > 0 ? clampPercent(((quota - used) / quota) * 100) : 0;

        return {
          success: true,
          percentRemaining,
          resetTimeIso: getNextDailyResetUtc(),
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
      failureCategory:
        responseStatus === undefined
          ? "provider_api"
          : providerFailureCategoryForHttpStatus(responseStatus),
    };
  }
}
