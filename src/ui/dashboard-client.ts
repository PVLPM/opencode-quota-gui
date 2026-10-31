import { encodeAnalyticsEntityToken } from "../contracts/analytics-entity";
import type {
  AccountingCountUnit,
  AccountingResultType,
  AccountingUnit,
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupFilter,
  AnalyticsGroupRow,
  AnalyticsGroupSnapshot,
  AnalyticsSeries,
  AnalyticsSeriesChildBucket,
  Bucket,
  CostedTokens,
  DashboardDataSource,
  DashboardEvent,
  HomeSnapshot,
  ImportPreview,
  JsonValue,
  ProjectActivityRow,
  ProjectRootRow,
  ProjectSnapshot,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
  RunwayProjection,
  SessionNode,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
  StepPoint,
  TokenStack,
  Usage,
} from "../contracts/dashboard";
import { isCostedTokens, isDashboardEvent, isTokenStack } from "../contracts/guards";
import type { CardId, RowId } from "../contracts/identity";
import type { BankedResetAvailability, BankedResetCredit } from "../contracts/openai-quota";
import { type BucketUnit, isRangeKey, type RangeKey, type RangeWindow } from "../contracts/ranges";
import type {
  TemporalEffect,
  TemporalHoliday,
  TemporalModelInterval,
  TemporalModelStatus,
  TemporalPhase,
  TemporalPolicySource,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
  TemporalWeekday,
  TemporalWeeklySchedule,
  TemporalWeeklyWindow,
} from "../contracts/temporal";

/**
 * Browser-side HTTP data source (design spec §5.1, §5.3; R37).
 *
 * The browser talks only to this same-origin JSON/SSE surface: no provider, DB,
 * or config credentials ever reach it.
 *
 * Every response is *decoded*, not asserted: each `parse*` function reads the
 * fields the dashboard renders out of the documented JSON types and builds the
 * DTO from them, so a wrong payload fails loudly instead of being cast blind.
 * Optional fields stay optional — an absent field is omitted rather than
 * invented — and the two opaque ids the server owns carry a branded-type
 * assertion each (the brand is what stops the browser from composing an id of
 * its own). Fields the dashboard never reads (`row.metric`, `step.model`,
 * `step.agent`, `node.parentId`) are not re-derived here; deep validation of
 * anything the GUI does not consume stays the server's guarantee (P4).
 */

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface DashboardErrorDetails {
  reason?: string;
  [key: string]: JsonValue | undefined;
}

/** An error envelope from the HTTP surface, carrying its stable code and status. */
export class DashboardError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: DashboardErrorDetails | undefined;

  constructor(code: string, status: number, message: string, details?: DashboardErrorDetails) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** The revision the client held no longer matches the canonical file (spec §7). */
  get isConfigChanged(): boolean {
    return this.code === "config-changed";
  }
}

/** A JSON object as `JSON.parse` produces it: never an array, never `null`. */
type JsonRecord = { [key: string]: JsonValue };

/** The vocabulary each union-typed field must be spelled with. */
const COUNT_UNITS = [
  "request",
  "token",
  "credit",
  "message",
  "interaction",
  "unit",
] as const satisfies readonly AccountingCountUnit[];

const RESULT_TYPES = [
  "quota",
  "rate_limit",
  "usage",
  "spend",
  "budget",
  "balance",
  "status",
] as const satisfies readonly AccountingResultType[];

const UNIT_KINDS = [
  "currency",
  "count",
  "custom",
] as const satisfies readonly AccountingUnit["kind"][];

const ROW_KINDS = [
  "percent",
  "value",
  "quantity",
  "boolean",
] as const satisfies readonly QuotaCardRow["kind"][];

const LABEL_SOURCES = [
  "connection",
  "org",
  "account",
  "provider",
] as const satisfies readonly ProviderCard["labelSource"][];

const BUCKET_UNITS = ["hour", "day"] as const satisfies readonly BucketUnit[];

const RUNWAY_KINDS = [
  "before_reset",
  "lasts_past_reset",
] as const satisfies readonly RunwayProjection["kind"][];

const TEMPORAL_PHASES = [
  "peak",
  "offpeak",
  "mixed",
  "unknown",
] as const satisfies readonly TemporalPhase[];

const TEMPORAL_MODEL_PHASES = [
  "peak",
  "offpeak",
  "unknown",
] as const satisfies readonly TemporalModelStatus["state"][];

const TEMPORAL_EFFECT_DIRECTIONS = [
  "peak",
  "offpeak",
  "unchanged",
] as const satisfies readonly TemporalEffect["direction"][];

const TEMPORAL_EFFECT_UNITS = [
  "api_price",
  "quota_points",
] as const satisfies readonly TemporalEffect["unit"][];

const TEMPORAL_HOLIDAYS = ["CN", "US", "CA"] as const satisfies readonly TemporalHoliday[];

const TEMPORAL_WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const satisfies readonly TemporalWeekday[];

function faulty(endpoint: string, detail: string): DashboardError {
  return new DashboardError(
    "invalid-response",
    0,
    `The dashboard server returned an unexpected payload for ${endpoint} (${detail}).`,
  );
}

function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumberValue(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: JsonValue | undefined, endpoint: string, detail: string): JsonRecord {
  if (!isJsonRecord(value)) throw faulty(endpoint, detail);
  return value;
}

function readArray(value: JsonValue | undefined, endpoint: string, detail: string): JsonValue[] {
  if (!Array.isArray(value)) throw faulty(endpoint, detail);
  return value;
}

function readText(value: JsonValue | undefined, endpoint: string, detail: string): string {
  if (!isJsonString(value)) throw faulty(endpoint, detail);
  return value;
}

function readOptionalText(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): string | undefined {
  return value === undefined ? undefined : readText(value, endpoint, detail);
}

function readNumber(value: JsonValue | undefined, endpoint: string, detail: string): number {
  if (!isFiniteNumberValue(value)) throw faulty(endpoint, detail);
  return value;
}

function readOptionalNumber(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): number | undefined {
  return value === undefined ? undefined : readNumber(value, endpoint, detail);
}

function readIntegerInRange(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
  minimum: number,
  maximum: number,
): number {
  const number = readNumber(value, endpoint, detail);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw faulty(endpoint, detail);
  }
  return number;
}

function readBoolean(value: JsonValue | undefined, endpoint: string, detail: string): boolean {
  if (!isJsonBoolean(value)) throw faulty(endpoint, detail);
  return value;
}

function readOptionalBoolean(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): boolean | undefined {
  return value === undefined ? undefined : readBoolean(value, endpoint, detail);
}

function readEnum<T extends string>(
  value: JsonValue | undefined,
  allowed: readonly T[],
  endpoint: string,
  detail: string,
): T {
  if (isJsonString(value)) {
    for (const entry of allowed) {
      if (entry === value) return entry;
    }
  }
  throw faulty(endpoint, detail);
}

function readRangeKey(value: JsonValue | undefined, endpoint: string, detail: string): RangeKey {
  if (isRangeKey(value)) return value;
  throw faulty(endpoint, detail);
}

