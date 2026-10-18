/**
 * GUI settings store over the canonical dashboard config layer (spec §5.4, §7).
 *
 * Reads the effective configuration through the shared core loader
 * (defaults → legacy layers → the global canonical dashboard file) and writes
 * only the global canonical `<configDir>/opencode-quota-gui/config.jsonc`
 * through the upstream comment-preserving, symlink-guarded atomic write
 * helpers. Project-scope files are read and reported, never written.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  GuiSettingsStore,
  ImportPreview,
  JsonValue,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../contracts/dashboard.js";
import {
  buildConfigLayerCandidates,
  type ConfigLayerCandidate,
  createLoadConfigMeta,
  GUI_CONFIG_RELATIVE_PATH,
  GUI_CONFIG_SIBLING_JSON_RELATIVE_PATH,
  getGuiConfigPath,
  getGuiConfigSiblingJsonPath,
  isPositiveNumber,
  isValidOpenCodeGoWindows,
  loadConfig,
  normalizeEnabledProviders,
} from "../lib/config.js";
import type { EditableConfigPath } from "../lib/config-file-utils.js";
import { ConfigWriteTargetError } from "../lib/config-write-target.js";
import { isResetTimeDecimals } from "../lib/format-utils.js";
import {
  applyConfigDocumentEdit,
  type ConfigDocumentEdit,
  ConfigDocumentError,
  type ManagedConfigComment,
  parseConfigDocument,
  planConfigDocumentEdit,
} from "../lib/opencode-config-editor.js";
import { isQuotaFormatStyle, resolveQuotaFormatStyle } from "../lib/quota-format-style.js";
import {
  DASHBOARD_HIDDEN_ID_LIMIT,
  DEFAULT_DASHBOARD_PORT,
  type QuotaToastConfig,
} from "../lib/types.js";

/** Writable GUI settings keys (spec §5.4 table order, port excluded). */
export const GUI_SETTINGS_WRITABLE_KEYS = [
  "formatStyle",
  "percentDisplayMode",
  "percentLabelStyle",
  "quotaProjection",
  "resetTimeDecimals",
  "resetTimeSpaced",
  "waitForQuotaReset",
  "enabledProviders",
  "minIntervalMs",
  "requestTimeoutMs",
  "accountingDetail",
  "opencodeGoWindows",
  "opencodeMonthlyLimit",
  "dashboard.hiddenCards",
  "dashboard.hiddenRows",
] as const;

/** Read-only GUI settings keys: the port needs a restart and has no fallback. */
export const GUI_SETTINGS_READ_ONLY_KEYS = ["dashboard.port"] as const;

/** Every GUI-exposed settings key (spec §5.4), in table order. */
export const GUI_SETTINGS_KEYS = [
  ...GUI_SETTINGS_WRITABLE_KEYS,
  ...GUI_SETTINGS_READ_ONLY_KEYS,
] as const;

export type GuiSettingsKey = (typeof GUI_SETTINGS_KEYS)[number];

const GUI_SETTINGS_KEY_NAMES: ReadonlySet<string> = new Set<string>(GUI_SETTINGS_KEYS);
const GUI_SETTINGS_READ_ONLY_KEY_NAMES: ReadonlySet<string> = new Set<string>(
  GUI_SETTINGS_READ_ONLY_KEYS,
);

/** The two sets above are the vocabulary; trust them as the membership proof. */
function isGuiSettingsKey(value: string): value is GuiSettingsKey {
  return GUI_SETTINGS_KEY_NAMES.has(value);
}

export type GuiSettingsErrorCode =
  | "config-read-error"
  | "config-changed"
  | "config-target-error"
  | "config-write-error"
  | "unknown-setting"
  | "invalid-setting";

export interface GuiSettingsErrorDetails {
  key?: string;
  reason?: string;
}

/**
 * Controlled settings failure for the HTTP boundary: a spec §5.3 code and a
 * generic message. Absolute paths and caller payloads never reach it.
 */
export class GuiSettingsError extends Error {
  readonly code: GuiSettingsErrorCode;
  readonly details?: GuiSettingsErrorDetails;

