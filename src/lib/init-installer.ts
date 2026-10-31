import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { getGuiConfigPath, getGuiConfigSiblingJsonPath, loadConfig } from "./config.js";
import {
  type ConfigFileFormat,
  dedupeNonEmptyStrings,
  type EditableConfigPath,
  findGitWorktreeRoot,
  getPluginSpecFromEntry,
  resolveEditableConfigPath,
} from "./config-file-utils.js";
import { writeConfiguredJsonAtomic } from "./config-write-target.js";
import { assertGuiConfigTargetIsIndependent } from "./gui-config-target.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import {
  applyConfigDocumentEdit,
  type ConfigDocumentEdit,
  planConfigDocumentEdit,
  validateConfigDocumentEdit,
} from "./opencode-config-editor.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { detectOpenCodeMajor } from "./opencode-version.js";
import {
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
  QUOTA_PROVIDER_SHAPES,
} from "./provider-metadata.js";
import {
  type CanonicalQuotaFormatStyle,
  getQuotaFormatStyleLabel,
  isQuotaFormatStyle,
  resolveQuotaFormatStyle,
} from "./quota-format-style.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";
import {
  DEFAULT_DASHBOARD_PORT,
  type QuotaToastConfig,
  type SessionTokenScope,
  type TuiCommandDisplay,
} from "./types.js";
import { getPackageVersion } from "./version.js";

const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const GITHUB_REPO_URL = "https://github.com/PVLPM/opencode-quota-gui";
const GITHUB_STAR_NOTE = `if this helps, stars are appreciated: ${GITHUB_REPO_URL}`;

export type InitInstallerInterface = "tui" | "web" | "both";
export type InitInstallerScope = "project" | "global";
export type InitQuotaUiChoice = "toast" | "sidebar" | "compact_status" | "none";
export type InitQuotaUi = readonly InitQuotaUiChoice[];
export type InitProviderMode = "auto" | "manual";

export interface InitInstallerSelections {
  interfaces: InitInstallerInterface;
  scope: InitInstallerScope;
  quotaUi: InitQuotaUi;
  providerMode: InitProviderMode;
  manualProviders: string[];
  formatStyle: CanonicalQuotaFormatStyle;
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"];
  showSessionTokens: boolean;
  sessionTokenScope?: SessionTokenScope;
  tuiCommandDisplay?: TuiCommandDisplay;
  maintainerAnnouncements?: boolean;
  configFormat?: ConfigFileFormat;
}

export interface InitInstallerQuickSetupNote {
  providerId: string;
  label: string;
  anchor: string;
}

export interface PlannedConfigEdit {
  kind: "opencode" | "quota";
  path: string;
  existed: boolean;
  format: ConfigFileFormat;
  changed: boolean;
  addedPlugins: string[];
  addedKeys: string[];
  updatedKeys: string[];
  valueChanges: string[];
  skippedValues: string[];
  warnings: string[];
  nextData?: Record<string, unknown>;
  plannedData?: Record<string, unknown>;
  documentEdit?: ConfigDocumentEdit;
}

export interface InitInstallerPlan {
  selections: InitInstallerSelections;
  /** Scope root for the OpenCode plugin entry (project worktree or global config). */
  baseDir: string;
  /** Global OpenCode config dir that owns the canonical dashboard config. */
  guiConfigDir: string;
  edits: PlannedConfigEdit[];
  warnings: string[];
  quickSetupNotes: InitInstallerQuickSetupNote[];
  summaryLines: string[];
}

export interface ApplyInitInstallerPlanResult {
  writtenPaths: string[];
  unchangedPaths: string[];
}

export class InitInstallerError extends Error {
  constructor(
    message: string,
    readonly details?: {
      path?: string;
      writtenPaths?: string[];
    },
  ) {
    super(message);
    this.name = "InitInstallerError";
  }
}

type JsonObject = Record<string, unknown>;

/** The renamed package identity. Legacy `@slkiser/opencode-quota` installs stay recognized. */
export const QUOTA_PLUGIN_PACKAGE_NAME = "opencode-quota-gui";
/** Optional explicit pack/tarball (or other) spec for new installs; local development and tests. */
export const QUOTA_PLUGIN_SPEC_ENV = "OPENCODE_QUOTA_PLUGIN_SPEC";

/** A prerelease (version with `-`) installs from the npm `next` tag; a stable release from `latest`. */
export function getQuotaPluginSpecForVersion(
  version: string,
  packageName: string = QUOTA_PLUGIN_PACKAGE_NAME,
): string {
  return version.includes("-") ? `${packageName}@next` : `${packageName}@latest`;
}

function normalizePluginSpecText(spec: string): string {
  return spec.replace(/\\/g, "/").toLowerCase();
}

function isUpstreamQuotaPackageSpec(spec: string): boolean {
  return normalizePluginSpecText(spec).includes("@slkiser/opencode-quota");
}

/**
 * True only for this package's own OpenCode plugin entry. Upstream
 * `@slkiser/opencode-quota` entries are deliberately excluded so both products can be
 * configured at once and GUI maintenance never rewrites the upstream entry.
 */