/** `token.stack` from P4's frame shape: the five raw categories, no derived total. */
function readTokenStack(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): TokenStack {
  if (!isTokenStack(value)) throw faulty(endpoint, detail);
  return value;
}

/** Invariant 1 (`total` equals the five categories) is part of the contract's guard. */
function readCostedTokens(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): CostedTokens {
  if (!isCostedTokens(value)) throw faulty(endpoint, detail);
  return value;
}

function readCardId(value: JsonValue | undefined, endpoint: string, detail: string): CardId {
  // SAFETY: the value is the server's opaque card id read as a string; the brand
  // only prevents the browser from composing a card id of its own (spec §5, §8).
  return readText(value, endpoint, detail) as CardId;
}

function readRowId(value: JsonValue | undefined, endpoint: string, detail: string): RowId {
  // SAFETY: the value is the server's opaque row id read as a string; the brand
  // only prevents the browser from composing a row id of its own (spec §5, §8).
  return readText(value, endpoint, detail) as RowId;
}

function readDetailRows(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): { label: string; value: string }[] {
  return readArray(value, endpoint, detail).map((entry) => {
    const row = readRecord(entry, endpoint, `${detail}[]`);
    return {
      label: readText(row.label, endpoint, `${detail}[].label`),
      value: readText(row.value, endpoint, `${detail}[].value`),
    };
  });
}

function readKeyMessages(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): { key: string; message: string }[] {
  return readArray(value, endpoint, detail).map((entry) => {
    const issue = readRecord(entry, endpoint, `${detail}[]`);
    return {
      key: readText(issue.key, endpoint, `${detail}[].key`),
      message: readText(issue.message, endpoint, `${detail}[].message`),
    };
  });
}

function readUnit(value: JsonValue, endpoint: string, detail: string): AccountingUnit {
  const unit = readRecord(value, endpoint, detail);
  const kind = readEnum(unit.kind, UNIT_KINDS, endpoint, `${detail}.kind`);
  if (kind === "currency") return { kind, code: readText(unit.code, endpoint, `${detail}.code`) };
  if (kind === "count") {
    return { kind, unit: readEnum(unit.unit, COUNT_UNITS, endpoint, `${detail}.unit`) };
  }
  return { kind, symbol: readText(unit.symbol, endpoint, `${detail}.symbol`) };
}

function readRunway(value: JsonValue, endpoint: string, detail: string): RunwayProjection {
  const runway = readRecord(value, endpoint, detail);
  const kind = readEnum(runway.kind, RUNWAY_KINDS, endpoint, `${detail}.kind`);
  if (kind === "before_reset") {
    return {
      kind,
      projectedAtIso: readText(runway.projectedAtIso, endpoint, `${detail}.projectedAtIso`),
    };
  }
  return { kind };
}

function readBankedResets(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): BankedResetAvailability {
  const resets = readRecord(value, endpoint, detail);
  return {
    availableCount: readNumber(resets.availableCount, endpoint, `${detail}.availableCount`),
    credits: readArray(resets.credits, endpoint, `${detail}.credits`).map((entry) => {
      const credit = readRecord(entry, endpoint, `${detail}.credits[]`);
      const parsed: BankedResetCredit = {};
      const title = readOptionalText(credit.title, endpoint, `${detail}.credits[].title`);
      if (title !== undefined) parsed.title = title;
      if (credit.expiresAtIso !== undefined) {
        parsed.expiresAtIso =
          credit.expiresAtIso === null
            ? null
            : readText(credit.expiresAtIso, endpoint, `${detail}.credits[].expiresAtIso`);
      }
      return parsed;
    }),
  };
}

function readRow(value: JsonValue, endpoint: string): QuotaCardRow {
  const detail = "providers.cards[].rows[]";
  const row = readRecord(value, endpoint, detail);
  const parsed: QuotaCardRow = {
    rowId: readRowId(row.rowId, endpoint, `${detail}.rowId`),
    label: readText(row.label, endpoint, `${detail}.label`),
    kind: readEnum(row.kind, ROW_KINDS, endpoint, `${detail}.kind`),
    resultType: readEnum(row.resultType, RESULT_TYPES, endpoint, `${detail}.resultType`),
  };

  const percentRemaining = readOptionalNumber(
    row.percentRemaining,
    endpoint,
    `${detail}.percentRemaining`,
  );
  if (percentRemaining !== undefined) parsed.percentRemaining = percentRemaining;
  const percentUsed = readOptionalNumber(row.percentUsed, endpoint, `${detail}.percentUsed`);
  if (percentUsed !== undefined) parsed.percentUsed = percentUsed;
  const valueText = readOptionalText(row.value, endpoint, `${detail}.value`);
  if (valueText !== undefined) parsed.value = valueText;
  const booleanValue = readOptionalBoolean(row.booleanValue, endpoint, `${detail}.booleanValue`);
  if (booleanValue !== undefined) parsed.booleanValue = booleanValue;
  const resetAtIso = readOptionalText(row.resetAtIso, endpoint, `${detail}.resetAtIso`);
  if (resetAtIso !== undefined) parsed.resetAtIso = resetAtIso;
  const countdown = readOptionalText(row.countdown, endpoint, `${detail}.countdown`);
  if (countdown !== undefined) parsed.countdown = countdown;
  const info = readOptionalText(row.info, endpoint, `${detail}.info`);
  if (info !== undefined) parsed.info = info;
  if (row.quantity !== undefined) {
    const quantity = readRecord(row.quantity, endpoint, `${detail}.quantity`);
    parsed.quantity = {
      decimal: readText(quantity.decimal, endpoint, `${detail}.quantity.decimal`),
      unit: readUnit(
        readRecord(quantity.unit, endpoint, `${detail}.quantity.unit`),
        endpoint,
        `${detail}.quantity.unit`,
      ),
    };
  }
  if (row.runway !== undefined) {
    parsed.runway = readRunway(row.runway, endpoint, `${detail}.runway`);
  }
  if (row.detailRows !== undefined) {
    parsed.detailRows = readDetailRows(row.detailRows, endpoint, `${detail}.detailRows`);
  }
  if (row.bankedResets !== undefined) {
    parsed.bankedResets = readBankedResets(row.bankedResets, endpoint, `${detail}.bankedResets`);
  }
  return parsed;
}

