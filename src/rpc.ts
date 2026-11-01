/**
 * The plugin RPC definitions. `QuotaRpc` is the inherited TUI contract (still
 * used by the retained TUI source, but no longer registered by the GUI-only
 * server plugin). `DashboardRpc` is the Stage 3 typed dashboard contract the
 * server plugin registers for native clients. Imports from `@opencode/*` stay
 * type-only, so loading this file loads no OpenCode package.
 */
import type { Rpc } from "@opencode/plugin/rpc";
import { isAnalyticsGroupQuery } from "./contracts/analytics-entity.js";
import {
  type AnalyticsGroupQuery,
  DASHBOARD_CONTRACT_VERSION,
  type DashboardEventTopic,
  type DashboardHealth,
  type JsonValue,
} from "./contracts/dashboard.js";
import {
  isAnalyticsGroupSnapshot,
  isDashboardHealth,
  isHomeSnapshot,
  isImportPreview,
  isJsonValue,
  isProjectSnapshot,
  isQuotaSnapshot,
  isSessionSnapshot,
  isSettingsSnapshot,
  isSettingsWriteResult,
} from "./contracts/dto-guards.js";
import { isRangeKey, type RangeKey } from "./contracts/ranges.js";
import {
  isQuotaDialogCommand,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
} from "./lib/quota-dialog-command-specs.js";

export const QUOTA_RPC_ID = "opencode-quota-gui";

export type QuotaRpcSurfaceInput = {
  surface: "sidebar" | "idle" | "compacted" | "question";
  sessionID: string;
};
export type QuotaRpcSurfaceOutput = {
  quota: {
    message: string;
    duration: number;
    activeProviderCount: number;
    resetNotification?: string;
  } | null;
};
export type QuotaRpcFooterInput = { surface: "prompt" | "home"; sessionID?: string };
export type QuotaRpcFooterOutput = { lines: string[] };
export type QuotaRpcWriteExportInput = Record<string, never>;
export type QuotaRpcWriteExportOutput = { written: boolean };
export type QuotaRpcCommandInput = {
  command: QuotaDialogCommandId;
  arguments?: string;
  sessionID?: string;
};
export type QuotaRpcCommandOutput = QuotaDialogCommandOutputResult;

type StandardValueSchema = Extract<Rpc.PortableValueSchema, { "~standard": unknown }>;
type QuotaRpcSchema<T> = StandardValueSchema & { "~standard": { types?: { input: T; output: T } } };
type ObjectEventSchema<T extends Record<string, unknown>> = {
  "~standard": {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: T } | { issues: ReadonlyArray<{ message: string }> };
    types?: { input: T; output: T };
  };
};

/**
 * A Standard Schema that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it. `types` only carries T for TypeScript.
 */
function schema<T>(
  check: (value: unknown) => string | null,
  normalize?: (value: unknown) => T,
): QuotaRpcSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota-gui",
      validate: (value) => {
        const issue = check(value);
        if (issue) return { issues: [{ message: issue }] };
        // SAFETY: `check` accepts only values whose shape was validated for T (or
        // `normalize` builds a fresh T from the accepted empty input).
        return { value: normalize ? normalize(value) : (value as T) };
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RPC events require their Standard Schema output to be an object, not the
 * unconstrained output used by method schemas.
 */
function eventSchema<T extends Record<string, unknown>>(
  check: (value: unknown) => string | null,
): ObjectEventSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-quota-gui",
      validate: (value) => {
        const issue = check(value);
        if (issue) return { issues: [{ message: issue }] };
        // SAFETY: `check` accepts only object values with this event shape.
        return { value: value as T };
      },
    },
  };
}

function checkOutput(value: unknown): string | null {
  return isObject(value) ? null : "output must be an object";
}

