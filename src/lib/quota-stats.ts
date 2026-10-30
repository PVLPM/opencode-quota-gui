import { encodeIdentityKey } from "../contracts/collision-safe-key.js";
import {
  isCursorModelId,
  isCursorProviderId,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "./cursor-pricing.js";
import {
  type CostBuckets,
  hasCatalogModel,
  hasCost,
  hasModel,
  hasProvider,
  isModelsDevProviderId,
  listProvidersForModelId,
  lookupCost,
  selectCostAtContext,
} from "./modelsdev-pricing.js";
import { getTemporalPolicy, resolveTemporalRates } from "./modelsdev-temporal.js";
import { getOpenCodeDbPath } from "./opencode-db-path.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import {
  iterAssistantMessages,
  iterAssistantMessagesForSession,
  iterAssistantMessagesForSessions,
  readAllSessionsIndex,
  SessionNotFoundError,
} from "./opencode-storage.js";
import type { TokenBuckets } from "./token-buckets.js";
import { addTokenBuckets, emptyTokenBuckets, tokenBucketsFromMessage } from "./token-buckets.js";
import {
  calculateUsdFromTokenBuckets,
  splitTokenBucketsByRate,
  tokenRateCoverage,
} from "./token-cost.js";

// Re-export for consumers
export { SessionNotFoundError } from "./opencode-storage.js";
export type { TokenBuckets } from "./token-buckets.js";

export type PricedKey = {
  provider: string;
  model: string;
};

export type UnknownKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider?: string;
  mappedModel?: string;
  normalizedModelID?: string;
  providerCandidates?: string[];
  reason?: "missing_model" | "missing_provider" | "ambiguous_model";
};

export type PricingResolution =
  | {
      ok: true;
      key: PricedKey;
      method:
        | "source_provider"
        | "model_prefix"
        | "unique_model"
        | "alias_fallback"
        | "cursor_local"
        | "cursor_api_alias";
    }
  | { ok: false; unknown: UnknownKey };

export type AggregateRow = {
  key: PricedKey;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
  /** Messages in this row whose cost excludes unpriced token buckets. */
  partialMessageCount?: number;
};

export type SessionRow = {
  sessionID: string;
  title?: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
  /** Messages in this session whose cost excludes unpriced token buckets. */
  partialMessageCount?: number;
  /** Messages in this session that contributed a known cost (including zero). */
  pricedMessageCount?: number;
  /** Messages in this session with no known cost (fully unpriced or unknown). */
  unpricedMessageCount?: number;
};

export type SourceProviderRow = {
  providerID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
  /** Messages in this provider whose cost excludes unpriced token buckets. */
  partialMessageCount?: number;
};

export type SourceModelRow = {
  sourceProviderID: string;
  sourceModelID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
  /** Messages in this model whose cost excludes unpriced token buckets. */
  partialMessageCount?: number;
};

export type UnknownRow = {
  key: UnknownKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type UnpricedKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider: string;
  mappedModel: string;
  reason: string;
};

export type UnpricedRow = {
  key: UnpricedKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type SessionTreeNode = {
  sessionID: string;
  parentID?: string;
  title?: string;
  depth: number;
};

export type AggregateResult = {
  window: { sinceMs?: number; untilMs?: number };
  totals: {
    priced: TokenBuckets;
    unknown: TokenBuckets;
    unpriced: TokenBuckets;
    costUsd: number;
    messageCount: number;
    sessionCount: number;
    /** Known subtotal contributed by messages with partially known rates. */
    partialCostUsd?: number;
    /** Messages whose cost excludes at least one unpriced token bucket. */
    partialMessageCount?: number;
  };
  bySourceProvider: SourceProviderRow[];
  bySourceModel: SourceModelRow[];
  byModel: AggregateRow[];
  bySession: SessionRow[];
  unknown: UnknownRow[];
  unpriced: UnpricedRow[];
};

function normalizeModelId(raw: string): string {
  let s = raw.trim();

  // routing prefixes
  if (s.toLowerCase().startsWith("antigravity-")) s = s.slice("antigravity-".length);
  // claude dotted versions -> hyphenated (models.dev uses dash): 4.5 -> 4-5, 4.6 -> 4-6, etc.
  s = s.replace(/(claude-[a-z-]+)-(\d+)\.(\d+)(?=$|[^0-9])/gi, "$1-$2-$3");
  // special: "glm-4.7-free" -> "glm-4.7"
  s = s.replace(/\bglm-(\d+)\.(\d+)-free\b/i, "glm-$1.$2");
  // internal OpenCode alias (Zen)
  if (s.toLowerCase() === "big-pickle") s = "glm-4.7";
  return s;
}

function stripFreeSuffix(modelId: string): string | null {
  if (!modelId.toLowerCase().endsWith("-free")) return null;
  const stripped = modelId.slice(0, -"-free".length);
  return stripped || null;
}

function freeSuffixCandidates(modelId: string): string[] {
  const candidates = [modelId];
  const stripped = stripFreeSuffix(modelId);
  if (stripped) candidates.push(stripped);
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function catalogCandidatesFor(...models: Array<string | undefined>): string[] {
  const candidates = new Set<string>();
  for (const model of models) {
    if (!model) continue;
    for (const candidate of freeSuffixCandidates(model)) candidates.add(candidate);
  }
  return [...candidates];
}

function findCatalogModel(
  providerID: string | undefined,
  candidates: readonly string[],
): string | null {
  if (!providerID) return null;
  for (const candidate of candidates) {
    if (hasCatalogModel(providerID, candidate)) return candidate;
  }
  return null;
}

function findPricedExactModel(
  providerID: string | undefined,
  candidates: Array<string | undefined>,
): string | null {
  if (!providerID) return null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (hasCost(providerID, candidate)) return candidate;
  }
  return null;
}

function pickBestModelForProvider(
  providerID: string,
  candidates: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (hasCost(providerID, candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (hasModel(providerID, candidate)) return candidate;
  }
  return null;
}

function parseModelIdHint(rawModelId?: string): { providerHint?: string; modelPart?: string } {
  if (!rawModelId || typeof rawModelId !== "string") return {};
  const trimmed = rawModelId.trim();
  if (!trimmed) return {};
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return { modelPart: trimmed };
  if (lastSlash === trimmed.length - 1) return { providerHint: trimmed.slice(0, -1) };
  return { providerHint: trimmed.slice(0, lastSlash), modelPart: trimmed.slice(lastSlash + 1) };
}

/**
 * Exact provider-scoped pricing aliases. These only choose the priced key used
 * for cost lookup; source provider/model ids stay untouched. Keep entries
 * literal instead of deriving nearby versions.
 */
const PROVIDER_MODEL_PRICING_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "opencode-go": {
    "deepseek-v4-flash": "deepseek-v4.1-flash",
  },
};

/**
 * Resolve an explicitly authoritative provider-scoped alias to a priced model.
 * These mappings are deliberate, so they win over catalog presence heuristics.
 */
function resolveExplicitPricingAlias(
  providerID: string | undefined,
  ...models: Array<string | undefined>
): string | null {
  if (!providerID) return null;
  const aliases = PROVIDER_MODEL_PRICING_ALIASES[providerID];
  if (!aliases) return null;
  for (const model of models) {
    if (!model) continue;
    const alias = aliases[model];
    if (alias && hasCost(providerID, alias)) return alias;
  }
  return null;
}

const SOURCE_PROVIDER_ALIASES: Record<string, string> = {
  cursor: "cursor",
  "cursor-acp": "cursor",
  "github-copilot": "openai",
  "copilot-chat": "openai",
  chatgpt: "openai",
  codex: "openai",
  "kimi-for-coding": "moonshotai",
  kimi: "moonshotai",
  "kimi-code": "moonshotai",
  "kimi-code-plan-global": "moonshotai",
  "kimi-code-plan-cn": "moonshotai",
  "zai-coding-plan": "zai",
  glm: "zai",
  // Same actual source provider, different registration synonym.
  "opencode-go-subscription": "opencode-go",
};

function normalizeSourceProviderId(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered || lowered === "unknown") return undefined;

  const parts = lowered.split(/[/:]/g).filter(Boolean);
  const candidates = [lowered, ...parts].filter((v, i, arr) => arr.indexOf(v) === i);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (isModelsDevProviderId(candidate)) return candidate;
    const alias = SOURCE_PROVIDER_ALIASES[candidate];
    if (alias && isModelsDevProviderId(alias)) return alias;
  }

  const directAlias = SOURCE_PROVIDER_ALIASES[lowered];
  return directAlias ?? lowered;
}

