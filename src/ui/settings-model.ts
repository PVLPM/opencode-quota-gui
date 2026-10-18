import type { JsonValue, SettingsWriteResult } from "../contracts/dashboard";
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

export type SettingsGroupId = "wait" | "display" | "advanced" | "visibility" | "dashboard";

export interface SettingsGroupDescriptor {
  id: SettingsGroupId;
  title: string;
  note?: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroupDescriptor[] = [
  { id: "wait", title: "Wait for quota reset" },
  { id: "display", title: "Display" },
  {
    id: "advanced",
    title: "Advanced",
    note: "Provider selection, polling intervals, and accounting detail.",
  },
  {
    id: "visibility",
    title: "Visible cards and rows",
    note: "Presentation only: hiding a card or row never changes what the dashboard polls or fetches.",
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
  | "readonly";

export interface SettingsField {
  key: string;
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

export const SETTINGS_FIELDS: readonly SettingsField[] = [
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
    options: [
      { value: "full", label: "Full" },
      { value: "bare", label: "Bare" },
    ],
  },
  {
    key: "quotaProjection",
    group: "display",
    control: "switch",
    label: "Runway projection",
    help: "Show a runway sentence on quota rows when the plugin can project exhaustion.",
    clearable: true,
    onValue: "runway",
  },
  {
    key: "resetTimeDecimals",
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
    group: "display",
    control: "switch",
    label: "Space countdown units",
  },
  {
    key: "formatStyle",
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
    group: "advanced",
    control: "windows",
    label: "OpenCode Go windows",
    help: "At least one of rolling, weekly, or monthly.",
  },
  {
    key: "opencodeMonthlyLimit",
    group: "advanced",
    control: "number",
    label: "OpenCode monthly limit",
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
    key: "dashboard.port",
    group: "dashboard",
    control: "readonly",
    label: "Port",
    help: "Changing the port needs a restart, so it is read-only here.",
    min: 1,
    max: 65535,
  },
];

/** Validates one value; `undefined` means the key is unset, which is valid for clearable fields. */
export function validateValue(
  field: SettingsField,
  value: JsonValue | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    if (field.control === "list") return undefined;
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

/** Display preferences the Home and Project views read from the settings snapshot. */
export function displayPreferencesFromValues(
  values: Record<string, JsonValue>,
): DisplayPreferences {
  const percentMode = values.percentDisplayMode === "used" ? "used" : "remaining";
  return {
    percentMode,
    showRunway: values.quotaProjection === "runway",
    detailed: values.accountingDetail === "detailed",
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
