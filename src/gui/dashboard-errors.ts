/**
 * Shared controlled error vocabulary for every dashboard transport (HTTP and
 * RPC). Messages are fixed generics: raw exception text, absolute paths and
 * provider payloads never cross a transport boundary.
 */

export type DashboardErrorCode =
  | "bad-request"
  | "bad-host"
  | "bad-origin"
  | "unsupported-media-type"
  | "body-too-large"
  | "method-not-allowed"
  | "not-found"
  | "config-read-error"
  | "config-changed"
  | "config-target-error"
  | "config-write-error"
  | "unknown-setting"
  | "invalid-setting"
  | "project-not-found"
  | "session-not-found"
  | "internal";

export interface DashboardErrorDetails {
  reason?: string;
  key?: string;
}

/** Status mapping from spec §5.3. */
export const DASHBOARD_ERROR_STATUS: Readonly<Record<DashboardErrorCode, number>> = {
  "bad-request": 400,
  "bad-host": 403,
  "bad-origin": 403,
  "unsupported-media-type": 415,
  "body-too-large": 413,
  "method-not-allowed": 405,
  "not-found": 404,
  "config-read-error": 409,
  "config-changed": 409,
  "config-target-error": 409,
  "config-write-error": 500,
  "unknown-setting": 422,
  "invalid-setting": 422,
  "project-not-found": 404,
  "session-not-found": 404,
  internal: 500,
};

export const DASHBOARD_ERROR_MESSAGES: Readonly<Record<DashboardErrorCode, string>> = {
  "bad-request": "Malformed request",
  "bad-host": "Requests must target the dashboard loopback address",
  "bad-origin": "Writes must originate from the dashboard page",
  "unsupported-media-type": "Writes require application/json",
  "body-too-large": "Request body exceeds the 64 KiB limit",
  "method-not-allowed": "Method not allowed",
  "not-found": "Not found",
  "config-read-error": "The dashboard config file is not valid JSONC",
  "config-changed": "Config changed since the last revision",
  "config-target-error": "The dashboard config path is not writable",
  "config-write-error": "Config write failed",
  "unknown-setting": "Unknown setting",
  "invalid-setting": "Invalid setting",
  "project-not-found": "Project not found",
  "session-not-found": "Session not found",
  internal: "Internal dashboard error",
};

const SOURCE_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad-request",
  "project-not-found",
  "session-not-found",
]);

/** The set above is the vocabulary; trust it as the membership proof. */
export function isDashboardSourceErrorCode(value: string): value is DashboardErrorCode {
  return SOURCE_ERROR_CODES.has(value);
}

const TARGET_REASONS: ReadonlySet<string> = new Set([
  "dangling",
  "loop",
  "depth",
  "non-regular",
  "permission",
]);

const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

/**
 * `details.reason` is forwarded for `config-target-error` only, and only from
 * the allowlisted target-reason vocabulary; `details.key` must be a setting key
 * shape. Other payload data never crosses the boundary.
 */
export function sanitizeDashboardErrorDetails(
  code: DashboardErrorCode,
  input:
    | {
        reason?: string;
        key?: string;
      }
    | undefined,
): DashboardErrorDetails | undefined {
  if (!input) return undefined;
  const details: DashboardErrorDetails = {};
  if (
    code === "config-target-error" &&
    input.reason !== undefined &&
    TARGET_REASONS.has(input.reason)
  ) {
    details.reason = input.reason;
  }
  if (input.key !== undefined && input.key.length <= 64 && SETTING_KEY_RE.test(input.key)) {
    details.key = input.key;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/** The stable source `code` field, across independently loaded module graphs. */
export function structuralDashboardSourceCode(error: unknown): DashboardErrorCode | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "string" || !isDashboardSourceErrorCode(code)) return undefined;
  return code;
}

/** A controlled condition the source or a store wants surfaced verbatim-ish. */
export class DashboardHttpError extends Error {
  readonly code: DashboardErrorCode;

  constructor(code: DashboardErrorCode) {
    super(DASHBOARD_ERROR_MESSAGES[code]);
    this.name = "DashboardHttpError";
    this.code = code;
  }
}
