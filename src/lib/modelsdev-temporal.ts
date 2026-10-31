import { readFileSync } from "node:fs";

/**
 * Narrow runtime for the temporal subset of models.dev schema v2 pricing.
 *
 * Supported condition keys: `utc_hours`, `utc_days`, `holiday`, recursively
 * combined with `all`, `any` and `not`. Supported effects: `cost.text.input`
 * / `cost.text.output` overrides and `cost.multipliers`. Anything else is
 * unsupported and fails closed (`rates: null`).
 *
 * Monetary only: this module never reads or changes quota points (for example
 * Z.ai quota accounting). Callers pass the already-resolved base token rates.
 *
 * `utc_hours` is a same-UTC-day minute window. In particular, `gte: "14:00"`
 * covers 14:00 through 23:59:59.999 UTC and does not wrap into the next day.
 *
 * `holiday` uses the authoritative civil calendar of the jurisdiction (CN uses
 * Asia/Shanghai, fixed UTC+8). A year without a bundled calendar is unresolved,
 * never assumed to be a non-holiday.
 */

const BUNDLED_SNAPSHOT_URL = new URL("../data/modelsdev-temporal.min.json", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const CN_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_TRANSITION_HORIZON_MS = 5 * 366 * DAY_MS;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SOURCE_PREFIX = "https://github.com/anomalyco/models.dev/tree/";

type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type TemporalDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const TEMPORAL_DAYS: readonly TemporalDay[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

export type TemporalHoliday = "CN" | "US" | "CA";
export const TEMPORAL_HOLIDAYS: readonly TemporalHoliday[] = ["CN", "US", "CA"];

export type TemporalComparator = "equals" | "in" | "gt" | "gte" | "lt" | "lte";

export type TemporalCondition =
  | { type: "all"; of: TemporalCondition[] }
  | { type: "any"; of: TemporalCondition[] }
  | { type: "not"; of: TemporalCondition }
  | { type: "utc_hours"; op: TemporalComparator; value: string | string[] }
  | { type: "utc_days"; op: "equals" | "in"; value: TemporalDay | TemporalDay[] }
  | { type: "holiday"; op: "equals" | "in"; value: TemporalHoliday | TemporalHoliday[] };

export type TemporalRateKey = "input" | "output" | "cache_read" | "cache_write" | "reasoning";
export const TEMPORAL_RATE_KEYS: readonly TemporalRateKey[] = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
];

export type TemporalRates = Partial<Record<TemporalRateKey, number>>;

export type TemporalOverride = {
  id: string;
  field: "input" | "output";
  when: TemporalCondition;
  rates: TemporalRates;
};

export type TemporalMultiplier = {
  id: string;
  when: TemporalCondition;
  factor: number | { text: number };
};

export type TemporalPolicyEntry =
  | {
      status: "supported";
      source: string;
      overrides: TemporalOverride[];
      multipliers: TemporalMultiplier[];
    }
  | {
      status: "unsupported";
      source: string;
      reason: string;
    };

export type TemporalHolidayInterval = {
  id: string;
  /** Inclusive civil date in the jurisdiction's time zone. */
  localStart: string;
  /** Exclusive civil date in the jurisdiction's time zone. */
  localEnd: string;
  /** Exact UTC instant of localStart at 00:00. */
  startMs: number;
  /** Exact UTC instant of localEnd at 00:00. */
  endMs: number;
};

export type TemporalHolidayYear = {
  timeZone: string;
  source: string;
  published: string;
  intervals: TemporalHolidayInterval[];
  makeupWorkdays: string[];
};

export type TemporalSnapshot = {
  version: 1;
  revision: string;
  source: string;
  generatedAt: number;
  jurisdictions: Record<string, Record<string, TemporalHolidayYear>>;
  providers: Record<string, Record<string, TemporalPolicyEntry>>;
};

export type TemporalStatus = "resolved" | "unresolved" | "unsupported";

export type TemporalConditionEvaluation = {
  status: TemporalStatus;
  value: boolean | null;
  reason?: string;
};

export type TemporalInstantState = {
  status: TemporalStatus;
  activeRuleIds: string[];
  reason?: string;
};

export type TemporalRateResolution = {
  status: TemporalStatus;
  rates: TemporalRates | null;
  appliedRuleIds: string[];
  reason?: string;
};

export type TemporalTransition = {
  atMs: number;
  before: TemporalInstantState;
  after: TemporalInstantState;
};

export type TemporalInterval = {
  startMs: number;
  endMs: number;
  status: TemporalStatus;
  activeRuleIds: string[];
  rates: TemporalRates | null;
  reason?: string;
};

export class TemporalSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalSnapshotValidationError";
  }
}

