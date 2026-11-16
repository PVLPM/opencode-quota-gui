import type { ProviderFailureCategory } from "../contracts/provider-failure.js";
import { createApiKeyRetryGuard, retryAfterDeadline } from "./api-key-retry-after.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const MIMO_USAGE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
const MIMO_DETAIL_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail";
const MIMO_BALANCE_URL = "https://platform.xiaomimimo.com/api/v1/balance";
const MIMO_REQUEST_TIMEOUT_MS = 10_000;
const MIMO_RESPONSE_MAX_BYTES = 256 * 1024;
const MIMO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export interface MimoMonthlyQuota {
  used: number;
  limit: number;
}

export interface MimoPlanDetail {
  planName: string | null;
  planCode: string | null;
  expired: boolean;
}

export interface MimoBalance {
  total: number | null;
  cash: number | null;
  gift: number | null;
  currency: string | null;
}

export type MimoEndpointResult<T> =
  | { state: "success"; data: T }
  | {
      state: "error";
      error: string;
      failureCategory: ProviderFailureCategory;
      /** Deadline observed in an upstream Retry-After response. */
      retryAtMs?: number;
    };

// The shared guard keys on `success`; carry the endpoint result alongside it.
type GuardedEndpoint = {
  success: boolean;
  retryAtMs?: number;
  endpoint: MimoEndpointResult<unknown>;
};
const endpointGuard = createApiKeyRetryGuard<GuardedEndpoint>((retryAtMs) => ({
  success: false,
  retryAtMs,
  endpoint: {
    state: "error",
    error: "Xiaomi MiMo request failed (HTTP 429)",
    failureCategory: "provider_api",
    retryAtMs,
  },
}));

