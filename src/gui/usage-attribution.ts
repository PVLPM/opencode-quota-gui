/**
 * Pure quota-burn attribution (USAGE_IMPLEMENTATION.md D7/D8).
 *
 * Paste-level semantics, no effort multipliers and no delay buffers:
 * - Only a provider-observed interval with burn > 0 can be attributed.
 * - An account is eligible only while it is the sole observed account of its
 *   provider; the caller supplies that boolean per interval.
 * - Every eligible step must be fully priced and the summed weight must be
 *   positive; otherwise the whole interval's burn stays unattributed while its
 *   recorded tokens are still reported.
 * - A model-specific window narrows eligibility; an unknown window matches
 *   nothing instead of guessing.
 *
 * The input activity is the host-side `source.activity(...)` result, aligned
 * 1:1 with the intervals of exactly one quota window.
 */
import type { CostedTokens } from "../contracts/dashboard.js";
import { MISTRAL_VIBE_BUDGET_ROW_KEY } from "../contracts/mistral-vibe-quota.js";
import type { UsageBreakdownRow, UsageLink, UsageUnattributedReason } from "../contracts/usage.js";
import type { UsageActivityInterval } from "../contracts/usage-activity.js";
import {
  type CanonicalQuotaProviderId,
  getQuotaProviderRegistration,
} from "../lib/provider-metadata.js";
import { modelIncludesAny } from "../lib/provider-model-matching.js";

export interface UsageAttributionIntervalInput {
  startMs: number;
  endMs: number;
  /** Observed decrease in percentage points; `null` across a boundary. */
  burnPercentPoints: number | null;
  link: UsageLink["kind"];
  /** False when another account of the same provider was also observed. */
  soleObservedAccount: boolean;
}

export interface UsageAttributionRequest {
  /** Intervals of exactly one quota window. */
  intervals: readonly UsageAttributionIntervalInput[];
  /** Aligned 1:1 with `intervals`. */
  activity: readonly UsageActivityInterval[];
  /** OpenCode runtime provider ids of the card's account. */
  providerIds: readonly string[];
  /** Model-specific window narrowing; absent = every model is eligible. */
  isEligibleModel?: (modelId: string) => boolean;
}

export interface UsageAttributionEntry {
  providerId: string;
  modelId: string;
  effort?: string;
  tokens: CostedTokens;
  stepCount: number;
  /** Present only when this window's burn was fully attributed. */
  estimatedBurnPercentPoints?: number;
}

export interface UsageAttributionInterval {
  startMs: number;
  endMs: number;
  burnPercentPoints: number | null;
  attributedBurnPercentPoints: number;
  unattributedBurnPercentPoints: number;
  unattributedReason?: UsageUnattributedReason;
  /** Eligible activity; tokens stay present even when the burn is unattributed. */
  activity: UsageAttributionEntry[];
}

export interface UsageAttributionResult {
  intervals: UsageAttributionInterval[];
  /** One window's model rows, with effort children. */
  breakdown: UsageBreakdownRow[];
}

/**
 * Attribution billing scope per quota provider, reviewed against the provider
 * sources. These are the runtime provider ids whose activity bills that card;
 * they are deliberately not the broader discovery/availability aliases
 * (`getQuotaProviderRuntimeIds`) because a discovery alias can route several
 * providers or a non-plan API. Unknown ids are never attributed.
 *
 * Sources: `src/lib/provider-registration.ts` (row contracts),
 * `src/providers/*.ts` `matchesCurrentModel`, and `docs/readme/providers.md`.
 */
const ATTRIBUTION_RUNTIME_IDS: Readonly<Record<CanonicalQuotaProviderId, readonly string[]>> = {
  anthropic: ["anthropic"],
  "claude-agent": ["claude-agent", "claude-code"],
  copilot: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
  openai: ["openai", "chatgpt", "codex"],
  openrouter: ["openrouter"],
  kilo: ["kilo"],
  cursor: ["cursor", "cursor-acp"],
  "alibaba-coding-plan": ["alibaba-coding-plan"],
  "alibaba-token-plan": ["alibaba-token-plan"],
  synthetic: ["synthetic"],
  chutes: ["chutes", "chutes-ai"],
  // Generic `google` is a discovery alias that can serve non-Gemini routes, so
  // it is not billing evidence for a Gemini Code Assist plan.
  "google-gemini-cli": ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth"],
  "google-agy": ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  zai: ["zai", "glm", "zai-coding-plan"],
  zhipu: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
  nanogpt: ["nanogpt", "nano-gpt"],
  // `minimax` is claimed by the global registration and conditionally by the CN
  // provider (`minimax-coding-plan.ts` matches provider `minimax` when the CN
  // plan is explicitly enabled), so neither card may claim it.
  "minimax-coding-plan": ["minimax-coding-plan"],
  "minimax-china-coding-plan": [
    "minimax-china-coding-plan",
    "minimax-cn-coding-plan",
    "minimax-cn",
    "minimax-china",
  ],
  "kimi-code-plan-global": ["kimi-code-plan-global"],
  "kimi-code-plan-cn": ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"],
  deepseek: ["deepseek"],
  // A Mistral login's API activity bills the account's pay-as-you-go API budget,
  // never the Vibe subscription allowance (that row is unattributable below).
  mistral: ["mistral"],
  xai: ["xai"],
  xiaomi: ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
  "opencode-go": ["opencode-go"],
  opencode: ["opencode", "opencode-zen"],
  "ollama-cloud": ["ollama-cloud"],
  "quota-providers": [],
};

