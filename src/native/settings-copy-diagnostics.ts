import {
  PROVIDER_FAILURE_CATEGORIES,
  type ProviderFailureCategory,
} from "../contracts/provider-failure.js";
import { getQuotaProviderShape } from "../lib/provider-metadata.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";

/** Closed statuses shared by provider availability and quota probe summaries. */
export type NativeSettingsCopyProbeStatus =
  | "success"
  | "partial"
  | "error"
  | "no_data"
  | "unavailable";

export type NativeSettingsCopyProviderStatus = NativeSettingsCopyProbeStatus | "unknown";
export type NativeSettingsCopyProviderReason = ProviderFailureCategory | "no_data" | "unknown";
export type NativeSettingsCopyTemporalPhase = "peak" | "offpeak" | "mixed" | "unknown";

interface NativeSettingsCopyProviderSummary {
  readonly providerId: CanonicalQuotaProviderId;
  readonly status: NativeSettingsCopyProviderStatus;
  readonly reasons?: readonly NativeSettingsCopyProviderReason[];
}

/**
 * Explicit backend-to-diagnostics seam. Callers supply summaries or temporal
 * phase facts and closed provider status summaries only; labels, messages,
 * paths, and raw status details are intentionally not part of this input
 * contract. Provider identifiers are revalidated against the canonical catalog.
 */
export interface NativeSettingsCopyDiagnosticsInput {
  readonly appVersion?: string | null;
  readonly hostVersion?: string | null;
  readonly providerAvailability?: {
    readonly enabledCount?: number;
    readonly availableCount?: number;
    readonly status?: NativeSettingsCopyProbeStatus;
  };
  readonly providerStatuses?: readonly {
    readonly providerId: string;
    readonly status: NativeSettingsCopyProviderStatus;
    readonly reasons?: readonly NativeSettingsCopyProviderReason[];
  }[];
  readonly quota?: {
    readonly source?: "remote-api" | "local-estimate" | "mixed";
    readonly status?: NativeSettingsCopyProbeStatus;
    readonly stale?: boolean;
    readonly providerCount?: number;
    readonly cardCount?: number;
    readonly errorCount?: number;
  };
  readonly configuration?: {
    readonly source?: "defaults" | "files";
    readonly status?: "ready" | "issues" | "unavailable";
    readonly issueCount?: number;
  };
  readonly pricing?: {
    readonly source?: "runtime" | "bundled" | "empty";
    readonly stale?: boolean;
  };
  readonly temporal?: {
    readonly providers?: readonly {
      readonly discovered?: boolean;
      readonly phase?: NativeSettingsCopyTemporalPhase;
    }[];
  };
}

export interface NativeSettingsCopyDiagnostics {
  readonly schemaVersion: 1;
  readonly appVersion?: string;
  readonly hostVersion?: string;
  readonly providers?: {
    readonly enabledCount?: number;
    readonly availableCount?: number;
    readonly availability?: "none" | "partial" | "all";
    readonly status?: NativeSettingsCopyProbeStatus;
    readonly statuses?: readonly NativeSettingsCopyProviderSummary[];
  };
  readonly quota?: {
    readonly source?: "remote-api" | "local-estimate" | "mixed";
    readonly status?: NativeSettingsCopyProbeStatus;
    readonly stale?: boolean;
    readonly providerCount?: number;
    readonly cardCount?: number;
    readonly errorCount?: number;
  };
  readonly configuration?: {
    readonly source?: "defaults" | "files";
    readonly status?: "ready" | "issues" | "unavailable";
    readonly issueCount?: number;
  };
  readonly pricing?: {
    readonly source?: "runtime" | "bundled" | "empty";
    readonly status?: "current" | "stale" | "unavailable";
  };
  readonly temporal?: {
    readonly status: "available" | "no_data";
    readonly providerCount: number;
    readonly discoveredCount: number;
    readonly phases: Readonly<Record<NativeSettingsCopyTemporalPhase, number>>;
  };
}

const MAX_COUNT = 1_000_000;
const MAX_TEMPORAL_PROVIDERS = 10_000;
const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const PROBE_STATUSES: readonly NativeSettingsCopyProbeStatus[] = [
  "success",
  "partial",
  "error",
  "no_data",
  "unavailable",
];

const TEMPORAL_PHASES: readonly NativeSettingsCopyTemporalPhase[] = [
  "peak",
  "offpeak",
  "mixed",
  "unknown",
];