export async function isVerifiedGuiQuotaPluginSpec(
  spec: string,
  configDir: string,
): Promise<boolean> {
  if (isUpstreamQuotaPackageSpec(spec)) return false;
  if (/^opencode-quota-gui(?:@[^/\\\s]+)?$/.test(spec)) return true;
  if (!/^(?:file:|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(spec)) return false;

  let path: string;
  try {
    path = spec.startsWith("file://")
      ? fileURLToPath(spec)
      : resolve(configDir, spec.replace(/^file:/, ""));
  } catch {
    return false;
  }

  const normalized = path.replace(/\\/g, "/");
  if (/\/dist\//.test(normalized) && !normalized.endsWith("/dist/index.js")) return false;
  const packageDir = normalized.endsWith("/dist/index.js")
    ? dirname(dirname(path))
    : normalized.endsWith("/server.ts")
      ? dirname(path)
      : path;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    return Boolean(
      manifest &&
        typeof manifest === "object" &&
        "name" in manifest &&
        manifest.name === QUOTA_PLUGIN_PACKAGE_NAME,
    );
  } catch {
    return false;
  }
}

/**
 * Resolves an explicit plugin spec (a local pack/tarball or the user's own package), or null when
 * none is given. An explicit spec that points at the upstream `@slkiser/opencode-quota` package
 * is refused.
 */
export function resolveExplicitQuotaPluginSpec(params: {
  pluginSpec?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): string | null {
  const env = params.env ?? process.env;
  const raw = params.pluginSpec ?? env[QUOTA_PLUGIN_SPEC_ENV];
  const spec = typeof raw === "string" ? raw.trim() : "";

  if (!spec) {
    return null;
  }

  if (isUpstreamQuotaPackageSpec(spec)) {
    throw new InitInstallerError(
      `Refusing to install the upstream @slkiser/opencode-quota package; provide a local pack/tarball or an explicit spec for the ${QUOTA_PLUGIN_PACKAGE_NAME} package.`,
    );
  }

  return spec;
}

/**
 * Resolves the plugin spec new installs write: an explicit spec when provided, otherwise the
 * canonical `opencode-quota-gui` npm tag for the running package version.
 */
async function resolveQuotaPluginSpec(params: {
  pluginSpec?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<string> {
  const explicit = resolveExplicitQuotaPluginSpec(params);
  if (explicit !== null) {
    return explicit;
  }

  const version = await getPackageVersion();
  if (!version) {
    throw new InitInstallerError("Cannot read the OpenCode Quota package version.");
  }
  return getQuotaPluginSpecForVersion(version);
}

type PromptOption = {
  label: string;
  value: string;
  hint?: string;
};

type NormalizedQuotaUiIntent = {
  choices: InitQuotaUiChoice[];
  enableToast: boolean;
  enableSidebarPanel: boolean;
  enableCompactStatus: boolean;
};

type PromptAdapter = {
  intro: (message: string) => void;
  outro: (message: string) => void;
  select: (options: {
    message: string;
    options: PromptOption[];
    initialValue?: string;
  }) => Promise<unknown>;
  multiselect: (options: {
    message: string;
    required?: boolean;
    options: PromptOption[];
    initialValues?: string[];
  }) => Promise<unknown>;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
  log: {
    info: (message: string) => void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
};

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function getPluginEntryOptionPayload(entry: unknown): unknown {
  if (typeof entry === "string") return null;
  if (Array.isArray(entry)) return entry.length > 1 ? entry.slice(1) : null;
  if (!isPlainObject(entry)) return null;

  const payload = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "package"));
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  if (keys.length === 1 && keys[0] === "options") return [payload.options];
  return payload;
}

const QUOTA_UI_CHOICE_ORDER: InitQuotaUiChoice[] = ["sidebar", "toast", "compact_status", "none"];

function normalizeQuotaUiIntent(selections: InitInstallerSelections): NormalizedQuotaUiIntent {
  const rawSelections = selections as unknown as Record<string, unknown>;
  if (hasOwnKey(rawSelections, "tuiCompactStatus")) {
    throw new InitInstallerError("Unsupported installer selection: tuiCompactStatus");
  }

  const quotaUi = rawSelections.quotaUi;
  if (!Array.isArray(quotaUi)) {
    throw new InitInstallerError("Quota UI selections must be an array.");
  }
  if (quotaUi.length === 0) {
    throw new InitInstallerError("Quota UI selections must not be empty.");
  }

  const seen = new Set<InitQuotaUiChoice>();
  for (const rawChoice of quotaUi) {
    if (
      typeof rawChoice !== "string" ||
      !QUOTA_UI_CHOICE_ORDER.includes(rawChoice as InitQuotaUiChoice)
    ) {
      throw new InitInstallerError(`Unknown Quota UI option: ${String(rawChoice)}`);
    }
    seen.add(rawChoice as InitQuotaUiChoice);
  }

  if (seen.has("none") && seen.size > 1) {
    throw new InitInstallerError(
      "Manual commands only cannot be combined with automatic quota displays.",
    );
  }

  const choices = QUOTA_UI_CHOICE_ORDER.filter((choice) => seen.has(choice));

  const enableSidebarPanel = choices.includes("sidebar");
  const enableCompactStatus = choices.includes("compact_status");

  return {
    choices,
    enableToast: choices.includes("toast"),
    enableSidebarPanel,
    enableCompactStatus,
  };
}

function getProviderModeLabel(mode: InitProviderMode): string {
  return mode === "manual" ? "Manual" : "Auto-detect";
}

function getPercentDisplayModeLabel(mode: QuotaToastConfig["percentDisplayMode"]): string {
  return mode === "used" ? "Used" : "Remaining";
}

function resolveRequestedProviders(selections: InitInstallerSelections): string[] | "auto" {
  if (selections.providerMode === "auto") {
    return "auto";
  }

  const normalized = dedupeNonEmptyStrings(
    selections.manualProviders
      .map((providerId) => normalizeQuotaProviderId(providerId))
      .filter((providerId) => QUOTA_PROVIDER_SHAPES.some((shape) => shape.id === providerId)),
  );

  if (normalized.length === 0) {
    throw new InitInstallerError("Manual provider mode requires at least one supported provider.");
  }

  return normalized;
}

function pickFormatStyleToWrite(params: {
  quotaToast: JsonObject;
  selectedFormatStyle: CanonicalQuotaFormatStyle;
}): CanonicalQuotaFormatStyle {
  if (isQuotaFormatStyle(params.quotaToast.toastStyle)) {
    return resolveQuotaFormatStyle(params.quotaToast.toastStyle);
  }

  return params.selectedFormatStyle;
}

function pushSkippedIfChanged(
  edit: PlannedConfigEdit,
  pathLabel: string,
  existingValue: unknown,
  desiredValue: unknown,
): void {
  if (!jsonEqual(existingValue, desiredValue)) {
    edit.skippedValues.push(`${pathLabel} preserved existing value`);
  }
}

function ensureSchema(root: JsonObject, schemaUrl: string, edit: PlannedConfigEdit): void {
  if (!hasOwnKey(root, "$schema")) {
    root.$schema = schemaUrl;
    edit.changed = true;
    edit.addedKeys.push("$schema");
    return;
  }

  pushSkippedIfChanged(edit, "$schema", root.$schema, schemaUrl);
}

function withPluginSpec(entry: unknown, spec: string): unknown {
  if (typeof entry === "string") return spec;
  if (Array.isArray(entry)) return [spec, ...entry.slice(1)];
  return { ...(entry as JsonObject), package: spec };
}

async function planPluginEntries(
  root: JsonObject,
  params: {
    baseDir: string;
    pluginSpec: string;
    explicit: boolean;
    edit: PlannedConfigEdit;
  },
): Promise<void> {
  for (const key of ["plugin", "plugins"]) {
    if (hasOwnKey(root, key) && !Array.isArray(root[key])) {
      throw new InitInstallerError(
        `Cannot update opencode config because ${key} is not an array.`,
        { path: params.edit.path },
      );
    }
  }
  // This package requires v2; an unavailable binary must not create a legacy key.
  const key = (await detectOpenCodeMajor()) === 1 ? "plugin" : "plugins";
  const native = (root[key] as unknown[] | undefined) ?? [];
  const legacy = key === "plugins" ? ((root.plugin as unknown[] | undefined) ?? []) : [];
  const beforeArrays = JSON.stringify([root.plugin, root.plugins]);
  const entries = [
    ...native.map((entry) => ({ entry, inNative: true })),
    ...legacy.map((entry) => ({ entry, inNative: false })),
  ];
  const inspectedEntries: Array<{
    entry: unknown;
    inNative: boolean;
    spec: string | null;
  }> = [];
  const options = new Set<string>();
  for (const item of entries) {
    const spec = getPluginSpecFromEntry(item.entry);
    const isQuotaPlugin =
      spec !== null &&
      (spec === params.pluginSpec || (await isVerifiedGuiQuotaPluginSpec(spec, params.baseDir)));
    inspectedEntries.push({
      entry: item.entry,
      inNative: item.inNative,
      spec: isQuotaPlugin ? spec : null,
    });
    if (isQuotaPlugin) {
      options.add(stableJsonStringify(getPluginEntryOptionPayload(item.entry)));
    }
  }
  if (options.size > 1) {
    throw new InitInstallerError(
      "Multiple quota plugin entries have different options; review them manually before replacing the plugin spec.",
      { path: params.edit.path },
    );
  }

  const next: unknown[] = [];
  const remainingLegacy: unknown[] = [];
  let retainedSpec: string | null = null;
  let migratedLegacySpec: string | null = null;
  let foundLegacyQuotaPlugin = false;
  for (const { entry, inNative, spec } of inspectedEntries) {
    if (spec === null) {
      // Legacy unrelated entries stay in their original array.
      if (inNative) next.push(entry);
      else remainingLegacy.push(entry);
      continue;
    }

    if (!inNative) foundLegacyQuotaPlugin = true;
    if (retainedSpec !== null) {
      params.edit.updatedKeys.push(key);
      const removalLocation = inNative ? key : `plugin -> ${key}`;
      params.edit.valueChanges.push(
        `${removalLocation}: remove duplicate quota plugin ${JSON.stringify(spec)}; keep ${JSON.stringify(retainedSpec)}`,
      );
      continue;
    }

    const retainedEntry = params.explicit ? withPluginSpec(entry, params.pluginSpec) : entry;
    retainedSpec = getPluginSpecFromEntry(retainedEntry) ?? spec;
    next.push(retainedEntry);
    if (!inNative) migratedLegacySpec = retainedSpec;
    if (params.explicit && spec !== retainedSpec) {
      params.edit.updatedKeys.push(key);
      params.edit.valueChanges.push(
        `${key}: ${JSON.stringify(spec)} -> ${JSON.stringify(retainedSpec)}`,
      );
    }
  }

  if (retainedSpec === null) {
    next.push(params.pluginSpec);
    params.edit.addedPlugins.push(`${key}: ${params.pluginSpec}`);
  }

  if (legacy.length > 0) root.plugin = remainingLegacy;
  if (foundLegacyQuotaPlugin) {
    params.edit.updatedKeys.push("plugin -> plugins");
    if (migratedLegacySpec !== null) {
      params.edit.valueChanges.push(`plugin -> plugins: ${JSON.stringify([migratedLegacySpec])}`);
    }
  }
  root[key] = next;

  if (
    !params.explicit &&
    retainedSpec !== null &&
    JSON.stringify([root.plugin, root.plugins]) === beforeArrays
  ) {
    params.edit.skippedValues.push(`${key} already includes a quota plugin entry`);
  }
}

function addSettingIfMissing(
  target: JsonObject,
  key: string,
  value: unknown,
  pathLabel: string,
  edit: PlannedConfigEdit,
): void {
  if (!hasOwnKey(target, key)) {
    target[key] = value;
    edit.changed = true;
    edit.addedKeys.push(pathLabel);
    return;
  }

  pushSkippedIfChanged(edit, pathLabel, target[key], value);
}

function setInstallerOwnedSetting(
  target: JsonObject,
  key: string,
  value: unknown,
  pathLabel: string,
  edit: PlannedConfigEdit,
): void {
  if (!hasOwnKey(target, key)) {
    target[key] = value;
    edit.changed = true;
    edit.addedKeys.push(pathLabel);
    return;
  }

  if (!jsonEqual(target[key], value)) {
    const previousValue = target[key];
    target[key] = value;
    edit.changed = true;
    edit.updatedKeys.push(pathLabel);
    edit.valueChanges.push(
      `${pathLabel}: ${JSON.stringify(previousValue)} -> ${JSON.stringify(value)}`,
    );
  }
}

function planTuiSidebarPanelConfig(params: {
  quotaToast: JsonObject;
  quotaUiIntent: NormalizedQuotaUiIntent;
  edit: PlannedConfigEdit;
}): void {
  const pathLabel = "quotaToast.tuiSidebarPanel";
  let tuiSidebarPanel: JsonObject;
  if (!hasOwnKey(params.quotaToast, "tuiSidebarPanel")) {
    tuiSidebarPanel = {};
    params.quotaToast.tuiSidebarPanel = tuiSidebarPanel;
  } else if (isPlainObject(params.quotaToast.tuiSidebarPanel)) {
    tuiSidebarPanel = params.quotaToast.tuiSidebarPanel;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    tuiSidebarPanel,
    "enabled",
    params.quotaUiIntent.enableSidebarPanel,
    `${pathLabel}.enabled`,
    params.edit,
  );
}

function planMaintainerAnnouncementsConfig(params: {
  quotaToast: JsonObject;
  selections: InitInstallerSelections;
  edit: PlannedConfigEdit;
}): void {
  if (params.selections.maintainerAnnouncements === undefined) {
    return;
  }

  const enabled = params.selections.maintainerAnnouncements;

  const pathLabel = "quotaToast.maintainerAnnouncements";
  let maintainerAnnouncements: JsonObject;
  if (!hasOwnKey(params.quotaToast, "maintainerAnnouncements")) {
    maintainerAnnouncements = {};
    params.quotaToast.maintainerAnnouncements = maintainerAnnouncements;
  } else if (isPlainObject(params.quotaToast.maintainerAnnouncements)) {
    maintainerAnnouncements = params.quotaToast.maintainerAnnouncements;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    maintainerAnnouncements,
    "enabled",
    enabled,
    `${pathLabel}.enabled`,
    params.edit,
  );

  if (enabled) {
    setInstallerOwnedSetting(
      maintainerAnnouncements,
      "home",
      true,
      `${pathLabel}.home`,
      params.edit,
    );
  }
}

function planTuiCompactStatusConfig(params: {
  quotaToast: JsonObject;
  quotaUiIntent: NormalizedQuotaUiIntent;
  edit: PlannedConfigEdit;
}): void {
  const hasExistingCompactStatus = hasOwnKey(params.quotaToast, "tuiCompactStatus");
  if (!params.quotaUiIntent.enableCompactStatus && !hasExistingCompactStatus) {
    return;
  }

  const pathLabel = "quotaToast.tuiCompactStatus";
  let tuiCompactStatus: JsonObject;
  if (!hasExistingCompactStatus) {
    tuiCompactStatus = {};
    params.quotaToast.tuiCompactStatus = tuiCompactStatus;
  } else if (isPlainObject(params.quotaToast.tuiCompactStatus)) {
    tuiCompactStatus = params.quotaToast.tuiCompactStatus;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    tuiCompactStatus,
    "enabled",
    params.quotaUiIntent.enableCompactStatus,
    `${pathLabel}.enabled`,
    params.edit,
  );

  if (!params.quotaUiIntent.enableCompactStatus) {
    return;
  }

  setInstallerOwnedSetting(
    tuiCompactStatus,
    "homeBottom",
    true,
    `${pathLabel}.homeBottom`,
    params.edit,
  );
  setInstallerOwnedSetting(
    tuiCompactStatus,
    "sessionPrompt",
    true,
    `${pathLabel}.sessionPrompt`,
    params.edit,
  );
}

async function readExistingConfig(params: {
  path: string;
  format: ConfigFileFormat;
}): Promise<JsonObject> {
  try {
    const content = await readFile(params.path, "utf-8");
    const parsed = parseJsonOrJsonc(content, params.format === "jsonc");
    if (!isPlainObject(parsed)) {
      throw new InitInstallerError("Existing config root must be a JSON object.", {
        path: params.path,
      });
    }

    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof InitInstallerError) {
      throw error;
    }

    throw new InitInstallerError(`Failed to parse ${basename(params.path)}.`, {
      path: params.path,
    });
  }
}

function buildQuickSetupNotes(selections: InitInstallerSelections): InitInstallerQuickSetupNote[] {
  if (selections.providerMode !== "manual") {
    return [];
  }

  const requestedProviders = resolveRequestedProviders(selections);
  if (requestedProviders === "auto") {
    return [];
  }

  return requestedProviders
    .map((providerId) => QUOTA_PROVIDER_SHAPES.find((shape) => shape.id === providerId))
    .filter((shape): shape is (typeof QUOTA_PROVIDER_SHAPES)[number] =>
      Boolean(shape?.quickSetupAnchor && shape.autoSetup === "needs_quick_setup"),
    )
    .map((shape) => ({
      providerId: shape.id,
      label: getQuotaProviderDisplayLabel(shape.id),
      anchor: shape.quickSetupAnchor!,
    }));
}

async function planOpencodeEdit(params: {
  selections: InitInstallerSelections;
  baseDir: string;
  pluginSpec: string;
  explicit: boolean;
  guiFirst?: boolean;
}): Promise<PlannedConfigEdit> {
  const target = resolveEditableConfigPath({
    dir: params.baseDir,
    kind: "opencode",
    preferredFormat: params.selections.configFormat ?? "jsonc",
    convertJsonToJsonc: !params.guiFirst,
  });
  const edit: PlannedConfigEdit = {
    kind: "opencode",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    updatedKeys: [],
    valueChanges: [],
    skippedValues: [],
    warnings: [],
  };

  const root = target.existed
    ? await readExistingConfig({
        path: target.sourcePath,
        format: target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
      })
    : {};

  if (!target.existed) {
    ensureSchema(root, OPENCODE_SCHEMA_URL, edit);
  }

  const beforePlugins = JSON.stringify(root);
  await planPluginEntries(root, { ...params, edit });
  const pluginsChanged = beforePlugins !== JSON.stringify(root);

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: root,
    managedComments: pluginsChanged
      ? [
          {
            path: ["plugins"],
            text: "// OpenCode Quota GUI: loads the server plugin for the local dashboard.",
          },
        ]
      : [],
  });
  edit.changed = documentEdit.changed;
  edit.documentEdit = documentEdit;

  return edit;
}

