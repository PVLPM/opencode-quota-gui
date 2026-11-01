/**
 * Browser-safe structural guards for every dashboard DTO that crosses a
 * transport boundary.
 *
 * These are deliberately separate from the richer UI decoders: they answer
 * "is this the documented DTO shape?" without constructing a new object, so a
 * transport can reject a malformed payload while preserving additive fields.
 * Existing narrow guards (`isTokenStack`, `isCostedTokens`, `isRangeKey`) are
 * reused rather than re-implemented.
 */

import type { AnalyticsTemporalBreakdown } from "./analytics-temporal.js";
import type {
  AccountingMetric,
  AccountingResultType,
  AccountingUnit,
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupFilter,
  AnalyticsGroupQuery,
  AnalyticsGroupRow,
  AnalyticsGroupSnapshot,
  AnalyticsSeries,
  AnalyticsSeriesChildBucket,
  Bucket,
  DashboardHealth,
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
  Usage,
} from "./dashboard.js";
import { PRIMARY_QUOTA_WINDOW_LIMIT } from "./dashboard.js";
import { isCostedTokens, isTokenStack } from "./guards.js";
import type { BankedResetAvailability } from "./openai-quota.js";
import { type BucketUnit, isRangeKey, type RangeWindow } from "./ranges.js";
import type {
  TemporalEffect,
  TemporalModelInterval,
  TemporalModelStatus,
  TemporalPolicySource,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
  TemporalWeeklySchedule,
  TemporalWeeklyWindow,
} from "./temporal.js";

type RecordValue = Record<string, unknown>;

const RESULT_TYPES = [
  "quota",
  "rate_limit",
  "usage",
  "spend",
  "budget",
  "balance",
  "status",
] as const satisfies readonly AccountingResultType[];

const COUNT_UNITS = ["request", "token", "credit", "message", "interaction", "unit"] as const;

const ROW_KINDS = ["percent", "value", "quantity", "boolean"] as const;
const LABEL_SOURCES = ["connection", "org", "account", "provider"] as const;
const PROVENANCE_SCOPES = ["defaults", "global", "workspace", "project", "legacy"] as const;
const TEMPORAL_PHASES = ["peak", "offpeak", "mixed", "unknown"] as const;
const TEMPORAL_MODEL_PHASES = ["peak", "offpeak", "unknown"] as const;
const TEMPORAL_EFFECT_DIRECTIONS = ["peak", "offpeak", "unchanged"] as const;
const TEMPORAL_EFFECT_UNITS = ["api_price", "quota_points"] as const;
const TEMPORAL_HOLIDAYS = ["CN", "US", "CA"] as const;
const TEMPORAL_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((entry) => entry === value);
}

function isArrayOf(value: unknown, guard: (entry: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every((entry) => guard(entry));
}

function isOptional(value: unknown, guard: (entry: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDimension(value: unknown): value is AnalyticsDimension {
  return value === "model" || value === "provider";
}

function isBucketUnit(value: unknown): value is BucketUnit {
  return value === "hour" || value === "day";
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (isFiniteNumber(value)) return true;
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

function isRangeWindow(value: unknown): value is RangeWindow {
  return (
    isRecord(value) && isFiniteNumber(value.untilMs) && isOptional(value.sinceMs, isFiniteNumber)
  );
}

function isBucket(value: unknown): value is Bucket {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startMs) &&
    isFiniteNumber(value.endMs) &&
    isCostedTokens(value.tokens)
  );
}

function isAccountingMetric(value: unknown): value is AccountingMetric {
  if (!isRecord(value)) return false;
  if (value.kind === "aggregate") return true;
  if (value.kind === "window") {
    return isOneOf(value.window, [
      "rpm",
      "hour",
      "five_hour",
      "day",
      "week",
      "month",
      "year",
      "mcp",
      "code_review",
    ] as const);
  }
  if (value.kind === "component") {
    return isOneOf(value.component, [
      "current_balance",
      "total_balance",
      "cash_balance",
      "gift_balance",
      "granted_balance",
      "topped_up_balance",
      "remaining_credits",
      "auto_reload",
      "auto_reload_amount",
      "auto_reload_trigger",
    ] as const);
  }
  return value.kind === "named" && isText(value.name);
}

function isAccountingUnit(value: unknown): value is AccountingUnit {
  if (!isRecord(value)) return false;
  if (value.kind === "currency") return isText(value.code);
  if (value.kind === "count") return isOneOf(value.unit, COUNT_UNITS);
  return value.kind === "custom" && isText(value.symbol);
}

function isRunwayProjection(value: unknown): value is RunwayProjection {
  if (!isRecord(value)) return false;
  if (value.kind === "before_reset") return isText(value.projectedAtIso);
  return value.kind === "lasts_past_reset";
}

function isBankedResets(value: unknown): value is BankedResetAvailability {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.availableCount) &&
    isArrayOf(value.credits, (credit) => {
      if (!isRecord(credit)) return false;
      return (
        isOptional(credit.title, isText) &&
        isOptional(credit.expiresAtIso, (entry) => entry === null || isText(entry))
      );
    })
  );
}