const PROVIDER_STATUSES: readonly NativeSettingsCopyProviderStatus[] = [
  ...PROBE_STATUSES,
  "unknown",
];
const PROVIDER_REASONS: readonly NativeSettingsCopyProviderReason[] = [
  ...PROVIDER_FAILURE_CATEGORIES,
  "no_data",
  "unknown",
];
const MAX_PROVIDER_STATUS_ENTRIES = 256;

type UnknownRecord = Record<string, unknown>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT
  );
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && VERSION_RE.test(value);
}

function canonicalProviderId(value: unknown): CanonicalQuotaProviderId | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  return getQuotaProviderShape(value)?.id;
}

function projectProviderStatuses(value: unknown): NativeSettingsCopyProviderSummary[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROVIDER_STATUS_ENTRIES) {
    return undefined;
  }

  const byProvider = new Map<CanonicalQuotaProviderId, NativeSettingsCopyProviderSummary>();
  for (const rawStatus of value) {
    const input = asRecord(rawStatus);
    if (!input) continue;
    const providerId = canonicalProviderId(input.providerId);
    if (!providerId) continue;
    if (byProvider.has(providerId)) {
      // Duplicate entries are ambiguous and not reliable enough to report as a
      // successful state or as a provider-supplied reason.
      byProvider.set(providerId, { providerId, status: "unknown", reasons: ["unknown"] });
      continue;
    }

    const rawStatusValue = input.status;
    const status = isOneOf(rawStatusValue, PROVIDER_STATUSES) ? rawStatusValue : "unknown";
    let reasons: NativeSettingsCopyProviderReason[] | undefined;
    if (status === "unknown") {
      reasons = ["unknown"];
    } else if (status === "no_data") {
      reasons = ["no_data"];
    } else if (status === "error" || status === "partial") {
      const rawReasons = input.reasons;
      const safeReasons = new Set<NativeSettingsCopyProviderReason>();
      if (Array.isArray(rawReasons) && rawReasons.length <= PROVIDER_REASONS.length) {
        for (const rawReason of rawReasons) {
          if (isOneOf(rawReason, PROVIDER_FAILURE_CATEGORIES)) safeReasons.add(rawReason);
          else safeReasons.add("unknown");
        }
      }
      if (safeReasons.size === 0) safeReasons.add("unknown");
      reasons = [...safeReasons].sort();
    }

    byProvider.set(providerId, {
      providerId,
      status,
      ...(reasons === undefined ? {} : { reasons }),
    });
  }

  if (byProvider.size === 0) return undefined;
  return [...byProvider.values()].sort((left, right) =>
    left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0,
  );
}