const EMPTY_SNAPSHOT: TemporalSnapshot = {
  version: 1,
  revision: "",
  source: "",
  generatedAt: 0,
  jurisdictions: {},
  providers: {},
};

const HOUR_OPERATORS = new Set<TemporalComparator>(["equals", "in", "gt", "gte", "lt", "lte"]);
const CHOICE_OPERATORS = new Set(["equals", "in"]);
const SNAPSHOT_KEYS = new Set([
  "version",
  "revision",
  "source",
  "generatedAt",
  "jurisdictions",
  "providers",
]);
const POLICY_KEYS = new Set(["status", "source", "overrides", "multipliers", "reason"]);
const CALENDAR_KEYS = new Set(["timeZone", "source", "published", "intervals", "makeupWorkdays"]);
const INTERVAL_KEYS = new Set(["id", "localStart", "localEnd", "startMs", "endMs"]);
const OVERRIDE_KEYS = new Set(["id", "field", "when", "rates"]);
const MULTIPLIER_KEYS = new Set(["id", "when", "factor"]);

let SNAPSHOT: TemporalSnapshot | null = null;
let VALIDATION_ERROR: string | null = null;

function fail(message: string): never {
  throw new TemporalSnapshotValidationError(message);
}

function asObject(value: JsonValue, path: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${path} must be an object`);
  }
  return value;
}

function asArray(value: JsonValue, path: string): JsonValue[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function asString(value: JsonValue, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function asFiniteNumber(value: JsonValue, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function asRate(value: JsonValue, path: string): number {
  const rate = asFiniteNumber(value, path);
  if (rate < 0) fail(`${path} must not be negative`);
  return rate;
}

function assertKeys(object: JsonObject, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not supported`);
  }
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort(compareText)) {
    sorted[key] = record[key];
  }
  return sorted;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function clockMinutes(clock: string, path: string): number {
  if (!CLOCK_PATTERN.test(clock)) fail(`${path} must be a UTC clock HH:MM`);
  const [hours, minutes] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function civilDateMs(date: string, path: string): number {
  if (!DATE_PATTERN.test(date)) fail(`${path} must be a date YYYY-MM-DD`);
  const parsed = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(parsed)) fail(`${path} is not a valid calendar date`);
  const roundTrip = new Date(parsed + CN_UTC_OFFSET_MS).toISOString().slice(0, 10);
  if (roundTrip !== date) fail(`${path} is not a valid calendar date`);
  return parsed;
}

function validateProviderId(providerId: string, path: string): void {
  if (
    providerId.length === 0 ||
    providerId.includes("/") ||
    providerId.includes("\\") ||
    providerId === "." ||
    providerId === ".."
  ) {
    fail(`${path} must be an exact provider id`);
  }
}

function validateModelId(modelId: string, path: string): void {
  const segments = modelId.split("/");
  if (
    modelId.length === 0 ||
    modelId.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(`${path} must be an exact model id`);
  }
}

function conditionRank(condition: TemporalCondition): number {
  switch (condition.type) {
    case "utc_days":
      return 0;
    case "utc_hours":
      return 1;
    case "holiday":
      return 2;
    case "not":
      return 3;
    case "all":
      return 4;
    case "any":
      return 5;
  }
}

function canonicalConditions(conditions: TemporalCondition[]): TemporalCondition[] {
  return [...conditions].sort((a, b) => {
    const rank = conditionRank(a) - conditionRank(b);
    if (rank !== 0) return rank;
    return JSON.stringify(a) === JSON.stringify(b)
      ? 0
      : compareText(JSON.stringify(a), JSON.stringify(b));
  });
}

function validateChoiceAst<T extends string>(
  raw: JsonValue,
  allowed: readonly T[],
  path: string,
  type: "utc_days" | "holiday",
): Extract<TemporalCondition, { type: "utc_days" | "holiday" }> {
  const object = asObject(raw, path);
  assertKeys(object, new Set(["type", "op", "value"]), path);
  const op = asString(object.op, `${path}.op`);
  if (!CHOICE_OPERATORS.has(op)) {
    fail(`${path}.op must be equals or in`);
  }
  if (op === "equals") {
    const value = asString(object.value, `${path}.value`);
    if (!allowed.includes(value as T)) fail(`${path}.value is not a supported value`);
    return { type, op: "equals", value: value as T } as Extract<
      TemporalCondition,
      { type: "utc_days" | "holiday" }
    >;
  }
  const values = asArray(object.value, `${path}.value`);
  if (values.length === 0) fail(`${path}.value must not be empty`);
  const parsed: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = asString(values[index], `${path}.value[${index}]`);
    if (!allowed.includes(value as T)) {
      fail(`${path}.value[${index}] is not a supported value`);
    }
    parsed.push(value as T);
  }
  return { type, op: "in", value: sortStrings(parsed) as T[] } as Extract<
    TemporalCondition,
    { type: "utc_days" | "holiday" }
  >;
}

