import type { CardId, RowId } from "./identity.js";
import type { BankedResetAvailability } from "./openai-quota.js";
import type { BucketUnit, RangeKey, RangeWindow } from "./ranges.js";

/**
 * Frozen GUI contracts (design spec §5.1–§5.4).
 *
 * Browser-safe: no Node, no DOM, no `src/lib` imports. Every name below is
 * frozen by the spec; the accounting unions are browser-safe mirrors of the
 * core `src/lib/entries.ts` definitions so the browser never imports core.
 */

/** Additive identity fields are absent on older, otherwise compatible servers. */
export interface DashboardHealth {
  app: "opencode-quota-gui";
  contractVersion: number;
  version?: string;
  build?: string;
}

/** Contract revision advertised by `DashboardDataSource.health()`. */
export const DASHBOARD_CONTRACT_VERSION = 2;

/** Values a settings payload may carry across the JSON boundary (`null` clears). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Browser-safe mirror of core `AccountingResultType`. */
export type AccountingResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";

/** Browser-safe mirror of core `AccountingWindow`. */
export type AccountingWindow =
  | "rpm"
  | "hour"
  | "five_hour"
  | "day"
  | "week"
  | "month"
  | "year"
  | "mcp"
  | "code_review";

/** Browser-safe mirror of core `AccountingComponent`. */
export type AccountingComponent =
  | "current_balance"
  | "total_balance"
  | "cash_balance"
  | "gift_balance"
  | "granted_balance"
  | "topped_up_balance"
  | "remaining_credits"
  | "auto_reload"
  | "auto_reload_amount"
  | "auto_reload_trigger";

/** Browser-safe mirror of core `AccountingMetric`; also the stable row-key vocabulary. */
export type AccountingMetric =
  | { kind: "aggregate" }
  | { kind: "window"; window: AccountingWindow }
  | { kind: "component"; component: AccountingComponent }
  | { kind: "named"; name: string };

/** Browser-safe mirror of core `AccountingCountUnit`. */
export type AccountingCountUnit =
  | "request"
  | "token"
  | "credit"
  | "message"
  | "interaction"
  | "unit";

/** Browser-safe mirror of core `AccountingUnit`. */
export type AccountingUnit =
  | { kind: "currency"; code: string }
  | { kind: "count"; unit: AccountingCountUnit }
  | { kind: "custom"; symbol: string };