function readCard(value: JsonValue, endpoint: string): ProviderCard {
  const detail = "providers.cards[]";
  const card = readRecord(value, endpoint, detail);
  const parsed: ProviderCard = {
    cardId: readCardId(card.cardId, endpoint, `${detail}.cardId`),
    providerId: readText(card.providerId, endpoint, `${detail}.providerId`),
    providerLabel: readText(card.providerLabel, endpoint, `${detail}.providerLabel`),
    labelSource: readEnum(card.labelSource, LABEL_SOURCES, endpoint, `${detail}.labelSource`),
    rows: readArray(card.rows, endpoint, `${detail}.rows`).map((row) => readRow(row, endpoint)),
    errors: readArray(card.errors, endpoint, `${detail}.errors`).map((entry) => {
      const error = readRecord(entry, endpoint, `${detail}.errors[]`);
      const parsedError: ProviderCard["errors"][number] = {
        label: readText(error.label, endpoint, `${detail}.errors[].label`),
        message: readText(error.message, endpoint, `${detail}.errors[].message`),
      };
      const retryable = readOptionalBoolean(
        error.retryable,
        endpoint,
        `${detail}.errors[].retryable`,
      );
      if (retryable !== undefined) parsedError.retryable = retryable;
      return parsedError;
    }),
  };

  const accountLabel = readOptionalText(card.accountLabel, endpoint, `${detail}.accountLabel`);
  if (accountLabel !== undefined) parsed.accountLabel = accountLabel;
  const planLabel = readOptionalText(card.planLabel, endpoint, `${detail}.planLabel`);
  if (planLabel !== undefined) parsed.planLabel = planLabel;
  if (card.providerScopeId !== undefined) {
    parsed.providerScopeId = readCardId(
      card.providerScopeId,
      endpoint,
      `${detail}.providerScopeId`,
    );
  }
  const providerScopeHash = readOptionalText(
    card.providerScopeHash,
    endpoint,
    `${detail}.providerScopeHash`,
  );
  if (providerScopeHash !== undefined) parsed.providerScopeHash = providerScopeHash;
  const observedAtIso = readOptionalText(card.observedAtIso, endpoint, `${detail}.observedAtIso`);
  if (observedAtIso !== undefined) parsed.observedAtIso = observedAtIso;
  if (card.details !== undefined) {
    parsed.details = readDetailRows(card.details, endpoint, `${detail}.details`);
  }
  if (card.visibilityRows !== undefined) {
    parsed.visibilityRows = readArray(
      card.visibilityRows,
      endpoint,
      `${detail}.visibilityRows`,
    ).map((entry) => {
      const row = readRecord(entry, endpoint, `${detail}.visibilityRows[]`);
      const parsedRow: NonNullable<ProviderCard["visibilityRows"]>[number] = {
        rowId: readRowId(row.rowId, endpoint, `${detail}.visibilityRows[].rowId`),
        label: readText(row.label, endpoint, `${detail}.visibilityRows[].label`),
      };
      const info = readOptionalText(row.info, endpoint, `${detail}.visibilityRows[].info`);
      if (info !== undefined) parsedRow.info = info;
      return parsedRow;
    });
  }
  return parsed;
}

function readEnabledProviders(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): string[] | "auto" {
  if (isJsonString(value)) {
    if (value === "auto") return "auto";
    throw faulty(endpoint, detail);
  }
  return readArray(value, endpoint, detail).map((entry) =>
    readText(entry, endpoint, `${detail}[]`),
  );
}

function readProjectActivityRow(value: JsonValue, endpoint: string): ProjectActivityRow {
  const detail = "projects[]";
  const row = readRecord(value, endpoint, detail);
  return {
    projectId: readText(row.projectId, endpoint, `${detail}.projectId`),
    name: readText(row.name, endpoint, `${detail}.name`),
    tokens: readCostedTokens(row.tokens, endpoint, `${detail}.tokens`),
    rootSessionCount: readNumber(row.rootSessionCount, endpoint, `${detail}.rootSessionCount`),
    latestActivityAtMs: readNumber(
      row.latestActivityAtMs,
      endpoint,
      `${detail}.latestActivityAtMs`,
    ),
  };
}

function readRangeWindow(
  value: JsonValue | undefined,
  endpoint: string,
  detail = "usage.window",
): RangeWindow {
  const window = readRecord(value, endpoint, detail);
  const sinceMs = readOptionalNumber(window.sinceMs, endpoint, `${detail}.sinceMs`);
  const untilMs = readNumber(window.untilMs, endpoint, `${detail}.untilMs`);
  return sinceMs === undefined ? { untilMs } : { sinceMs, untilMs };
}

const ANALYTICS_DIMENSIONS = ["model", "provider"] as const satisfies readonly AnalyticsDimension[];

function readAnalyticsDimension(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): AnalyticsDimension {
  return readEnum(value, ANALYTICS_DIMENSIONS, endpoint, detail);
}

function readEntityIdentity(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): AnalyticsEntityIdentity {
  const identity = readRecord(value, endpoint, detail);
  const kind = readEnum(identity.kind, ["known", "unknown"] as const, endpoint, `${detail}.kind`);
  if (kind === "unknown") return { kind };
  return { kind, id: readText(identity.id, endpoint, `${detail}.id`) };
}

function readGroupFilter(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
): AnalyticsGroupFilter {
  const filter = readRecord(value, endpoint, detail);
  return {
    dimension: readAnalyticsDimension(filter.dimension, endpoint, `${detail}.dimension`),
    identity: readEntityIdentity(filter.identity, endpoint, `${detail}.identity`),
  };
}

type GroupTemporalBreakdown = NonNullable<AnalyticsGroupSnapshot["temporalBreakdown"]>;
type GroupTemporalBreakdownRow = GroupTemporalBreakdown["rows"][number];

function readTemporalBreakdownRow(
  value: JsonValue,
  endpoint: string,
  detail: string,
): GroupTemporalBreakdownRow {
  const row = readRecord(value, endpoint, detail);
  return {
    identity: readEntityIdentity(row.identity, endpoint, `${detail}.identity`),
    peak: readCostedTokens(row.peak, endpoint, `${detail}.peak`),
    offpeak: readCostedTokens(row.offpeak, endpoint, `${detail}.offpeak`),
  };
}

/** Model-detail-only historical split; absent on overviews, never invented. */
function readGroupTemporalBreakdown(
  value: JsonValue,
  endpoint: string,
  detail: string,
): GroupTemporalBreakdown {
  const breakdown = readRecord(value, endpoint, detail);
  return {
    rows: readArray(breakdown.rows, endpoint, `${detail}.rows`).map((row) =>
      readTemporalBreakdownRow(row, endpoint, `${detail}.rows[]`),
    ),
  };
}

function readGroupRow(value: JsonValue, endpoint: string, detail: string): AnalyticsGroupRow {
  const row = readRecord(value, endpoint, detail);
  return {
    identity: readEntityIdentity(row.identity, endpoint, `${detail}.identity`),
    tokens: readCostedTokens(row.tokens, endpoint, `${detail}.tokens`),
    sessionCount: readNumber(row.sessionCount, endpoint, `${detail}.sessionCount`),
    stepCount: readNumber(row.stepCount, endpoint, `${detail}.stepCount`),
    children: readArray(row.children, endpoint, `${detail}.children`).map((child) =>
      readGroupRow(child, endpoint, `${detail}.children[]`),
    ),
  };
}

function readSeriesEntityBuckets(
  value: JsonValue | undefined,
  endpoint: string,
  detail: string,
  bucketCount: number,
): AnalyticsSeriesChildBucket[][] | undefined {
  if (value === undefined) return undefined;
  const buckets = readArray(value, endpoint, detail);
  if (buckets.length !== bucketCount) throw faulty(endpoint, detail);
  return buckets.map((bucket, bucketIndex) => {
    const childDetail = `${detail}[${bucketIndex}]`;
    const seen = new Set<string>();
    return readArray(bucket, endpoint, childDetail).map((child) => {
      const record = readRecord(child, endpoint, `${childDetail}[]`);
      const identity = readEntityIdentity(record.identity, endpoint, `${childDetail}[].identity`);
      const key = identity.kind === "unknown" ? "unknown" : `known:${identity.id}`;
      if (seen.has(key)) throw faulty(endpoint, childDetail);
      seen.add(key);
      return {
        identity,
        tokens: readCostedTokens(record.tokens, endpoint, `${childDetail}[].tokens`),
      };
    });
  });
}