interface AttributionRowRule {
  /** Extra model scope; absent = every model of the eligible providers. */
  modelFragments?: readonly string[];
  /** This row's quota is not consumed by the account's model activity. */
  unattributable?: true;
}

/** Row-specific overrides keyed by `${quotaProviderId}\0${baseRowKey}`. */
const ATTRIBUTION_ROW_RULES: Readonly<Record<string, AttributionRowRule>> = {
  // Code Review has its own product quota, not the ChatGPT/Codex windows.
  "openai\u0000window:code_review": { unattributable: true },
  // Fable weekly is the only model-scoped Claude Agent window.
  "claude-agent\u0000named:Fable weekly": { modelFragments: ["fable"] },
  // AGY reports one family row per model family (`agyBucketRowKey`).
  "google-agy\u0000named:Gemini Models weekly": { modelFragments: ["gemini"] },
  "google-agy\u0000named:Gemini Models 5h": { modelFragments: ["gemini"] },
  "google-agy\u0000named:Claude and GPT models weekly": { modelFragments: ["claude", "gpt"] },
  "google-agy\u0000named:Claude and GPT models 5h": { modelFragments: ["claude", "gpt"] },
  // The Vibe allowance is a subscription meter; OpenCode's Mistral API activity
  // bills the separate pay-as-you-go API budget row instead.
  [`mistral\u0000${MISTRAL_VIBE_BUDGET_ROW_KEY}`]: { unattributable: true },
};

/** AGY rows are family rows; an unrecognized family has unknown billing scope. */
const ROW_SCOPED_PROVIDERS: ReadonlySet<CanonicalQuotaProviderId> = new Set(["google-agy"]);

export interface UsageAttributionScope {
  /** False when the row's billing scope cannot be proven; never attribute then. */
  known: boolean;
  /** Runtime provider ids whose activity bills this row. */
  providerIds: readonly string[];
  /** Model-family narrowing; absent = every model is eligible. */
  isEligibleModel?: (modelId: string) => boolean;
}

const UNKNOWN_ATTRIBUTION_SCOPE: UsageAttributionScope = { known: false, providerIds: [] };

/** Stored row keys end with `|<resultType>:<kind>`; rules use the base row key. */
function baseRowKey(rowKey: string): string {
  const discriminator = rowKey.lastIndexOf("|");
  return discriminator >= 0 ? rowKey.slice(0, discriminator) : rowKey;
}

/**
 * Billing scope for one quota row. Keyed by (quotaProviderId, rowKey), never by
 * a discovered runtime-id list. An unknown provider, an unknown family row or
 * an explicitly non-attributable window returns `known: false` with no ids.
 */
export function attributionScopeForRow(
  quotaProviderId: string,
  rowKey: string,
): UsageAttributionScope {
  const registration = getQuotaProviderRegistration(quotaProviderId);
  if (registration === undefined) return UNKNOWN_ATTRIBUTION_SCOPE;
  const providerId = registration.id;
  const rule = ATTRIBUTION_ROW_RULES[`${providerId}\u0000${baseRowKey(rowKey)}`];
  if (rule?.unattributable === true) return UNKNOWN_ATTRIBUTION_SCOPE;
  if (rule === undefined && ROW_SCOPED_PROVIDERS.has(providerId)) {
    return UNKNOWN_ATTRIBUTION_SCOPE;
  }
  const providerIds = ATTRIBUTION_RUNTIME_IDS[providerId];
  if (providerIds.length === 0) return UNKNOWN_ATTRIBUTION_SCOPE;
  const fragments = rule?.modelFragments;
  return {
    known: true,
    providerIds,
    ...(fragments !== undefined
      ? { isEligibleModel: (modelId: string) => modelIncludesAny(modelId, fragments) }
      : {}),
  };
}