function validateHoursAst(raw: JsonValue, path: string): TemporalCondition {
  const object = asObject(raw, path);
  assertKeys(object, new Set(["type", "op", "value"]), path);
  const op = asString(object.op, `${path}.op`) as TemporalComparator;
  if (!HOUR_OPERATORS.has(op)) fail(`${path}.op is not a supported UTC hour operator`);
  if (op === "in") {
    const values = asArray(object.value, `${path}.value`);
    if (values.length === 0) fail(`${path}.value must not be empty`);
    const parsed: string[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = asString(values[index], `${path}.value[${index}]`);
      clockMinutes(value, `${path}.value[${index}]`);
      parsed.push(value);
    }
    return { type: "utc_hours", op, value: sortStrings(parsed) };
  }
  const value = asString(object.value, `${path}.value`);
  clockMinutes(value, `${path}.value`);
  return { type: "utc_hours", op, value };
}

function validateConditionAst(raw: JsonValue, path: string, depth = 0): TemporalCondition {
  if (depth > 8) fail(`${path} is nested too deeply`);
  const object = asObject(raw, path);
  const type = asString(object.type, `${path}.type`);
  switch (type) {
    case "all":
    case "any": {
      assertKeys(object, new Set(["type", "of"]), path);
      const values = asArray(object.of, `${path}.of`);
      if (values.length === 0) fail(`${path}.of must not be empty`);
      return {
        type,
        of: canonicalConditions(
          values.map((value, index) =>
            validateConditionAst(value, `${path}.of[${index}]`, depth + 1),
          ),
        ),
      };
    }
    case "not":
      assertKeys(object, new Set(["type", "of"]), path);
      return {
        type: "not",
        of: validateConditionAst(object.of, `${path}.of`, depth + 1),
      };
    case "utc_hours":
      return validateHoursAst(object, path);
    case "utc_days":
      return validateChoiceAst(object, TEMPORAL_DAYS, path, "utc_days");
    case "holiday":
      return validateChoiceAst(object, TEMPORAL_HOLIDAYS, path, "holiday");
    default:
      return fail(`${path}.type is not supported`);
  }
}

function parseRates(raw: JsonValue, field: "input" | "output", path: string): TemporalRates {
  const object = asObject(raw, path);
  const allowed = new Set<TemporalRateKey>(
    field === "input" ? ["input", "cache_read", "cache_write"] : ["output", "reasoning"],
  );
  const rates: TemporalRates = {};
  for (const [key, value] of Object.entries(object)) {
    if (!allowed.has(key as TemporalRateKey)) fail(`${path}.${key} is not supported`);
    rates[key as TemporalRateKey] = asRate(value, `${path}.${key}`);
  }
  if (Object.keys(rates).length === 0) fail(`${path} must set at least one rate`);
  return rates;
}

function parseMultiplierFactor(raw: JsonValue, path: string): number | { text: number } {
  if (typeof raw === "number") {
    return asRate(raw, path);
  }
  const object = asObject(raw, path);
  assertKeys(object, new Set(["text"]), path);
  if (!hasOwn(object, "text")) fail(`${path} must contain text`);
  return { text: asRate(object.text, `${path}.text`) };
}