function inferOfficialProviderFromModelId(modelId: string): string | null {
  // Prefer snapshot-driven inference when possible.
  // This keeps mapping future-proof as models.dev adds providers/models.
  const providers = listProvidersForModelId(modelId);
  if (providers.length === 1) return providers[0] ?? null;

  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("kimi")) return "moonshotai";
  if (lower.startsWith("glm")) return "zai";
  if (lower.startsWith("grok")) return "xai";
  // heuristics
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("gpt")) return "openai";
  if (lower.includes("kimi")) return "moonshotai";
  if (lower.includes("glm")) return "zai";
  if (lower.includes("grok")) return "xai";
  return null;
}

/**
 * Get pricing alias candidates for Anthropic models when the exact key is missing.
 * Returns ordered candidates to try, including the original model.
 */
function anthropicPricingCandidates(model: string): string[] {
  // model is expected normalized like "claude-opus-4-6"
  if (model === "claude-opus-4-6") return [model, "claude-opus-4-5"];
  if (model === "claude-sonnet-4-6") return [model, "claude-sonnet-4-7", "claude-sonnet-4-5"];
  // Future-proof: try next lower version for any claude-*-N-M pattern
  const match = model.match(/^(claude-[a-z]+-\d+)-(\d+)$/);
  if (match) {
    const [, prefix, minor] = match;
    const minorNum = parseInt(minor, 10);
    if (minorNum > 0) {
      return [model, `${prefix}-${minorNum - 1}`];
    }
  }
  return [model];
}