function readGroupSeries(value: JsonValue, endpoint: string): AnalyticsSeries {
  const detail = "series[]";
  const series = readRecord(value, endpoint, detail);
  const kind = readEnum(series.kind, ["entity", "other"] as const, endpoint, `${detail}.kind`);
  const tokens = readCostedTokens(series.tokens, endpoint, `${detail}.tokens`);
  const buckets = readArray(series.buckets, endpoint, `${detail}.buckets`).map((bucket, index) =>
    readCostedTokens(bucket, endpoint, `${detail}.buckets[${index}]`),
  );
  const childBuckets = readSeriesEntityBuckets(
    series.childBuckets,
    endpoint,
    `${detail}.childBuckets`,
    buckets.length,
  );
  if (kind === "other") {
    const parentBuckets = readSeriesEntityBuckets(
      series.parentBuckets,
      endpoint,
      `${detail}.parentBuckets`,
      buckets.length,
    );
    return {
      kind,
      tokens,
      buckets,
      ...(childBuckets === undefined ? {} : { childBuckets }),
      ...(parentBuckets === undefined ? {} : { parentBuckets }),
    };
  }
  const identity = readEntityIdentity(series.identity, endpoint, `${detail}.identity`);
  return childBuckets === undefined
    ? { kind, identity, tokens, buckets }
    : { kind, identity, tokens, buckets, childBuckets };
}

/** Decodes one range-certified grouped model/provider payload. */
export function parseGroupSnapshot(
  value: JsonValue,
  endpoint = "/api/v1/models",
): AnalyticsGroupSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const parsed: AnalyticsGroupSnapshot = {
    dimension: readAnalyticsDimension(root.dimension, endpoint, "dimension"),
    range: readRangeKey(root.range, endpoint, "range"),
    window: readRangeWindow(root.window, endpoint, "window"),
    bucketUnit: readEnum(root.bucketUnit, BUCKET_UNITS, endpoint, "bucketUnit"),
    timeZone: readText(root.timeZone, endpoint, "timeZone"),
    buckets: readArray(root.buckets, endpoint, "buckets").map((boundary) => {
      const entry = readRecord(boundary, endpoint, "buckets[]");
      return {
        startMs: readNumber(entry.startMs, endpoint, "buckets[].startMs"),
        endMs: readNumber(entry.endMs, endpoint, "buckets[].endMs"),
      };
    }),
    totals: readCostedTokens(root.totals, endpoint, "totals"),
    sessionCount: readNumber(root.sessionCount, endpoint, "sessionCount"),
    stepCount: readNumber(root.stepCount, endpoint, "stepCount"),
    rows: readArray(root.rows, endpoint, "rows").map((row) =>
      readGroupRow(row, endpoint, "rows[]"),
    ),
    series: readArray(root.series, endpoint, "series").map((series) =>
      readGroupSeries(series, endpoint),
    ),
    stale: readBoolean(root.stale, endpoint, "stale"),
  };
  if (root.filter !== undefined) {
    parsed.filter = readGroupFilter(root.filter, endpoint, "filter");
  }
  if (root.temporalBreakdown !== undefined) {
    parsed.temporalBreakdown = readGroupTemporalBreakdown(
      root.temporalBreakdown,
      endpoint,
      "temporalBreakdown",
    );
  }
  return parsed;
}

function readBucket(value: JsonValue, endpoint: string): Bucket {
  const detail = "usage.buckets[]";
  const bucket = readRecord(value, endpoint, detail);
  return {
    startMs: readNumber(bucket.startMs, endpoint, `${detail}.startMs`),
    endMs: readNumber(bucket.endMs, endpoint, `${detail}.endMs`),
    tokens: readCostedTokens(bucket.tokens, endpoint, `${detail}.tokens`),
  };
}

function readUsage(value: JsonValue | undefined, endpoint: string): Usage {
  const detail = "usage";
  const usage = readRecord(value, endpoint, detail);
  return {
    range: readRangeKey(usage.range, endpoint, `${detail}.range`),
    window: readRangeWindow(usage.window, endpoint),
    bucketUnit: readEnum(usage.bucketUnit, BUCKET_UNITS, endpoint, `${detail}.bucketUnit`),
    timeZone: readText(usage.timeZone, endpoint, `${detail}.timeZone`),
    buckets: readArray(usage.buckets, endpoint, `${detail}.buckets`).map((bucket) =>
      readBucket(bucket, endpoint),
    ),
    totals: readCostedTokens(usage.totals, endpoint, `${detail}.totals`),
    stepCount: readNumber(usage.stepCount, endpoint, `${detail}.stepCount`),
    sessionCount: readNumber(usage.sessionCount, endpoint, `${detail}.sessionCount`),
    stale: readBoolean(usage.stale, endpoint, `${detail}.stale`),
  };
}

function readTemporalEffect(value: JsonValue | undefined, endpoint: string): TemporalEffect {
  const detail = "temporal.providers[].models[].effect";
  const effect = readRecord(value, endpoint, detail);
  const unit = readEnum(effect.unit, TEMPORAL_EFFECT_UNITS, endpoint, `${detail}.unit`);
  const scalar = readOptionalBoolean(effect.scalar, endpoint, `${detail}.scalar`);
  // Quota-point effects are scalar by contract and omit the cross-rate field.
  // Reject contradictory wire data instead of silently ignoring it.
  if (unit === "quota_points" && scalar !== undefined) {
    throw faulty(endpoint, `${detail}.scalar`);
  }
  return {
    factor: readNumber(effect.factor, endpoint, `${detail}.factor`),
    direction: readEnum(
      effect.direction,
      TEMPORAL_EFFECT_DIRECTIONS,
      endpoint,
      `${detail}.direction`,
    ),
    unit,
    ...(scalar === undefined ? {} : { scalar }),
  };
}

function readTemporalInterval(value: JsonValue, endpoint: string): TemporalModelInterval {
  const detail = "temporal.providers[].models[].intervals[]";
  const interval = readRecord(value, endpoint, detail);
  const parsed: TemporalModelInterval = {
    startMs: readNumber(interval.startMs, endpoint, `${detail}.startMs`),
    endMs: readNumber(interval.endMs, endpoint, `${detail}.endMs`),
    phase: readEnum(interval.phase, TEMPORAL_MODEL_PHASES, endpoint, `${detail}.phase`),
  };
  if (interval.effect !== undefined) {
    parsed.effect = readTemporalEffect(interval.effect, endpoint);
  }
  const reason = readOptionalText(interval.reason, endpoint, `${detail}.reason`);
  if (reason !== undefined) parsed.reason = reason;
  return parsed;
}