function isQuotaCardRow(value: unknown): value is QuotaCardRow {
  if (!isRecord(value)) return false;
  if (
    !isText(value.rowId) ||
    !isText(value.label) ||
    !isOneOf(value.kind, ROW_KINDS) ||
    !isOneOf(value.resultType, RESULT_TYPES)
  ) {
    return false;
  }
  if (!isOptional(value.info, isText)) return false;
  if (!isOptional(value.percentRemaining, isFiniteNumber)) return false;
  if (!isOptional(value.percentUsed, isFiniteNumber)) return false;
  if (!isOptional(value.value, isText)) return false;
  if (!isOptional(value.booleanValue, isBoolean)) return false;
  if (!isOptional(value.resetAtIso, isText)) return false;
  if (!isOptional(value.countdown, isText)) return false;
  if (!isOptional(value.metric, isAccountingMetric)) return false;
  if (value.quantity !== undefined) {
    if (!isRecord(value.quantity)) return false;
    if (!isText(value.quantity.decimal) || !isAccountingUnit(value.quantity.unit)) return false;
  }
  if (!isOptional(value.runway, isRunwayProjection)) return false;
  if (
    !isOptional(value.detailRows, (rows): rows is { label: string; value: string }[] =>
      isArrayOf(rows, (row) => isRecord(row) && isText(row.label) && isText(row.value)),
    )
  ) {
    return false;
  }
  return isOptional(value.bankedResets, isBankedResets);
}

function isProviderCard(value: unknown): value is ProviderCard {
  if (!isRecord(value)) return false;
  if (
    !isText(value.cardId) ||
    !isText(value.providerId) ||
    !isText(value.providerLabel) ||
    !isOneOf(value.labelSource, LABEL_SOURCES) ||
    !isArrayOf(value.rows, isQuotaCardRow)
  ) {
    return false;
  }
  if (!isOptional(value.planLabel, isText)) return false;
  if (!isOptional(value.accountLabel, isText)) return false;
  if (!isOptional(value.providerScopeId, isText)) return false;
  if (!isOptional(value.providerScopeHash, isText)) return false;
  if (!isOptional(value.observedAtIso, isText)) return false;
  if (
    !isOptional(
      value.errors,
      (errors): errors is { label: string; message: string; retryable?: boolean }[] =>
        isArrayOf(
          errors,
          (entry) =>
            isRecord(entry) &&
            isText(entry.label) &&
            isText(entry.message) &&
            isOptional(entry.retryable, isBoolean),
        ),
    )
  ) {
    return false;
  }
  if (
    !isOptional(value.details, (details): details is { label: string; value: string }[] =>
      isArrayOf(details, (entry) => isRecord(entry) && isText(entry.label) && isText(entry.value)),
    )
  ) {
    return false;
  }
  if (
    !isOptional(
      value.visibilityRows,
      (rows): rows is { rowId: string; label: string; info?: string }[] =>
        isArrayOf(
          rows,
          (row) =>
            isRecord(row) && isText(row.rowId) && isText(row.label) && isOptional(row.info, isText),
        ),
    )
  ) {
    return false;
  }

  const rowsById = new Map<string, QuotaCardRow>(
    (value.rows as QuotaCardRow[]).map((row) => [row.rowId, row] as const),
  );
  return isOptional(value.primaryQuotaWindows, (windows): windows is unknown[] => {
    if (!Array.isArray(windows) || windows.length > PRIMARY_QUOTA_WINDOW_LIMIT) return false;
    const seenRowIds = new Set<string>();
    const seenSlots = new Set<number>();
    return windows.every((window) => {
      if (
        !isRecord(window) ||
        !isText(window.rowId) ||
        !isIntegerBetween(window.slot, 0, 2) ||
        seenRowIds.has(window.rowId) ||
        seenSlots.has(window.slot)
      ) {
        return false;
      }
      const row = rowsById.get(window.rowId);
      if (
        row === undefined ||
        row.kind !== "percent" ||
        (row.resultType !== "quota" && row.resultType !== "rate_limit") ||
        !isFiniteNumber(row.percentRemaining)
      ) {
        return false;
      }
      seenRowIds.add(window.rowId);
      seenSlots.add(window.slot);
      return true;
    });
  });
}