function moonshotaiPricingCandidates(model: string): string[] {
  const candidates: string[] = [];
  for (const freeCandidate of freeSuffixCandidates(model)) {
    candidates.push(freeCandidate);
    if (freeCandidate.includes(".")) {
      candidates.push(freeCandidate.replace(/\./g, "-"));
    }
  }
  if (model === "k3" || model === "k3-256k") {
    candidates.push("kimi-k3");
  }
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function resolveModelForProvider(providerID: string, normalizedModel: string): string | null {
  if (!isModelsDevProviderId(providerID)) return null;
  const preferredDirect = pickBestModelForProvider(
    providerID,
    freeSuffixCandidates(normalizedModel),
  );
  if (preferredDirect) return preferredDirect;

  const pricingAlias = resolveExplicitPricingAlias(providerID, normalizedModel);
  if (pricingAlias) return pricingAlias;

  // Some source ids include "-thinking" while snapshot keeps a base key (or vice versa).
  if (normalizedModel.toLowerCase().endsWith("-thinking")) {
    const withoutThinking = normalizedModel.slice(0, -"-thinking".length);
    if (hasModel(providerID, withoutThinking)) return withoutThinking;
  }

  // Kimi naming: some logs use kimi-k2, while snapshot may use kimi-k2-thinking.
  if (providerID === "moonshotai" && normalizedModel === "kimi-k2") {
    if (hasModel("moonshotai", "kimi-k2-thinking")) return "kimi-k2-thinking";
  }

  if (providerID === "moonshotai") {
    const preferredMoonshot = pickBestModelForProvider(
      "moonshotai",
      moonshotaiPricingCandidates(normalizedModel),
    );
    if (preferredMoonshot) return preferredMoonshot;
  }

  // Gemini naming fallback: some logs omit -preview.
  if (providerID === "google") {
    if (normalizedModel === "gemini-3-pro" && hasModel("google", "gemini-3-pro-preview")) {
      return "gemini-3-pro-preview";
    }
    if (normalizedModel === "gemini-3-flash" && hasModel("google", "gemini-3-flash-preview")) {
      return "gemini-3-flash-preview";
    }
  }

  // Anthropic alias fallback: try alternative version keys when exact key is missing.
  if (providerID === "anthropic") {
    const candidates = anthropicPricingCandidates(normalizedModel);
    for (const candidate of candidates) {
      if (hasModel("anthropic", candidate)) return candidate;
    }
  }

  return null;
}

export function resolvePricingKey(source: {
  providerID?: string;
  modelID?: string;
}): PricingResolution {
  const srcProvider = source.providerID ?? "unknown";
  const srcModel = source.modelID ?? "unknown";

  if (!source.modelID || typeof source.modelID !== "string") {
    return {
      ok: false,
      unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" },
    };
  }

  const rawModelID = source.modelID.trim();
  const sourceProviderHint = normalizeSourceProviderId(source.providerID);

  // Preserve an exact source-provider route first. This keeps provider-owned
  // catalogs (for example opencode/big-pickle or openrouter vendor-prefixed
  // model ids) from being rewritten into a different provider's key.
  if (sourceProviderHint && rawModelID && hasCost(sourceProviderHint, rawModelID)) {
    return {
      ok: true,
      key: { provider: sourceProviderHint, model: rawModelID },
      method: "source_provider",
    };
  }

  if (sourceProviderHint && rawModelID.startsWith(`${sourceProviderHint}/`)) {
    const unprefixedModelID = rawModelID.slice(sourceProviderHint.length + 1);
    if (hasCost(sourceProviderHint, unprefixedModelID)) {
      return {
        ok: true,
        key: { provider: sourceProviderHint, model: unprefixedModelID },
        method: "source_provider",
      };
    }
  }

  const parsed = parseModelIdHint(rawModelID);
  if (!parsed.modelPart) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        reason: "missing_model",
      },
    };
  }

  const normalizedModel = normalizeModelId(parsed.modelPart);
  const modelProviderHint = normalizeSourceProviderId(parsed.providerHint);

  const tryProvider = (
    providerID: string | undefined,
    method: "source_provider" | "model_prefix" | "alias_fallback" | "cursor_api_alias",
    modelIDHint: string = normalizedModel,
  ): PricingResolution | null => {
    if (!providerID) return null;
    const modelID = resolveModelForProvider(providerID, modelIDHint);
    if (!modelID) return null;
    return { ok: true, key: { provider: providerID, model: modelID }, method };
  };

  if (isCursorProviderId(source.providerID) || isCursorModelId(source.modelID)) {
    const cursorModel = resolveCursorModel(source.modelID);
    if (cursorModel.kind === "local") {
      return {
        ok: true,
        key: { provider: "cursor", model: cursorModel.model },
        method: "cursor_local",
      };
    }
    if (cursorModel.kind === "official") {
      const resolved = tryProvider(
        cursorModel.providerHint,
        "cursor_api_alias",
        cursorModel.modelHint,
      );
      if (resolved) return resolved;
    }
  }

  // An explicit provider-scoped alias is a deliberate mapping and wins over
  // catalog presence, but only after exact priced keys were tried above.
  const sourcePricingAlias = resolveExplicitPricingAlias(sourceProviderHint, normalizedModel);
  if (sourcePricingAlias && sourceProviderHint) {
    return {
      ok: true,
      key: { provider: sourceProviderHint, model: sourcePricingAlias },
      method: "source_provider",
    };
  }

  // The source catalog is authoritative for presence. Consult it BEFORE any
  // heuristic fallback (free-suffix stripping, -thinking, preview aliases, ...)
  // so a catalog-listed model without a cost cannot inherit a different priced
  // model.
  const unprefixedRawModelID =
    sourceProviderHint && rawModelID.startsWith(`${sourceProviderHint}/`)
      ? rawModelID.slice(sourceProviderHint.length + 1)
      : rawModelID;
  const catalogCandidates = catalogCandidatesFor(
    rawModelID,
    unprefixedRawModelID,
    parsed.modelPart.trim(),
    normalizedModel,
  );
  const sourceCatalogModel = findCatalogModel(sourceProviderHint, catalogCandidates);
  if (sourceCatalogModel && sourceProviderHint) {
    return {
      ok: true,
      key: { provider: sourceProviderHint, model: sourceCatalogModel },
      method: "source_provider",
    };
  }

  // Only now run same-provider heuristics (free-suffix stripping, -thinking,
  // Gemini preview, Kimi/Anthropic variants).
  const fromSourceProvider = tryProvider(sourceProviderHint, "source_provider");
  if (fromSourceProvider) return fromSourceProvider;

  // A non-listed gateway may still pass an explicit provider prefix. Try the
  // leading segment as a models.dev provider (and its catalog) after the source
  // guard, so a listed source provider cannot be rewritten into a vendor route.
  const firstSlash = rawModelID.indexOf("/");
  if ((!sourceProviderHint || !isModelsDevProviderId(sourceProviderHint)) && firstSlash > 0) {
    const firstSegmentProvider = normalizeSourceProviderId(rawModelID.slice(0, firstSlash));
    const firstSegmentModelPart = rawModelID.slice(firstSlash + 1);
    if (
      firstSegmentProvider &&
      firstSegmentProvider !== sourceProviderHint &&
      isModelsDevProviderId(firstSegmentProvider)
    ) {
      if (hasCost(firstSegmentProvider, firstSegmentModelPart)) {
        return {
          ok: true,
          key: { provider: firstSegmentProvider, model: firstSegmentModelPart },
          method: "model_prefix",
        };
      }
      const firstSegmentAlias = resolveExplicitPricingAlias(firstSegmentProvider, normalizedModel);
      if (firstSegmentAlias) {
        return {
          ok: true,
          key: { provider: firstSegmentProvider, model: firstSegmentAlias },
          method: "model_prefix",
        };
      }
      const firstSegmentCatalogModel = findCatalogModel(
        firstSegmentProvider,
        catalogCandidatesFor(firstSegmentModelPart, parsed.modelPart.trim(), normalizedModel),
      );
      if (firstSegmentCatalogModel) {
        return {
          ok: true,
          key: { provider: firstSegmentProvider, model: firstSegmentCatalogModel },
          method: "model_prefix",
        };
      }
    }
  }

  // For a model-prefix route, prefer an exact priced key, then an explicit
  // provider-scoped alias, then catalog presence, and only then heuristics.
  const prefixExactModel = findPricedExactModel(modelProviderHint, [parsed.modelPart.trim()]);
  if (prefixExactModel && modelProviderHint) {
    return {
      ok: true,
      key: { provider: modelProviderHint, model: prefixExactModel },
      method: "model_prefix",
    };
  }
  const prefixPricingAlias = resolveExplicitPricingAlias(modelProviderHint, normalizedModel);
  if (prefixPricingAlias && modelProviderHint) {
    return {
      ok: true,
      key: { provider: modelProviderHint, model: prefixPricingAlias },
      method: "model_prefix",
    };
  }
  const prefixCatalogModel = findCatalogModel(modelProviderHint, catalogCandidates);
  if (prefixCatalogModel && modelProviderHint) {
    return {
      ok: true,
      key: { provider: modelProviderHint, model: prefixCatalogModel },
      method: "model_prefix",
    };
  }

  const fromModelPrefix = tryProvider(modelProviderHint, "model_prefix");
  if (fromModelPrefix) return fromModelPrefix;

  const modelCandidates = freeSuffixCandidates(normalizedModel);
  let ambiguousMatch: { model: string; providerCandidates: string[] } | null = null;

  for (const candidateModel of modelCandidates) {
    const providerCandidates = listProvidersForModelId(candidateModel);
    if (providerCandidates.length === 1) {
      const provider = providerCandidates[0]!;
      return {
        ok: true,
        key: { provider, model: candidateModel },
        method: "unique_model",
      };
    }

    if (providerCandidates.length > 1) {
      const inferredAmbiguousProvider = inferOfficialProviderFromModelId(candidateModel);
      if (inferredAmbiguousProvider && providerCandidates.includes(inferredAmbiguousProvider)) {
        const inferredFromAmbiguous = tryProvider(
          inferredAmbiguousProvider,
          "alias_fallback",
          candidateModel,
        );
        if (inferredFromAmbiguous) return inferredFromAmbiguous;
      }

      if (!ambiguousMatch) {
        ambiguousMatch = {
          model: candidateModel,
          providerCandidates: [...providerCandidates].sort((a, b) => a.localeCompare(b)),
        };
      }
    }
  }

  if (ambiguousMatch) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedModel: ambiguousMatch.model,
        normalizedModelID: ambiguousMatch.model,
        providerCandidates: ambiguousMatch.providerCandidates,
        reason: "ambiguous_model",
      },
    };
  }

  let inferredMissing: { provider: string; model: string } | null = null;
  for (const candidateModel of modelCandidates) {
    const inferredProvider = inferOfficialProviderFromModelId(candidateModel);
    const inferred = tryProvider(inferredProvider ?? undefined, "alias_fallback", candidateModel);
    if (inferred) return inferred;

    if (inferredProvider && !inferredMissing) {
      inferredMissing = { provider: inferredProvider, model: candidateModel };
    }
  }

  if (inferredMissing) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedProvider: inferredMissing.provider,
        mappedModel: inferredMissing.model,
        normalizedModelID: inferredMissing.model,
        reason: "missing_provider",
      },
    };
  }

  return {
    ok: false,
    unknown: {
      sourceProviderID: srcProvider,
      sourceModelID: srcModel,
      mappedModel: normalizedModel,
      normalizedModelID: normalizedModel,
      reason: "missing_provider",
    },
  };
}