function projectProviders(value: unknown): NativeSettingsCopyDiagnostics["providers"] {
  const input = asRecord(value);
  if (!input) return undefined;
  const rawEnabledCount = input.enabledCount;
  const rawAvailableCount = input.availableCount;
  const rawStatus = input.status;
  const rawProviderStatuses = input.statuses;
  const enabledCount = validCount(rawEnabledCount) ? rawEnabledCount : undefined;
  const availableCount = validCount(rawAvailableCount) ? rawAvailableCount : undefined;
  const status = isOneOf(rawStatus, PROBE_STATUSES) ? rawStatus : undefined;
  const statuses = projectProviderStatuses(rawProviderStatuses);
  const projected: {
    enabledCount?: number;
    availableCount?: number;
    availability?: "none" | "partial" | "all";
    status?: NativeSettingsCopyProbeStatus;
    statuses?: readonly NativeSettingsCopyProviderSummary[];
  } = {};

  if (
    enabledCount !== undefined &&
    availableCount !== undefined &&
    availableCount <= enabledCount
  ) {
    projected.enabledCount = enabledCount;
    projected.availableCount = availableCount;
    projected.availability =
      availableCount === 0 ? "none" : availableCount === enabledCount ? "all" : "partial";
  }
  if (status !== undefined) projected.status = status;
  if (statuses !== undefined) projected.statuses = statuses;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectQuota(value: unknown): NativeSettingsCopyDiagnostics["quota"] {
  const input = asRecord(value);
  if (!input) return undefined;
  const source = input.source;
  const status = input.status;
  const stale = input.stale;
  const providerCount = input.providerCount;
  const cardCount = input.cardCount;
  const errorCount = input.errorCount;
  const projected: Mutable<NonNullable<NativeSettingsCopyDiagnostics["quota"]>> = {};
  if (isOneOf(source, ["remote-api", "local-estimate", "mixed"] as const))
    projected.source = source;
  if (isOneOf(status, PROBE_STATUSES)) projected.status = status;
  if (typeof stale === "boolean") projected.stale = stale;
  if (validCount(providerCount)) projected.providerCount = providerCount;
  if (validCount(cardCount)) projected.cardCount = cardCount;
  if (validCount(errorCount)) projected.errorCount = errorCount;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectConfiguration(value: unknown): NativeSettingsCopyDiagnostics["configuration"] {
  const input = asRecord(value);
  if (!input) return undefined;
  const source = input.source;
  const status = input.status;
  const issueCount = input.issueCount;
  const projected: Mutable<NonNullable<NativeSettingsCopyDiagnostics["configuration"]>> = {};
  if (isOneOf(source, ["defaults", "files"] as const)) projected.source = source;
  if (isOneOf(status, ["ready", "issues", "unavailable"] as const)) {
    projected.status = status;
  }
  if (validCount(issueCount)) projected.issueCount = issueCount;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectPricing(value: unknown): NativeSettingsCopyDiagnostics["pricing"] {
  const input = asRecord(value);
  if (!input) return undefined;
  const rawSource = input.source;
  const rawStale = input.stale;
  const source = isOneOf(rawSource, ["runtime", "bundled", "empty"] as const)
    ? rawSource
    : undefined;
  const stale = typeof rawStale === "boolean" ? rawStale : undefined;
  const projected: Mutable<NonNullable<NativeSettingsCopyDiagnostics["pricing"]>> = {};
  if (source !== undefined) projected.source = source;
  if (source !== undefined && stale !== undefined) {
    projected.status = source === "empty" ? "unavailable" : stale ? "stale" : "current";
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function sanitizePricingDto(value: unknown): NativeSettingsCopyDiagnostics["pricing"] {
  const input = asRecord(value);
  if (!input) return undefined;
  const rawSource = input.source;
  const status = input.status;
  const projected: Mutable<NonNullable<NativeSettingsCopyDiagnostics["pricing"]>> = {};
  const source = isOneOf(rawSource, ["runtime", "bundled", "empty"] as const)
    ? rawSource
    : undefined;
  if (source !== undefined) projected.source = source;
  if (source === "empty" && status === "unavailable") {
    projected.status = "unavailable";
  } else if (
    (source === "runtime" || source === "bundled") &&
    isOneOf(status, ["current", "stale"] as const)
  ) {
    projected.status = status;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectTemporal(value: unknown): NativeSettingsCopyDiagnostics["temporal"] {
  const input = asRecord(value);
  if (!input) {
    return undefined;
  }
  const providers = input.providers;
  if (!Array.isArray(providers)) return undefined;
  const providersLength = providers.length;
  if (providersLength > MAX_TEMPORAL_PROVIDERS) return undefined;

  const phases: Record<NativeSettingsCopyTemporalPhase, number> = {
    peak: 0,
    offpeak: 0,
    mixed: 0,
    unknown: 0,
  };
  let providerCount = 0;
  let discoveredCount = 0;
  for (let index = 0; index < providersLength; index += 1) {
    const rawProvider = providers[index];
    const provider = asRecord(rawProvider);
    if (!provider) continue;
    const discovered = provider.discovered;
    const phase = provider.phase;
    if (typeof discovered !== "boolean") continue;
    if (!isOneOf(phase, TEMPORAL_PHASES)) continue;
    providerCount += 1;
    if (discovered) discoveredCount += 1;
    phases[phase] += 1;
  }

  // An explicitly empty list is trustworthy. If a non-empty list contains no
  // recognized records, its status is unknown, so do not report a false zero.
  if (providerCount === 0 && providersLength > 0) return undefined;
  return {
    status: providerCount === 0 ? "no_data" : "available",
    providerCount,
    discoveredCount,
    phases,
  };
}

/**
 * Project backend diagnostics into a fresh, closed, privacy-safe DTO. Unknown
 * properties are never enumerated or copied; malformed source data is omitted.
 */
export function projectNativeSettingsCopyDiagnostics(
  source: NativeSettingsCopyDiagnosticsInput,
): NativeSettingsCopyDiagnostics {
  const projected: {
    schemaVersion: 1;
    appVersion?: string;
    hostVersion?: string;
    providers?: NativeSettingsCopyDiagnostics["providers"];
    quota?: NativeSettingsCopyDiagnostics["quota"];
    configuration?: NativeSettingsCopyDiagnostics["configuration"];
    pricing?: NativeSettingsCopyDiagnostics["pricing"];
    temporal?: NativeSettingsCopyDiagnostics["temporal"];
  } = { schemaVersion: 1 };

  try {
    const input = asRecord(source);
    if (!input) return projected;
    const appVersion = input.appVersion;
    const hostVersion = input.hostVersion;
    const providerAvailability = input.providerAvailability;
    const providerStatusesValue = input.providerStatuses;
    const quotaValue = input.quota;
    const configurationValue = input.configuration;
    const pricingValue = input.pricing;
    const temporalValue = input.temporal;
    if (validVersion(appVersion)) projected.appVersion = appVersion;
    if (validVersion(hostVersion)) projected.hostVersion = hostVersion;
    const providerAvailabilitySummary = projectProviders(providerAvailability);
    const providerStatuses = projectProviderStatuses(providerStatusesValue);
    const providers =
      providerAvailabilitySummary === undefined && providerStatuses === undefined
        ? undefined
        : {
            ...providerAvailabilitySummary,
            ...(providerStatuses === undefined ? {} : { statuses: providerStatuses }),
          };
    const quota = projectQuota(quotaValue);
    const configuration = projectConfiguration(configurationValue);
    const pricing = projectPricing(pricingValue);
    const temporal = projectTemporal(temporalValue);
    if (providers !== undefined) projected.providers = providers;
    if (quota !== undefined) projected.quota = quota;
    if (configuration !== undefined) projected.configuration = configuration;
    if (pricing !== undefined) projected.pricing = pricing;
    if (temporal !== undefined) projected.temporal = temporal;
    return projected;
  } catch {
    // A hostile or broken getter is not diagnostic content. Fail closed without
    // retaining even the fields read before the failure.
    return { schemaVersion: 1 };
  }
}

function sanitizeDto(value: unknown): NativeSettingsCopyDiagnostics {
  const empty: NativeSettingsCopyDiagnostics = { schemaVersion: 1 };
  try {
    const input = asRecord(value);
    if (!input) return empty;
    const schemaVersion = input.schemaVersion;
    if (schemaVersion !== 1) return empty;
    const appVersion = input.appVersion;
    const hostVersion = input.hostVersion;
    const providersValue = input.providers;
    const quotaValue = input.quota;
    const configurationValue = input.configuration;
    const pricingValue = input.pricing;
    const temporalValue = input.temporal;
    const safe: {
      schemaVersion: 1;
      appVersion?: string;
      hostVersion?: string;
      providers?: NativeSettingsCopyDiagnostics["providers"];
      quota?: NativeSettingsCopyDiagnostics["quota"];
      configuration?: NativeSettingsCopyDiagnostics["configuration"];
      pricing?: NativeSettingsCopyDiagnostics["pricing"];
      temporal?: NativeSettingsCopyDiagnostics["temporal"];
    } = { schemaVersion: 1 };

    if (validVersion(appVersion)) safe.appVersion = appVersion;
    if (validVersion(hostVersion)) safe.hostVersion = hostVersion;
    const providers = projectProviders(providersValue);
    const quota = projectQuota(quotaValue);
    const configuration = projectConfiguration(configurationValue);
    const pricing = sanitizePricingDto(pricingValue);
    if (providers !== undefined) safe.providers = providers;
    if (quota !== undefined) safe.quota = quota;
    if (configuration !== undefined) safe.configuration = configuration;
    if (pricing !== undefined) safe.pricing = pricing;

    const temporal = asRecord(temporalValue);
    const rawStatus = temporal?.status;
    const rawProviderCount = temporal?.providerCount;
    const rawDiscoveredCount = temporal?.discoveredCount;
    const phases = asRecord(temporal?.phases);
    const rawPeak = phases?.peak;
    const rawOffpeak = phases?.offpeak;
    const rawMixed = phases?.mixed;
    const rawUnknown = phases?.unknown;
    const phaseCounts: Record<NativeSettingsCopyTemporalPhase, unknown> = {
      peak: rawPeak,
      offpeak: rawOffpeak,
      mixed: rawMixed,
      unknown: rawUnknown,
    };
    const phaseCountValues = TEMPORAL_PHASES.map((phase) => phaseCounts[phase]);
    const phaseTotal = phaseCountValues.reduce<number>(
      (total, count) => total + (typeof count === "number" ? count : 0),
      0,
    );
    if (
      temporal &&
      phases &&
      isOneOf(rawStatus, ["available", "no_data"] as const) &&
      validCount(rawProviderCount) &&
      validCount(rawDiscoveredCount) &&
      rawDiscoveredCount <= rawProviderCount &&
      phaseCountValues.every(validCount) &&
      phaseTotal === rawProviderCount &&
      (rawStatus === "available" ? rawProviderCount > 0 : rawProviderCount === 0)
    ) {
      safe.temporal = {
        status: rawStatus,
        providerCount: rawProviderCount,
        discoveredCount: rawDiscoveredCount,
        phases: {
          peak: rawPeak as number,
          offpeak: rawOffpeak as number,
          mixed: rawMixed as number,
          unknown: rawUnknown as number,
        },
      };
    }
    return safe;
  } catch {
    return empty;
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Format only the closed DTO, using fixed labels and controlled enum values. */
export function formatNativeSettingsCopyDiagnostics(
  diagnostics: NativeSettingsCopyDiagnostics,
): string {
  const safe = sanitizeDto(diagnostics);
  const lines = ["Native Settings diagnostics"];
  if (safe.appVersion !== undefined) lines.push(`Application version: ${safe.appVersion}`);
  if (safe.hostVersion !== undefined) lines.push(`Host version: ${safe.hostVersion}`);

  const providers = safe.providers;
  if (providers) {
    if (providers.availability !== undefined) {
      lines.push(
        `Provider availability: ${providers.availability} (${providers.availableCount}/${providers.enabledCount} available)${
          providers.status === undefined ? "" : `; status ${providers.status}`
        }`,
      );
    } else if (providers.status !== undefined) {
      lines.push(`Provider status: ${providers.status}`);
    }
    if (providers.statuses && providers.statuses.length > 0) {
      lines.push("Provider diagnostics:");
      for (const provider of providers.statuses) {
        const reasons = provider.reasons;
        lines.push(
          `- ${provider.providerId}: ${provider.status}${
            reasons && reasons.length > 0 ? `; reasons ${reasons.join(", ")}` : ""
          }`,
        );
      }
    }
  }

  const quota = safe.quota;
  if (quota) {
    const parts: string[] = [];
    if (quota.source !== undefined) {
      parts.push(
        quota.source === "remote-api"
          ? "remote API"
          : quota.source === "local-estimate"
            ? "local estimate"
            : "mixed",
      );
    }
    if (quota.status !== undefined) parts.push(quota.status);
    if (quota.stale !== undefined) parts.push(quota.stale ? "stale" : "fresh");
    if (quota.providerCount !== undefined) parts.push(plural(quota.providerCount, "provider"));
    if (quota.cardCount !== undefined) parts.push(plural(quota.cardCount, "card"));
    if (quota.errorCount !== undefined) parts.push(plural(quota.errorCount, "error"));
    if (parts.length > 0) lines.push(`Quota: ${parts.join("; ")}`);
  }

  const configuration = safe.configuration;
  if (configuration) {
    const parts: string[] = [];
    if (configuration.source !== undefined) parts.push(configuration.source);
    if (configuration.status !== undefined) parts.push(configuration.status);
    const issueCount =
      configuration.issueCount === undefined
        ? ""
        : ` (${plural(configuration.issueCount, "issue")})`;
    if (parts.length > 0) lines.push(`Configuration: ${parts.join("; ")}${issueCount}`);
  }

  const pricing = safe.pricing;
  if (pricing) {
    const parts: string[] = [];
    if (pricing.source !== undefined) parts.push(pricing.source);
    if (pricing.status !== undefined) parts.push(pricing.status);
    if (parts.length > 0) lines.push(`Pricing: ${parts.join("; ")}`);
  }

  const temporal = safe.temporal;
  if (temporal) {
    lines.push(
      `Temporal: ${temporal.status}; ${plural(temporal.providerCount, "provider")}; ${temporal.discoveredCount} discovered; peak ${temporal.phases.peak}, off-peak ${temporal.phases.offpeak}, mixed ${temporal.phases.mixed}, unknown ${temporal.phases.unknown}`,
    );
  }
  return lines.join("\n");
}