/**
 * The dashboard only reads the canonical `opencode-quota-gui/config.jsonc`. Keep the
 * target independent of the host OpenCode format and never touch/convert the dormant
 * sibling `config.json`.
 */
function resolveQuotaConfigTarget(configDir: string): EditableConfigPath {
  const path = getGuiConfigPath(configDir);
  return {
    path,
    sourcePath: path,
    format: "jsonc",
    existed: existsSync(path),
  };
}

async function planQuotaConfigEdit(params: {
  selections: InitInstallerSelections;
  quotaUiIntent: NormalizedQuotaUiIntent;
  configDir: string;
  guiFirst?: boolean;
}): Promise<PlannedConfigEdit> {
  const target = resolveQuotaConfigTarget(params.configDir);
  await assertGuiConfigTargetIsIndependent(target.path, params.configDir);
  const edit: PlannedConfigEdit = {
    kind: "quota",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    updatedKeys: [],
    valueChanges: [],
    skippedValues: [],
    warnings: [],
  };
  if (existsSync(getGuiConfigSiblingJsonPath(params.configDir))) {
    edit.warnings.push(
      target.existed
        ? "Both opencode-quota-gui/config.jsonc and config.json exist; using JSONC and preserving the JSON file."
        : "Existing opencode-quota-gui/config.json is preserved unchanged; the dashboard reads only config.jsonc.",
    );
  }

  const quotaToast = target.existed
    ? await readExistingConfig({
        path: target.sourcePath,
        format: "jsonc",
      })
    : {};

  if (!target.existed) {
    edit.addedKeys.push("opencode-quota-gui/config.jsonc");
  }

  const setUnaskedSetting = params.guiFirst ? addSettingIfMissing : setInstallerOwnedSetting;
  setUnaskedSetting(
    quotaToast,
    "enableToast",
    params.quotaUiIntent.enableToast,
    "quotaToast.enableToast",
    edit,
  );
  if (params.selections.tuiCommandDisplay !== undefined) {
    setInstallerOwnedSetting(
      quotaToast,
      "tuiCommandDisplay",
      params.selections.tuiCommandDisplay,
      "quotaToast.tuiCommandDisplay",
      edit,
    );
  }
  setUnaskedSetting(
    quotaToast,
    "showSessionTokens",
    params.selections.showSessionTokens,
    "quotaToast.showSessionTokens",
    edit,
  );
  setUnaskedSetting(
    quotaToast,
    "sessionTokenScope",
    params.selections.sessionTokenScope ?? "current",
    "quotaToast.sessionTokenScope",
    edit,
  );
  const requestedProviders = resolveRequestedProviders(params.selections);
  const enabledProviders =
    requestedProviders !== "auto" &&
    Array.isArray(quotaToast.enabledProviders) &&
    quotaToast.enabledProviders.includes(QUOTA_PROVIDERS_AGGREGATE_ID)
      ? [...requestedProviders, QUOTA_PROVIDERS_AGGREGATE_ID]
      : requestedProviders;
  setInstallerOwnedSetting(
    quotaToast,
    "enabledProviders",
    enabledProviders,
    "quotaToast.enabledProviders",
    edit,
  );
  setUnaskedSetting(
    quotaToast,
    "formatStyle",
    params.selections.formatStyle,
    "quotaToast.formatStyle",
    edit,
  );
  setInstallerOwnedSetting(
    quotaToast,
    "percentDisplayMode",
    params.selections.percentDisplayMode,
    "quotaToast.percentDisplayMode",
    edit,
  );
  if (params.guiFirst) {
    for (const key of ["tuiSidebarPanel", "tuiCompactStatus", "maintainerAnnouncements"]) {
      addSettingIfMissing(quotaToast, key, { enabled: false }, `quotaToast.${key}`, edit);
    }
  } else {
    planTuiSidebarPanelConfig({ quotaToast, quotaUiIntent: params.quotaUiIntent, edit });
    planTuiCompactStatusConfig({ quotaToast, quotaUiIntent: params.quotaUiIntent, edit });
    planMaintainerAnnouncementsConfig({ quotaToast, selections: params.selections, edit });
  }

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: quotaToast,
    managedComments: [
      {
        path: ["enableToast"],
        text: "// Automatic quota surfaces. Dashboard settings remain separate when these are disabled.",
      },
      {
        path: ["enabledProviders"],
        text: '// Provider selection: "auto" detects providers; an array tracks only listed providers.',
      },
      {
        path: ["formatStyle"],
        text: "// Quota presentation and reset-period choices.",
      },
      {
        path: ["showSessionTokens"],
        text: "// Include or hide session input and output token totals.",
      },
      {
        path: ["sessionTokenScope"],
        text: '// Session token totals: "current" session only, or "tree" including descendants.',
      },
      {
        path: ["maintainerAnnouncements"],
        text: "// Optional bundled maintainer Home announcements.",
      },
    ],
  });
  edit.changed = documentEdit.changed;
  edit.documentEdit = documentEdit;
  edit.plannedData = quotaToast;

  return edit;
}

