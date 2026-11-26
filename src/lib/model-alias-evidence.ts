import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";
import { hasPricingNameCoverage, listModelDisplayNames } from "./modelsdev-pricing.js";
import { getOpencodeRuntimeDirs, type OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getGuiPrivateCacheDir } from "./private-state-paths.js";

/** Unversioned Claude Agent aliases whose target moves without a version suffix. */
export const CLAUDE_AGENT_PRICING_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
export type ClaudeAgentPricingAlias = (typeof CLAUDE_AGENT_PRICING_ALIASES)[number];

const RUNTIME_MODEL_ALIAS_FILENAME = "model-aliases.runtime.json";
const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
const CLAUDE_AGENT_PRICED_PROVIDER = "anthropic";
const CLAUDE_AGENT_ALIAS_SET: ReadonlySet<string> = new Set(CLAUDE_AGENT_PRICING_ALIASES);

/**
 * One observed alias target. `resolvedModelID: null` with `catalogObserved`
 * means the covered catalog had no unique match, so the alias must stay
 * unpriced rather than falling back to an older static price.
 */
export interface ModelAliasEvidenceEntry {
  name?: string;
  resolvedModelID?: string | null;
  ambiguous?: true;
  catalogObserved: boolean;
  observedAt: number;
}

export interface ModelAliasEvidenceV2 {
  version: 2;
  updatedAt: number;
  aliases: Partial<Record<ClaudeAgentPricingAlias, ModelAliasEvidenceEntry>>;
}

export interface ObservedModelEntry {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
}

export type ClaudeAgentAliasObservation = { kind: "ambiguous" } | { kind: "name"; name: string };

export type ClaudeAgentAliasEvidenceState =
  /**
   * `catalogObserved` separates a target resolved against the catalog from a
   * target saved before name coverage was available (last confirmed).
   */
  | { kind: "resolved"; modelID: string; name?: string; catalogObserved: boolean }
  | { kind: "ambiguous" }
  /**
   * A covered catalog had no unique match. The saved native name lets a later
   * catalog refresh resolve it without another Claude Agent observation.
   */
  | { kind: "unresolved"; name?: string }
  | { kind: "name"; name: string }
  | { kind: "unavailable" };