function parsePolicyEntry(
  raw: JsonValue,
  providerId: string,
  modelId: string,
  path: string,
): TemporalPolicyEntry {
  const object = asObject(raw, path);
  assertKeys(object, POLICY_KEYS, path);
  const status = asString(object.status, `${path}.status`);
  const source = asString(object.source, `${path}.source`);
  const expectedSource = `providers/${providerId}/models/${modelId}.toml`;
  if (source !== expectedSource) {
    fail(`${path}.source must be the exact route ${expectedSource}`);
  }
  if (status === "unsupported") {
    return {
      status: "unsupported",
      source,
      reason: asString(object.reason, `${path}.reason`),
    };
  }
  if (status !== "supported") fail(`${path}.status is not supported`);

  const rawOverrides = asArray(object.overrides, `${path}.overrides`);
  const rawMultipliers = asArray(object.multipliers, `${path}.multipliers`);
  if (rawOverrides.length === 0 && rawMultipliers.length === 0) {
    fail(`${path} must contain at least one temporal rule`);
  }

  const ids = new Set<string>();
  const overrides: TemporalOverride[] = rawOverrides.map((rawOverride, index) => {
    const overridePath = `${path}.overrides[${index}]`;
    const override = asObject(rawOverride, overridePath);
    assertKeys(override, OVERRIDE_KEYS, overridePath);
    const id = asString(override.id, `${overridePath}.id`);
    if (ids.has(id)) fail(`${overridePath}.id duplicates ${id}`);
    ids.add(id);
    const field = asString(override.field, `${overridePath}.field`);
    if (field !== "input" && field !== "output") fail(`${overridePath}.field is not supported`);
    return {
      id,
      field,
      when: validateConditionAst(override.when, `${overridePath}.when`),
      rates: parseRates(override.rates, field, `${overridePath}.rates`),
    };
  });

  const multipliers: TemporalMultiplier[] = rawMultipliers.map((rawMultiplier, index) => {
    const multiplierPath = `${path}.multipliers[${index}]`;
    const multiplier = asObject(rawMultiplier, multiplierPath);
    assertKeys(multiplier, MULTIPLIER_KEYS, multiplierPath);
    const id = asString(multiplier.id, `${multiplierPath}.id`);
    if (ids.has(id)) fail(`${multiplierPath}.id duplicates ${id}`);
    ids.add(id);
    return {
      id,
      when: validateConditionAst(multiplier.when, `${multiplierPath}.when`),
      factor: parseMultiplierFactor(multiplier.factor, `${multiplierPath}.factor`),
    };
  });

  return { status: "supported", source, overrides, multipliers };
}

function parseHolidayCalendar(raw: JsonValue, path: string): TemporalHolidayYear {
  const object = asObject(raw, path);
  assertKeys(object, CALENDAR_KEYS, path);
  const timeZone = asString(object.timeZone, `${path}.timeZone`);
  if (timeZone !== "Asia/Shanghai") fail(`${path}.timeZone is not supported`);
  const source = asString(object.source, `${path}.source`);
  const published = asString(object.published, `${path}.published`);
  civilDateMs(published, `${path}.published`);

  const rawIntervals = asArray(object.intervals, `${path}.intervals`);
  if (rawIntervals.length === 0) fail(`${path}.intervals must not be empty`);
  const ids = new Set<string>();
  const intervals: TemporalHolidayInterval[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < rawIntervals.length; index += 1) {
    const intervalPath = `${path}.intervals[${index}]`;
    const interval = asObject(rawIntervals[index], intervalPath);
    assertKeys(interval, INTERVAL_KEYS, intervalPath);
    const id = asString(interval.id, `${intervalPath}.id`);
    if (ids.has(id)) fail(`${intervalPath}.id duplicates ${id}`);
    ids.add(id);
    const localStart = asString(interval.localStart, `${intervalPath}.localStart`);
    const localEnd = asString(interval.localEnd, `${intervalPath}.localEnd`);
    const startMs = asFiniteNumber(interval.startMs, `${intervalPath}.startMs`);
    const endMs = asFiniteNumber(interval.endMs, `${intervalPath}.endMs`);
    const expectedStart = civilDateMs(localStart, `${intervalPath}.localStart`);
    const expectedEnd = civilDateMs(localEnd, `${intervalPath}.localEnd`);
    if (startMs !== expectedStart || endMs !== expectedEnd) {
      fail(`${intervalPath} boundary must match Asia/Shanghai midnight`);
    }
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
      fail(`${intervalPath} must be a positive half-open interval`);
    }
    if (startMs < previousEnd) fail(`${path}.intervals must be sorted and non-overlapping`);
    previousEnd = endMs;
    intervals.push({ id, localStart, localEnd, startMs, endMs });
  }

  const makeupWorkdays = asArray(object.makeupWorkdays, `${path}.makeupWorkdays`).map(
    (value, index) => {
      const date = asString(value, `${path}.makeupWorkdays[${index}]`);
      civilDateMs(date, `${path}.makeupWorkdays[${index}]`);
      return date;
    },
  );
  const sortedWorkdays = sortStrings(makeupWorkdays);
  if (sortedWorkdays.join(",") !== makeupWorkdays.join(",")) {
    fail(`${path}.makeupWorkdays must be sorted and unique`);
  }
  for (const date of makeupWorkdays) {
    const instant = civilDateMs(date, `${path}.makeupWorkdays`);
    if (intervals.some((interval) => instant >= interval.startMs && instant < interval.endMs)) {
      fail(`${path}.makeupWorkdays must not fall inside a holiday interval`);
    }
  }

  return { timeZone, source, published, intervals, makeupWorkdays };
}

