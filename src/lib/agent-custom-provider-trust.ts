import { createHash } from "node:crypto";

import {
  type QuotaProviderDefinition,
  type RemoteApiQuotaProviderDefinition,
  validateQuotaProviders,
} from "./quota-providers.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Labels are presentation-only; request, identity, and mapping fields affect trust. */
export function agentCustomProviderTrustFingerprint(definition: QuotaProviderDefinition): string {
  const material = Object.fromEntries(
    Object.entries(definition).filter(([key]) => key !== "label"),
  );
  return createHash("sha256").update(stableJson(material)).digest("hex");
}

export interface AgentCustomProviderRuntimeTrust {
  agentCustomProviderIds?: readonly string[];
  agentCustomProviderTrust?: Readonly<Record<string, string>>;
}

export function isAgentCustomProviderManagedDefinition(
  definition: QuotaProviderDefinition,
  trust: AgentCustomProviderRuntimeTrust = {},
): boolean {
  return (
    (trust.agentCustomProviderIds ?? []).includes(definition.id) ||
    Object.hasOwn(trust.agentCustomProviderTrust ?? {}, definition.id)
  );
}

export function isAgentCustomProviderTrustedDefinition(
  definition: QuotaProviderDefinition,
  trust: AgentCustomProviderRuntimeTrust = {},
): boolean {
  if (!isAgentCustomProviderManagedDefinition(definition, trust)) return true;
  return (
    trust.agentCustomProviderTrust?.[definition.id] ===
    agentCustomProviderTrustFingerprint(definition)
  );
}

export function resolveApprovedAgentCustomProviderApiKey(
  definition: RemoteApiQuotaProviderDefinition,
  trust: AgentCustomProviderRuntimeTrust,
): string | undefined {
  if (
    !definition.apiKeyEnv ||
    !isAgentCustomProviderManagedDefinition(definition, trust) ||
    !isAgentCustomProviderTrustedDefinition(definition, trust)
  ) {
    return undefined;
  }
  return process.env[definition.apiKeyEnv]?.trim() || undefined;
}

export interface AgentCustomProviderTrustProjection {
  /** Every recognizable proposal id, including disabled and stale proposals. */
  managedIds: string[];
  /** Enabled definitions with a currently matching approval fingerprint only. */
  definitions: QuotaProviderDefinition[];
  fingerprints: Record<string, string>;
}

/**
 * Fail closed when projecting persisted agent proposals into runtime config.
 * Invalid or duplicate records never become pollable; their recognizable ids
 * remain marked as managed so a stale preselected definition is rejected.
 */
export function projectTrustedAgentCustomProviders(
  value: unknown,
  existingDefinitions: readonly QuotaProviderDefinition[],
): AgentCustomProviderTrustProjection {
  const rawRecords = Array.isArray(value) ? value : [];
  const counts = new Map<string, number>();
  for (const raw of rawRecords) {
    if (!isPlainObject(raw) || !isPlainObject(raw.definition)) continue;
    const id = raw.definition.id;
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const managedIds: string[] = [];
  const definitions: QuotaProviderDefinition[] = [];
  const fingerprints: Record<string, string> = {};
  const existingIds = new Set(existingDefinitions.map((definition) => definition.id));
  const seenIds = new Set<string>();

  for (const raw of rawRecords) {
    if (!isPlainObject(raw) || !isPlainObject(raw.definition)) continue;
    const rawId = raw.definition.id;
    if (typeof rawId !== "string") continue;
    if (!seenIds.has(rawId)) managedIds.push(rawId);
    seenIds.add(rawId);
    if (counts.get(rawId) !== 1) continue;

    const validation = validateQuotaProviders([raw.definition]);
    const definition = validation.value?.[0];
    if (!definition || existingIds.has(definition.id)) continue;
    const fingerprint = agentCustomProviderTrustFingerprint(definition);
    if (raw.enabled !== true || raw.trustedDefinitionHash !== fingerprint) continue;

    existingIds.add(definition.id);
    definitions.push(definition);
    fingerprints[definition.id] = fingerprint;
  }

  return { managedIds, definitions, fingerprints };
}