export type ClaudeAgentCatalogMatch =
  | { kind: "unique"; modelID: string }
  | { kind: "ambiguous"; modelIDs: string[] }
  | { kind: "absent" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function observedAtOf(entry: Record<string, unknown>, fallback: number): number {
  const observedAt = Number(entry.observedAt);
  return Number.isFinite(observedAt) && observedAt > 0 ? Math.trunc(observedAt) : fallback;
}

function normalizeEvidence(raw: unknown): ModelAliasEvidenceV2 | null {
  const root = asRecord(raw);
  if (!root) return null;

  const version = Number(root.version);
  if (version !== 1 && version !== 2) return null;

  const updatedAt = Number(root.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;

  const aliasesRaw = asRecord(root.aliases);
  if (!aliasesRaw) return null;

  const aliases: ModelAliasEvidenceV2["aliases"] = {};
  for (const alias of CLAUDE_AGENT_PRICING_ALIASES) {
    const entry = asRecord(aliasesRaw[alias]);
    if (!entry) continue;

    if (version === 2 && entry.ambiguous === true) {
      aliases[alias] = {
        ambiguous: true,
        catalogObserved: entry.catalogObserved === true,
        observedAt: observedAtOf(entry, Math.trunc(updatedAt)),
      };
      continue;
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";

    // Version 1 only carried a name; leave it unresolved until the next host
    // observation records catalog coverage.
    if (version === 1) {
      if (!name) continue;
      aliases[alias] = {
        name,
        catalogObserved: false,
        observedAt: Math.trunc(updatedAt),
      };
      continue;
    }

    const resolvedRaw = entry.resolvedModelID;
    const resolvedModelID =
      typeof resolvedRaw === "string" && resolvedRaw.trim()
        ? resolvedRaw.trim()
        : resolvedRaw === null
          ? null
          : undefined;

    // Version 2 entries may omit the display name (for example a host that only
    // reported a resolved target). Keep them whenever the catalog answer or the
    // pinned target is still meaningful.
    if (!name && resolvedModelID === undefined && entry.catalogObserved !== true) continue;

    aliases[alias] = {
      ...(name ? { name } : {}),
      ...(resolvedModelID === undefined ? {} : { resolvedModelID }),
      catalogObserved: entry.catalogObserved === true,
      observedAt: observedAtOf(entry, Math.trunc(updatedAt)),
    };
  }

  return Object.keys(aliases).length > 0
    ? { version: 2, updatedAt: Math.trunc(updatedAt), aliases }
    : null;
}

export function getRuntimeModelAliasEvidencePath(runtimeDirs?: OpencodeRuntimeDirs): string {
  return join(
    getGuiPrivateCacheDir(runtimeDirs ?? getOpencodeRuntimeDirs()),
    RUNTIME_MODEL_ALIAS_FILENAME,
  );
}

/** Last confirmed evidence for this OpenCode runtime; invalid/missing files are ignored. */
export function readModelAliasEvidenceSync(
  runtimeDirs?: OpencodeRuntimeDirs,
): ModelAliasEvidenceV2 | null {
  try {
    const raw = readFileSync(getRuntimeModelAliasEvidencePath(runtimeDirs), "utf-8");
    return normalizeEvidence(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Content identity for analytics fingerprints; the raw file is tiny and bounded. */
export function getModelAliasEvidenceFingerprint(runtimeDirs?: OpencodeRuntimeDirs): string {
  try {
    const raw = readFileSync(getRuntimeModelAliasEvidencePath(runtimeDirs), "utf-8");
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Exact or vendor-prefix suffix match against display names. Zero matches
 * (absent) and multiple matches (ambiguous) stay distinct so callers can keep
 * the static fallback only where it is a same-generation answer.
 */
export function matchClaudeAgentCatalogName(
  name: string,
  catalogNames: readonly { modelID: string; name: string }[],
): ClaudeAgentCatalogMatch {
  const matches = catalogNames.filter(
    (model) => model.name === name || model.name.endsWith(` ${name}`),
  );
  const [only] = matches;
  if (only !== undefined && matches.length === 1) {
    return { kind: "unique", modelID: only.modelID };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", modelIDs: matches.map((model) => model.modelID) };
  }
  return { kind: "absent" };
}

/** One unique display-name match; null means ambiguous or absent. */
export function resolveClaudeAgentCatalogName(
  name: string,
  catalogNames: readonly { modelID: string; name: string }[],
): string | null {
  const match = matchClaudeAgentCatalogName(name, catalogNames);
  return match.kind === "unique" ? match.modelID : null;
}

export function readClaudeAgentAliasEvidence(
  alias: ClaudeAgentPricingAlias,
  runtimeDirs?: OpencodeRuntimeDirs,
): ClaudeAgentAliasEvidenceState {
  const entry = readModelAliasEvidenceSync(runtimeDirs)?.aliases[alias];
  if (!entry) return { kind: "unavailable" };
  if (entry.ambiguous) return { kind: "ambiguous" };
  if (typeof entry.resolvedModelID === "string") {
    return {
      kind: "resolved",
      modelID: entry.resolvedModelID,
      ...(entry.name ? { name: entry.name } : {}),
      catalogObserved: entry.catalogObserved,
    };
  }
  if (entry.catalogObserved) {
    return { kind: "unresolved", ...(entry.name ? { name: entry.name } : {}) };
  }
  if (entry.name) return { kind: "name", name: entry.name };
  return { kind: "unavailable" };
}

/**
 * Project one host model list to Claude Agent alias observations. A duplicate
 * alias is ambiguous evidence and must reach the worker as an explicit marker.
 */
export function collectClaudeAgentAliasEvidence(
  models: readonly ObservedModelEntry[],
): Partial<Record<ClaudeAgentPricingAlias, ClaudeAgentAliasObservation>> {
  const observed: Partial<Record<ClaudeAgentPricingAlias, ClaudeAgentAliasObservation>> = {};
  for (const alias of CLAUDE_AGENT_PRICING_ALIASES) {
    const entries = models.filter(
      (model) =>
        model.providerID === CLAUDE_AGENT_PROVIDER_ID && (model.id ?? model.modelID) === alias,
    );
    if (entries.length === 0) continue;
    const names = entries
      .map((model) => model.name?.trim())
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    const name = names[0];
    observed[alias] =
      entries.length === 1 && names.length === 1 && name
        ? { kind: "name", name }
        : { kind: "ambiguous" };
  }
  return observed;
}

function sameEvidence(a: ModelAliasEvidenceEntry | undefined, b: ModelAliasEvidenceEntry): boolean {
  return (
    a !== undefined &&
    a.name === b.name &&
    a.resolvedModelID === b.resolvedModelID &&
    a.ambiguous === b.ambiguous &&
    a.catalogObserved === b.catalogObserved
  );
}

/**
 * Persist what the host observed and what the current catalog resolved. A
 * changed or ambiguous observation rewrites the file so the worker's pricing
 * fingerprint sees it without a restart.
 */
export async function recordClaudeAgentModelEvidence(
  models: readonly ObservedModelEntry[],
  opts: {
    runtimeDirs?: OpencodeRuntimeDirs;
    nowMs?: number;
    /** Lets a disposing plugin stop an in-flight request before it writes. */
    shouldAbort?: () => boolean;
  } = {},
): Promise<void> {
  if (opts.shouldAbort?.()) return;

  const observed = collectClaudeAgentAliasEvidence(models);
  if (Object.keys(observed).length === 0) return;

  const path = getRuntimeModelAliasEvidencePath(opts.runtimeDirs);
  const existing = readModelAliasEvidenceSync(opts.runtimeDirs);
  const catalogObserved = hasPricingNameCoverage();
  const catalogNames = catalogObserved ? listModelDisplayNames(CLAUDE_AGENT_PRICED_PROVIDER) : [];
  const nowMs = opts.nowMs ?? Date.now();
  const aliases: ModelAliasEvidenceV2["aliases"] = { ...(existing?.aliases ?? {}) };
  let changed = false;

  for (const alias of CLAUDE_AGENT_PRICING_ALIASES) {
    const observation = observed[alias];
    if (!observation) continue;

    const previous = aliases[alias];
    // Without a covered catalog we cannot re-resolve, but the same confirmed
    // name keeps its last confirmed target for later/offline runs.
    if (
      observation.kind === "name" &&
      !catalogObserved &&
      previous?.name === observation.name &&
      typeof previous.resolvedModelID === "string"
    ) {
      continue;
    }

    const next: ModelAliasEvidenceEntry =
      observation.kind === "ambiguous"
        ? { ambiguous: true, catalogObserved, observedAt: nowMs }
        : {
            name: observation.name,
            ...(catalogObserved
              ? {
                  resolvedModelID: resolveClaudeAgentCatalogName(observation.name, catalogNames),
                }
              : {}),
            catalogObserved,
            observedAt: nowMs,
          };

    if (sameEvidence(aliases[alias], next)) continue;
    aliases[alias] = next;
    changed = true;
  }

  if (!changed) return;
  if (opts.shouldAbort?.()) return;
  await writeJsonAtomic(path, { version: 2, updatedAt: nowMs, aliases }, { trailingNewline: true });
}

export function isClaudeAgentPricingAlias(value: string): value is ClaudeAgentPricingAlias {
  return CLAUDE_AGENT_ALIAS_SET.has(value);
}