  constructor(code: GuiSettingsErrorCode, message: string, details?: GuiSettingsErrorDetails) {
    super(message);
    this.name = "GuiSettingsError";
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

/** HTTP status per settings error code (spec §5.3 status mapping). */
export const GUI_SETTINGS_ERROR_STATUS: Readonly<Record<GuiSettingsErrorCode, number>> = {
  "config-read-error": 409,
  "config-changed": 409,
  "config-target-error": 409,
  "config-write-error": 500,
  "unknown-setting": 422,
  "invalid-setting": 422,
};

/** Effective dashboard port from a loaded config, with the spec default. */
export function getGuiDashboardPort(
  config: { dashboard?: { port?: number } } | null | undefined,
): number {
  const port = config?.dashboard?.port;
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : DEFAULT_DASHBOARD_PORT;
}

export function resolveGuiDashboardUrl(port: number): string {
  return `http://127.0.0.1:${getGuiDashboardPort({ dashboard: { port } })}`;
}

export interface GuiSettingsStoreOptions {
  /** Global OpenCode config dir; the canonical file lives under it. */
  configDir: string;
  /** Project config root whose legacy layers are read and reported, never written. */
  workspaceRoot?: string;
}

interface CanonicalDocument {
  exists: boolean;
  malformed: boolean;
  data: Record<string, unknown> | null;
}

interface SettingsState {
  config: QuotaToastConfig;
  meta: ReturnType<typeof createLoadConfigMeta>;
  candidates: ConfigLayerCandidate[];
  canonical: CanonicalDocument;
  revision: string;
}

interface ImportPlan {
  from: string;
  keys: { key: GuiSettingsKey; value: JsonValue }[];
  issues: { key: string; message: string }[];
}

interface NormalizedWrite {
  applied: Record<string, JsonValue>;
  warnings: { key: string; message: string }[];
  changes: Map<string, JsonValue | undefined>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strict finite-number check: `Number.isFinite` coerces nothing, so it implies a number primitive. */
function isFiniteNumber(value: JsonValue): value is number {
  return Number.isFinite(value);
}

/** Never reflects an arbitrary caller key into a message or log. */
function safeSettingKeyLabel(key: string): string {
  return /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(key) && key.length <= 64
    ? key
    : "$unknown";
}

export function createGuiSettingsStore(options: GuiSettingsStoreOptions): GuiSettingsStore {
  const configDir = resolve(options.configDir);
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const canonicalPath = getGuiConfigPath(configDir);
  const siblingJsonPath = getGuiConfigSiblingJsonPath(configDir);

  let lockTail: Promise<unknown> = Promise.resolve();

  /** One serialized queue for all writers: the loser's stale revision yields 409. */
  function withLock<T>(run: () => Promise<T>): Promise<T> {
    const next = lockTail.then(run, run);
    lockTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function invalidSetting(key: string, message: string): GuiSettingsError {
    return new GuiSettingsError("invalid-setting", message, { key });
  }

  function symbolicSourceLabel(candidate: ConfigLayerCandidate): string {
    if (candidate.kind === "canonical") {
      return GUI_CONFIG_RELATIVE_PATH;
    }

    const scope = candidate.scope === "global" ? "global" : "project";
    if (candidate.kind === "plugin") {
      const relative = candidate.path.endsWith(".jsonc")
        ? "opencode-quota/quota-toast.jsonc"
        : "opencode-quota/quota-toast.json";
      return `${scope} ${relative}`;
    }

    const relative = candidate.path.endsWith(".jsonc") ? "opencode.jsonc" : "opencode.json";
    return `${scope} ${relative} (experimental.quotaToast)`;
  }

  function sourceLabelFor(
    sourceLabel: string | undefined,
    candidates: ConfigLayerCandidate[],
  ): string {
    if (!sourceLabel) {
      return "defaults";
    }

    const candidate = candidates.find(
      (entry) => sourceLabel === entry.path || sourceLabel.startsWith(`${entry.path} (`),
    );
    return candidate ? symbolicSourceLabel(candidate) : "defaults";
  }

  function settingValue(config: QuotaToastConfig, key: GuiSettingsKey): JsonValue {
    switch (key) {
      case "formatStyle":
        return config.formatStyle;
      case "percentDisplayMode":
        return config.percentDisplayMode;
      case "percentLabelStyle":
        return config.percentLabelStyle ?? null;
      case "quotaProjection":
        return config.quotaProjection ?? null;
      case "resetTimeDecimals":
        return config.resetTimeDecimals ?? null;
      case "resetTimeSpaced":
        return config.resetTimeSpaced ?? null;
      case "waitForQuotaReset":
        return config.waitForQuotaReset;
      case "enabledProviders":
        return Array.isArray(config.enabledProviders)
          ? [...config.enabledProviders]
          : config.enabledProviders;
      case "minIntervalMs":
        return config.minIntervalMs;
      case "requestTimeoutMs":
        return config.requestTimeoutMs;
      case "accountingDetail":
        return config.accountingDetail;
      case "opencodeGoWindows":
        return [...config.opencodeGoWindows];
      case "opencodeMonthlyLimit":
        return config.opencodeMonthlyLimit ?? null;
      case "dashboard.hiddenCards":
        return [...config.dashboard.hiddenCards];
      case "dashboard.hiddenRows":
        return [...config.dashboard.hiddenRows];
      case "dashboard.port":
        return config.dashboard.port;
    }
  }

  async function readCanonicalDocument(): Promise<CanonicalDocument> {
    if (!existsSync(canonicalPath)) {
      return { exists: false, malformed: false, data: null };
    }

    let raw: string;
    try {
      raw = await readFile(canonicalPath, "utf8");
    } catch {
      // Non-regular target, dangling link, or unreadable: the write path reports
      // the specific target reason instead of a read error.
      return { exists: true, malformed: false, data: null };
    }

    try {
      return {
        exists: true,
        malformed: false,
        data: parseConfigDocument(raw, "jsonc", canonicalPath),
      };
    } catch {
      return { exists: true, malformed: true, data: null };
    }
  }

  /** Revision covers the canonical file and every inherited source byte-for-byte. */
  async function computeRevision(candidates: ConfigLayerCandidate[]): Promise<string> {
    const hash = createHash("sha256");
    for (const candidate of candidates) {
      hash.update(symbolicSourceLabel(candidate));
      hash.update("\0");
      if (!existsSync(candidate.path)) {
        hash.update("missing\0");
        continue;
      }
      try {
        hash.update(await readFile(candidate.path));
      } catch {
        hash.update("unreadable\0");
      }
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 32);
  }

  async function readState(): Promise<SettingsState> {
    const meta = createLoadConfigMeta();
    const candidates = buildConfigLayerCandidates(configDir, workspaceRoot);
    const config = await loadConfig(undefined, meta, {
      configRootDir: workspaceRoot,
      globalConfigDir: configDir,
    });
    const canonical = await readCanonicalDocument();
    const revision = await computeRevision(candidates);
    return { config, meta, candidates, canonical, revision };
  }

  function collectIssues(state: SettingsState): SettingsSnapshot["issues"] {
    const issues = state.meta.configIssues.map((issue) => ({
      label: sourceLabelFor(issue.path, state.candidates),
      key: issue.key,
      message: issue.message,
    }));

    if (existsSync(siblingJsonPath)) {
      issues.push({
        label: GUI_CONFIG_RELATIVE_PATH,
        key: "$file",
        message: `${GUI_CONFIG_SIBLING_JSON_RELATIVE_PATH} exists and is not read; use ${GUI_CONFIG_RELATIVE_PATH}`,
      });
    }

    return issues;
  }

  function deriveImportPlan(state: SettingsState): ImportPlan {
    const keys: ImportPlan["keys"] = [];
    const origins: string[] = [];

    for (const key of GUI_SETTINGS_WRITABLE_KEYS) {
      const label = sourceLabelFor(state.meta.settingSources[key], state.candidates);
      if (label === "defaults" || label === GUI_CONFIG_RELATIVE_PATH) {
        continue;
      }
      keys.push({ key, value: settingValue(state.config, key) });
      if (!origins.includes(label)) {
        origins.push(label);
      }
    }

    const issues = state.meta.configIssues
      .filter((issue) => sourceLabelFor(issue.path, state.candidates) !== GUI_CONFIG_RELATIVE_PATH)
      .map((issue) => ({ key: issue.key, message: issue.message }));

    return { from: origins.join(", "), keys, issues };
  }

  function normalizeSettingValue(
    key: GuiSettingsKey,
    value: JsonValue,
    warnings: { key: string; message: string }[],
  ): JsonValue {
    switch (key) {
      case "formatStyle":
        if (!isQuotaFormatStyle(value)) {
          throw invalidSetting(key, "expected a quota format style");
        }
        return resolveQuotaFormatStyle(value);
      case "percentDisplayMode":
        if (value !== "used" && value !== "remaining") {
          throw invalidSetting(key, 'expected "used" or "remaining"');
        }
        return value;
      case "percentLabelStyle":
        if (value !== "full" && value !== "bare") {
          throw invalidSetting(key, 'expected "full" or "bare"');
        }
        return value;
      case "quotaProjection":
        if (value !== "runway") {
          throw invalidSetting(key, 'expected "runway"');
        }
        return value;
      case "resetTimeDecimals":
        if (!isResetTimeDecimals(value)) {
          throw invalidSetting(key, "expected an integer between 0 and 4");
        }
        return value;
      case "resetTimeSpaced":
      case "waitForQuotaReset":
        if (value !== true && value !== false) {
          throw invalidSetting(key, "expected boolean");
        }
        return value;
      case "enabledProviders": {
        if (value === "auto") {
          return "auto";
        }
        if (!Array.isArray(value)) {
          throw invalidSetting(key, 'expected "auto" or an array of provider ids');
        }
        const normalized = normalizeEnabledProviders(value);
        if (normalized.invalidEmpty || normalized.value === undefined) {
          throw invalidSetting(key, "expected known provider ids");
        }
        if (normalized.issues.length > 0) {
          warnings.push({ key, message: normalized.issues.join("; ") });
        }
        return [...normalized.value];
      }
      case "minIntervalMs":
      case "requestTimeoutMs":
        if (!isPositiveNumber(value)) {
          throw invalidSetting(key, "expected a finite number greater than 0");
        }
        return value;
      case "accountingDetail":
        if (value !== "summary" && value !== "detailed") {
          throw invalidSetting(key, 'expected "summary" or "detailed"');
        }
        return value;
      case "opencodeGoWindows":
        if (!isValidOpenCodeGoWindows(value)) {
          throw invalidSetting(
            key,
            'expected a non-empty subset of "rolling", "weekly", "monthly"',
          );
        }
        return [...new Set(value)];
      case "opencodeMonthlyLimit":
        if (!isFiniteNumber(value) || value < 0) {
          throw invalidSetting(key, "expected a number greater than or equal to 0");
        }
        return value;
      case "dashboard.hiddenCards":
      case "dashboard.hiddenRows": {
        if (!Array.isArray(value)) {
          throw invalidSetting(key, "expected a list of id strings");
        }
        const ids: string[] = [];
        for (const entry of value) {
          if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
            throw invalidSetting(key, "expected a list of id strings");
          }
          ids.push(entry);
        }
        if (ids.length > DASHBOARD_HIDDEN_ID_LIMIT) {
          throw invalidSetting(key, `expected at most ${DASHBOARD_HIDDEN_ID_LIMIT} ids`);
        }
        return [...new Set(ids)];
      }
      case "dashboard.port":
        throw invalidSetting(key, "this setting is read-only; edit the canonical file and restart");
    }
  }

  function normalizeWrite(patch: Record<string, JsonValue>): NormalizedWrite {
    const applied: Record<string, JsonValue> = {};
    const warnings: { key: string; message: string }[] = [];
    const changes = new Map<string, JsonValue | undefined>();

    for (const [rawKey, rawValue] of Object.entries(patch)) {
      if (!isGuiSettingsKey(rawKey)) {
        throw new GuiSettingsError("unknown-setting", "Unknown setting", {
          key: safeSettingKeyLabel(rawKey),
        });
      }

      const key = rawKey;
      if (GUI_SETTINGS_READ_ONLY_KEY_NAMES.has(rawKey)) {
        throw invalidSetting(key, "this setting is read-only; edit the canonical file and restart");
      }

      if (rawValue === null) {
        // `null` clears: the key is removed from the canonical file.
        changes.set(rawKey, undefined);
        applied[rawKey] = null;
        continue;
      }

      const value = normalizeSettingValue(key, rawValue, warnings);
      changes.set(rawKey, value);
      applied[rawKey] = value;
    }

    return { applied, warnings, changes };
  }

  function setKeyPath(
    target: Record<string, unknown>,
    parts: string[],
    value: JsonValue | undefined,
  ): void {
    const leaf = parts.at(-1);
    if (leaf === undefined) {
      return;
    }

    let node = target;
    for (const part of parts.slice(0, -1)) {
      const child = node[part];
      if (isPlainObject(child)) {
        node = child;
      } else {
        const created: Record<string, unknown> = {};
        node[part] = created;
        node = created;
      }
    }
    node[leaf] = value;
  }

  function applyChanges(
    base: Record<string, unknown>,
    changes: Map<string, JsonValue | undefined>,
  ): Record<string, unknown> {
    const desired = structuredClone(base);
    for (const [key, value] of changes) {
      setKeyPath(desired, key.split("."), value);
    }
    return desired;
  }

  function targetReasonFromMessage(message: string): string | undefined {
    if (/Dangling config symlink/.test(message)) return "dangling";
    if (/symlink loop/.test(message)) return "loop";
    if (/chain exceeds/.test(message)) return "depth";
    if (/not a regular file/.test(message)) return "non-regular";
    if (/Cannot inspect config path|Refusing to delete a symlinked/.test(message))
      return "permission";
    return undefined;
  }

  function asGuiSettingsError(error: unknown): GuiSettingsError {
    if (error instanceof GuiSettingsError) {
      return error;
    }
    if (error instanceof ConfigWriteTargetError) {
      return new GuiSettingsError(
        "config-target-error",
        "The dashboard config path is not writable",
        {
          reason: error.reason,
        },
      );
    }
    if (error instanceof ConfigDocumentError) {
      const message = error.message;
      if (/Cannot parse|must be an object/.test(message)) {
        return new GuiSettingsError(
          "config-read-error",
          "The dashboard config file is not valid JSONC",
        );
      }
      if (/changed since preview/.test(message)) {
        return new GuiSettingsError("config-changed", "Config changed since preview");
      }
      const reason = targetReasonFromMessage(message);
      if (reason) {
        return new GuiSettingsError(
          "config-target-error",
          "The dashboard config path is not writable",
          { reason },
        );
      }
      return new GuiSettingsError("config-write-error", "Config write failed");
    }
    return new GuiSettingsError("config-write-error", "Config write failed");
  }

  async function writeCanonicalDocument(
    desired: Record<string, unknown>,
    managedComments?: ManagedConfigComment[],
  ): Promise<void> {
    const target: EditableConfigPath = {
      path: canonicalPath,
      sourcePath: canonicalPath,
      format: "jsonc",
      existed: existsSync(canonicalPath),
    };

    let planned: ConfigDocumentEdit;
    try {
      planned = await planConfigDocumentEdit({ target, desiredData: desired, managedComments });
    } catch (error) {
      throw asGuiSettingsError(error);
    }

    if (!planned.changed) {
      return;
    }

    try {
      await applyConfigDocumentEdit(planned);
    } catch (error) {
      throw asGuiSettingsError(error);
    }
  }

  function assertRevision(current: string, expected: string): void {
    if (current !== expected) {
      throw new GuiSettingsError("config-changed", "Config changed since preview");
    }
  }

  async function commit(
    patch: Record<string, JsonValue>,
    expectedRevision: string,
  ): Promise<SettingsWriteResult> {
    const normalized = normalizeWrite(patch);
    const state = await readState();
    assertRevision(state.revision, expectedRevision);

    if (state.canonical.malformed) {
      throw new GuiSettingsError(
        "config-read-error",
        "The dashboard config file is not valid JSONC",
      );
    }

    await writeCanonicalDocument(applyChanges(state.canonical.data ?? {}, normalized.changes));

    return {
      revision: await computeRevision(state.candidates),
      applied: normalized.applied,
      warnings: normalized.warnings,
    };
  }

  async function settings(): Promise<SettingsSnapshot> {
    const state = await readState();
    const values: Record<string, JsonValue> = {};
    for (const key of GUI_SETTINGS_KEYS) {
      values[key] = settingValue(state.config, key);
    }

    const sources: Record<string, string> = {};
    for (const key of GUI_SETTINGS_KEYS) {
      sources[key] = sourceLabelFor(state.meta.settingSources[key], state.candidates);
    }

    const importPlan = deriveImportPlan(state);
    const issues = collectIssues(state);
    const port = getGuiDashboardPort(state.config);
    const importSection: SettingsSnapshot["import"] = {
      available: importPlan.keys.length > 0,
      issues: importPlan.issues,
    };
    if (importPlan.from) importSection.from = importPlan.from;
    if (importPlan.keys.length > 0) importSection.keyCount = importPlan.keys.length;

    return {
      revision: state.revision,
      pathLabel: GUI_CONFIG_RELATIVE_PATH,
      values,
      sources,
      writable: [...GUI_SETTINGS_WRITABLE_KEYS],
      dashboard: { port, url: resolveGuiDashboardUrl(port) },
      visibility: {
        hiddenCards: [...state.config.dashboard.hiddenCards],
        hiddenRows: [...state.config.dashboard.hiddenRows],
      },
      import: importSection,
      issues,
    };
  }

  async function saveSettings(input: {
    patch: Record<string, JsonValue>;
    expectedRevision: string;
  }): Promise<SettingsWriteResult> {
    return withLock(() => commit(input.patch, input.expectedRevision));
  }

  async function saveVisibility(input: {
    hiddenCards: string[];
    hiddenRows: string[];
    expectedRevision: string;
  }): Promise<SettingsWriteResult> {
    return withLock(() =>
      commit(
        {
          "dashboard.hiddenCards": [...input.hiddenCards],
          "dashboard.hiddenRows": [...input.hiddenRows],
        },
        input.expectedRevision,
      ),
    );
  }

  async function importPreview(): Promise<ImportPreview> {
    const state = await readState();
    const plan = deriveImportPlan(state);
    return {
      from: plan.from,
      keys: plan.keys.map(({ key, value }) => ({ key, value })),
      issues: plan.issues,
      expectedRevision: state.revision,
    };
  }

  async function importApply(input: { expectedRevision: string }): Promise<SettingsWriteResult> {
    return withLock(async () => {
      const state = await readState();
      assertRevision(state.revision, input.expectedRevision);

      if (state.canonical.malformed) {
        throw new GuiSettingsError(
          "config-read-error",
          "The dashboard config file is not valid JSONC",
        );
      }

      const plan = deriveImportPlan(state);
      if (plan.keys.length === 0) {
        return { revision: state.revision, applied: {}, warnings: [] };
      }

      const desired = structuredClone(state.canonical.data ?? {});
      const applied: Record<string, JsonValue> = {};
      for (const { key, value } of plan.keys) {
        setKeyPath(desired, key.split("."), value);
        applied[key] = value;
      }

      const firstKey = Object.keys(desired)[0];
      const managedComments: ManagedConfigComment[] | undefined = firstKey
        ? [{ path: [firstKey], text: `// Imported from ${plan.from}` }]
        : undefined;

      await writeCanonicalDocument(desired, managedComments);

      return {
        revision: await computeRevision(state.candidates),
        applied,
        warnings: [],
      };
    });
  }

  return { settings, saveSettings, saveVisibility, importPreview, importApply };
}
