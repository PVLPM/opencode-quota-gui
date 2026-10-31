import type { JsonValue, SettingsSnapshot, SettingsWriteResult } from "../contracts/dashboard";
import { isLegacyImportKey } from "../contracts/settings";
import type { DisplayPreferences } from "./components/quota-card";

/**
 * Settings model (design spec §5.4, §7, §10; R14, R15).
 *
 * One declarative table describes every GUI-exposed key: its group, control,
 * validation and whether `null` clears it. `null` is the only way to unset a
 * key — `0` and `false` are real values — and the port is read-only here because
 * changing it needs a restart. Anything not in this table is not editable, and
 * the page only offers what the server reports as writable.
 */

export type SettingsGroupId =
  | "wait"
  | "display"
  | "temporal"
  | "advanced"
  | "visibility"
  | "dashboard";

export interface SettingsGroupDescriptor {
  id: SettingsGroupId;
  title: string;
  note?: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroupDescriptor[] = [
  { id: "wait", title: "Wait for quota reset" },
  { id: "display", title: "Display" },
  {
    id: "temporal",
    title: "Temporal pricing",
    note: "Live peak and off-peak status. Discovered accounts start on; each switch keeps an explicit on or off choice.",
  },
  {
    id: "advanced",
    title: "Advanced",
    note: "Provider selection, polling intervals, and accounting detail.",
  },
  {
    id: "visibility",
    title: "Visibility",
    note: "Choose which cards and rows appear, and drag the grips to arrange your cards.",
  },
  { id: "dashboard", title: "Dashboard" },
];

export type SettingsControl =
  | "switch"
  | "select"
  | "number"
  | "integer"
  | "providers"
  | "windows"
  | "list"
  | "map"
  | "readonly";

export interface SettingsField {
  key: string;
  /** Derived from the shared v1 rule, never a second allowlist. */
  importable?: boolean;
  group: SettingsGroupId;
  control: SettingsControl;
  label: string;
  help?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  /** `null` clears the key in the canonical file. */
  clearable?: boolean;
  /**
   * A hidden field stays in the table for validation and patching but is never
   * rendered as a generic control (compatibility-only or dedicated UI).
   */
  hidden?: boolean;
  /**
   * The value a clearable switch writes when it is on. Without it a switch is a
   * plain boolean; with it the on-value is this string, which is what the plugin
   * stores (`quotaProjection: "runway"`).
   */
  onValue?: string;
}

/** Numbers follow the upstream `isPositiveNumber` semantics: finite and > 0, with no GUI floor. */
export function isPositiveNumberValue(value: JsonValue | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export const OPENCODE_GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;

function withImportEligibility(fields: SettingsField[]): readonly SettingsField[] {
  return fields.map((field) => ({ ...field, importable: isLegacyImportKey(field.key) }));
}

export const SETTINGS_FIELDS: readonly SettingsField[] = withImportEligibility([
  {
    key: "waitForQuotaReset",
    group: "wait",
    control: "switch",
    label: "Wait for quota reset",
    help: "Hold requests until the quota window resets instead of failing them.",
  },
  {
    key: "percentDisplayMode",
    group: "display",
    control: "select",
    label: "Percent shows",
    options: [
      { value: "remaining", label: "Remaining" },
      { value: "used", label: "Used" },
    ],
  },
  {
    key: "percentLabelStyle",
    group: "display",
    control: "select",
    label: "Label style",
    help: "Full includes used or remaining beside the percentage; bare shows only the number.",
    options: [
      { value: "full", label: "Full" },
      { value: "bare", label: "Bare" },
    ],
  },
  {
    key: "quotaProjection",
    hidden: true,
    group: "display",
    control: "switch",
    label: "Runway projection",
    help: "Show a runway sentence on quota rows when the plugin can project exhaustion.",
    clearable: true,
    onValue: "runway",
  },
  {
    key: "resetTimeDecimals",
    hidden: true,
    group: "display",
    control: "integer",
    label: "Countdown decimals",
    help: "0–4 decimal places on reset countdowns; clear to use the default.",
    min: 0,
    max: 4,
    clearable: true,
  },
  {
    key: "resetTimeSpaced",
    hidden: true,
    group: "display",
    control: "switch",
    label: "Space countdown units",
  },
  {
    key: "formatStyle",
    hidden: true,
    group: "display",
    control: "select",
    label: "Quota row style",
    help: "Affects toasts, TUI sidebar, and compact status only — not this page.",
    options: [
      { value: "singleWindow", label: "Single window" },
      { value: "allWindows", label: "All windows" },
    ],
  },
  {
    key: "enabledProviders",
    group: "advanced",
    control: "providers",
    label: "Providers",
    help: "Automatic selection, or an explicit list. An empty list enables no provider.",
  },
  {
    key: "minIntervalMs",
    group: "advanced",
    control: "number",
    label: "Minimum refresh interval (ms)",
    help: "Any finite value above zero; there is no extra dashboard floor.",
  },
  {
    key: "requestTimeoutMs",
    group: "advanced",
    control: "number",
    label: "Request timeout (ms)",
    help: "Any finite value above zero.",
  },
  {
    key: "accountingDetail",
    group: "advanced",
    control: "select",
    label: "Accounting detail",
    options: [
      { value: "summary", label: "Summary" },
      { value: "detailed", label: "Detailed" },
    ],
  },
  {
    key: "opencodeGoWindows",
    hidden: true,
    group: "advanced",
    control: "windows",
    label: "Go windows",
    help: "At least one of rolling, weekly, or monthly.",
  },
  {
    key: "opencodeMonthlyLimit",
    hidden: true,
    group: "advanced",
    control: "number",
    label: "Monthly limit",
    help: "A number of at least zero, or clear the key to leave it unset.",
    min: 0,
    clearable: true,
  },
  {
    key: "dashboard.hiddenCards",
    group: "visibility",
    control: "list",
    label: "Hidden cards",
  },
  {
    key: "dashboard.hiddenRows",
    group: "visibility",
    control: "list",
    label: "Hidden rows",
  },
  {
    key: "dashboard.cardOrder",
    group: "visibility",
    control: "list",
    label: "Card order",
    hidden: true,
  },
  {
    key: "dashboard.providerOrder",
    group: "visibility",
    control: "list",
    label: "Provider order",
    hidden: true,
  },
  {
    key: "dashboard.temporalProviderOverrides",
    group: "temporal",
    control: "map",
    label: "Temporal provider overrides",
    hidden: true,
  },
  {
    key: "dashboard.port",
    group: "dashboard",
    control: "readonly",
    label: "Port",
    help: "Changing the port needs a restart, so it is read-only here.",
    min: 1,
    max: 65535,
  },
]);

/** No path heuristics or fallback to the compatibility `sources` strings. */
export function settingProvenanceNote(
  snapshot: Pick<SettingsSnapshot, "provenance">,
  key: string,
): string | undefined {
  switch (snapshot.provenance?.[key]?.scope) {
    case "workspace":
      return "Workspace override";
    case "project":
      return "Project override";
    case "legacy":
      return "Legacy override";
    default:
      return undefined;
  }
}

/** Validates one value; `undefined` means the key is unset, which is valid for clearable fields. */
export function validateValue(
  field: SettingsField,
  value: JsonValue | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    if (field.control === "list" || field.control === "map") return undefined;
    return field.clearable ? undefined : `${field.label} needs a value.`;
  }
  switch (field.control) {
    case "switch": {
      // A plain switch is a boolean. A clearable switch stores its documented
      // on-value (`"runway"`) and is cleared with `null`, so both have to pass —
      // and a legacy boolean in the canonical file must not block the save.
      if (typeof value === "boolean") return undefined;
      if (field.clearable && field.onValue !== undefined) {
        return value === field.onValue
          ? undefined
          : `${field.label} takes ${field.onValue} or an empty value.`;
      }
      return `${field.label} takes true or false.`;
    }
    case "select":
      return typeof value === "string" && field.options?.some((option) => option.value === value)
        ? undefined
        : `Pick one of the listed ${field.label.toLowerCase()} values.`;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${field.label} takes a number.`;
      }
      if (field.min === undefined) {
        return isPositiveNumberValue(value)
          ? undefined
          : `${field.label} must be greater than zero.`;
      }
      return value < field.min ? `${field.label} must be at least ${field.min}.` : undefined;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${field.label} takes a whole number.`;
      }
      if (field.min !== undefined && value < field.min)
        return `${field.label} must be at least ${field.min}.`;
      if (field.max !== undefined && value > field.max)
        return `${field.label} must be at most ${field.max}.`;
      return undefined;
    }
    case "providers": {
      if (value === "auto") return undefined;
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || entry.trim() === "")
      ) {
        return "Provider ids must be a list of non-empty strings, or automatic.";
      }
      return undefined;
    }
    case "windows": {
      if (!Array.isArray(value) || value.length === 0) {
        return "Choose at least one window.";
      }
      return value.every(
        (entry) =>
          typeof entry === "string" && (OPENCODE_GO_WINDOWS as readonly string[]).includes(entry),
      )
        ? undefined
        : "Windows are limited to rolling, weekly, and monthly.";
    }
    case "list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? undefined
        : `${field.label} takes a list of ids.`;
    case "map":
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "boolean")
        ? undefined
        : `${field.label} takes provider ids mapped to true or false.`;
    default:
      return undefined;
  }
}