/** The five raw additive token categories (R31, R48). */
export interface TokenStack {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/** A `TokenStack` with its derived total and API-equivalent cost (never provider spend). */
export interface CostedTokens extends TokenStack {
  total: number;
  apiEquivalentCostUsd: number | null;
  unpricedTokens: number;
  unknownTokens: number;
}

export interface Bucket {
  startMs: number;
  endMs: number;
  tokens: CostedTokens;
}

export interface Usage {
  range: RangeKey;
  window: RangeWindow;
  bucketUnit: BucketUnit;
  /**
   * IANA zone of the machine that owns the calendar buckets. Every bucket
   * boundary is that zone's local hour/day; the browser must format with this
   * zone rather than its own.
   */
  timeZone: string;
  buckets: Bucket[];
  totals: CostedTokens;
  stepCount: number;
  sessionCount: number;
  stale: boolean;
}

/** Grouping axis for model/provider analytics. */
export type AnalyticsDimension = "model" | "provider";

/**
 * Exact raw identity of one analytics group. `unknown` is an explicit missing
 * identity: it never aliases a known raw id, including the empty string.
 */
export type AnalyticsEntityIdentity = { kind: "known"; id: string } | { kind: "unknown" };

/** One range bucket boundary shared by every row and series in a grouped snapshot. */
export interface AnalyticsBucketBoundary {
  startMs: number;
  endMs: number;
}

/**
 * One grouped model/provider row. A parent groups by the query dimension; its
 * children group the same owned steps by the opposite dimension and are always
 * present when the subtree has usage, including a sole child.
 *
 * Rows intentionally carry totals only. Bucket series live on
 * `AnalyticsSeries`, so output stays bounded by series × buckets instead of
 * (parents + children) × buckets for long lifetimes.
 */
export interface AnalyticsGroupRow {
  identity: AnalyticsEntityIdentity;
  /** Subtree totals; token categories equal the sum of the children's. */
  tokens: CostedTokens;
  /** Distinct owning sessions in this subtree (a set union, not a row count). */
  sessionCount: number;
  /** Fork-deduplicated owned steps in this subtree. */
  stepCount: number;
  children: AnalyticsGroupRow[];
}

/**
 * One opposite-dimension contribution inside a chart series bucket. For a
 * model-series bucket, `identity` is a provider; for a provider-series bucket
 * it is a model. The bucket entries are sparse: children with zero usage are
 * omitted, and each child appears at most once per bucket.
 */
export interface AnalyticsSeriesChildBucket {
  identity: AnalyticsEntityIdentity;
  tokens: CostedTokens;
}

/**
 * One hidden same-dimension parent's additive share inside an Other bucket.
 * The shape matches `AnalyticsSeriesChildBucket`; only `identity` differs: it
 * uses the snapshot's own dimension (models when grouping by model). Entries
 * are sparse and unique per bucket, so Other's composition is inspectable
 * without a dense hidden-parent × bucket matrix.
 */
export type AnalyticsSeriesParentBucket = AnalyticsSeriesChildBucket;

/**
 * One chart series for the visible grouping level, ranked by selected-range
 * token volume. The trailing `"other"` series aggregates every entity outside
 * the top five; it is chart-only and never replaces the breakdown rows.
 */
export type AnalyticsSeries =
  | {
      kind: "entity";
      identity: AnalyticsEntityIdentity;
      tokens: CostedTokens;
      /** Aligned index-for-index with `AnalyticsGroupSnapshot.buckets`. */
      buckets: CostedTokens[];
      /**
       * Additive in-bar subdivision: the opposite-dimension children inside
       * each bucket, aligned index-for-index with `buckets`. Token categories,
       * unpriced tokens, and unknown tokens conserve that same-index bucket;
       * numeric cost also conserves it subject to floating-point rounding.
       * This host always emits it for a series with
       * usage; it is optional so older snapshots and readers remain compatible.
       */
      childBuckets?: AnalyticsSeriesChildBucket[][];
    }
  | {
      kind: "other";
      tokens: CostedTokens;
      buckets: CostedTokens[];
      /**
       * Real children of every parent outside the top five, aggregated by exact
       * child identity per bucket — never a remainder derived from a total.
       */
      childBuckets?: AnalyticsSeriesChildBucket[][];
      /**
       * Sparse hidden same-dimension parents aggregated into Other, aligned
       * index-for-index with `buckets`. Each entry is one exact raw parent
       * identity with its real bucket tokens (token categories, cost status,
       * unpriced and unknown counts), so inspection needs no row rescan and no
       * hidden-parent × bucket dense array. Only Other carries this field.
       */
      parentBuckets?: AnalyticsSeriesParentBucket[][];
    };

/**
 * Exact entity selector for a grouped query. `dimension` names the entity kind
 * independently of the query's grouping dimension, so a model detail query can
 * group by provider while filtering one model (and vice versa).
 */
export interface AnalyticsGroupFilter {
  dimension: AnalyticsDimension;
  identity: AnalyticsEntityIdentity;
}

/** Input for one grouped model/provider query. */
export interface AnalyticsGroupQuery {
  range: RangeKey;
  dimension: AnalyticsDimension;
  /**
   * Optional exact entity filter, matched by both its entity dimension and its
   * identity kind + raw id. A known empty/whitespace/delimiter-bearing id never
   * matches `unknown`. No usage in range yields zero totals and empty
   * rows/series; the echoed `filter` still identifies the selection.
   */
  filter?: AnalyticsGroupFilter;
}

/** One range-certified grouped model/provider snapshot. */
export interface AnalyticsGroupSnapshot {
  dimension: AnalyticsDimension;
  range: RangeKey;
  window: RangeWindow;
  bucketUnit: BucketUnit;
  timeZone: string;
  /** Echo of the applied query filter; absent for an unfiltered query. */
  filter?: AnalyticsGroupFilter;
  /** Range bucket boundaries; every series bucket aligns by index. */
  buckets: AnalyticsBucketBoundary[];
  totals: CostedTokens;
  sessionCount: number;
  stepCount: number;
  rows: AnalyticsGroupRow[];
  /**
   * Top five `rows` by selected-range token volume plus Other, for both
   * filtered and unfiltered queries. Only these series carry bucket arrays and
   * per-bucket breakdowns; Other additionally carries its hidden
   * same-dimension parent breakdown.
   */
  series: AnalyticsSeries[];
  stale: boolean;
}

export interface QuotaCardRow {
  rowId: RowId;
  label: string;
  /** Optional short help text for the GUI row label. */
  info?: string;
  kind: "percent" | "value" | "quantity" | "boolean";
  resultType: AccountingResultType;
  metric?: AccountingMetric;
  percentRemaining?: number;
  percentUsed?: number;
  quantity?: { decimal: string; unit: AccountingUnit };
  value?: string;
  booleanValue?: boolean;
  resetAtIso?: string;
  countdown?: string;
  runway?: RunwayProjection;
  detailRows?: { label: string; value: string }[];
  /** Additive OpenAI resets metadata; absent for every other row/provider. */
  bankedResets?: BankedResetAvailability;
}

export type RunwayProjection =
  | { kind: "before_reset"; projectedAtIso: string }
  | { kind: "lasts_past_reset" };

export interface ProviderCard {
  cardId: CardId;
  providerId: string;
  providerLabel: string;
  /** Display-only plan shown before the account; never an identity input. */
  planLabel?: string;
  accountLabel?: string;
  labelSource: "connection" | "org" | "account" | "provider";
  /**
   * Additive presentation metadata (optional for backwards compatibility): the
   * provider-scope card id for this card's provider and its bare hash form.
   * Settings uses these authoritative opaque values to recognize legacy
   * provider-wide hides without hashing or reconstructing identities.
   */
  providerScopeId?: CardId;
  providerScopeHash?: string;
  rows: QuotaCardRow[];
  errors: { label: string; message: string; retryable?: boolean }[];
  /** Explicit safe field list only — never a raw `statusDetails` copy. */
  details?: { label: string; value: string }[];
  observedAtIso?: string;
  /**
   * Persistent optional-row choices (additive): stable ids and labels exist
   * even when runtime values are absent. Never synthetic zero data rows.
   */
  visibilityRows?: { rowId: RowId; label: string; info?: string }[];
}

export interface ProjectActivityRow {
  projectId: string;
  name: string;
  tokens: CostedTokens;
  rootSessionCount: number;
  latestActivityAtMs: number;
}

export interface HomeSnapshot {
  generatedAtMs: number;
  range: RangeKey;
  stale: boolean;
  providers: { cards: ProviderCard[]; enabledProviders: string[] | "auto"; polledAtMs: number };
  usage: Usage;
  projects: ProjectActivityRow[];
}

/**
 * Independent quota/provider read (transport contract). Analytics never waits
 * on this; a quota viewer never starts the analytics worker.
 */
export interface QuotaSnapshot {
  generatedAtMs: number;
  stale: boolean;
  /** Host zone used to format `polledAtMs` and quota reset timestamps. */
  timeZone: string;
  providers: HomeSnapshot["providers"];
}

export interface ProjectRootRow {
  sessionId: string;
  title: string;
  worktreeLabel?: string;
  tokens: CostedTokens;
  latestActivityAtMs: number;
}

export interface ProjectSnapshot {
  projectId: string;
  name: string;
  range: RangeKey;
  window: RangeWindow;
  roots: ProjectRootRow[];
  totals: CostedTokens & { sessionCount: number };
  usage: Usage;
  stale: boolean;
}

export interface SessionNode {
  sessionId: string;
  parentId?: string;
  title: string;
  /** Persisted session agent, falling back to the latest known owned assistant agent. */
  agent?: string;
  depth: number;
  worktreeLabel?: string;
  childIds: string[];
  ownTokens: CostedTokens;
  subtreeTokens: CostedTokens;
  stepCount: number;
  subtreeNodeCount: number;
  latestActivityAtMs: number;
}

export interface StepPoint {
  sessionId: string;
  messageId: string;
  atMs: number;
  branch: number;
  stack: TokenStack;
  contextTokens: number;
  totalTokens: number;
  model?: { providerId: string; modelId: string };
  agent?: string;
}

export interface SessionSnapshot {
  focusSessionId: string;
  /** Host zone used to format every step/compaction timestamp. */
  timeZone: string;
  /** Owning project of the focus session; the explicit parent crumb above session ancestors. */
  projectId: string;
  projectName: string;
  breadcrumbs: { sessionId: string; title: string; isFocus: boolean }[];
  nodes: SessionNode[];
  steps: StepPoint[];
  compactionMarkers: { sessionId: string; atMs: number; messageId: string }[];
  ownSummary: CostedTokens & { stepCount: number };
  treeTotals: CostedTokens;
  stepSemantics: string;
}

export interface SettingProvenance {
  scope: "defaults" | "global" | "workspace" | "project" | "legacy";
}

export interface SettingsSnapshot {
  revision: string;
  /**
   * Absolute canonical GUI settings file path. This is the one deliberate
   * display exception requested by the user; every other field stays
   * path-redacted.
   */
  pathLabel: string;
  values: Record<string, JsonValue>;
  sources: Record<string, string>;
  /** Actual winning loader scope. Optional for older contract-2 hosts. No paths. */
  provenance?: Record<string, SettingProvenance>;
  writable: readonly string[];
  dashboard: { port: number; url: string };
  visibility: { hiddenCards: string[]; hiddenRows: string[] };
  import: {
    available: boolean;
    from?: string;
    keyCount?: number;
    issues: { key: string; message: string }[];
  };
  issues: { label: string; key: string; message: string }[];
}

export interface SettingsWriteResult {
  revision: string;
  applied: Record<string, JsonValue>;
  warnings: { key: string; message: string }[];
}

export interface ImportPreview {
  from: string;
  keys: { key: string; value: JsonValue }[];
  issues: { key: string; message: string }[];
  /** Covers the canonical file and every inherited source the import copies from. */
  expectedRevision: string;
}

export type DashboardEventTopic = "quota.changed" | "sessions.changed" | "settings.changed";

export interface DashboardEvent {
  topic: DashboardEventTopic;
  at: number;
  scope?: "visibility";
}

/** Transport-neutral browser seam (spec §5.1); every member has a producer. */
export interface DashboardDataSource {
  health(): Promise<DashboardHealth>;
  home(input: { range: RangeKey }): Promise<HomeSnapshot>;
  quota(): Promise<QuotaSnapshot>;
  project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot>;
  session(input: { sessionId: string }): Promise<SessionSnapshot>;
  /** Range-certified grouped model/provider analytics (one exact query). */
  groups(input: AnalyticsGroupQuery): Promise<AnalyticsGroupSnapshot>;
  settings(): Promise<SettingsSnapshot>;
  saveSettings(input: {
    patch: Record<string, JsonValue>;
    expectedRevision: string;
  }): Promise<SettingsWriteResult>;
  saveVisibility(input: {
    hiddenCards: string[];
    hiddenRows: string[];
    expectedRevision: string;
  }): Promise<SettingsWriteResult>;
  importPreview(): Promise<ImportPreview>;
  importApply(input: { expectedRevision: string }): Promise<SettingsWriteResult>;
  /**
   * Optional additive seam: open the fixed canonical GUI settings file with
   * the OS default application. No arguments, no caller path.
   */
  openSettingsFile?(): Promise<void>;
  subscribe(onEvent: (event: DashboardEvent) => void): () => void;
}

/** Read/write config seam for the GUI server (P2 store satisfies this Pick). */
export type GuiSettingsStore = Pick<
  DashboardDataSource,
  | "settings"
  | "saveSettings"
  | "saveVisibility"
  | "importPreview"
  | "importApply"
  | "openSettingsFile"
>;