/**
 * Prompt-side token count: OpenCode stores non-cached input separately from
 * cache read/write, so their sum is the request context a context tier measures.
 */
function promptTokenCount(tokens: TokenBuckets): number {
  return tokens.input + tokens.cache_read + tokens.cache_write;
}

/**
 * Known cost for the buckets that have an applicable rate. Returns `ok: false`
 * only when positive tokens exist but none of them can be priced, preserving
 * the existing entirely-unpriced path.
 */
function calculateKnownCost(
  rates: CostBuckets,
  tokens: TokenBuckets,
): { ok: true; costUsd: number; unpricedTokens?: number } | { ok: false } {
  const coverage = tokenRateCoverage(rates, tokens);
  if (coverage.pricedTokens === 0 && coverage.unpricedTokens > 0) {
    return { ok: false };
  }
  return {
    ok: true,
    costUsd: calculateUsdFromTokenBuckets(rates, tokens),
    ...(coverage.unpricedTokens > 0 ? { unpricedTokens: coverage.unpricedTokens } : {}),
  };
}

/**
 * Resolve the rates that apply to one priced key, including context-tier
 * selection and, when a completion instant is supplied, the exact
 * provider/model temporal policy. Shared by `calculateCostUsd` and
 * `aggregateUsage` so bucket splitting and cost calculation never disagree
 * about which rates applied.
 *
 * Temporal pricing is opt-in per call: without `atMs`, existing callers keep
 * using base rates unchanged. With `atMs`, only a verified exact provider/model
 * route participates (never a provider inference, model alias, or prefix
 * guess), and an unresolved/unsupported rule fails closed instead of silently
 * charging base rates.
 */