function isProviders(value: unknown): value is HomeSnapshot["providers"] {
  return (
    isRecord(value) &&
    isArrayOf(value.cards, isProviderCard) &&
    (value.enabledProviders === "auto" || isArrayOf(value.enabledProviders, isText)) &&
    isFiniteNumber(value.polledAtMs)
  );
}

function isUsage(value: unknown): value is Usage {
  return (
    isRecord(value) &&
    isRangeKey(value.range) &&
    isRangeWindow(value.window) &&
    isBucketUnit(value.bucketUnit) &&
    isText(value.timeZone) &&
    isArrayOf(value.buckets, isBucket) &&
    isCostedTokens(value.totals) &&
    isFiniteNumber(value.stepCount) &&
    isFiniteNumber(value.sessionCount) &&
    isBoolean(value.stale)
  );
}

function isProjectActivityRow(value: unknown): value is ProjectActivityRow {
  return (
    isRecord(value) &&
    isText(value.projectId) &&
    isText(value.name) &&
    isCostedTokens(value.tokens) &&
    isFiniteNumber(value.rootSessionCount) &&
    isFiniteNumber(value.latestActivityAtMs)
  );
}

function isTemporalEffect(value: unknown): value is TemporalEffect {
  if (!isRecord(value)) return false;
  if (
    !isFiniteNumber(value.factor) ||
    !isOneOf(value.direction, TEMPORAL_EFFECT_DIRECTIONS) ||
    !isOneOf(value.unit, TEMPORAL_EFFECT_UNITS) ||
    !isOptional(value.scalar, isBoolean)
  ) {
    return false;
  }
  // Quota-point effects are scalar by contract and must not carry the
  // cross-rate classification field.
  return value.unit !== "quota_points" || value.scalar === undefined;
}

function isTemporalModelInterval(value: unknown): value is TemporalModelInterval {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startMs) &&
    isFiniteNumber(value.endMs) &&
    isOneOf(value.phase, TEMPORAL_MODEL_PHASES) &&
    isOptional(value.effect, isTemporalEffect) &&
    isOptional(value.reason, isText)
  );
}

function isTemporalWeeklyWindow(value: unknown): value is TemporalWeeklyWindow {
  if (!isRecord(value)) return false;
  if (
    !isArrayOf(value.days, (day) => isOneOf(day, TEMPORAL_WEEKDAYS)) ||
    !isIntegerBetween(value.startMinute, 0, 1439) ||
    !isIntegerBetween(value.endMinute, 1, 1440) ||
    value.endMinute <= value.startMinute ||
    !isOneOf(value.phase, TEMPORAL_MODEL_PHASES) ||
    !isOptional(value.effect, isTemporalEffect)
  ) {
    return false;
  }
  return new Set(value.days).size === value.days.length;
}

function isTemporalWeekly(value: unknown): value is TemporalWeeklySchedule {
  if (!isRecord(value)) return false;
  if (
    !isText(value.timeZone) ||
    value.timeZone.length === 0 ||
    !isIntegerBetween(value.utcOffsetMinutes, -1440, 1440) ||
    !isOneOf(value.basePhase, TEMPORAL_MODEL_PHASES) ||
    !isArrayOf(value.windows, isTemporalWeeklyWindow) ||
    !isOptional(value.baseEffect, isTemporalEffect)
  ) {
    return false;
  }
  const exceptHolidays = value.exceptHolidays;
  if (exceptHolidays === undefined) return true;
  if (
    !Array.isArray(exceptHolidays) ||
    !exceptHolidays.every((holiday) => isOneOf(holiday, TEMPORAL_HOLIDAYS))
  ) {
    return false;
  }
  return new Set(exceptHolidays).size === exceptHolidays.length;
}