function readTemporalWeeklyWindow(value: JsonValue, endpoint: string): TemporalWeeklyWindow {
  const detail = "temporal.providers[].models[].weekly.windows[]";
  const window = readRecord(value, endpoint, detail);
  const days = readArray(window.days, endpoint, `${detail}.days`).map((day) =>
    readEnum(day, TEMPORAL_WEEKDAYS, endpoint, `${detail}.days[]`),
  );
  if (days.length === 0 || new Set(days).size !== days.length) {
    throw faulty(endpoint, `${detail}.days`);
  }
  const startMinute = readIntegerInRange(
    window.startMinute,
    endpoint,
    `${detail}.startMinute`,
    0,
    1439,
  );
  const endMinute = readIntegerInRange(window.endMinute, endpoint, `${detail}.endMinute`, 1, 1440);
  if (endMinute <= startMinute) throw faulty(endpoint, `${detail}.endMinute`);
  const parsed: TemporalWeeklyWindow = {
    days: TEMPORAL_WEEKDAYS.filter((day) => days.includes(day)),
    startMinute,
    endMinute,
    phase: readEnum(window.phase, TEMPORAL_MODEL_PHASES, endpoint, `${detail}.phase`),
  };
  if (window.effect !== undefined) {
    parsed.effect = readTemporalEffect(window.effect, endpoint);
  }
  return parsed;
}

function readTemporalWeekly(value: JsonValue, endpoint: string): TemporalWeeklySchedule {
  const detail = "temporal.providers[].models[].weekly";
  const weekly = readRecord(value, endpoint, detail);
  const timeZone = readText(weekly.timeZone, endpoint, `${detail}.timeZone`);
  if (timeZone.length === 0) throw faulty(endpoint, `${detail}.timeZone`);
  const parsed: TemporalWeeklySchedule = {
    timeZone,
    utcOffsetMinutes: readIntegerInRange(
      weekly.utcOffsetMinutes,
      endpoint,
      `${detail}.utcOffsetMinutes`,
      -1440,
      1440,
    ),
    basePhase: readEnum(weekly.basePhase, TEMPORAL_MODEL_PHASES, endpoint, `${detail}.basePhase`),
    windows: readArray(weekly.windows, endpoint, `${detail}.windows`).map((window) =>
      readTemporalWeeklyWindow(window, endpoint),
    ),
  };
  if (weekly.baseEffect !== undefined) {
    parsed.baseEffect = readTemporalEffect(weekly.baseEffect, endpoint);
  }
  if (weekly.exceptHolidays !== undefined) {
    const jurisdictions = readArray(
      weekly.exceptHolidays,
      endpoint,
      `${detail}.exceptHolidays`,
    ).map((jurisdiction) =>
      readEnum(jurisdiction, TEMPORAL_HOLIDAYS, endpoint, `${detail}.exceptHolidays[]`),
    );
    if (new Set(jurisdictions).size !== jurisdictions.length) {
      throw faulty(endpoint, `${detail}.exceptHolidays`);
    }
    parsed.exceptHolidays = TEMPORAL_HOLIDAYS.filter((entry) => jurisdictions.includes(entry));
  }
  return parsed;
}

function readTemporalModel(value: JsonValue, endpoint: string): TemporalModelStatus {
  const detail = "temporal.providers[].models[]";
  const model = readRecord(value, endpoint, detail);
  const parsed: TemporalModelStatus = {
    modelId: readText(model.modelId, endpoint, `${detail}.modelId`),
    state: readEnum(model.state, TEMPORAL_MODEL_PHASES, endpoint, `${detail}.state`),
    intervals: readArray(model.intervals, endpoint, `${detail}.intervals`).map((interval) =>
      readTemporalInterval(interval, endpoint),
    ),
  };
  if (model.effect !== undefined) parsed.effect = readTemporalEffect(model.effect, endpoint);
  if (model.weekly !== undefined) parsed.weekly = readTemporalWeekly(model.weekly, endpoint);
  const nextChangeAtMs = readOptionalNumber(
    model.nextChangeAtMs,
    endpoint,
    `${detail}.nextChangeAtMs`,
  );
  if (nextChangeAtMs !== undefined) parsed.nextChangeAtMs = nextChangeAtMs;
  if (model.nextState !== undefined) {
    parsed.nextState = readEnum(
      model.nextState,
      TEMPORAL_MODEL_PHASES,
      endpoint,
      `${detail}.nextState`,
    );
  }
  const reason = readOptionalText(model.reason, endpoint, `${detail}.reason`);
  if (reason !== undefined) parsed.reason = reason;
  return parsed;
}

function readTemporalHoliday(
  value: JsonValue,
  endpoint: string,
): TemporalProviderStatus["holidays"][number] {
  const detail = "temporal.providers[].holidays[]";
  const holiday = readRecord(value, endpoint, detail);
  return {
    jurisdiction: readEnum(
      holiday.jurisdiction,
      TEMPORAL_HOLIDAYS,
      endpoint,
      `${detail}.jurisdiction`,
    ),
    id: readText(holiday.id, endpoint, `${detail}.id`),
    localStart: readText(holiday.localStart, endpoint, `${detail}.localStart`),
    localEnd: readText(holiday.localEnd, endpoint, `${detail}.localEnd`),
    startMs: readNumber(holiday.startMs, endpoint, `${detail}.startMs`),
    endMs: readNumber(holiday.endMs, endpoint, `${detail}.endMs`),
  };
}

function readTemporalSource(
  value: JsonValue | undefined,
  endpoint: string,
): TemporalPolicySource | undefined {
  if (value === undefined) return undefined;
  const detail = "temporal.providers[].source";
  const source = readRecord(value, endpoint, detail);
  return {
    label: readText(source.label, endpoint, `${detail}.label`),
    url: readText(source.url, endpoint, `${detail}.url`),
    accessedAt: readText(source.accessedAt, endpoint, `${detail}.accessedAt`),
  };
}

function readTemporalProvider(value: JsonValue, endpoint: string): TemporalProviderStatus {
  const detail = "temporal.providers[]";
  const provider = readRecord(value, endpoint, detail);
  const source = readTemporalSource(provider.source, endpoint);
  return {
    providerId: readText(provider.providerId, endpoint, `${detail}.providerId`),
    providerLabel: readText(provider.providerLabel, endpoint, `${detail}.providerLabel`),
    discovered: readBoolean(provider.discovered, endpoint, `${detail}.discovered`),
    phase: readEnum(provider.phase, TEMPORAL_PHASES, endpoint, `${detail}.phase`),
    models: readArray(provider.models, endpoint, `${detail}.models`).map((model) =>
      readTemporalModel(model, endpoint),
    ),
    holidays: readArray(provider.holidays, endpoint, `${detail}.holidays`).map((holiday) =>
      readTemporalHoliday(holiday, endpoint),
    ),
    ...(source ? { source } : {}),
  };
}