export interface MimoDashboardResult {
  usage: MimoEndpointResult<MimoMonthlyQuota>;
  detail: MimoEndpointResult<MimoPlanDetail>;
  balance: MimoEndpointResult<MimoBalance>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(json: unknown): Record<string, unknown> {
  if (!isRecord(json) || json.code !== 0 || !isRecord(json.data)) {
    throw new Error("invalid envelope");
  }
  return json.data;
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseBalanceNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMimoUsageResponse(json: unknown): MimoMonthlyQuota {
  const data = parseEnvelope(json);
  if (!isRecord(data.monthUsage) || !Array.isArray(data.monthUsage.items)) {
    throw new Error("missing monthly usage");
  }

  const item = data.monthUsage.items.find(
    (candidate) => isRecord(candidate) && candidate.name === "month_total_token",
  );
  if (!isRecord(item)) throw new Error("missing monthly quota");

  const used = parseNonNegativeNumber(item.used);
  const limit = parseNonNegativeNumber(item.limit);
  if (used === null || limit === null || limit <= 0) {
    throw new Error("invalid monthly quota");
  }

  return { used, limit };
}

export function parseMimoDetailResponse(json: unknown): MimoPlanDetail {
  const data = parseEnvelope(json);
  if (typeof data.expired !== "boolean") throw new Error("invalid plan state");

  return {
    planName: typeof data.planName === "string" && data.planName.trim() ? data.planName : null,
    planCode: typeof data.planCode === "string" && data.planCode.trim() ? data.planCode : null,
    expired: data.expired,
  };
}

export function parseMimoBalanceResponse(json: unknown): MimoBalance {
  const data = parseEnvelope(json);
  const fields = [
    ["balance", data.balance],
    ["cashBalance", data.cashBalance],
    ["giftBalance", data.giftBalance],
  ] as const;

  const parsed = new Map<string, number | null>();
  for (const [name, value] of fields) {
    if (value === undefined || value === null || value === "") {
      parsed.set(name, null);
      continue;
    }
    const amount = parseBalanceNumber(value);
    if (amount === null) throw new Error("invalid balance");
    parsed.set(name, amount);
  }

  const currency =
    typeof data.currency === "string" && /^[A-Za-z]{3}$/u.test(data.currency.trim())
      ? data.currency.trim().toUpperCase()
      : null;

  return {
    total: parsed.get("balance") ?? null,
    cash: parsed.get("cashBalance") ?? null,
    gift: parsed.get("giftBalance") ?? null,
    currency,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MIMO_RESPONSE_MAX_BYTES) {
      throw new Error("response too large");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MIMO_RESPONSE_MAX_BYTES) {
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or size-limit error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(body));
}

export function formatMimoDashboardTimeZone(timezoneOffsetMinutes?: number): string {
  const javascriptOffset = timezoneOffsetMinutes ?? new Date().getTimezoneOffset();
  const utcOffset = -javascriptOffset;
  const sign = utcOffset >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(utcOffset);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getCookieValues(cookie: string): string[] {
  return cookie
    .split(";")
    .map((part) => part.slice(part.indexOf("=") + 1).trim())
    .filter(Boolean);
}

function sanitizeRequestError(error: unknown, cookie: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [cookie, ...getCookieValues(cookie)]) {
    message = message.split(secret).join("[redacted]");
  }
  return sanitizeSingleLineDisplaySnippet(message, 120) || "request failed";
}

type MimoEndpointParams<T> = {
  name: "usage" | "detail" | "balance";
  url: string;
  cookie: string;
  requestTimeoutMs: number;
  timeZone: string;
  parse: (json: unknown) => T;
};

/** One cooldown per session cookie and endpoint; other cookies are unaffected. */
async function fetchMimoEndpoint<T>(params: MimoEndpointParams<T>): Promise<MimoEndpointResult<T>> {
  const guarded = await endpointGuard(
    JSON.stringify([params.cookie, params.name]),
    async () => {
      const endpoint = await requestMimoEndpoint(params);
      return {
        success: endpoint.state === "success",
        ...(endpoint.state === "error" && endpoint.retryAtMs !== undefined
          ? { retryAtMs: endpoint.retryAtMs }
          : {}),
        endpoint,
      };
    },
    params.requestTimeoutMs,
    (retryAtMs) => ({
      success: false,
      retryAtMs,
      endpoint: {
        state: "error",
        error: `Xiaomi MiMo ${params.name} request failed (HTTP 429)`,
        failureCategory: "provider_api",
        retryAtMs,
      },
    }),
  );
  return guarded.endpoint as MimoEndpointResult<T>;
}

async function requestMimoEndpoint<T>(
  params: MimoEndpointParams<T>,
): Promise<MimoEndpointResult<T>> {
  try {
    return await fetchWithTimeout(params.url, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: params.cookie,
          Origin: "https://platform.xiaomimimo.com",
          Referer: "https://platform.xiaomimimo.com/#/console/balance",
          "User-Agent": MIMO_USER_AGENT,
          "x-timeZone": params.timeZone,
        },
      },
      timeoutMs: params.requestTimeoutMs,
      consume: async (response, timeoutSignal): Promise<MimoEndpointResult<T>> => {
        if (response.status >= 300 && response.status < 400) {
          return {
            state: "error",
            error: `Xiaomi MiMo ${params.name} request requires login`,
            failureCategory: "credentials",
          };
        }
        if (!response.ok) {
          const retryAtMs = retryAfterDeadline(response);
          return {
            state: "error",
            error: `Xiaomi MiMo ${params.name} request failed (HTTP ${response.status})`,
            failureCategory:
              response.status === 401 || response.status === 403 ? "credentials" : "provider_api",
            ...(retryAtMs !== undefined ? { retryAtMs } : {}),
          };
        }

        let json: unknown;
        try {
          json = await readBoundedJson(response);
        } catch (error) {
          if (timeoutSignal.aborted) throw error;
          return {
            state: "error",
            error: `Xiaomi MiMo ${params.name} response could not be parsed`,
            failureCategory: "provider_api",
          };
        }

        try {
          return { state: "success", data: params.parse(json) };
        } catch {
          return {
            state: "error",
            error: `Xiaomi MiMo ${params.name} response did not match the expected schema`,
            failureCategory: "provider_api",
          };
        }
      },
    });
  } catch (error) {
    return {
      state: "error",
      error: `Xiaomi MiMo ${params.name} request failed: ${sanitizeRequestError(error, params.cookie)}`,
      failureCategory: "provider_api",
    };
  }
}

export async function queryMimoDashboard(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<MimoDashboardResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? MIMO_REQUEST_TIMEOUT_MS;
  const timeZone = formatMimoDashboardTimeZone();
  const [usage, detail, balance] = await Promise.all([
    fetchMimoEndpoint({
      name: "usage",
      url: MIMO_USAGE_URL,
      cookie,
      requestTimeoutMs,
      timeZone,
      parse: parseMimoUsageResponse,
    }),
    fetchMimoEndpoint({
      name: "detail",
      url: MIMO_DETAIL_URL,
      cookie,
      requestTimeoutMs,
      timeZone,
      parse: parseMimoDetailResponse,
    }),
    fetchMimoEndpoint({
      name: "balance",
      url: MIMO_BALANCE_URL,
      cookie,
      requestTimeoutMs,
      timeZone,
      parse: parseMimoBalanceResponse,
    }),
  ]);

  return { usage, detail, balance };
}