function selectTokenRates(params: {
  provider: string;
  model: string;
  tokens: TokenBuckets;
  contextTokens?: number;
  atMs?: number;
  /**
   * Verified exact temporal route. `undefined` means direct callers treat the
   * provided provider/model as exact; `null` means the route was inferred or
   * aliased and must not receive a temporal correction.
   */
  temporalRoute?: PricedKey | null;
}): { ok: true; rates: CostBuckets; contextTierSize?: number } | { ok: false; reason?: string } {
  let base: CostBuckets;
  let contextTierSize: number | undefined;

  if (params.provider === "cursor") {
    const cursorCost = lookupCursorLocalCost(params.model);
    if (!cursorCost) return { ok: false };
    base = cursorCost;
  } else {
    const cost = lookupCost(params.provider, params.model);
    if (!cost) return { ok: false };

    const hasExplicitContext =
      typeof params.contextTokens === "number" && Number.isFinite(params.contextTokens);
    if (!cost.tiers?.length && !hasExplicitContext) {
      base = cost;
    } else {
      const contextTokens = hasExplicitContext
        ? params.contextTokens
        : promptTokenCount(params.tokens);
      const selected = selectCostAtContext(cost, contextTokens);
      base = selected.rates;
      contextTierSize = selected.tierSize;
    }
  }

  if (params.temporalRoute === null) {
    return {
      ok: true,
      rates: base,
      ...(contextTierSize !== undefined ? { contextTierSize } : {}),
    };
  }

  const temporalProvider = params.temporalRoute?.provider ?? params.provider;
  const temporalModel = params.temporalRoute?.model ?? params.model;
  const temporal = applyTemporalRates(temporalProvider, temporalModel, base, params.atMs);
  if (!temporal.ok) return temporal;

  return {
    ok: true,
    rates: temporal.rates,
    ...(contextTierSize !== undefined ? { contextTierSize } : {}),
  };
}

/**
 * Apply a model's temporal rates at one physical completion instant. Callers
 * must pass a verified exact source provider/model route; this function never
 * derives one from a pricing key, alias, or model-family guess.
 */
function applyTemporalRates(
  provider: string,
  model: string,
  rates: CostBuckets,
  atMs: number | undefined,
): { ok: true; rates: CostBuckets } | { ok: false; reason: string } {
  if (atMs === undefined) return { ok: true, rates };
  if (getTemporalPolicy(provider, model) === null) return { ok: true, rates };
  if (!Number.isFinite(atMs)) {
    return { ok: false, reason: "temporal pricing requires a finite completion timestamp" };
  }

  const resolved = resolveTemporalRates(provider, model, atMs, rates);
  if (resolved.status !== "resolved" || resolved.rates === null) {
    const detail = resolved.reason ? `: ${resolved.reason}` : "";
    return {
      ok: false,
      reason: `temporal pricing is ${resolved.status} for ${provider}/${model}${detail}`,
    };
  }
  return { ok: true, rates: resolved.rates };
}

/**
 * Temporal corrections require a verified exact source route. A pricing key
 * inferred from a model id, an alias, or a prefix is not evidence that the
 * source actually came from that provider/model, so it must keep base pricing.
 */
function verifiedTemporalRoute(
  sourceProviderID: string | null | undefined,
  sourceModelID: string | null | undefined,
  key: PricedKey,
): PricedKey | null {
  if (typeof sourceProviderID !== "string" || typeof sourceModelID !== "string") return null;
  const provider = sourceProviderID.trim();
  const model = sourceModelID.trim();
  if (!provider || !model) return null;
  if (provider.toLowerCase() !== key.provider.toLowerCase()) return null;
  if (model !== key.model) return null;
  return { provider: key.provider, model: key.model };
}

/** Per-message cost calculation; temporal rates apply only when `atMs` is supplied. */
export function calculateCostUsd(params: {
  provider: string;
  model: string;
  tokens: TokenBuckets;
  /**
   * Optional prompt/context token override. When omitted, prompt-side token
   * buckets select a published context tier; without tier evidence the base
   * rates apply and no tier is claimed as applied.
   */
  contextTokens?: number;
  /**
   * Optional physical completion instant. When supplied, an exact
   * provider/model temporal policy is applied; unresolved rules fail closed
   * rather than charging base rates.
   */
  atMs?: number;
  /**
   * Verified exact temporal route. Callers resolving from source metadata pass
   * a key only when the source provider/model exactly match it; `null`
   * suppresses temporal pricing for inferred/aliased routes.
   */
  temporalRoute?: PricedKey | null;
}):
  | {
      ok: true;
      costUsd: number;
      /** Positive tokens whose buckets had no applicable rate; absent when complete. */
      unpricedTokens?: number;
      contextTierSize?: number;
    }
  | { ok: false; reason?: string } {
  const selected = selectTokenRates(params);
  if (!selected.ok) return selected;
  const known = calculateKnownCost(selected.rates, params.tokens);
  if (!known.ok) return known;
  return {
    ...known,
    ...(selected.contextTierSize !== undefined
      ? { contextTierSize: selected.contextTierSize }
      : {}),
  };
}

/** Classify a resolved model as unpriced when the snapshot or catalog knows it without rates. */
export function classifyMissingPricing(params: {
  mappedProvider: string;
  mappedModel: string;
}): { kind: "unpriced"; reason: string } | { kind: "unknown" } {
  if (params.mappedProvider === "cursor") {
    return { kind: "unknown" };
  }

  // When provider/model exists in the priced snapshot or source catalog but
  // has no numeric rates, classify as unpriced. Catalog-only providers may be
  // absent from the priced snapshot.
  const inCatalog = hasCatalogModel(params.mappedProvider, params.mappedModel);
  if (!hasProvider(params.mappedProvider) && !inCatalog) {
    return { kind: "unknown" };
  }

  if (hasModel(params.mappedProvider, params.mappedModel) || inCatalog) {
    if (params.mappedModel.toLowerCase().endsWith("-free")) {
      return { kind: "unpriced", reason: "free-tier model id not priced in snapshot" };
    }
    return { kind: "unpriced", reason: "model id exists in snapshot but has no token pricing" };
  }

  // Provider exists but model key missing from snapshot.
  return { kind: "unknown" };
}

/**
 * One message's pricing outcome: fully priced cost, a partial known cost with
 * the token count that could not be priced, fully unpriced tokens, or an
 * unknown mapping.
 */