export interface UsageNamedWindowEligibility {
  /** False when the window's model scope is unknown; never attribute then. */
  known: boolean;
  matches(modelId: string): boolean;
}

/**
 * Named windows whose quota is scoped to one model family. `Fable weekly` is
 * the only model-scoped named window the providers currently report.
 */
const MODEL_SPECIFIC_NAMED_WINDOWS: Readonly<Record<string, readonly string[]>> = {
  "fable weekly": ["fable"],
};

function normalizeNamedWindow(namedWindow: string): string {
  return namedWindow
    .trim()
    .toLowerCase()
    .replace(/^named:/u, "")
    .trim();
}

/**
 * Eligibility for a named quota window. A declared but provider-wide named
 * window matches every model; an unknown name matches nothing.
 */
export function modelEligibilityForNamedWindow(
  quotaProviderId: string,
  namedWindow: string,
): UsageNamedWindowEligibility {
  const name = normalizeNamedWindow(namedWindow);
  const fragments = MODEL_SPECIFIC_NAMED_WINDOWS[name];
  if (fragments !== undefined) {
    return { known: true, matches: (modelId) => modelIncludesAny(modelId, fragments) };
  }
  const registration = getQuotaProviderRegistration(quotaProviderId);
  const declared =
    registration?.optionalVisibilityRows?.some(
      (row) => row.rowKey.startsWith("named:") && normalizeNamedWindow(row.rowKey) === name,
    ) ?? false;
  return declared ? { known: true, matches: () => true } : { known: false, matches: () => false };
}

/** Complete pricing: every token has a finite, non-negative API-equivalent cost. */
function isFullyPriced(tokens: CostedTokens): boolean {
  return (
    tokens.apiEquivalentCostUsd !== null &&
    Number.isFinite(tokens.apiEquivalentCostUsd) &&
    tokens.apiEquivalentCostUsd >= 0 &&
    tokens.unpricedTokens === 0 &&
    tokens.unknownTokens === 0
  );
}

function attributeInterval(
  interval: UsageAttributionIntervalInput,
  activity: UsageActivityInterval,
  providerIds: ReadonlySet<string>,
  isEligibleModel: ((modelId: string) => boolean) | undefined,
): UsageAttributionInterval {
  const reported = activity.entries.filter((entry) => providerIds.has(entry.providerId));
  const eligible =
    isEligibleModel === undefined
      ? reported
      : reported.filter((entry) => isEligibleModel(entry.modelId));
  const result: UsageAttributionInterval = {
    startMs: interval.startMs,
    endMs: interval.endMs,
    burnPercentPoints: interval.burnPercentPoints,
    attributedBurnPercentPoints: 0,
    unattributedBurnPercentPoints: 0,
    activity: eligible,
  };
  const burn = interval.burnPercentPoints;
  if (interval.link === "boundary" || burn === null || !(burn > 0)) return result;

  const unattributed = (reason: UsageUnattributedReason): UsageAttributionInterval => ({
    ...result,
    unattributedBurnPercentPoints: burn,
    unattributedReason: reason,
  });
  if (interval.link === "unobserved") return unattributed("unobserved-interval");
  if (!interval.soleObservedAccount) return unattributed("ambiguous-account");
  // A matching-provider step without a model id has positive tokens but no way
  // to be priced or weighted, so the burn cannot be complete.
  if ((activity.unidentifiedSteps ?? 0) > 0 || (activity.unidentifiedTokens ?? 0) > 0) {
    return unattributed("unidentified-activity");
  }
  if (reported.length === 0) return unattributed("no-activity");
  if (eligible.length === 0) return unattributed("zero-weight");
  if (!eligible.every((entry) => isFullyPriced(entry.tokens))) return unattributed("unpriced");

  let totalWeight = 0;
  for (const entry of eligible) {
    totalWeight += Math.max(0, entry.tokens.apiEquivalentCostUsd ?? 0);
  }
  if (!Number.isFinite(totalWeight) || !(totalWeight > 0)) {
    return unattributed("zero-weight");
  }

  return {
    ...result,
    attributedBurnPercentPoints: burn,
    activity: eligible.map((entry) => ({
      ...entry,
      estimatedBurnPercentPoints:
        burn * (Math.max(0, entry.tokens.apiEquivalentCostUsd ?? 0) / totalWeight),
    })),
  };
}