function parseJurisdictions(raw: JsonValue): Record<string, Record<string, TemporalHolidayYear>> {
  const object = asObject(raw, "snapshot.jurisdictions");
  const jurisdictions: Record<string, Record<string, TemporalHolidayYear>> = {};
  for (const [jurisdiction, rawYears] of Object.entries(object)) {
    if (!TEMPORAL_HOLIDAYS.includes(jurisdiction as TemporalHoliday)) {
      fail(`snapshot.jurisdictions.${jurisdiction} is not supported`);
    }
    const yearsObject = asObject(rawYears, `snapshot.jurisdictions.${jurisdiction}`);
    const years: Record<string, TemporalHolidayYear> = {};
    for (const [year, rawCalendar] of Object.entries(yearsObject)) {
      if (!/^\d{4}$/.test(year)) fail(`snapshot.jurisdictions.${jurisdiction}.${year} is invalid`);
      years[year] = parseHolidayCalendar(
        rawCalendar,
        `snapshot.jurisdictions.${jurisdiction}.${year}`,
      );
    }
    jurisdictions[jurisdiction] = sortRecord(years);
  }
  const cn = jurisdictions.CN;
  if (!cn || !cn["2026"]) fail("snapshot must bundle the authoritative CN 2026 calendar");
  return sortRecord(jurisdictions);
}

function parseProviders(raw: JsonValue): Record<string, Record<string, TemporalPolicyEntry>> {
  const object = asObject(raw, "snapshot.providers");
  const providers: Record<string, Record<string, TemporalPolicyEntry>> = {};
  for (const [providerId, rawModels] of Object.entries(object)) {
    validateProviderId(providerId, `snapshot.providers.${providerId}`);
    const modelsObject = asObject(rawModels, `snapshot.providers.${providerId}`);
    const models: Record<string, TemporalPolicyEntry> = {};
    for (const [modelId, rawPolicy] of Object.entries(modelsObject)) {
      validateModelId(modelId, `snapshot.providers.${providerId}.${modelId}`);
      models[modelId] = parsePolicyEntry(
        rawPolicy,
        providerId,
        modelId,
        `snapshot.providers.${providerId}.${modelId}`,
      );
    }
    providers[providerId] = sortRecord(models);
  }
  return sortRecord(providers);
}

export function normalizeTemporalSnapshot(raw: JsonValue): TemporalSnapshot {
  const object = asObject(raw, "snapshot");
  assertKeys(object, SNAPSHOT_KEYS, "snapshot");
  const version = asFiniteNumber(object.version, "snapshot.version");
  if (version !== 1) fail("snapshot.version must be 1");
  const revision = asString(object.revision, "snapshot.revision");
  if (!REVISION_PATTERN.test(revision)) fail("snapshot.revision must be a full git revision");
  const source = asString(object.source, "snapshot.source");
  if (source !== `${SOURCE_PREFIX}${revision}`) {
    fail("snapshot.source must retain the exact pinned revision");
  }
  const generatedAt = asFiniteNumber(object.generatedAt, "snapshot.generatedAt");
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) {
    fail("snapshot.generatedAt must be a positive safe integer");
  }
  const jurisdictions = parseJurisdictions(object.jurisdictions);
  const providers = parseProviders(object.providers);
  return {
    version: 1,
    revision,
    source,
    generatedAt,
    jurisdictions,
    providers,
  };
}

function ensureSnapshot(): TemporalSnapshot {
  if (SNAPSHOT) return SNAPSHOT;
  try {
    const raw = JSON.parse(readFileSync(BUNDLED_SNAPSHOT_URL, "utf-8"));
    SNAPSHOT = normalizeTemporalSnapshot(raw);
  } catch (error) {
    VALIDATION_ERROR =
      error instanceof Error ? error.message : "modelsdev temporal snapshot is invalid";
    SNAPSHOT = EMPTY_SNAPSHOT;
  }
  return SNAPSHOT;
}

export function setTemporalSnapshotForTests(snapshot: TemporalSnapshot): void {
  SNAPSHOT = normalizeTemporalSnapshot(snapshot);
  VALIDATION_ERROR = null;
}

export function __resetTemporalSnapshotForTests(): void {
  SNAPSHOT = null;
  VALIDATION_ERROR = null;
}

export function getTemporalSnapshotMeta(): Pick<
  TemporalSnapshot,
  "revision" | "source" | "generatedAt"
> {
  const snapshot = ensureSnapshot();
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
  };
}

/** Returns the bundled-snapshot validation error, or null when it loaded cleanly. */
export function getTemporalSnapshotValidationError(): string | null {
  ensureSnapshot();
  return VALIDATION_ERROR;
}

/** Exact provider/model temporal policy, or null when the model has none. */
export function getTemporalPolicy(providerId: string, modelId: string): TemporalPolicyEntry | null {
  return ensureSnapshot().providers[providerId]?.[modelId] ?? null;
}