function readTemporalStatus(
  value: JsonValue | undefined,
  endpoint: string,
): TemporalStatusSnapshot | undefined {
  if (value === undefined) return undefined;
  const detail = "temporal";
  const temporal = readRecord(value, endpoint, detail);
  const snapshot = readRecord(temporal.snapshot, endpoint, `${detail}.snapshot`);
  return {
    generatedAtMs: readNumber(temporal.generatedAtMs, endpoint, `${detail}.generatedAtMs`),
    providers: readArray(temporal.providers, endpoint, `${detail}.providers`).map((provider) =>
      readTemporalProvider(provider, endpoint),
    ),
    snapshot: {
      revision: readText(snapshot.revision, endpoint, `${detail}.snapshot.revision`),
      generatedAtMs: readNumber(
        snapshot.generatedAtMs,
        endpoint,
        `${detail}.snapshot.generatedAtMs`,
      ),
    },
  };
}

/** Decodes the independent, range-free quota payload. */
export function parseQuotaSnapshot(value: JsonValue, endpoint = "/api/v1/quota"): QuotaSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const providers = readRecord(root.providers, endpoint, "providers");
  const parsed: QuotaSnapshot = {
    generatedAtMs: readNumber(root.generatedAtMs, endpoint, "generatedAtMs"),
    stale: readBoolean(root.stale, endpoint, "stale"),
    timeZone: readText(root.timeZone, endpoint, "timeZone"),
    providers: {
      cards: readArray(providers.cards, endpoint, "providers.cards").map((card) =>
        readCard(card, endpoint),
      ),
      enabledProviders: readEnabledProviders(
        providers.enabledProviders,
        endpoint,
        "providers.enabledProviders",
      ),
      polledAtMs: readNumber(providers.polledAtMs, endpoint, "providers.polledAtMs"),
    },
  };
  const temporal = readTemporalStatus(root.temporal, endpoint);
  if (temporal !== undefined) parsed.temporal = temporal;
  return parsed;
}

/** Decodes the compatible Analytics payload (`HomeSnapshot`, spec §5.2). */
export function parseHomeSnapshot(value: JsonValue, endpoint = "/api/v1/home"): HomeSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const providers = readRecord(root.providers, endpoint, "providers");
  return {
    generatedAtMs: readNumber(root.generatedAtMs, endpoint, "generatedAtMs"),
    range: readRangeKey(root.range, endpoint, "range"),
    stale: readBoolean(root.stale, endpoint, "stale"),
    providers: {
      cards: readArray(providers.cards, endpoint, "providers.cards").map((card) =>
        readCard(card, endpoint),
      ),
      enabledProviders: readEnabledProviders(
        providers.enabledProviders,
        endpoint,
        "providers.enabledProviders",
      ),
      polledAtMs: readNumber(providers.polledAtMs, endpoint, "providers.polledAtMs"),
    },
    usage: readUsage(root.usage, endpoint),
    projects: readArray(root.projects, endpoint, "projects").map((row) =>
      readProjectActivityRow(row, endpoint),
    ),
  };
}

function readProjectRoot(value: JsonValue, endpoint: string): ProjectRootRow {
  const detail = "roots[]";
  const root = readRecord(value, endpoint, detail);
  const parsed: ProjectRootRow = {
    sessionId: readText(root.sessionId, endpoint, `${detail}.sessionId`),
    title: readText(root.title, endpoint, `${detail}.title`),
    tokens: readCostedTokens(root.tokens, endpoint, `${detail}.tokens`),
    latestActivityAtMs: readNumber(
      root.latestActivityAtMs,
      endpoint,
      `${detail}.latestActivityAtMs`,
    ),
  };
  const worktreeLabel = readOptionalText(root.worktreeLabel, endpoint, `${detail}.worktreeLabel`);
  if (worktreeLabel !== undefined) parsed.worktreeLabel = worktreeLabel;
  return parsed;
}

/** Decodes `ProjectSnapshot`. */
export function parseProjectSnapshot(value: JsonValue, endpoint: string): ProjectSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const totalsRecord = readRecord(root.totals, endpoint, "totals");
  const totals = readCostedTokens(totalsRecord, endpoint, "totals");
  return {
    projectId: readText(root.projectId, endpoint, "projectId"),
    name: readText(root.name, endpoint, "name"),
    range: readRangeKey(root.range, endpoint, "range"),
    window: readRangeWindow(root.window, endpoint),
    roots: readArray(root.roots, endpoint, "roots").map((entry) =>
      readProjectRoot(entry, endpoint),
    ),
    totals: {
      ...totals,
      sessionCount: readNumber(totalsRecord.sessionCount, endpoint, "totals.sessionCount"),
    },
    usage: readUsage(root.usage, endpoint),
    stale: readBoolean(root.stale, endpoint, "stale"),
  };
}

function readBreadcrumb(
  value: JsonValue,
  endpoint: string,
): SessionSnapshot["breadcrumbs"][number] {
  const detail = "breadcrumbs[]";
  const crumb = readRecord(value, endpoint, detail);
  return {
    sessionId: readText(crumb.sessionId, endpoint, `${detail}.sessionId`),
    title: readText(crumb.title, endpoint, `${detail}.title`),
    isFocus: readBoolean(crumb.isFocus, endpoint, `${detail}.isFocus`),
  };
}

function readSessionNode(value: JsonValue, endpoint: string): SessionNode {
  const detail = "nodes[]";
  const node = readRecord(value, endpoint, detail);
  const parsed: SessionNode = {
    sessionId: readText(node.sessionId, endpoint, `${detail}.sessionId`),
    title: readText(node.title, endpoint, `${detail}.title`),
    depth: readNumber(node.depth, endpoint, `${detail}.depth`),
    childIds: readArray(node.childIds, endpoint, `${detail}.childIds`).map((entry) =>
      readText(entry, endpoint, `${detail}.childIds[]`),
    ),
    ownTokens: readCostedTokens(node.ownTokens, endpoint, `${detail}.ownTokens`),
    subtreeTokens: readCostedTokens(node.subtreeTokens, endpoint, `${detail}.subtreeTokens`),
    stepCount: readNumber(node.stepCount, endpoint, `${detail}.stepCount`),
    subtreeNodeCount: readNumber(node.subtreeNodeCount, endpoint, `${detail}.subtreeNodeCount`),
    latestActivityAtMs: readNumber(
      node.latestActivityAtMs,
      endpoint,
      `${detail}.latestActivityAtMs`,
    ),
  };
  const worktreeLabel = readOptionalText(node.worktreeLabel, endpoint, `${detail}.worktreeLabel`);
  if (worktreeLabel !== undefined) parsed.worktreeLabel = worktreeLabel;
  const agent = readOptionalText(node.agent, endpoint, `${detail}.agent`);
  if (agent !== undefined) parsed.agent = agent;
  const parentId = readOptionalText(node.parentId, endpoint, `${detail}.parentId`);
  if (parentId !== undefined) parsed.parentId = parentId;
  return parsed;
}