/** Attribute every interval of one window and derive its model breakdown. */
export function attributeUsageWindow(request: UsageAttributionRequest): UsageAttributionResult {
  if (request.activity.length !== request.intervals.length) {
    throw new TypeError("activity intervals must align with series intervals");
  }
  const providerIds = new Set(request.providerIds);
  const intervals = request.intervals.map((interval, index) => {
    const activity = request.activity[index];
    if (activity === undefined) throw new TypeError("missing activity interval");
    if (activity.startMs !== interval.startMs || activity.endMs !== interval.endMs) {
      throw new TypeError("activity interval boundaries must match series intervals");
    }
    return attributeInterval(interval, activity, providerIds, request.isEligibleModel);
  });
  return { intervals, breakdown: buildUsageAttributionBreakdown(intervals) };
}

interface TokenTotal {
  tokens: CostedTokens;
  stepCount: number;
  estimatedBurnPercentPoints?: number;
}

interface ModelTokenTotal extends TokenTotal {
  efforts: Map<string | undefined, TokenTotal>;
}

function emptyCostedTokens(): CostedTokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function addCostedTokens(target: CostedTokens, source: CostedTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
  target.unpricedTokens += source.unpricedTokens;
  target.unknownTokens += source.unknownTokens;
  if (source.apiEquivalentCostUsd !== null) {
    target.apiEquivalentCostUsd = (target.apiEquivalentCostUsd ?? 0) + source.apiEquivalentCostUsd;
  }
  if (source.recordedCostUsd !== undefined) {
    target.recordedCostUsd = (target.recordedCostUsd ?? 0) + source.recordedCostUsd;
  }
  if (source.recordedCostTokens !== undefined) {
    target.recordedCostTokens = (target.recordedCostTokens ?? 0) + source.recordedCostTokens;
  }
}

function createTokenTotal(): TokenTotal {
  return { tokens: emptyCostedTokens(), stepCount: 0 };
}

function createModelTokenTotal(): ModelTokenTotal {
  return { ...createTokenTotal(), efforts: new Map() };
}

function addEntryToTotal(total: TokenTotal, entry: UsageAttributionEntry): void {
  addCostedTokens(total.tokens, entry.tokens);
  total.stepCount += entry.stepCount;
  if (entry.estimatedBurnPercentPoints !== undefined) {
    total.estimatedBurnPercentPoints =
      (total.estimatedBurnPercentPoints ?? 0) + entry.estimatedBurnPercentPoints;
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Model rows with effort children for one window's intervals. Tokens and
 * estimated points are summed across exactly the intervals passed in; never
 * combine intervals from different quota windows.
 */
export function buildUsageAttributionBreakdown(
  intervals: readonly UsageAttributionInterval[],
): UsageBreakdownRow[] {
  const models = new Map<string, ModelTokenTotal & { providerId: string; modelId: string }>();
  for (const interval of intervals) {
    for (const entry of interval.activity) {
      const key = `${entry.providerId}\u0000${entry.modelId}`;
      let model = models.get(key);
      if (model === undefined) {
        model = {
          ...createModelTokenTotal(),
          providerId: entry.providerId,
          modelId: entry.modelId,
        };
        models.set(key, model);
      }
      addEntryToTotal(model, entry);
      let effort = model.efforts.get(entry.effort);
      if (effort === undefined) {
        effort = createTokenTotal();
        model.efforts.set(entry.effort, effort);
      }
      addEntryToTotal(effort, entry);
    }
  }

  const rows = [...models.values()].sort((a, b) => {
    const byTokens = b.tokens.total - a.tokens.total;
    if (byTokens !== 0) return byTokens;
    return compareIds(a.providerId, b.providerId) || compareIds(a.modelId, b.modelId);
  });
  return rows.map((model) => {
    const row: UsageBreakdownRow = {
      providerId: model.providerId,
      modelId: model.modelId,
      tokens: model.tokens,
      stepCount: model.stepCount,
      efforts: [...model.efforts]
        .sort(([aEffort, a], [bEffort, b]) => {
          const byTokens = b.tokens.total - a.tokens.total;
          if (byTokens !== 0) return byTokens;
          if (aEffort === bEffort) return 0;
          if (aEffort === undefined) return 1;
          if (bEffort === undefined) return -1;
          return compareIds(aEffort, bEffort);
        })
        .map(([effort, total]) => {
          const child: UsageBreakdownRow["efforts"][number] = {
            tokens: total.tokens,
            stepCount: total.stepCount,
          };
          if (effort !== undefined) child.effort = effort;
          if (total.estimatedBurnPercentPoints !== undefined) {
            child.estimatedBurnPercentPoints = total.estimatedBurnPercentPoints;
          }
          return child;
        }),
    };
    if (model.estimatedBurnPercentPoints !== undefined) {
      row.estimatedBurnPercentPoints = model.estimatedBurnPercentPoints;
    }
    return row;
  });
}
