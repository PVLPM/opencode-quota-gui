/**
 * The plugin RPC definitions. `QuotaRpc` is a legacy terminal-client contract
 * retained for compatibility, but is not registered by the GUI-only server
 * plugin. `DashboardRpc` is the typed dashboard contract the
 * server plugin registers for native clients. Imports from `@opencode/*` stay
 * type-only, so loading this file loads no OpenCode package.
 */
import type { Rpc } from "@opencode/plugin/rpc";
import { isAnalyticsGroupQuery } from "./contracts/analytics-entity.js";
import {
  type AgentCustomProviderSnapshot,
  type AgentCustomProviderTestResult,
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
export type DashboardRpcAgentCustomProviderInput = { id: string; expectedRevision: string };
export type DashboardRpcSetAgentCustomProviderEnabledInput = {
  id: string;
  enabled: boolean;
  expectedRevision: string;
};
export type DashboardRpcWatchInput = { scope: DashboardRpcViewScope };
export type DashboardRpcWatchOutput = { active: boolean };
export type DashboardRpcOpenSettingsOutput = { opened: true };
export type DashboardRpcCacheObserverEvent =
  | {
      type: "session.step.started";
      created: number;
      data: {
        sessionID: string;
        assistantMessageID: string;
        /** OpenCode's selected model identity, not the resolved HTTP request route. */
        model: { providerID: string; id: string; variant?: string };
        /** Captured before `llm.stream`; event.created is emitted at first output instead. */
        started?: number;
      };
    }
  | {
      type: "session.step.ended";
      created: number;
      data: {
        sessionID: string;
        assistantMessageID: string;
        tokens: {
          input?: number;
          cache?: { read?: number; write?: number };
        };
      };
    }
  | {
      type: "session.created";
      data: { sessionID: string; parentID: string };
    }
  | {
      type: "session.forked";
      data: { sessionID: string; parentID?: string };
    }
  | {
      type: "session.compaction.ended" | "session.deleted";
      data: { sessionID: string };
    }
  | {
      type: "source.status";
      created: number;
      data: { state: "observed" | "unavailable" | "stopped" };
    };
export type DashboardRpcEventData = {
  topic: DashboardEventTopic | "cache.observer";
  at: number;
  scope?: "visibility";
  cacheObserverEvent?: DashboardRpcCacheObserverEvent;
};
export type DashboardRpcQuotaNotificationKind = "low" | "exhausted" | "reset" | "provider-error";
/**
 * Safe quota notification payload. The host writes the wording; no raw provider
 * message, label, path or credential is ever carried.
 */
export type DashboardRpcQuotaNotificationData = {
  id: string;
  kind: DashboardRpcQuotaNotificationKind;
  title: string;
  description?: string;
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

/** Bounded single-line text for a user-facing notification event. */
function isSafeNotificationText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
  );
}

const QUOTA_NOTIFICATION_KINDS: readonly DashboardRpcQuotaNotificationKind[] = [
  "low",
  "exhausted",
  "reset",
  "provider-error",
];

function isValidResourceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RESOURCE_ID_LENGTH && !hasControlCharacters(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAgentCustomProviderSnapshot(value: unknown): value is AgentCustomProviderSnapshot {
  return (
    isObject(value) &&
    hasExactKeys(value, ["revision", "providers"]) &&
    typeof value.revision === "string" &&
    /^[0-9a-f]{64}$/.test(value.revision) &&
    Array.isArray(value.providers) &&
    value.providers.every(
      (provider) =>
        isObject(provider) &&
        hasExactKeys(provider, ["id", "definition", "approved", "enabled"]) &&
        typeof provider.id === "string" &&
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(provider.id) &&
        isJsonValue(provider.definition) &&
        typeof provider.approved === "boolean" &&
        typeof provider.enabled === "boolean",
    )
  );
}

function isAgentCustomProviderTestResult(value: unknown): value is AgentCustomProviderTestResult {
  return (
    isObject(value) &&
    hasExactKeys(value, ["id", "status", "reason", "trusted", "enabled"]) &&
    typeof value.id === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.id) &&
    (value.status === "passed" || value.status === "failed" || value.status === "not-applicable") &&
    (value.reason === "provider-responded" ||
      value.reason === "provider-rejected" ||
      value.reason === "unsafe-endpoint" ||
      value.reason === "local-estimate") &&
    typeof value.trusted === "boolean" &&
    typeof value.enabled === "boolean"
  );
}

function checkAgentCustomProviderActionInput(value: unknown): string | null {
  if (!isObject(value) || !hasExactKeys(value, ["id", "expectedRevision"])) {
    return "input must contain only id and expectedRevision";
  }
  if (typeof value.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.id)) {
    return "id must be a provider id";
  }
  return typeof value.expectedRevision === "string" && /^[0-9a-f]{64}$/.test(value.expectedRevision)
    ? null
    : "expectedRevision must be a canonical config revision";
}

