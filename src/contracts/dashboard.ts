import type { CardId, RowId } from "./identity.js";
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
}

export type RunwayProjection =
  | { kind: "before_reset"; projectedAtIso: string }
  | { kind: "lasts_past_reset" };

export interface ProviderCard {
  cardId: CardId;
  providerId: string;
  providerLabel: string;
  accountLabel?: string;
  labelSource: "connection" | "org" | "account" | "provider";
  rows: QuotaCardRow[];
  errors: { label: string; message: string; retryable?: boolean }[];
  /** Explicit safe field list only — never a raw `statusDetails` copy. */
  details?: { label: string; value: string }[];
  observedAtIso?: string;
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