function isTemporalModel(value: unknown): value is TemporalModelStatus {
  return (
    isRecord(value) &&
    isText(value.modelId) &&
    isOneOf(value.state, TEMPORAL_MODEL_PHASES) &&
    isArrayOf(value.intervals, isTemporalModelInterval) &&
    isOptional(value.effect, isTemporalEffect) &&
    isOptional(value.weekly, isTemporalWeekly) &&
    isOptional(value.nextChangeAtMs, isFiniteNumber) &&
    isOptional(value.nextState, (state) => isOneOf(state, TEMPORAL_MODEL_PHASES)) &&
    isOptional(value.reason, isText)
  );
}

function isTemporalHoliday(value: unknown): value is TemporalHolidayIntervalValue {
  return (
    isRecord(value) &&
    isOneOf(value.jurisdiction, TEMPORAL_HOLIDAYS) &&
    isText(value.id) &&
    isText(value.localStart) &&
    isText(value.localEnd) &&
    isFiniteNumber(value.startMs) &&
    isFiniteNumber(value.endMs)
  );
}

type TemporalHolidayIntervalValue = TemporalProviderStatus["holidays"][number];

function isTemporalSource(value: unknown): value is TemporalPolicySource {
  return isRecord(value) && isText(value.label) && isText(value.url) && isText(value.accessedAt);
}

function isTemporalProvider(value: unknown): value is TemporalProviderStatus {
  return (
    isRecord(value) &&
    isText(value.providerId) &&
    isText(value.providerLabel) &&
    isBoolean(value.discovered) &&
    isOneOf(value.phase, TEMPORAL_PHASES) &&
    isArrayOf(value.models, isTemporalModel) &&
    isArrayOf(value.holidays, isTemporalHoliday) &&
    isOptional(value.source, isTemporalSource)
  );
}

function isTemporalStatus(value: unknown): value is TemporalStatusSnapshot {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false;
  return (
    isFiniteNumber(value.generatedAtMs) &&
    isArrayOf(value.providers, isTemporalProvider) &&
    isText(value.snapshot.revision) &&
    isFiniteNumber(value.snapshot.generatedAtMs)
  );
}

export function isDashboardHealth(value: unknown): value is DashboardHealth {
  return (
    isRecord(value) &&
    value.app === "opencode-quota-gui" &&
    isFiniteNumber(value.contractVersion) &&
    isOptional(value.version, isText) &&
    isOptional(value.build, isText)
  );
}

export function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  return (
    isRecord(value) &&
    isFiniteNumber(value.generatedAtMs) &&
    isBoolean(value.stale) &&
    isText(value.timeZone) &&
    isProviders(value.providers) &&
    isOptional(value.temporal, isTemporalStatus)
  );
}

export function isHomeSnapshot(value: unknown): value is HomeSnapshot {
  return (
    isRecord(value) &&
    isFiniteNumber(value.generatedAtMs) &&
    isRangeKey(value.range) &&
    isBoolean(value.stale) &&
    isProviders(value.providers) &&
    isUsage(value.usage) &&
    isArrayOf(value.projects, isProjectActivityRow)
  );
}

function isAnalyticsIdentity(value: unknown): value is AnalyticsEntityIdentity {
  if (!isRecord(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  return value.kind === "known" && hasExactKeys(value, ["kind", "id"]) && isText(value.id);
}

function isAnalyticsGroupFilter(value: unknown): value is AnalyticsGroupFilter {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["dimension", "identity"]) &&
    isDimension(value.dimension) &&
    isAnalyticsIdentity(value.identity)
  );
}

/** Exact-key grouped query validation, including the nested filter identity. */
export function isAnalyticsGroupQuery(value: unknown): value is AnalyticsGroupQuery {
  if (!isRecord(value)) return false;
  if (!isRangeKey(value.range) || !isDimension(value.dimension)) return false;
  if (value.filter === undefined) {
    return hasExactKeys(value, ["range", "dimension"]);
  }
  return (
    hasExactKeys(value, ["range", "dimension", "filter"]) && isAnalyticsGroupFilter(value.filter)
  );
}