function readStep(value: JsonValue, endpoint: string): StepPoint {
  const detail = "steps[]";
  const step = readRecord(value, endpoint, detail);
  return {
    sessionId: readText(step.sessionId, endpoint, `${detail}.sessionId`),
    messageId: readText(step.messageId, endpoint, `${detail}.messageId`),
    atMs: readNumber(step.atMs, endpoint, `${detail}.atMs`),
    branch: readNumber(step.branch, endpoint, `${detail}.branch`),
    stack: readTokenStack(step.stack, endpoint, `${detail}.stack`),
    contextTokens: readNumber(step.contextTokens, endpoint, `${detail}.contextTokens`),
    totalTokens: readNumber(step.totalTokens, endpoint, `${detail}.totalTokens`),
  };
}

function readCompactionMarker(
  value: JsonValue,
  endpoint: string,
): SessionSnapshot["compactionMarkers"][number] {
  const detail = "compactionMarkers[]";
  const marker = readRecord(value, endpoint, detail);
  return {
    sessionId: readText(marker.sessionId, endpoint, `${detail}.sessionId`),
    atMs: readNumber(marker.atMs, endpoint, `${detail}.atMs`),
    messageId: readText(marker.messageId, endpoint, `${detail}.messageId`),
  };
}

/** Decodes `SessionSnapshot` (range-free by design, R25–R27). */
export function parseSessionSnapshot(value: JsonValue, endpoint: string): SessionSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const ownSummaryRecord = readRecord(root.ownSummary, endpoint, "ownSummary");
  const ownSummary = readCostedTokens(ownSummaryRecord, endpoint, "ownSummary");
  return {
    focusSessionId: readText(root.focusSessionId, endpoint, "focusSessionId"),
    timeZone: readText(root.timeZone, endpoint, "timeZone"),
    projectId: readText(root.projectId, endpoint, "projectId"),
    projectName: readText(root.projectName, endpoint, "projectName"),
    breadcrumbs: readArray(root.breadcrumbs, endpoint, "breadcrumbs").map((entry) =>
      readBreadcrumb(entry, endpoint),
    ),
    nodes: readArray(root.nodes, endpoint, "nodes").map((node) => readSessionNode(node, endpoint)),
    steps: readArray(root.steps, endpoint, "steps").map((step) => readStep(step, endpoint)),
    compactionMarkers: readArray(root.compactionMarkers, endpoint, "compactionMarkers").map(
      (marker) => readCompactionMarker(marker, endpoint),
    ),
    ownSummary: {
      ...ownSummary,
      stepCount: readNumber(ownSummaryRecord.stepCount, endpoint, "ownSummary.stepCount"),
    },
    treeTotals: readCostedTokens(root.treeTotals, endpoint, "treeTotals"),
    stepSemantics: readText(root.stepSemantics, endpoint, "stepSemantics"),
  };
}

function readStringMap(value: JsonValue | undefined, endpoint: string, detail: string) {
  // The accumulator carries the target type; the inferred return keeps the rule
  // against discarded evidence quiet without changing what callers receive.
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(readRecord(value, endpoint, detail))) {
    result[key] = readText(entry, endpoint, `${detail}.${key}`);
  }
  return result;
}

function readStringList(value: JsonValue | undefined, endpoint: string, detail: string): string[] {
  return readArray(value, endpoint, detail).map((entry) =>
    readText(entry, endpoint, `${detail}[]`),
  );
}

function readImportState(
  value: JsonValue | undefined,
  endpoint: string,
): SettingsSnapshot["import"] {
  const detail = "import";
  const state = readRecord(value, endpoint, detail);
  const parsed: SettingsSnapshot["import"] = {
    available: readBoolean(state.available, endpoint, `${detail}.available`),
    issues: readKeyMessages(state.issues, endpoint, `${detail}.issues`),
  };
  const from = readOptionalText(state.from, endpoint, `${detail}.from`);
  if (from !== undefined) parsed.from = from;
  const keyCount = readOptionalNumber(state.keyCount, endpoint, `${detail}.keyCount`);
  if (keyCount !== undefined) parsed.keyCount = keyCount;
  return parsed;
}

function readSettingsIssue(value: JsonValue, endpoint: string): SettingsSnapshot["issues"][number] {
  const detail = "issues[]";
  const issue = readRecord(value, endpoint, detail);
  return {
    label: readText(issue.label, endpoint, `${detail}.label`),
    key: readText(issue.key, endpoint, `${detail}.key`),
    message: readText(issue.message, endpoint, `${detail}.message`),
  };
}

/** Decodes `SettingsSnapshot`. */
export function parseSettingsSnapshot(
  value: JsonValue,
  endpoint = "/api/v1/settings",
): SettingsSnapshot {
  const root = readRecord(value, endpoint, "not an object");
  const dashboard = readRecord(root.dashboard, endpoint, "dashboard");
  const visibility = readRecord(root.visibility, endpoint, "visibility");
  const provenance: SettingsSnapshot["provenance"] =
    root.provenance === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(readRecord(root.provenance, endpoint, "provenance")).map(
            ([key, value]) => {
              const source = readRecord(value, endpoint, "provenance[]");
              return [
                key,
                {
                  scope: readEnum(
                    source.scope,
                    ["defaults", "global", "workspace", "project", "legacy"] as const,
                    endpoint,
                    "provenance[].scope",
                  ),
                },
              ];
            },
          ),
        );
  return {
    revision: readText(root.revision, endpoint, "revision"),
    pathLabel: readText(root.pathLabel, endpoint, "pathLabel"),
    values: readRecord(root.values, endpoint, "values"),
    sources: readStringMap(root.sources, endpoint, "sources"),
    ...(provenance === undefined ? {} : { provenance }),
    writable: readStringList(root.writable, endpoint, "writable"),
    dashboard: {
      port: readNumber(dashboard.port, endpoint, "dashboard.port"),
      url: readText(dashboard.url, endpoint, "dashboard.url"),
    },
    visibility: {
      hiddenCards: readStringList(visibility.hiddenCards, endpoint, "visibility.hiddenCards"),
      hiddenRows: readStringList(visibility.hiddenRows, endpoint, "visibility.hiddenRows"),
    },
    import: readImportState(root.import, endpoint),
    issues: readArray(root.issues, endpoint, "issues").map((issue) =>
      readSettingsIssue(issue, endpoint),
    ),
  };
}

/** Decodes `SettingsWriteResult` (save, visibility save, import apply). */
export function parseSettingsWriteResult(value: JsonValue, endpoint: string): SettingsWriteResult {
  const root = readRecord(value, endpoint, "not an object");
  return {
    revision: readText(root.revision, endpoint, "revision"),
    applied: readRecord(root.applied, endpoint, "applied"),
    warnings: readKeyMessages(root.warnings, endpoint, "warnings"),
  };
}

/** Decodes `ImportPreview`. */
export function parseImportPreview(value: JsonValue, endpoint: string): ImportPreview {
  const root = readRecord(value, endpoint, "not an object");
  return {
    from: readText(root.from, endpoint, "from"),
    keys: readArray(root.keys, endpoint, "keys").map((entry) => {
      const key = readRecord(entry, endpoint, "keys[]");
      return {
        key: readText(key.key, endpoint, "keys[].key"),
        value: key.value,
      };
    }),
    issues: readKeyMessages(root.issues, endpoint, "issues"),
    expectedRevision: readText(root.expectedRevision, endpoint, "expectedRevision"),
  };
}