function checkRange(value: Record<string, unknown>): string | null {
  return isRangeKey(value.range) ? null : "range must be one of 24h, 7d, 30d, lifetime";
}

/**
 * The explicit typed dashboard RPC. Methods map to a dashboard data-source or
 * user settings-store operation (plus `watch`); there is no generic dispatch.
 */
export const DashboardRpc = {
  id: DASHBOARD_RPC_ID,
  events: {
    invalidated: {
      schema: eventSchema<DashboardRpcEventData>((value) => {
        if (!isObject(value)) return "event must be an object";
        if (!hasOnlyKeys(value, ["topic", "at", "scope", "cacheObserverEvent"])) {
          return "event must contain only topic, at, scope and cacheObserverEvent";
        }
        if (!Number.isFinite(value.at)) return "at must be a finite number";
        if (value.topic === "cache.observer") {
          if (value.scope !== undefined) return "cache observer events cannot have a scope";
          return isDashboardRpcCacheObserverEvent(value.cacheObserverEvent)
            ? null
            : "cache.observer topic requires a valid cache observer payload";
        }
        if (
          value.topic !== "quota.changed" &&
          value.topic !== "sessions.changed" &&
          value.topic !== "settings.changed"
        ) {
          return "topic must be a dashboard event topic";
        }
        if (value.scope !== undefined && value.scope !== "visibility") {
          return "scope must be visibility";
        }
        if (value.cacheObserverEvent !== undefined) {
          return "cache observer payload requires the cache.observer topic";
        }
        return null;
      }),
    },
    quotaNotification: {
      schema: eventSchema<DashboardRpcQuotaNotificationData>((value) => {
        if (!isObject(value)) return "event must be an object";
        if (!hasOnlyKeys(value, ["id", "kind", "title", "description"])) {
          return "event must contain only id, kind, title and description";
        }
        if (!isSafeNotificationText(value.id, 256)) {
          return "id must be a safe non-empty string";
        }
        if (
          typeof value.kind !== "string" ||
          !(QUOTA_NOTIFICATION_KINDS as readonly string[]).includes(value.kind)
        ) {
          return "kind must be a quota notification kind";
        }
        if (!isSafeNotificationText(value.title, 200)) {
          return "title must be a safe non-empty string";
        }
        if (value.description !== undefined && !isSafeNotificationText(value.description, 1024)) {
          return "description must be a safe non-empty string when present";
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
    agentCustomProviders: {
      input: NO_INPUT,
      output: output(isAgentCustomProviderSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    approveAgentCustomProvider: {
      input: schema<DashboardRpcAgentCustomProviderInput>(checkAgentCustomProviderActionInput),
      output: output(isAgentCustomProviderSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    setAgentCustomProviderEnabled: {
      input: schema<DashboardRpcSetAgentCustomProviderEnabledInput>((value) => {
        if (!isObject(value) || !hasExactKeys(value, ["id", "enabled", "expectedRevision"])) {
          return "input must contain only id, enabled and expectedRevision";
        }
        if (typeof value.enabled !== "boolean") return "enabled must be a boolean";
        return checkAgentCustomProviderActionInput({
          id: value.id,
          expectedRevision: value.expectedRevision,
        });
      }),
      output: output(isAgentCustomProviderSnapshot),
      errors: DASHBOARD_RPC_ERRORS,
    },
    testApprovedAgentCustomProvider: {
      input: schema<DashboardRpcAgentCustomProviderInput>(checkAgentCustomProviderActionInput),
      output: output(isAgentCustomProviderTestResult),
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

/**
 * Runtime guard for the event seam. It mirrors the RPC schema so a malformed or
 * unsafe payload is dropped before it can reach a window's presenter.
 */
export function isDashboardRpcQuotaNotificationData(
  value: unknown,
): value is DashboardRpcQuotaNotificationData {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, ["id", "kind", "title", "description"])) return false;
  if (!isSafeNotificationText(value.id, 256)) return false;
  if (
    typeof value.kind !== "string" ||
    !(QUOTA_NOTIFICATION_KINDS as readonly string[]).includes(value.kind)
  ) {
    return false;
  }
  if (!isSafeNotificationText(value.title, 200)) return false;
  return value.description === undefined || isSafeNotificationText(value.description, 1024);
}

/** Strict runtime validation for the narrow, content-free cache observer event DTO. */
export function isDashboardRpcCacheObserverEvent(
  value: unknown,
): value is DashboardRpcCacheObserverEvent {
  if (!isObject(value) || typeof value.type !== "string") return false;

  if (value.type === "source.status") {
    return (
      hasExactKeys(value, ["type", "created", "data"]) &&
      Number.isFinite(value.created) &&
      isObject(value.data) &&
      hasExactKeys(value.data, ["state"]) &&
      (value.data.state === "observed" ||
        value.data.state === "unavailable" ||
        value.data.state === "stopped")
    );
  }

  if (value.type === "session.step.started") {
    if (
      !hasExactKeys(value, ["type", "created", "data"]) ||
      !Number.isFinite(value.created) ||
      !isObject(value.data) ||
      !hasOnlyKeys(value.data, ["sessionID", "assistantMessageID", "model", "started"]) ||
      typeof value.data.sessionID !== "string" ||
      !isValidResourceId(value.data.sessionID) ||
      typeof value.data.assistantMessageID !== "string" ||
      !isValidResourceId(value.data.assistantMessageID) ||
      !isObject(value.data.model) ||
      !hasOnlyKeys(value.data.model, ["providerID", "id", "variant"]) ||
      typeof value.data.model.providerID !== "string" ||
      !isValidResourceId(value.data.model.providerID) ||
      typeof value.data.model.id !== "string" ||
      !isValidResourceId(value.data.model.id) ||
      (value.data.model.variant !== undefined &&
        (typeof value.data.model.variant !== "string" ||
          !isValidResourceId(value.data.model.variant))) ||
      (value.data.started !== undefined &&
        (typeof value.data.started !== "number" ||
          !Number.isFinite(value.data.started) ||
          value.data.started < 0))
    ) {
      return false;
    }
    return true;
  }

  if (value.type === "session.step.ended") {
    if (!hasExactKeys(value, ["type", "created", "data"]) || !isObject(value.data)) return false;
    if (
      !Number.isFinite(value.created) ||
      !hasExactKeys(value.data, ["sessionID", "assistantMessageID", "tokens"]) ||
      typeof value.data.sessionID !== "string" ||
      !isValidResourceId(value.data.sessionID) ||
      typeof value.data.assistantMessageID !== "string" ||
      !isValidResourceId(value.data.assistantMessageID) ||
      !isObject(value.data.tokens) ||
      !hasOnlyKeys(value.data.tokens, ["input", "cache"])
    ) {
      return false;
    }
    const tokens = value.data.tokens;
    if (
      tokens.input !== undefined &&
      (!Number.isFinite(tokens.input) || (tokens.input as number) < 0)
    ) {
      return false;
    }
    if (tokens.cache === undefined) return true;
    if (!isObject(tokens.cache) || !hasOnlyKeys(tokens.cache, ["read", "write"])) return false;
    return [tokens.cache.read, tokens.cache.write].every(
      (count) => count === undefined || (Number.isFinite(count) && (count as number) >= 0),
    );
  }

  if (value.type === "session.created") {
    return (
      hasExactKeys(value, ["type", "data"]) &&
      isObject(value.data) &&
      hasExactKeys(value.data, ["sessionID", "parentID"]) &&
      typeof value.data.sessionID === "string" &&
      isValidResourceId(value.data.sessionID) &&
      typeof value.data.parentID === "string" &&
      isValidResourceId(value.data.parentID)
    );
  }

  if (value.type === "session.forked") {
    return (
      hasExactKeys(value, ["type", "data"]) &&
      isObject(value.data) &&
      hasOnlyKeys(value.data, ["sessionID", "parentID"]) &&
      typeof value.data.sessionID === "string" &&
      isValidResourceId(value.data.sessionID) &&
      (value.data.parentID === undefined ||
        (typeof value.data.parentID === "string" && isValidResourceId(value.data.parentID)))
    );
  }

  if (value.type !== "session.compaction.ended" && value.type !== "session.deleted") return false;
  return (
    hasExactKeys(value, ["type", "data"]) &&
    isObject(value.data) &&
    hasExactKeys(value.data, ["sessionID"]) &&
    typeof value.data.sessionID === "string" &&
    isValidResourceId(value.data.sessionID)
  );
}

/** Strict guard for cache observer DTOs wrapped in the existing invalidation event envelope. */
export function isDashboardRpcCacheObserverEventData(
  value: unknown,
): value is DashboardRpcEventData & {
  topic: "cache.observer";
  cacheObserverEvent: DashboardRpcCacheObserverEvent;
} {
  return (
    isObject(value) &&
    hasExactKeys(value, ["topic", "at", "cacheObserverEvent"]) &&
    value.topic === "cache.observer" &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    value.at >= 0 &&
    isDashboardRpcCacheObserverEvent(value.cacheObserverEvent)
  );
}