export type TokenPricingOutcome =
  | {
      status: "priced";
      key: PricedKey;
      costUsd: number;
      /** Present only when a context tier applied. */
      contextTierSize?: number;
    }
  | {
      status: "partial";
      key: PricedKey;
      /** Cost of the buckets that have an applicable rate. */
      costUsd: number;
      /** Positive tokens whose buckets had no applicable rate. */
      unpricedTokens: number;
      /** Present only when a context tier applied to the priced buckets. */
      contextTierSize?: number;
    }
  | { status: "unpriced"; key: PricedKey; reason: string }
  | { status: "unknown"; unknown: UnknownKey };

/**
 * The one shared pricing primitive. Both `aggregateUsage` (upstream surfaces)
 * and the GUI aggregation call this; neither resolves keys, computes cost, or
 * classifies missing pricing on its own.
 *
 * `atMs` is the physical assistant completion instant for one row. When it is
 * supplied, temporal pricing applies only if the raw source provider/model
 * exactly match the resolved priced route; inferred providers, model aliases,
 * and prefix guesses keep base pricing. When `atMs` is absent, callers keep the
 * existing non-temporal pricing behavior.
 *
 * `cache` is optional and keyed by a collision-safe tuple of the exact raw
 * source ids, so a caller can reuse key resolution across many messages of the
 * same source without conflating delimiter-bearing or missing ids.
 */
export function priceTokenBuckets(params: {
  providerID?: string | null;
  modelID?: string | null;
  tokens: TokenBuckets;
  /** Optional context override; otherwise prompt token buckets select a tier. */
  contextTokens?: number;
  /** Optional physical completion instant for exact historical temporal rates. */
  atMs?: number;
  cache?: Map<string, PricingResolution>;
}): TokenPricingOutcome {
  const cacheKey = encodeIdentityKey([params.providerID, params.modelID]);
  let resolution = params.cache?.get(cacheKey);
  if (!resolution) {
    resolution = resolvePricingKey({
      providerID: params.providerID ?? undefined,
      modelID: params.modelID ?? undefined,
    });
    params.cache?.set(cacheKey, resolution);
  }

  if (!resolution.ok) {
    return { status: "unknown", unknown: resolution.unknown };
  }

  const key = resolution.key;
  const temporalRoute = verifiedTemporalRoute(params.providerID, params.modelID, key);
  const priced = calculateCostUsd({
    provider: key.provider,
    model: key.model,
    tokens: params.tokens,
    contextTokens: params.contextTokens,
    atMs: params.atMs,
    temporalRoute,
  });
  if (priced.ok) {
    const contextTier =
      priced.contextTierSize !== undefined ? { contextTierSize: priced.contextTierSize } : {};
    if (priced.unpricedTokens !== undefined && priced.unpricedTokens > 0) {
      return {
        status: "partial",
        key,
        costUsd: priced.costUsd,
        unpricedTokens: priced.unpricedTokens,
        ...contextTier,
      };
    }
    return {
      status: "priced",
      key,
      costUsd: priced.costUsd,
      ...contextTier,
    };
  }

  // A temporal policy that cannot be resolved is not a missing catalog price:
  // report the token count as unpriced without falling back to base rates.
  if (priced.reason !== undefined) {
    return { status: "unpriced", key, reason: priced.reason };
  }

  const classification = classifyMissingPricing({
    mappedProvider: key.provider,
    mappedModel: key.model,
  });
  if (classification.kind === "unpriced") {
    return { status: "unpriced", key, reason: classification.reason };
  }

  return {
    status: "unknown",
    unknown: {
      sourceProviderID: params.providerID ?? "unknown",
      sourceModelID: params.modelID ?? "unknown",
      mappedProvider: key.provider,
      mappedModel: key.model,
    },
  };
}