/** Concrete DTO output validation; the message is deliberately fixed. */
function output<T>(isDto: (value: unknown) => value is T): QuotaRpcSchema<T> {
  return schema<T>((value) =>
    isDto(value) ? null : "output does not match the dashboard contract",
  );
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function checkOptionalString(input: Record<string, unknown>, field: string): string | null {
  return input[field] === undefined || typeof input[field] === "string"
    ? null
    : `${field} must be a string`;
}

const SURFACES = ["sidebar", "idle", "compacted", "question"];
const FOOTER_SURFACES = ["prompt", "home"];

export const QuotaRpc = {
  id: QUOTA_RPC_ID,
  events: {},
  methods: {
    surface: {
      input: schema<QuotaRpcSurfaceInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !SURFACES.includes(value.surface)) {
          return `surface must be one of ${SURFACES.join(", ")}`;
        }
        if (typeof value.sessionID !== "string") return "sessionID must be a string";
        return null;
      }),
      output: schema<QuotaRpcSurfaceOutput>(checkOutput),
    },
    footer: {
      input: schema<QuotaRpcFooterInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.surface !== "string" || !FOOTER_SURFACES.includes(value.surface)) {
          return `surface must be one of ${FOOTER_SURFACES.join(", ")}`;
        }
        return checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcFooterOutput>(checkOutput),
    },
    writeExport: {
      input: schema<QuotaRpcWriteExportInput>((value) =>
        isObject(value) ? null : "input must be an object",
      ),
      output: schema<QuotaRpcWriteExportOutput>(checkOutput),
    },
    command: {
      input: schema<QuotaRpcCommandInput>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (typeof value.command !== "string" || !isQuotaDialogCommand(value.command)) {
          return "command must be a quota command id";
        }
        return checkOptionalString(value, "arguments") ?? checkOptionalString(value, "sessionID");
      }),
      output: schema<QuotaRpcCommandOutput>(checkOutput),
    },
  },
} satisfies Rpc.PortableDefinition;

export const DASHBOARD_RPC_ID = "opencode-quota-gui.dashboard";

export type DashboardRpcViewScope = "quota" | "analytics";
export type DashboardRpcNoInput = Record<string, never>;
export type DashboardRpcSaveSettingsInput = {
  patch: Record<string, JsonValue>;
  expectedRevision: string;
};
export type DashboardRpcSaveVisibilityInput = {
  hiddenCards: string[];
  hiddenRows: string[];
  expectedRevision: string;
};
export type DashboardRpcImportApplyInput = { expectedRevision: string };
export type DashboardRpcWatchInput = { scope: DashboardRpcViewScope };
export type DashboardRpcWatchOutput = { active: boolean };
export type DashboardRpcOpenSettingsOutput = { opened: true };
export type DashboardRpcEventData = {
  topic: DashboardEventTopic;
  at: number;
  scope?: "visibility";
};
export type DashboardRpcErrorDetails = {
  key?: string;
  reason?: string;
};

const MAX_RESOURCE_ID_LENGTH = 256;

const NO_INPUT = schema<DashboardRpcNoInput>(
  (value) =>
    value === undefined || (isObject(value) && Object.keys(value).length === 0)
      ? null
      : "input must be an empty object",
  () => ({}),
);

const ERROR_DETAILS = schema<DashboardRpcErrorDetails>((value) => {
  if (!isObject(value)) return "error details must be an object";
  if (!hasOnlyKeys(value, ["key", "reason"])) {
    return "error details may contain only key and reason";
  }
  return checkOptionalString(value, "key") ?? checkOptionalString(value, "reason");
});

/**
 * One explicit error vocabulary for every dashboard method. Any raw failure is
 * mapped to one of these codes by the server handler; messages are fixed
 * generics and details only carry an allowlisted setting key/reason.
 */
const DASHBOARD_RPC_ERRORS = {
  "bad-request": ERROR_DETAILS,
  "config-read-error": ERROR_DETAILS,
  "config-changed": ERROR_DETAILS,
  "config-target-error": ERROR_DETAILS,
  "config-write-error": ERROR_DETAILS,
  "unknown-setting": ERROR_DETAILS,
  "invalid-setting": ERROR_DETAILS,
  "project-not-found": ERROR_DETAILS,
  "session-not-found": ERROR_DETAILS,
  internal: ERROR_DETAILS,
} as const;