function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Normalizes a raw input string for a numeric field. */
export function parseNumberInput(raw: string): JsonValue | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function parseIntegerInput(raw: string): JsonValue | undefined {
  const value = parseNumberInput(raw);
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) ? value : Number.NaN;
}

/** Provider list editor value: automatic, or an explicit (possibly empty) list. */
export function providerSelection(value: JsonValue | undefined): {
  mode: "auto" | "manual";
  ids: string[];
} {
  if (value === "auto") return { mode: "auto", ids: [] };
  if (Array.isArray(value)) {
    return {
      mode: "manual",
      ids: value.filter((entry): entry is string => typeof entry === "string"),
    };
  }
  return { mode: "auto", ids: [] };
}

export function parseProviderIds(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function windowSelection(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && (OPENCODE_GO_WINDOWS as readonly string[]).includes(entry),
  );
}

export function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Sparse explicit provider choices; malformed entries are ignored. */
export function temporalProviderOverridesFromValue(
  value: JsonValue | undefined,
): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, boolean][] = [];
  for (const [providerId, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") entries.push([providerId, enabled]);
  }
  return Object.fromEntries(entries);
}

/** Labels are presentation only; ordering and toggles always use cardId. */
export function cardIdentityLabel(card: {
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
}): string {
  return [
    card.providerLabel,
    card.planLabel,
    card.accountLabel ? visibilityAccountLabel(card.providerLabel, card.accountLabel) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function toggleHiddenCard(hidden: readonly string[], cardId: string): string[] {
  return hidden.includes(cardId) ? hidden.filter((id) => id !== cardId) : [...hidden, cardId];
}

/** The identity metadata every Show needs; labels are never consulted. */
export interface HiddenCardIdentity {
  cardId: string;
  providerId: string;
  providerScopeHash?: string;
}

/** A provider group's markers, using catalog metadata and never labels. */
function providerGroupMarkers(
  selected: HiddenCardIdentity,
  catalog: readonly HiddenCardIdentity[],
): { sameProvider: HiddenCardIdentity[]; markers: Set<string> } {
  const sameProvider = catalog.filter((card) => card.providerId === selected.providerId);
  const markers = new Set<string>([selected.providerId]);
  for (const hash of [
    selected.providerScopeHash,
    ...sameProvider.map((card) => card.providerScopeHash),
  ]) {
    if (hash !== undefined) markers.add(hash);
  }
  return { sameProvider, markers };
}

/** True when a provider id or a catalog-authoritative bare scope hash hides the card. */
export function isInheritedProviderHidden(
  card: HiddenCardIdentity,
  hidden: ReadonlySet<string>,
  catalog: readonly HiddenCardIdentity[],
): boolean {
  const { markers } = providerGroupMarkers(card, catalog);
  return [...markers].some((marker) => hidden.has(marker));
}

/**
 * Shows one card. An exact version 2 hide is a plain removal. An inherited
 * provider-group hide (the provider id or an authoritative bare scope hash) is
 * converted to exact hides for every sibling the current catalog knows about.
 * Unrelated ids and other providers stay untouched; an account absent from the
 * catalog has no id to hide.
 */
export function showCardKeepingKnownSiblingsHidden(
  hidden: readonly string[],
  selected: HiddenCardIdentity,
  catalog: readonly HiddenCardIdentity[],
): string[] {
  const { sameProvider, markers } = providerGroupMarkers(selected, catalog);
  const inherited = hidden.some((id) => id !== selected.cardId && markers.has(id));
  const result = hidden.filter((id) => id !== selected.cardId && (!inherited || !markers.has(id)));
  if (!inherited) return result;

  const seen = new Set(result);
  for (const card of sameProvider) {
    if (card.cardId === selected.cardId || seen.has(card.cardId)) continue;
    seen.add(card.cardId);
    result.push(card.cardId);
  }
  return result;
}

/** Match Quota's exact generated-label cleanup; never infer a plan from free text. */
export function visibilityAccountLabel(provider: string, account: string): string {
  const prefix = `[${provider}] (`;
  if (account.startsWith(prefix) && account.endsWith(")")) {
    const label = account.slice(prefix.length, -1);
    if (label.length > 0 && !/[()[\]\r\n]/.test(label)) return label;
  }
  return account;
}

export function reorderedCardOrder(
  ids: readonly string[],
  fromId: string,
  toIndex: number,
): string[] {
  if (!ids.includes(fromId)) return [...ids];
  const without = ids.filter((id) => id !== fromId);
  without.splice(Math.max(0, Math.min(Math.trunc(toIndex), without.length)), 0, fromId);
  return without;
}

export function keyboardMovedCardOrder(
  ids: readonly string[],
  fromId: string,
  step: -1 | 1,
): string[] {
  return reorderedCardOrder(
    ids,
    fromId,
    Math.max(0, Math.min(ids.indexOf(fromId) + step, ids.length - 1)),
  );
}

/** Display preferences the Home and Project views read from the settings snapshot. */
export function displayPreferencesFromValues(
  values: Record<string, JsonValue>,
): DisplayPreferences {
  const percentMode = values.percentDisplayMode === "used" ? "used" : "remaining";
  const cardOrder = stringList(values["dashboard.cardOrder"]);
  const providerOrder = stringList(values["dashboard.providerOrder"]);
  const temporalProviderOverrides = temporalProviderOverridesFromValue(
    values["dashboard.temporalProviderOverrides"],
  );
  return {
    percentMode,
    percentLabelStyle: values.percentLabelStyle === "bare" ? "bare" : "full",
    showRunway: values.quotaProjection === "runway",
    detailed: values.accountingDetail === "detailed",
    // Absent and empty mean the same thing; omitting them keeps the shape the
    // view already had when neither order was configured.
    ...(cardOrder.length > 0 ? { cardOrder } : {}),
    ...(providerOrder.length > 0 ? { providerOrder } : {}),
    ...(Object.keys(temporalProviderOverrides).length > 0 ? { temporalProviderOverrides } : {}),
  };
}

export interface SettingsDraft {
  /** Key → value; `undefined` means "clear this key with null". */
  edits: Record<string, JsonValue | undefined>;
  revision: string;
  /** Set when a write hit `config-changed`: the edits are kept, the revision is refreshed. */
  conflict: boolean;
}

export function initialDraft(revision: string): SettingsDraft {
  return { edits: {}, revision, conflict: false };
}

export function setEdit(
  draft: SettingsDraft,
  key: string,
  value: JsonValue | undefined,
): SettingsDraft {
  return { ...draft, edits: { ...draft.edits, [key]: value } };
}

/** Dirty keys are writable keys whose edited value differs from the snapshot. */
export function dirtyKeys(
  draft: SettingsDraft,
  values: Record<string, JsonValue>,
  writable: readonly string[],
): string[] {
  return Object.keys(draft.edits)
    .filter((key) => writable.includes(key))
    .filter((key) => !sameValue(draft.edits[key], values[key]))
    .sort();
}

export function fieldErrors(
  draft: SettingsDraft,
  fields: readonly SettingsField[],
): { key: string; message: string }[] {
  return fields.flatMap((field) => {
    if (!(field.key in draft.edits)) return [];
    const message = validateValue(field, draft.edits[field.key]);
    return message === undefined ? [] : [{ key: field.key, message }];
  });
}

/** The request patch: a cleared key travels as `null`, everything else as its value. */
export function toPatch(
  draft: SettingsDraft,
  dirtyList: readonly string[],
): Record<string, JsonValue> {
  const patch: Record<string, JsonValue> = {};
  for (const key of dirtyList) {
    const value = draft.edits[key];
    patch[key] = value === undefined ? null : value;
  }
  return patch;
}

/** After a successful write every edit is committed to the new revision. */
export function applyWriteResult(result: SettingsWriteResult): SettingsDraft {
  return { edits: {}, revision: result.revision, conflict: false };
}

/** A 409 keeps the user's edits and adopts the revision the server reported. */
export function applyConflict(draft: SettingsDraft, freshRevision: string): SettingsDraft {
  return { edits: draft.edits, revision: freshRevision, conflict: true };
}

export function clearConflict(draft: SettingsDraft): SettingsDraft {
  return { ...draft, conflict: false };
}