function compareSessionCreatedAt(
  a: Awaited<ReturnType<typeof readAllSessionsIndex>>[string],
  b: Awaited<ReturnType<typeof readAllSessionsIndex>>[string],
): number {
  const aCreated =
    typeof a.time?.created === "number" && Number.isFinite(a.time.created)
      ? a.time.created
      : Number.MAX_SAFE_INTEGER;
  const bCreated =
    typeof b.time?.created === "number" && Number.isFinite(b.time.created)
      ? b.time.created
      : Number.MAX_SAFE_INTEGER;

  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

export async function resolveSessionTree(rootSessionID: string): Promise<SessionTreeNode[]> {
  if (!rootSessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(rootSessionID, "(invalid session ID format)");
  }

  const sessionsIdx = await readAllSessionsIndex();
  const root = sessionsIdx[rootSessionID];
  if (!root) {
    throw new SessionNotFoundError(rootSessionID, getOpenCodeDbPath());
  }

  const childrenByParentID = new Map<string, Array<(typeof sessionsIdx)[string]>>();
  for (const session of Object.values(sessionsIdx)) {
    if (!session.parentID) continue;
    const children = childrenByParentID.get(session.parentID);
    if (children) {
      children.push(session);
    } else {
      childrenByParentID.set(session.parentID, [session]);
    }
  }

  for (const children of childrenByParentID.values()) {
    children.sort(compareSessionCreatedAt);
  }

  const tree: SessionTreeNode[] = [];
  const visited = new Set<string>();

  const visit = (session: (typeof sessionsIdx)[string], depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);

    tree.push({
      sessionID: session.id,
      parentID: session.parentID,
      title: session.title,
      depth,
    });

    const children = childrenByParentID.get(session.id) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return tree;
}

/** Physical completion instant of one message, or undefined when absent/invalid. */
function messageCompletedAtMs(message: OpenCodeMessage): number | undefined {
  const completed = message.time?.completed;
  return typeof completed === "number" && Number.isFinite(completed) ? completed : undefined;
}

export async function aggregateUsage(params: {
  sinceMs?: number;
  untilMs?: number;
  sessionID?: string;
  sessionIDs?: string[];
}): Promise<AggregateResult> {
  if (params.sessionID && params.sessionIDs?.length) {
    throw new Error("aggregateUsage received both sessionID and sessionIDs");
  }

  // Use session-scoped iterators when filtering by session ids for better performance.
  let messages: OpenCodeMessage[];
  if (params.sessionIDs) {
    messages = await iterAssistantMessagesForSessions({
      sessionIDs: params.sessionIDs,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
    });
  } else if (params.sessionID) {
    messages = await iterAssistantMessagesForSession({
      sessionID: params.sessionID,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
    });
  } else {
    messages = await iterAssistantMessages({ sinceMs: params.sinceMs, untilMs: params.untilMs });
  }
  const sessionsIdx = await readAllSessionsIndex();

  const byModel = new Map<string, AggregateRow>();
  const bySession = new Map<string, SessionRow>();
  const bySourceProvider = new Map<string, SourceProviderRow>();
  const bySourceModel = new Map<string, SourceModelRow>();
  const unknown = new Map<string, UnknownRow>();
  const unpriced = new Map<string, UnpricedRow>();

  let pricedTotals = emptyTokenBuckets();
  let unknownTotals = emptyTokenBuckets();
  let unpricedTotals = emptyTokenBuckets();
  let costTotal = 0;
  let partialCostTotal = 0;
  let partialMessageCount = 0;
  const resolutionCache = new Map<string, PricingResolution>();

  for (const msg of messages) {
    const tokens = tokenBucketsFromMessage(msg);
    const sid = msg.sessionID;
    const atMs = messageCompletedAtMs(msg);
    const sessionTitle = sessionsIdx[sid]?.title;
    const existingSessionRow = bySession.get(sid);
    if (existingSessionRow) {
      existingSessionRow.tokens = addTokenBuckets(existingSessionRow.tokens, tokens);
      existingSessionRow.messageCount += 1;
    } else {
      bySession.set(sid, {
        sessionID: sid,
        title: sessionTitle,
        tokens,
        costUsd: 0,
        messageCount: 1,
      });
    }

    const outcome = priceTokenBuckets({
      providerID: msg.providerID,
      modelID: msg.modelID,
      tokens,
      atMs,
      cache: resolutionCache,
    });

    if (outcome.status === "unknown") {
      unknownTotals = addTokenBuckets(unknownTotals, tokens);
      const k = JSON.stringify(outcome.unknown);
      const row = unknown.get(k);
      if (row) {
        row.tokens = addTokenBuckets(row.tokens, tokens);
        row.messageCount += 1;
      } else {
        unknown.set(k, { key: outcome.unknown, tokens, messageCount: 1 });
      }
      const sessionRow = bySession.get(sid);
      if (sessionRow) {
        sessionRow.unpricedMessageCount = (sessionRow.unpricedMessageCount ?? 0) + 1;
      }
      continue;
    }

    if (outcome.status === "unpriced") {
      unpricedTotals = addTokenBuckets(unpricedTotals, tokens);
      const rowKey: UnpricedKey = {
        sourceProviderID: msg.providerID ?? "unknown",
        sourceModelID: msg.modelID ?? "unknown",
        mappedProvider: outcome.key.provider,
        mappedModel: outcome.key.model,
        reason: outcome.reason,
      };
      const k = JSON.stringify(rowKey);
      const row = unpriced.get(k);
      if (row) {
        row.tokens = addTokenBuckets(row.tokens, tokens);
        row.messageCount += 1;
      } else {
        unpriced.set(k, { key: rowKey, tokens, messageCount: 1 });
      }
      const sessionRow = bySession.get(sid);
      if (sessionRow) {
        sessionRow.unpricedMessageCount = (sessionRow.unpricedMessageCount ?? 0) + 1;
      }
      continue;
    }

    // Remaining outcomes are "priced" or "partial". A partial row keeps its
    // known cost, but only the buckets with an applicable rate count as priced;
    // the missing-rate buckets stay in the unpriced totals.
    const isPartial = outcome.status === "partial";
    if (isPartial) {
      const selected = selectTokenRates({
        provider: outcome.key.provider,
        model: outcome.key.model,
        tokens,
        atMs,
      });
      if (selected.ok) {
        const split = splitTokenBucketsByRate(selected.rates, tokens);
        pricedTotals = addTokenBuckets(pricedTotals, split.priced);
        unpricedTotals = addTokenBuckets(unpricedTotals, split.unpriced);
      } else {
        // A partial outcome always has at least one priced bucket. If a second
        // lookup disagrees, keep its usage conservative rather than claim it.
        unpricedTotals = addTokenBuckets(unpricedTotals, tokens);
      }
      partialCostTotal += outcome.costUsd;
      partialMessageCount += 1;
    } else {
      pricedTotals = addTokenBuckets(pricedTotals, tokens);
    }
    costTotal += outcome.costUsd;

    // Tokscale-style: key by OpenCode source provider + source model id.
    const srcProviderID = msg.providerID ?? "unknown";
    const srcModelID = msg.modelID ?? "unknown";
    const srcModelKey = `${srcProviderID}\n${srcModelID}`;
    const sm = bySourceModel.get(srcModelKey);
    if (sm) {
      sm.tokens = addTokenBuckets(sm.tokens, tokens);
      sm.costUsd += outcome.costUsd;
      sm.messageCount += 1;
      if (isPartial) sm.partialMessageCount = (sm.partialMessageCount ?? 0) + 1;
    } else {
      bySourceModel.set(srcModelKey, {
        sourceProviderID: srcProviderID,
        sourceModelID: srcModelID,
        tokens,
        costUsd: outcome.costUsd,
        messageCount: 1,
        ...(isPartial ? { partialMessageCount: 1 } : {}),
      });
    }

    const srcProvider = srcProviderID;
    const src = bySourceProvider.get(srcProvider);
    if (src) {
      src.tokens = addTokenBuckets(src.tokens, tokens);
      src.costUsd += outcome.costUsd;
      src.messageCount += 1;
      if (isPartial) src.partialMessageCount = (src.partialMessageCount ?? 0) + 1;
    } else {
      bySourceProvider.set(srcProvider, {
        providerID: srcProvider,
        tokens,
        costUsd: outcome.costUsd,
        messageCount: 1,
        ...(isPartial ? { partialMessageCount: 1 } : {}),
      });
    }

    const modelKey = `${outcome.key.provider}/${outcome.key.model}`;
    const existing = byModel.get(modelKey);
    if (existing) {
      existing.tokens = addTokenBuckets(existing.tokens, tokens);
      existing.costUsd += outcome.costUsd;
      existing.messageCount += 1;
      if (isPartial) existing.partialMessageCount = (existing.partialMessageCount ?? 0) + 1;
    } else {
      byModel.set(modelKey, {
        key: outcome.key,
        tokens,
        costUsd: outcome.costUsd,
        messageCount: 1,
        ...(isPartial ? { partialMessageCount: 1 } : {}),
      });
    }

    const s = bySession.get(sid);
    if (s) {
      s.costUsd += outcome.costUsd;
      s.pricedMessageCount = (s.pricedMessageCount ?? 0) + 1;
      if (isPartial) s.partialMessageCount = (s.partialMessageCount ?? 0) + 1;
    }
  }

  const byModelRows = Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd);
  const bySessionRows = Array.from(bySession.values()).sort((a, b) => b.costUsd - a.costUsd);
  const bySourceProviderRows = Array.from(bySourceProvider.values()).sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const bySourceModelRows = Array.from(bySourceModel.values()).sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const unknownRows = Array.from(unknown.values()).sort(
    (a, b) =>
      b.tokens.input +
      b.tokens.output +
      b.tokens.reasoning +
      b.tokens.cache_read +
      b.tokens.cache_write -
      (a.tokens.input +
        a.tokens.output +
        a.tokens.reasoning +
        a.tokens.cache_read +
        a.tokens.cache_write),
  );

  const unpricedRows = Array.from(unpriced.values()).sort(
    (a, b) =>
      b.tokens.input +
      b.tokens.output +
      b.tokens.reasoning +
      b.tokens.cache_read +
      b.tokens.cache_write -
      (a.tokens.input +
        a.tokens.output +
        a.tokens.reasoning +
        a.tokens.cache_read +
        a.tokens.cache_write),
  );

  return {
    window: { sinceMs: params.sinceMs, untilMs: params.untilMs },
    totals: {
      priced: pricedTotals,
      unknown: unknownTotals,
      unpriced: unpricedTotals,
      costUsd: costTotal,
      messageCount: messages.length,
      sessionCount: new Set(messages.map((m) => m.sessionID)).size,
      ...(partialMessageCount > 0 ? { partialCostUsd: partialCostTotal, partialMessageCount } : {}),
    },
    bySourceProvider: bySourceProviderRows,
    bySourceModel: bySourceModelRows,
    byModel: byModelRows,
    bySession: bySessionRows,
    unknown: unknownRows,
    unpriced: unpricedRows,
  };
}