export type DashboardRpcErrorCode = keyof typeof DASHBOARD_RPC_ERRORS;
export type DashboardRpcMethod = (typeof DashboardRpc.methods)[keyof typeof DashboardRpc.methods];

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidResourceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RESOURCE_ID_LENGTH && !hasControlCharacters(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function checkRange(value: Record<string, unknown>): string | null {
  return isRangeKey(value.range) ? null : "range must be one of 24h, 7d, 30d, lifetime";
}

/**
 * The explicit typed dashboard RPC. Every method maps to one `DashboardDataSource`
 * operation (plus the transport-lifecycle `watch` method); there is deliberately
 * no generic dispatch/call method.
 */
export const DashboardRpc = {
  id: DASHBOARD_RPC_ID,
  events: {
    invalidated: {
      schema: eventSchema<DashboardRpcEventData>((value) => {
        if (!isObject(value)) return "event must be an object";
        if (!hasOnlyKeys(value, ["topic", "at", "scope"])) {
          return "event must contain only topic, at and scope";
        }
        if (
          value.topic !== "quota.changed" &&
          value.topic !== "sessions.changed" &&
          value.topic !== "settings.changed"
        ) {
          return "topic must be a dashboard event topic";
        }
        if (!Number.isFinite(value.at)) return "at must be a finite number";
        if (value.scope !== undefined && value.scope !== "visibility") {
          return "scope must be visibility";
        }
        return null;
      }),
    },
  },
  methods: {
    health: {
      input: NO_INPUT,
      output: output(isDashboardHealth),
      errors: DASHBOARD_RPC_ERRORS,
    },
    quota: {
      input: NO_INPUT,
      output: output(isQuotaSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    home: {
      input: schema<{ range: RangeKey }>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["range"])) {
          return "input must contain only range";
        }
        return checkRange(value);
      }),
      output: output(isHomeSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    groups: {
      input: schema<AnalyticsGroupQuery>((value) => {
        if (!isObject(value)) return "input must be an object";
        if (value.filter === undefined) {
          if (!hasExactKeys(value, ["range", "dimension"])) {
            return "input must contain only range and dimension";
          }
        } else if (!hasExactKeys(value, ["range", "dimension", "filter"])) {
          return "input must contain only range, dimension and filter";
        }
        return isAnalyticsGroupQuery(value) ? null : "input must be a grouped analytics query";
      }),
      output: output(isAnalyticsGroupSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    project: {
      input: schema<{ projectId: string; range: RangeKey }>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["projectId", "range"])) {
          return "input must contain only projectId and range";
        }
        if (typeof value.projectId !== "string" || !isValidResourceId(value.projectId)) {
          return "projectId must be a non-empty resource id";
        }
        return checkRange(value);
      }),
      output: output(isProjectSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    session: {
      input: schema<{ sessionId: string }>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["sessionId"])) {
          return "input must contain only sessionId";
        }
        return typeof value.sessionId === "string" && isValidResourceId(value.sessionId)
          ? null
          : "sessionId must be a non-empty resource id";
      }),
      output: output(isSessionSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    settings: {
      input: NO_INPUT,
      output: output(isSettingsSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    saveSettings: {
      input: schema<DashboardRpcSaveSettingsInput>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["patch", "expectedRevision"])) {
          return "input must contain only patch and expectedRevision";
        }
        if (!isObject(value.patch)) return "patch must be an object";
        if (typeof value.expectedRevision !== "string") return "expectedRevision must be a string";
        for (const [key, entry] of Object.entries(value.patch)) {
          if (key.length === 0 || !isJsonValue(entry)) {
            return "patch values must be JSON values";
          }
        }
        return null;
      }),
      output: output(isSettingsWriteResult),
      errors: DASHBOARD_RPC_ERRORS,
    },
    saveVisibility: {
      input: schema<DashboardRpcSaveVisibilityInput>((value) => {
        if (
          !isObject(value) ||
          !hasExactKeys(value, ["hiddenCards", "hiddenRows", "expectedRevision"])
        ) {
          return "input must contain only hiddenCards, hiddenRows and expectedRevision";
        }
        if (!isStringArray(value.hiddenCards)) return "hiddenCards must be a string array";
        if (!isStringArray(value.hiddenRows)) return "hiddenRows must be a string array";
        return typeof value.expectedRevision === "string"
          ? null
          : "expectedRevision must be a string";
      }),
      output: output(isSettingsWriteResult),
      errors: DASHBOARD_RPC_ERRORS,
    },
    importPreview: {
      input: NO_INPUT,
      output: output(isImportPreview),
      errors: DASHBOARD_RPC_ERRORS,
    },
    importApply: {
      input: schema<DashboardRpcImportApplyInput>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["expectedRevision"])) {
          return "input must contain only expectedRevision";
        }
        return typeof value.expectedRevision === "string"
          ? null
          : "expectedRevision must be a string";
      }),
      output: output(isSettingsWriteResult),
      errors: DASHBOARD_RPC_ERRORS,
    },
    openSettingsFile: {
      input: NO_INPUT,
      output: schema<DashboardRpcOpenSettingsOutput>((value) =>
        isObject(value) && value.opened === true ? null : "output must report opened",
      ),
      errors: DASHBOARD_RPC_ERRORS,
    },
    watch: {
      input: schema<DashboardRpcWatchInput>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["scope"])) {
          return "input must contain only scope";
        }
        return value.scope === "quota" || value.scope === "analytics"
          ? null
          : "scope must be quota or analytics";
      }),
      output: schema<DashboardRpcWatchOutput>((value) =>
        isObject(value) && typeof value.active === "boolean" ? null : "output must report active",
      ),
      errors: DASHBOARD_RPC_ERRORS,
    },
  },
} satisfies Rpc.PortableDefinition;

export const DASHBOARD_HEALTH: DashboardHealth = {
  app: "opencode-quota-gui",
  contractVersion: DASHBOARD_CONTRACT_VERSION,
};