function isAnalyticsSeriesChildBucket(value: unknown): value is AnalyticsSeriesChildBucket {
  return isRecord(value) && isAnalyticsIdentity(value.identity) && isCostedTokens(value.tokens);
}

function isAnalyticsSeries(value: unknown): value is AnalyticsSeries {
  if (!isRecord(value)) return false;
  if (!isCostedTokens(value.tokens) || !isArrayOf(value.buckets, isCostedTokens)) return false;
  if (
    !isOptional(value.childBuckets, (buckets): buckets is AnalyticsSeriesChildBucket[][] =>
      isArrayOf(buckets, (row) => isArrayOf(row, isAnalyticsSeriesChildBucket)),
    )
  ) {
    return false;
  }
  if (value.kind === "entity") return isAnalyticsIdentity(value.identity);
  if (value.kind !== "other") return false;
  return isOptional(value.parentBuckets, (buckets): buckets is AnalyticsSeriesChildBucket[][] =>
    isArrayOf(buckets, (row) => isArrayOf(row, isAnalyticsSeriesChildBucket)),
  );
}

function isAnalyticsGroupRow(value: unknown): value is AnalyticsGroupRow {
  return (
    isRecord(value) &&
    isAnalyticsIdentity(value.identity) &&
    isCostedTokens(value.tokens) &&
    isFiniteNumber(value.sessionCount) &&
    isFiniteNumber(value.stepCount) &&
    isArrayOf(value.children, isAnalyticsGroupRow)
  );
}

function isAnalyticsTemporalBreakdown(value: unknown): value is AnalyticsTemporalBreakdown {
  return (
    isRecord(value) &&
    isArrayOf(
      value.rows,
      (row) =>
        isRecord(row) &&
        isAnalyticsIdentity(row.identity) &&
        isCostedTokens(row.peak) &&
        isCostedTokens(row.offpeak),
    )
  );
}

export function isAnalyticsGroupSnapshot(value: unknown): value is AnalyticsGroupSnapshot {
  return (
    isRecord(value) &&
    isDimension(value.dimension) &&
    isRangeKey(value.range) &&
    isRangeWindow(value.window) &&
    isBucketUnit(value.bucketUnit) &&
    isText(value.timeZone) &&
    isOptional(value.filter, isAnalyticsGroupFilter) &&
    isArrayOf(
      value.buckets,
      (bucket) =>
        isRecord(bucket) && isFiniteNumber(bucket.startMs) && isFiniteNumber(bucket.endMs),
    ) &&
    isCostedTokens(value.totals) &&
    isFiniteNumber(value.sessionCount) &&
    isFiniteNumber(value.stepCount) &&
    isArrayOf(value.rows, isAnalyticsGroupRow) &&
    isArrayOf(value.series, isAnalyticsSeries) &&
    isBoolean(value.stale) &&
    isOptional(value.temporalBreakdown, isAnalyticsTemporalBreakdown)
  );
}

function isProjectRootRow(value: unknown): value is ProjectRootRow {
  return (
    isRecord(value) &&
    isText(value.sessionId) &&
    isText(value.title) &&
    isOptional(value.worktreeLabel, isText) &&
    isCostedTokens(value.tokens) &&
    isFiniteNumber(value.latestActivityAtMs)
  );
}

export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!isRecord(value) || !isRecord(value.totals)) return false;
  return (
    isText(value.projectId) &&
    isText(value.name) &&
    isRangeKey(value.range) &&
    isRangeWindow(value.window) &&
    isArrayOf(value.roots, isProjectRootRow) &&
    isCostedTokens(value.totals) &&
    isFiniteNumber(value.totals.sessionCount) &&
    isUsage(value.usage) &&
    isBoolean(value.stale)
  );
}

function isSessionBreadcrumb(value: unknown): value is SessionSnapshot["breadcrumbs"][number] {
  return (
    isRecord(value) && isText(value.sessionId) && isText(value.title) && isBoolean(value.isFocus)
  );
}