/**
 * Lightweight session token summary for toast display.
 * Returns per-model input/output totals for a single session.
 */
export type SessionTokenRow = {
  modelID: string;
  input: number;
  cachedInput: number;
  totalInput: number;
  output: number;
};

export type SessionTokenSummary = {
  sessionID: string;
  models: SessionTokenRow[];
  totalInput: number;
  totalCachedInput: number;
  totalCombinedInput: number;
  totalOutput: number;
};

function summarizeSessionTokenMessages(
  sessionID: string,
  sessionMessages: readonly OpenCodeMessage[],
): SessionTokenSummary | null {
  if (sessionMessages.length === 0) return null;

  const byModel = new Map<
    string,
    { input: number; cachedInput: number; totalInput: number; output: number }
  >();
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalCombinedInput = 0;
  let totalOutput = 0;

  for (const msg of sessionMessages) {
    const tokens = msg.tokens;
    if (!tokens) continue;

    const input = typeof tokens.input === "number" ? tokens.input : 0;
    const cachedInput = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
    const totalInputForMessage = input + cachedInput;
    const output = typeof tokens.output === "number" ? tokens.output : 0;

    // Skip if both are 0
    if (totalInputForMessage === 0 && output === 0) continue;

    totalInput += input;
    totalCachedInput += cachedInput;
    totalCombinedInput += totalInputForMessage;
    totalOutput += output;

    const modelID = msg.modelID ?? "unknown";
    const existing = byModel.get(modelID);
    if (existing) {
      existing.input += input;
      existing.cachedInput += cachedInput;
      existing.totalInput += totalInputForMessage;
      existing.output += output;
    } else {
      byModel.set(modelID, { input, cachedInput, totalInput: totalInputForMessage, output });
    }
  }

  // Sort by total tokens descending
  const models = Array.from(byModel.entries())
    .map(([modelID, t]) => ({
      modelID,
      input: t.input,
      cachedInput: t.cachedInput,
      totalInput: t.totalInput,
      output: t.output,
    }))
    .filter((m) => m.totalInput > 0 || m.output > 0)
    .sort((a, b) => b.totalInput + b.output - (a.totalInput + a.output));

  return {
    sessionID,
    models,
    totalInput,
    totalCachedInput,
    totalCombinedInput,
    totalOutput,
  };
}

export async function getSessionTokenSummary(
  sessionID: string,
): Promise<SessionTokenSummary | null> {
  // Use session-scoped iterator for better performance (only reads this session's directory)
  const sessionMessages = await iterAssistantMessagesForSession({ sessionID });
  return summarizeSessionTokenMessages(sessionID, sessionMessages);
}

export async function getSessionTreeTokenSummary(
  rootSessionID: string,
): Promise<SessionTokenSummary | null> {
  const sessionIDs = [
    ...new Set((await resolveSessionTree(rootSessionID)).map((node) => node.sessionID)),
  ];
  const sessionMessages = await iterAssistantMessagesForSessions({ sessionIDs });
  return summarizeSessionTokenMessages(rootSessionID, sessionMessages);
}