function buildPlanSummary(plan: InitInstallerPlan): string[] {
  const opencodeFormat =
    plan.edits.find((edit) => edit.kind === "opencode")?.format ??
    plan.selections.configFormat ??
    "jsonc";
  const lines: string[] = [
    "Interface: GUI dashboard",
    `OpenCode plugin scope: ${plan.selections.scope} (${plan.baseDir})`,
    `Dashboard config (global): ${getGuiConfigPath(plan.guiConfigDir)}`,
    `OpenCode config format: ${opencodeFormat.toUpperCase()}`,
  ];

  lines.push(
    `Provider mode: ${getProviderModeLabel(plan.selections.providerMode)}`,
    `Quota reset periods: ${getQuotaFormatStyleLabel(plan.selections.formatStyle)}`,
    `Quota percentage meaning: ${getPercentDisplayModeLabel(plan.selections.percentDisplayMode)}`,
    `Session input/output tokens: ${plan.selections.showSessionTokens ? "Show" : "Hide"}`,
    `Session token scope: ${plan.selections.sessionTokenScope === "tree" ? "Current session and descendants" : "Current session"}`,
  );

  if (plan.selections.maintainerAnnouncements !== undefined) {
    lines.push(
      `Maintainer announcements: ${plan.selections.maintainerAnnouncements ? "Enabled" : "Disabled"}`,
    );
  }

  const requestedProviders = resolveRequestedProviders(plan.selections);
  if (requestedProviders !== "auto") {
    lines.push(
      `Manual providers: ${requestedProviders.map((providerId) => getQuotaProviderDisplayLabel(providerId)).join(", ")}`,
    );
  }

  for (const edit of plan.edits) {
    const convertedFrom = edit.documentEdit?.removeSourcePath;
    const mode = convertedFrom
      ? "convert"
      : !edit.existed
        ? "create"
        : edit.changed
          ? "update"
          : "unchanged";
    lines.push(
      convertedFrom ? `${mode}: ${convertedFrom} -> ${edit.path}` : `${mode}: ${edit.path}`,
    );

    for (const plugin of edit.addedPlugins) {
      lines.push(`  + plugin ${plugin}`);
    }
    for (const key of edit.addedKeys) {
      lines.push(`  + ${key}`);
    }
    for (const key of edit.updatedKeys) {
      lines.push(`  ~ ${key}`);
    }
    for (const change of edit.valueChanges) {
      lines.push(`    ${change}`);
    }
    for (const skipped of edit.skippedValues) {
      lines.push(`  = ${skipped}`);
    }
    for (const warning of edit.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  if (plan.quickSetupNotes.length > 0) {
    lines.push("Quick setup reminders:");
    for (const note of plan.quickSetupNotes) {
      lines.push(`  - ${note.label}: docs/readme/providers.md#${note.anchor}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  return lines;
}

export function getInstallerProviderPromptOptions(): PromptOption[] {
  return QUOTA_PROVIDER_SHAPES.map((shape) => ({
    label:
      shape.autoSetup === "needs_quick_setup"
        ? `${getQuotaProviderDisplayLabel(shape.id)} (quick setup)`
        : getQuotaProviderDisplayLabel(shape.id),
    value: shape.id,
  }));
}

export function resolveInitInstallerBaseDir(params: {
  scope: InitInstallerScope;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  if (params.scope === "global") {
    return getOpencodeRuntimeDirs({ env: params.env, homeDir: params.homeDir }).configDir;
  }

  const cwd = params.cwd ?? process.cwd();
  return findGitWorktreeRoot(cwd) ?? cwd;
}

export async function planInitInstaller(params: {
  selections: InitInstallerSelections;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pluginSpec?: string;
  guiFirst?: boolean;
}): Promise<InitInstallerPlan> {
  const requestedSelections: InitInstallerSelections = {
    ...params.selections,
    quotaUi: params.selections.interfaces === "web" ? ["none"] : params.selections.quotaUi,
  };
  const quotaUiIntent = normalizeQuotaUiIntent(requestedSelections);
  const selections: InitInstallerSelections = {
    ...requestedSelections,
    configFormat: params.selections.configFormat ?? "jsonc",
    quotaUi: quotaUiIntent.choices,
    tuiCommandDisplay:
      params.selections.interfaces === "web"
        ? undefined
        : (params.selections.tuiCommandDisplay ?? "dialog"),
    maintainerAnnouncements: params.selections.maintainerAnnouncements,
    manualProviders:
      params.selections.providerMode === "manual"
        ? (resolveRequestedProviders(params.selections) as string[])
        : [],
  };
  const baseDir = resolveInitInstallerBaseDir({
    scope: selections.scope,
    cwd: params.cwd,
    env: params.env,
    homeDir: params.homeDir,
  });
  // Dashboard behavior always lives in the global canonical config, even when the
  // plugin entry is installed for the current project only.
  const guiConfigDir = resolveInitInstallerBaseDir({
    scope: "global",
    env: params.env,
    homeDir: params.homeDir,
  });
  const quotaEdit = await planQuotaConfigEdit({
    selections,
    quotaUiIntent,
    configDir: guiConfigDir,
    guiFirst: params.guiFirst,
  });
  const pluginSpec = await resolveQuotaPluginSpec({
    pluginSpec: params.pluginSpec,
    env: params.env,
  });
  const edits = [
    await planOpencodeEdit({
      selections,
      baseDir,
      pluginSpec,
      explicit: resolveExplicitQuotaPluginSpec(params) !== null,
      guiFirst: params.guiFirst,
    }),
    quotaEdit,
  ];

  const quickSetupNotes = buildQuickSetupNotes(selections);
  const warnings = edits.flatMap((edit) => edit.warnings);

  const plan: InitInstallerPlan = {
    selections,
    baseDir,
    guiConfigDir,
    edits,
    warnings,
    quickSetupNotes,
    summaryLines: [],
  };
  plan.summaryLines = buildPlanSummary(plan);
  return plan;
}

export async function applyInitInstallerPlan(
  plan: InitInstallerPlan,
): Promise<ApplyInitInstallerPlanResult> {
  const writtenPaths: string[] = [];
  const unchangedPaths: string[] = [];

  // Re-check the canonical target immediately before apply so a symlink retarget cannot
  // redirect this write into upstream quota sources after planning.
  await Promise.all(
    plan.edits
      .filter((edit) => edit.kind === "quota")
      .map((edit) => assertGuiConfigTargetIsIndependent(edit.path, plan.guiConfigDir)),
  );

  try {
    await Promise.all(
      plan.edits.flatMap((edit) =>
        edit.documentEdit ? [validateConfigDocumentEdit(edit.documentEdit)] : [],
      ),
    );
  } catch (error) {
    const path =
      error && typeof error === "object" && "path" in error
        ? String((error as { path?: unknown }).path ?? "")
        : "";
    throw new InitInstallerError(`Config changed since preview${path ? `: ${path}` : "."}`, {
      path: path || undefined,
      writtenPaths,
    });
  }

  for (const edit of plan.edits) {
    if (!edit.changed || (!edit.nextData && !edit.documentEdit)) {
      unchangedPaths.push(edit.path);
      continue;
    }

    try {
      if (edit.documentEdit) {
        await applyConfigDocumentEdit(edit.documentEdit);
      } else {
        await writeConfiguredJsonAtomic(edit.path, edit.nextData, { trailingNewline: true });
      }
      writtenPaths.push(edit.path);
    } catch (error) {
      throw new InitInstallerError(`Failed writing ${edit.path}.`, {
        path: edit.path,
        writtenPaths,
      });
    }
  }

  return {
    writtenPaths,
    unchangedPaths,
  };
}

type ExistingInstallerAnswers = {
  configFormat?: ConfigFileFormat;
  quotaUi?: InitQuotaUiChoice[];
  providerMode?: InitProviderMode;
  manualProviders?: string[];
  formatStyle?: CanonicalQuotaFormatStyle;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  showSessionTokens?: boolean;
  sessionTokenScope?: SessionTokenScope;
  tuiCommandDisplay?: TuiCommandDisplay;
  maintainerAnnouncements?: boolean;
};

async function readExistingInstallerAnswers(params: {
  hostBaseDir: string;
  guiConfigDir: string;
}): Promise<ExistingInstallerAnswers> {
  const existingHostPath = ["opencode.jsonc", "opencode.json"]
    .map((name) => join(params.hostBaseDir, name))
    .find((path) => existsSync(path));
  const answers: ExistingInstallerAnswers = {
    // Host format only; the dashboard target is always canonical JSONC and the
    // dormant GUI sibling config.json is never a defaults source.
    configFormat: existingHostPath?.endsWith(".jsonc")
      ? "jsonc"
      : existingHostPath
        ? "json"
        : undefined,
  };
  const existingQuotaPath = getGuiConfigPath(params.guiConfigDir);
  if (!existsSync(existingQuotaPath)) return answers;

  const quotaToast = await readExistingConfig({
    path: existingQuotaPath,
    format: "jsonc",
  });
  const quotaUi: InitQuotaUiChoice[] = [];
  if (isPlainObject(quotaToast.tuiSidebarPanel) && quotaToast.tuiSidebarPanel.enabled === true) {
    quotaUi.push("sidebar");
  }
  if (quotaToast.enableToast === true) quotaUi.push("toast");
  if (isPlainObject(quotaToast.tuiCompactStatus) && quotaToast.tuiCompactStatus.enabled === true) {
    quotaUi.push("compact_status");
  }
  answers.quotaUi = quotaUi.length > 0 ? quotaUi : ["none"];

  if (quotaToast.enabledProviders === "auto") {
    answers.providerMode = "auto";
    answers.manualProviders = [];
  } else if (Array.isArray(quotaToast.enabledProviders)) {
    answers.providerMode = "manual";
    answers.manualProviders = quotaToast.enabledProviders.filter(
      (value): value is string =>
        typeof value === "string" &&
        QUOTA_PROVIDER_SHAPES.some((shape) => shape.id === normalizeQuotaProviderId(value)),
    );
  }
  if (isQuotaFormatStyle(quotaToast.formatStyle)) {
    answers.formatStyle = resolveQuotaFormatStyle(quotaToast.formatStyle);
  }
  if (quotaToast.percentDisplayMode === "remaining" || quotaToast.percentDisplayMode === "used") {
    answers.percentDisplayMode = quotaToast.percentDisplayMode;
  }
  if (typeof quotaToast.showSessionTokens === "boolean") {
    answers.showSessionTokens = quotaToast.showSessionTokens;
  }
  if (quotaToast.sessionTokenScope === "current" || quotaToast.sessionTokenScope === "tree") {
    answers.sessionTokenScope = quotaToast.sessionTokenScope;
  }
  if (quotaToast.tuiCommandDisplay === "inline" || quotaToast.tuiCommandDisplay === "dialog") {
    answers.tuiCommandDisplay = quotaToast.tuiCommandDisplay;
  }
  if (
    isPlainObject(quotaToast.maintainerAnnouncements) &&
    typeof quotaToast.maintainerAnnouncements.enabled === "boolean"
  ) {
    answers.maintainerAnnouncements = quotaToast.maintainerAnnouncements.enabled;
  }
  return answers;
}

async function promptForSelections(
  prompts: PromptAdapter,
  context: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    pluginSpec: string;
  },
): Promise<InitInstallerSelections | null> {
  const scope = await prompts.select({
    message: "Where should OpenCode Quota GUI be configured?",
    initialValue: "global",
    options: [
      {
        label: "Global OpenCode config (recommended)",
        value: "global",
        hint: "install for all projects using your global config",
      },
      { label: "Current project", value: "project", hint: "install only for this repo/worktree" },
    ],
  });
  if (prompts.isCancel(scope)) return null;

  const hostBaseDir = resolveInitInstallerBaseDir({
    scope: scope as InitInstallerScope,
    cwd: context.cwd,
    env: context.env,
    homeDir: context.homeDir,
  });
  const guiConfigDir = resolveInitInstallerBaseDir({
    scope: "global",
    env: context.env,
    homeDir: context.homeDir,
  });
  const existing = await readExistingInstallerAnswers({ hostBaseDir, guiConfigDir });

  const providerMode = await prompts.select({
    message: "How should pre-configured providers be selected?",
    initialValue: existing.providerMode ?? "auto",
    options: [
      {
        label: "Auto-detect providers",
        value: "auto",
        hint: "use providers found in your OpenCode configuration and authentication",
      },
      {
        label: "Choose providers manually",
        value: "manual",
        hint: "track only the pre-configured providers you select",
      },
    ],
  });
  if (prompts.isCancel(providerMode)) return null;

  let manualProviders: string[] = [];
  if (providerMode === "manual") {
    const selected = await prompts.multiselect({
      message: "Which pre-configured providers should be tracked?",
      required: true,
      initialValues: existing.manualProviders,
      options: getInstallerProviderPromptOptions(),
    });
    if (prompts.isCancel(selected)) return null;
    if (!Array.isArray(selected) || selected.length === 0) {
      throw new InitInstallerError("Manual provider mode requires at least one selected provider.");
    }
    manualProviders = selected.filter((value): value is string => typeof value === "string");
  }
  prompts.log.info("Custom providers are configured after installation.");

  const percentDisplayMode = await prompts.select({
    message: "What should quota percentages show?",
    initialValue: existing.percentDisplayMode ?? "remaining",
    options: [
      { label: "Remaining quota", value: "remaining", hint: "show how much quota is left" },
      { label: "Used quota", value: "used", hint: "show how much quota has been consumed" },
    ],
  });
  if (prompts.isCancel(percentDisplayMode)) return null;

  return {
    interfaces: "web",
    scope: scope as InitInstallerScope,
    quotaUi: ["none"],
    providerMode: providerMode as InitProviderMode,
    manualProviders,
    formatStyle: existing.formatStyle ?? "allWindows",
    percentDisplayMode: percentDisplayMode as QuotaToastConfig["percentDisplayMode"],
    showSessionTokens: existing.showSessionTokens ?? false,
    sessionTokenScope: existing.sessionTokenScope ?? "current",
    configFormat: existing.configFormat ?? "jsonc",
  };
}

export async function runInitInstaller(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  prompts?: PromptAdapter;
  dryRun?: boolean;
  pluginSpec?: string;
}): Promise<number> {
  const prompts = params?.prompts ?? ((await import("@clack/prompts")) as unknown as PromptAdapter);

  prompts.intro("Configure OpenCode Quota GUI");

  try {
    let openCodeMajor = await detectOpenCodeMajor();
    if (openCodeMajor === undefined) {
      const answer = await prompts.select({
        message: "Could not detect your OpenCode version. Which OpenCode do you use?",
        initialValue: "2",
        options: [
          { label: "OpenCode 2", value: "2", hint: "default" },
          { label: "OpenCode 1", value: "1" },
        ],
      });
      if (prompts.isCancel(answer)) {
        prompts.outro("OpenCode Quota setup cancelled — no files changed.");
        return 0;
      }
      openCodeMajor = answer === "1" ? 1 : 2;
    }
    if (openCodeMajor === 1) {
      prompts.log.error("You're on OpenCode 1. OpenCode Quota 5 needs OpenCode 2.");
      prompts.outro("OpenCode Quota GUI requires OpenCode 2 — no files changed.");
      return 1;
    }

    const pluginSpec = await resolveQuotaPluginSpec({
      pluginSpec: params?.pluginSpec,
      env: params?.env,
    });
    const selections = await promptForSelections(prompts, {
      cwd: params?.cwd,
      env: params?.env,
      homeDir: params?.homeDir,
      pluginSpec,
    });
    if (!selections) {
      prompts.outro("OpenCode Quota setup cancelled — no files changed.");
      return 0;
    }

    const plan = await planInitInstaller({
      selections,
      cwd: params?.cwd,
      env: params?.env,
      homeDir: params?.homeDir,
      pluginSpec: params?.pluginSpec,
      guiFirst: true,
    });

    if (
      plan.edits.some((edit) => {
        if (edit.kind !== "opencode" || !edit.documentEdit?.originalBytes) return false;
        const root = parseJsonOrJsonc(
          edit.documentEdit.originalBytes.toString("utf8"),
          edit.documentEdit.sourcePath.endsWith(".jsonc"),
        ) as JsonObject;
        if (isPlainObject(root.experimental) && isPlainObject(root.experimental.quotaToast))
          return true;
        return [root.plugin, root.plugins].some(
          (entries) =>
            Array.isArray(entries) &&
            entries.some((entry) => {
              const spec = getPluginSpecFromEntry(entry);
              return spec !== null && /^@slkiser\/opencode-quota(?:@[^/\\\s]+)?$/.test(spec);
            }),
        );
      })
    ) {
      prompts.log.info(
        "Legacy quota configuration detected. Only previewed changes will be applied; existing source settings are preserved.",
      );
    }
    prompts.log.info("Preview changes");
    for (const line of plan.summaryLines) {
      prompts.log.info(line);
    }

    if (!plan.edits.some((edit) => edit.changed)) {
      prompts.outro(
        `OpenCode Quota is already configured and current. No files changed. ${GITHUB_STAR_NOTE}`,
      );
      return 0;
    }

    if (params?.dryRun) {
      prompts.outro(
        `OpenCode Quota setup preview complete — no files changed. Run npx ${pluginSpec} init to apply.`,
      );
      return 0;
    }

    const confirmed = await prompts.confirm({
      message: "Apply changes?",
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || !confirmed) {
      prompts.outro("OpenCode Quota setup cancelled — no files changed.");
      return 0;
    }

    const result = await applyInitInstallerPlan(plan);
    for (const path of result.writtenPaths) {
      prompts.log.success(`Wrote ${path}`);
    }
    for (const path of result.unchangedPaths) {
      prompts.log.info(`Unchanged ${path}`);
    }

    if (plan.quickSetupNotes.length > 0) {
      prompts.log.info("Manual quick-setup still needed:");
      for (const note of plan.quickSetupNotes) {
        prompts.log.info(`- ${note.label}: docs/readme/providers.md#${note.anchor}`);
      }
    }

    const interfaceLabel =
      plan.selections.interfaces === "tui"
        ? "TUI"
        : plan.selections.interfaces === "web"
          ? "Web"
          : "TUI and Web";
    const configuredPaths = [...result.writtenPaths, ...result.unchangedPaths];
    const config = await loadConfig(undefined, undefined, {
      configRootDir: resolveInitInstallerBaseDir({ scope: "project", cwd: params?.cwd }),
      globalConfigDir: resolveInitInstallerBaseDir({
        scope: "global",
        env: params?.env,
        homeDir: params?.homeDir,
      }),
    });
    const dashboardUrl = `http://localhost:${config.dashboard?.port ?? DEFAULT_DASHBOARD_PORT}/quota`;
    const dashboardOutro =
      config.dashboard.enabled === true
        ? `Restart OpenCode, then open ${dashboardUrl}.`
        : `Web dashboard access is off by default. Add "dashboard": { "enabled": true } to the canonical config, then restart OpenCode and open ${dashboardUrl}.`;
    prompts.outro(
      [
        "OpenCode Quota setup complete.",
        `Interfaces: ${interfaceLabel}`,
        "Configured paths:",
        ...configuredPaths.map((path) => `- ${path}`),
        dashboardOutro,
        `If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`,
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    prompts.log.error(reason);
    const writtenPaths =
      error instanceof InitInstallerError ? (error.details?.writtenPaths ?? []) : [];
    if (writtenPaths.length > 0) {
      prompts.log.info(`Files changed before failure: ${writtenPaths.join(", ")}`);
      prompts.outro(
        "OpenCode Quota setup failed after some files changed. Review the listed files, fix the reason above, then rerun init.",
      );
    } else {
      prompts.outro(
        "OpenCode Quota setup failed before any files changed. Fix the reason above, then rerun init.",
      );
    }
    return 1;
  }
}