function isSessionNode(value: unknown): value is SessionNode {
  return (
    isRecord(value) &&
    isText(value.sessionId) &&
    isText(value.title) &&
    isOptional(value.parentId, isText) &&
    isOptional(value.agent, isText) &&
    isFiniteNumber(value.depth) &&
    isOptional(value.worktreeLabel, isText) &&
    isArrayOf(value.childIds, isText) &&
    isCostedTokens(value.ownTokens) &&
    isCostedTokens(value.subtreeTokens) &&
    isFiniteNumber(value.stepCount) &&
    isFiniteNumber(value.subtreeNodeCount) &&
    isFiniteNumber(value.latestActivityAtMs)
  );
}

function isStepPoint(value: unknown): value is StepPoint {
  return (
    isRecord(value) &&
    isText(value.sessionId) &&
    isText(value.messageId) &&
    isFiniteNumber(value.atMs) &&
    isFiniteNumber(value.branch) &&
    isTokenStack(value.stack) &&
    isFiniteNumber(value.contextTokens) &&
    isFiniteNumber(value.totalTokens) &&
    isOptional(
      value.model,
      (model): model is { providerId: string; modelId: string } =>
        isRecord(model) && isText(model.providerId) && isText(model.modelId),
    ) &&
    isOptional(value.agent, isText)
  );
}

function isCompactionMarker(value: unknown): value is SessionSnapshot["compactionMarkers"][number] {
  return (
    isRecord(value) &&
    isText(value.sessionId) &&
    isFiniteNumber(value.atMs) &&
    isText(value.messageId)
  );
}

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value) || !isRecord(value.ownSummary)) return false;
  return (
    isText(value.focusSessionId) &&
    isText(value.timeZone) &&
    isText(value.projectId) &&
    isText(value.projectName) &&
    isArrayOf(value.breadcrumbs, isSessionBreadcrumb) &&
    isArrayOf(value.nodes, isSessionNode) &&
    isArrayOf(value.steps, isStepPoint) &&
    isArrayOf(value.compactionMarkers, isCompactionMarker) &&
    isCostedTokens(value.ownSummary) &&
    isFiniteNumber(value.ownSummary.stepCount) &&
    isCostedTokens(value.treeTotals) &&
    isText(value.stepSemantics)
  );
}

function isKeyMessages(value: unknown): value is { key: string; message: string }[] {
  return isArrayOf(value, (entry) => isRecord(entry) && isText(entry.key) && isText(entry.message));
}

function isSettingsIssue(value: unknown): value is SettingsSnapshot["issues"][number] {
  return isRecord(value) && isText(value.label) && isText(value.key) && isText(value.message);
}

function isProvenance(value: unknown): value is SettingsSnapshot["provenance"] {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) => isRecord(entry) && isOneOf(entry.scope, PROVENANCE_SCOPES),
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => isText(entry));
}

function isJsonMap(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));
}

export function isSettingsSnapshot(value: unknown): value is SettingsSnapshot {
  if (!isRecord(value) || !isRecord(value.dashboard) || !isRecord(value.visibility)) {
    return false;
  }
  if (!isRecord(value.import) || !isArrayOf(value.issues, isSettingsIssue)) return false;
  return (
    isText(value.revision) &&
    isText(value.pathLabel) &&
    isJsonMap(value.values) &&
    isStringMap(value.sources) &&
    isOptional(value.provenance, isProvenance) &&
    isArrayOf(value.writable, isText) &&
    isFiniteNumber(value.dashboard.port) &&
    isText(value.dashboard.url) &&
    isArrayOf(value.visibility.hiddenCards, isText) &&
    isArrayOf(value.visibility.hiddenRows, isText) &&
    isBoolean(value.import.available) &&
    isOptional(value.import.from, isText) &&
    isOptional(value.import.keyCount, isFiniteNumber) &&
    isKeyMessages(value.import.issues)
  );
}

export function isSettingsWriteResult(value: unknown): value is SettingsWriteResult {
  return (
    isRecord(value) &&
    isText(value.revision) &&
    isJsonMap(value.applied) &&
    isKeyMessages(value.warnings)
  );
}

export function isImportPreview(value: unknown): value is ImportPreview {
  return (
    isRecord(value) &&
    isText(value.from) &&
    isArrayOf(
      value.keys,
      (entry) => isRecord(entry) && isText(entry.key) && isJsonValue(entry.value),
    ) &&
    isKeyMessages(value.issues) &&
    isText(value.expectedRevision)
  );
}