function readErrorDetails(
  value: JsonValue | undefined,
  endpoint: string,
): DashboardErrorDetails | undefined {
  if (value === undefined) return undefined;
  const record = readRecord(value, endpoint, "error.details");
  const details: DashboardErrorDetails = {};
  for (const [key, entry] of Object.entries(record)) {
    details[key] = entry;
  }
  return details;
}

/** Reads the error envelope (`{ error: { code, message, details? } }`). */
async function toDashboardError(response: Response, endpoint: string): Promise<DashboardError> {
  const fallback = new DashboardError(
    "internal",
    response.status,
    `The dashboard request to ${endpoint} failed with status ${response.status}.`,
  );
  try {
    const payload: JsonValue = await response.json();
    if (!isJsonRecord(payload)) return fallback;
    const error = payload.error;
    if (!isJsonRecord(error)) return fallback;
    const code = readOptionalText(error.code, endpoint, "error.code");
    const message = readOptionalText(error.message, endpoint, "error.message");
    if (code === undefined || message === undefined) return fallback;
    return new DashboardError(
      code,
      response.status,
      message,
      readErrorDetails(error.details, endpoint),
    );
  } catch {
    return fallback;
  }
}

export type ActiveViewScope = "quota" | "analytics";

export interface DashboardClient extends DashboardDataSource {
  /** Optional for older injected clients; failure must not block the read UI. */
  setActiveView?(scope: ActiveViewScope): Promise<void>;
  /** SSE transport state; `live` means the stream is open. */
  connection(): ConnectionState;
  /** Observes transport state; returns an unsubscribe function. */
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
}

/** Every body the dashboard PUTs or POSTs, exactly as the seam declares it. */
type DashboardWriteBody =
  | Record<string, never>
  | { scope: ActiveViewScope }
  | Parameters<DashboardDataSource["saveSettings"]>[0]
  | Parameters<DashboardDataSource["saveVisibility"]>[0]
  | Parameters<DashboardDataSource["importApply"]>[0];

export interface DashboardClientOptions {
  /** Defaults to the page origin: the dashboard is same-origin by construction. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
  onConnectionChange?: (state: ConnectionState) => void;
}

export function createHttpDashboardClient(options: DashboardClientOptions = {}): DashboardClient {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const openEvents =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url, { withCredentials: false }));
  const listeners = new Set<(state: ConnectionState) => void>();
  let connectionState: ConnectionState = "connecting";

  function setConnection(state: ConnectionState): void {
    if (state === connectionState) return;
    connectionState = state;
    options.onConnectionChange?.(state);
    for (const listener of listeners) listener(state);
  }

  async function request(endpoint: string, init?: RequestInit): Promise<JsonValue> {
    const response = await fetchImpl(`${baseUrl}${endpoint}`, {
      ...init,
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw await toDashboardError(response, endpoint);
    // `JSON.parse` only produces JSON values, so the declared type is exact for
    // this source; the parsers then decode the fields the dashboard reads.
    const payload: JsonValue = await response.json();
    return payload;
  }

  function write(
    endpoint: string,
    body: DashboardWriteBody,
    method: "PUT" | "POST",
  ): Promise<JsonValue> {
    return request(endpoint, { method, body: JSON.stringify(body) });
  }

  return {
    async setActiveView(scope) {
      const endpoint = "/api/v1/view";
      const root = readRecord(await write(endpoint, { scope }, "PUT"), endpoint, "not an object");
      const applied = readEnum(root.scope, ["quota", "analytics"], endpoint, "scope");
      if (applied !== scope) throw faulty(endpoint, "scope does not match the requested view");
    },

    connection: () => connectionState,

    onConnectionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async health() {
      const endpoint = "/api/v1/health";
      const root = readRecord(await request(endpoint), endpoint, "not an object");
      const version = readOptionalText(root.version, endpoint, "version");
      const build = readOptionalText(root.build, endpoint, "build");
      return {
        app: "opencode-quota-gui",
        contractVersion: readNumber(root.contractVersion, endpoint, "contractVersion"),
        ...(version === undefined ? {} : { version }),
        ...(build === undefined ? {} : { build }),
      };
    },

    async quota() {
      return parseQuotaSnapshot(await request("/api/v1/quota"));
    },

    async home(input) {
      const endpoint = `/api/v1/home?range=${encodeURIComponent(input.range)}`;
      return parseHomeSnapshot(await request(endpoint), endpoint);
    },

    async project(input) {
      const endpoint = `/api/v1/projects/${encodeURIComponent(input.projectId)}?range=${encodeURIComponent(input.range)}`;
      return parseProjectSnapshot(await request(endpoint), endpoint);
    },

    async session(input) {
      const endpoint = `/api/v1/sessions/${encodeURIComponent(input.sessionId)}`;
      return parseSessionSnapshot(await request(endpoint), endpoint);
    },

    async groups(input) {
      const entityDimension = input.filter?.dimension ?? input.dimension;
      const collection = entityDimension === "model" ? "models" : "providers";
      const token = input.filter ? `/${encodeAnalyticsEntityToken(input.filter.identity)}` : "";
      const defaultGroup = entityDimension === "model" ? "provider" : "model";
      const group =
        input.filter && input.dimension !== defaultGroup ? `&group=${input.dimension}` : "";
      const endpoint = `/api/v1/${collection}${token}?range=${encodeURIComponent(input.range)}${group}`;
      return parseGroupSnapshot(await request(endpoint), endpoint);
    },

    async openSettingsFile() {
      const endpoint = "/api/v1/settings/open";
      const root = readRecord(await write(endpoint, {}, "POST"), endpoint, "not an object");
      if (!readBoolean(root.opened, endpoint, "opened"))
        throw faulty(endpoint, "file was not opened");
    },

    async settings() {
      return parseSettingsSnapshot(await request("/api/v1/settings"));
    },

    async saveSettings(input) {
      return parseSettingsWriteResult(
        await write("/api/v1/settings", input, "PUT"),
        "/api/v1/settings",
      );
    },

    async saveVisibility(input) {
      return parseSettingsWriteResult(
        await write("/api/v1/visibility", input, "PUT"),
        "/api/v1/visibility",
      );
    },

    async importPreview() {
      return parseImportPreview(
        await request("/api/v1/settings/import"),
        "/api/v1/settings/import",
      );
    },

    async importApply(input) {
      return parseSettingsWriteResult(
        await write("/api/v1/settings/import", input, "POST"),
        "/api/v1/settings/import",
      );
    },

    subscribe(onEvent: (event: DashboardEvent) => void) {
      const source = openEvents(`${baseUrl}/api/v1/events`);
      setConnection("connecting");
      source.onopen = () => setConnection("live");
      source.onerror = () => setConnection("reconnecting");
      source.onmessage = (message) => {
        try {
          const payload: unknown = JSON.parse(message.data);
          // The event helper is the locally validated part of the stream (spec §5.5).
          if (isDashboardEvent(payload)) onEvent(payload);
        } catch {
          // A malformed frame is dropped; the next change event re-invalidates.
        }
      };
      return () => {
        source.close();
        setConnection("reconnecting");
      };
    },
  };
}