export function hasTemporalPolicy(providerId: string, modelId: string): boolean {
  return getTemporalPolicy(providerId, modelId) !== null;
}

function utcMinuteOfDay(atMs: number): number {
  const date = new Date(atMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function utcDayOfWeek(atMs: number): TemporalDay {
  const index = new Date(atMs).getUTCDay();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][index] as TemporalDay;
}

function compareClock(minute: number, op: TemporalComparator, value: string): boolean {
  const target = clockMinutes(value, "utc_hours");
  switch (op) {
    case "equals":
      return minute === target;
    case "gt":
      return minute > target;
    case "gte":
      return minute >= target;
    case "lt":
      return minute < target;
    case "lte":
      return minute <= target;
    case "in":
      return false;
  }
}

function matchChoice<T extends string>(value: T, op: "equals" | "in", expected: T | T[]): boolean {
  if (op === "equals") {
    return typeof expected === "string" && value === expected;
  }
  return Array.isArray(expected) && expected.includes(value);
}

function resolved(value: boolean): TemporalConditionEvaluation {
  return { status: "resolved", value };
}

function unresolved(reason: string): TemporalConditionEvaluation {
  return { status: "unresolved", value: null, reason };
}

function unsupported(reason: string): TemporalConditionEvaluation {
  return { status: "unsupported", value: null, reason };
}

function localCivilYear(atMs: number): number {
  return new Date(atMs + CN_UTC_OFFSET_MS).getUTCFullYear();
}

function evaluateHolidayValue(holiday: TemporalHoliday, atMs: number): TemporalConditionEvaluation {
  const snapshot = ensureSnapshot();
  const year = localCivilYear(atMs);
  const calendar = snapshot.jurisdictions[holiday]?.[String(year)];
  if (!calendar) {
    return unresolved(`${holiday} public holiday calendar for ${year} is unavailable`);
  }
  const active = calendar.intervals.some(
    (interval) => atMs >= interval.startMs && atMs < interval.endMs,
  );
  return resolved(active);
}

function orEvaluations(evaluations: TemporalConditionEvaluation[]): TemporalConditionEvaluation {
  if (evaluations.some((evaluation) => evaluation.status === "resolved" && evaluation.value)) {
    return resolved(true);
  }
  const unknown = evaluations.find((evaluation) => evaluation.status === "unresolved");
  if (unknown) return unresolved(unknown.reason ?? "temporal condition is unresolved");
  const bad = evaluations.find((evaluation) => evaluation.status === "unsupported");
  if (bad) return unsupported(bad.reason ?? "temporal condition is unsupported");
  return resolved(false);
}

export function evaluateTemporalCondition(
  condition: TemporalCondition,
  atMs: number,
): TemporalConditionEvaluation {
  if (!Number.isFinite(atMs)) fail("atMs must be a finite epoch millisecond");
  switch (condition.type) {
    case "all": {
      const evaluations = condition.of.map((child) => evaluateTemporalCondition(child, atMs));
      const bad = evaluations.find((evaluation) => evaluation.status === "unsupported");
      if (bad) return bad;
      if (evaluations.some((evaluation) => evaluation.status === "resolved" && !evaluation.value)) {
        return resolved(false);
      }
      const unknown = evaluations.find((evaluation) => evaluation.status === "unresolved");
      if (unknown) return unresolved(unknown.reason ?? "temporal condition is unresolved");
      return resolved(true);
    }
    case "any":
      return orEvaluations(condition.of.map((child) => evaluateTemporalCondition(child, atMs)));
    case "not": {
      const evaluation = evaluateTemporalCondition(condition.of, atMs);
      if (evaluation.status !== "resolved" || evaluation.value === null) return evaluation;
      return resolved(!evaluation.value);
    }
    case "utc_hours": {
      const minute = utcMinuteOfDay(atMs);
      if (condition.op === "in") {
        const values = Array.isArray(condition.value) ? condition.value : [];
        return resolved(values.some((value) => minute === clockMinutes(value, "utc_hours")));
      }
      return resolved(compareClock(minute, condition.op, condition.value as string));
    }
    case "utc_days":
      return resolved(
        matchChoice(
          utcDayOfWeek(atMs),
          condition.op,
          condition.value as TemporalDay | TemporalDay[],
        ),
      );
    case "holiday": {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      return orEvaluations(values.map((value) => evaluateHolidayValue(value, atMs)));
    }
  }
}

function copyRates(rates: TemporalRates): TemporalRates {
  const copy: TemporalRates = {};
  for (const key of TEMPORAL_RATE_KEYS) {
    const value = rates[key];
    if (typeof value === "number" && Number.isFinite(value)) copy[key] = value;
  }
  return copy;
}

function mergeRates(target: TemporalRates, incoming: TemporalRates): void {
  for (const key of TEMPORAL_RATE_KEYS) {
    const value = incoming[key];
    if (typeof value === "number") target[key] = value;
  }
}

function factorFor(factor: number | { text: number }): number {
  return typeof factor === "number" ? factor : factor.text;
}

function applyMultiplier(rates: TemporalRates, factor: number | { text: number }): void {
  for (const key of TEMPORAL_RATE_KEYS) {
    const value = rates[key];
    if (typeof value === "number") rates[key] = value * factorFor(factor);
  }
}

function evaluatePolicyRules(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  atMs: number,
): TemporalInstantState {
  const activeRuleIds: string[] = [];
  let unresolvedReason: string | undefined;
  for (const rule of [...policy.overrides, ...policy.multipliers]) {
    const evaluation = evaluateTemporalCondition(rule.when, atMs);
    if (evaluation.status === "unsupported") {
      return { status: "unsupported", activeRuleIds: [], reason: evaluation.reason };
    }
    if (evaluation.status === "unresolved") {
      unresolvedReason = unresolvedReason ?? evaluation.reason;
      continue;
    }
    if (evaluation.value) activeRuleIds.push(rule.id);
  }
  if (unresolvedReason !== undefined) {
    return { status: "unresolved", activeRuleIds, reason: unresolvedReason };
  }
  return { status: "resolved", activeRuleIds };
}

export function getTemporalInstantState(
  providerId: string,
  modelId: string,
  atMs: number,
): TemporalInstantState {
  const policy = getTemporalPolicy(providerId, modelId);
  if (!policy) return { status: "resolved", activeRuleIds: [] };
  if (policy.status === "unsupported") {
    return { status: "unsupported", activeRuleIds: [], reason: policy.reason };
  }
  return evaluatePolicyRules(policy, atMs);
}

/**
 * Apply a model's temporal overrides in source order, then every matching
 * multiplier. `rates` is null whenever the result is not fully resolved, so a
 * caller can never mistake an unknown year or unsupported rule for a price.
 */
export function resolveTemporalRates(
  providerId: string,
  modelId: string,
  atMs: number,
  baseRates: TemporalRates,
): TemporalRateResolution {
  const policy = getTemporalPolicy(providerId, modelId);
  const base = copyRates(baseRates);
  if (!policy) return { status: "resolved", rates: base, appliedRuleIds: [] };
  if (policy.status === "unsupported") {
    return {
      status: "unsupported",
      rates: null,
      appliedRuleIds: [],
      reason: policy.reason,
    };
  }

  const rates = copyRates(base);
  const appliedRuleIds: string[] = [];
  for (const override of policy.overrides) {
    const evaluation = evaluateTemporalCondition(override.when, atMs);
    if (evaluation.status !== "resolved") {
      return {
        status: evaluation.status,
        rates: null,
        appliedRuleIds,
        reason: evaluation.reason,
      };
    }
    if (evaluation.value) {
      mergeRates(rates, override.rates);
      appliedRuleIds.push(override.id);
    }
  }
  for (const multiplier of policy.multipliers) {
    const evaluation = evaluateTemporalCondition(multiplier.when, atMs);
    if (evaluation.status !== "resolved") {
      return {
        status: evaluation.status,
        rates: null,
        appliedRuleIds,
        reason: evaluation.reason,
      };
    }
    if (evaluation.value) {
      applyMultiplier(rates, multiplier.factor);
      appliedRuleIds.push(multiplier.id);
    }
  }
  return { status: "resolved", rates, appliedRuleIds };
}

function collectClockMinutes(condition: TemporalCondition, minutes: Set<number>): void {
  switch (condition.type) {
    case "all":
    case "any":
      for (const child of condition.of) collectClockMinutes(child, minutes);
      return;
    case "not":
      collectClockMinutes(condition.of, minutes);
      return;
    case "utc_hours": {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      for (const value of values) {
        const target = clockMinutes(value, "utc_hours");
        if (
          condition.op === "equals" ||
          condition.op === "in" ||
          condition.op === "gt" ||
          condition.op === "lte"
        ) {
          minutes.add(target + 1);
        }
        if (condition.op !== "gt") minutes.add(target);
      }
      return;
    }
    case "utc_days":
    case "holiday":
      return;
  }
}

function policyClockMinutes(policy: Extract<TemporalPolicyEntry, { status: "supported" }>) {
  const minutes = new Set<number>();
  for (const rule of [...policy.overrides, ...policy.multipliers]) {
    collectClockMinutes(rule.when, minutes);
  }
  minutes.add(0);
  return [...minutes].sort((a, b) => a - b);
}

function dayStartMs(atMs: number): number {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function collectCandidateInstants(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  fromMs: number,
  toMs: number,
): number[] {
  const candidates = new Set<number>();
  const minutes = policyClockMinutes(policy);
  const firstDay = dayStartMs(fromMs);
  const lastDay = dayStartMs(toMs);
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    for (const minute of minutes) {
      const instant = day + minute * MINUTE_MS;
      if (instant >= fromMs && instant <= toMs) candidates.add(instant);
    }
  }

  const snapshot = ensureSnapshot();
  for (const years of Object.values(snapshot.jurisdictions)) {
    for (const calendar of Object.values(years)) {
      for (const interval of calendar.intervals) {
        if (interval.startMs >= fromMs && interval.startMs <= toMs) {
          candidates.add(interval.startMs);
        }
        if (interval.endMs >= fromMs && interval.endMs <= toMs) candidates.add(interval.endMs);
      }
    }
    for (const calendar of Object.values(years)) {
      const calendarYears = new Set(
        calendar.intervals.map((interval) => Number(interval.localStart.slice(0, 4))),
      );
      for (const year of calendarYears) {
        for (const candidateYear of [year, year + 1]) {
          const boundary = Date.parse(`${candidateYear}-01-01T00:00:00+08:00`);
          if (boundary >= fromMs && boundary <= toMs) candidates.add(boundary);
        }
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function sameState(a: TemporalInstantState, b: TemporalInstantState): boolean {
  return (
    a.status === b.status &&
    a.activeRuleIds.length === b.activeRuleIds.length &&
    a.activeRuleIds.every((id, index) => id === b.activeRuleIds[index])
  );
}

/** Next instant at which the resolved state or active rule set changes, within a
 * bounded five-year search horizon. Returns null when nothing changes or the
 * policy is unsupported. */
export function getNextTemporalTransition(
  providerId: string,
  modelId: string,
  fromMs: number,
): TemporalTransition | null {
  const policy = getTemporalPolicy(providerId, modelId);
  if (!policy || policy.status !== "supported") return null;
  const horizonEnd = fromMs + MAX_TRANSITION_HORIZON_MS;
  const candidates = collectCandidateInstants(policy, fromMs + 1, horizonEnd);
  let previous = getTemporalInstantState(providerId, modelId, fromMs);
  for (const candidate of candidates) {
    if (candidate <= fromMs) continue;
    const next = getTemporalInstantState(providerId, modelId, candidate);
    if (!sameState(previous, next)) {
      return { atMs: candidate, before: previous, after: next };
    }
    previous = next;
  }
  return null;
}

function sameRates(a: TemporalRates | null, b: TemporalRates | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Half-open `[startMs, endMs)` windows grouped by status, active rules and
 * (when supplied) the effective temporal rates. */
export function listTemporalIntervals(
  providerId: string,
  modelId: string,
  fromMs: number,
  toMs: number,
  baseRates?: TemporalRates,
): TemporalInterval[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    fail("listTemporalIntervals requires fromMs < toMs");
  }
  const policy = getTemporalPolicy(providerId, modelId);
  if (!policy || policy.status === "unsupported") {
    const state = getTemporalInstantState(providerId, modelId, fromMs);
    const resolution = baseRates
      ? resolveTemporalRates(providerId, modelId, fromMs, baseRates)
      : null;
    return [
      {
        startMs: fromMs,
        endMs: toMs,
        status: state.status,
        activeRuleIds: state.activeRuleIds,
        rates: resolution?.status === "resolved" ? resolution.rates : null,
        reason: state.reason,
      },
    ];
  }

  const boundaries = collectCandidateInstants(policy, fromMs, toMs);
  if (boundaries[0] !== fromMs) boundaries.unshift(fromMs);
  if (boundaries[boundaries.length - 1] !== toMs) boundaries.push(toMs);
  const intervals: TemporalInterval[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (endMs <= startMs) continue;
    const state = getTemporalInstantState(providerId, modelId, startMs);
    const resolution = baseRates
      ? resolveTemporalRates(providerId, modelId, startMs, baseRates)
      : null;
    const interval: TemporalInterval = {
      startMs,
      endMs,
      status: state.status,
      activeRuleIds: state.activeRuleIds,
      rates: resolution?.status === "resolved" ? resolution.rates : null,
      reason: state.reason,
    };
    const previous = intervals[intervals.length - 1];
    if (
      previous &&
      previous.status === interval.status &&
      previous.reason === interval.reason &&
      previous.activeRuleIds.join("\u0000") === interval.activeRuleIds.join("\u0000") &&
      sameRates(previous.rates, interval.rates)
    ) {
      previous.endMs = endMs;
    } else {
      intervals.push(interval);
    }
  }
  return intervals;
}
