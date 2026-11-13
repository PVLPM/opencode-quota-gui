import type { QuotaSnapshot, SettingsSnapshot } from "../contracts/dashboard.js";
import { isProviderFailureCategory } from "../contracts/provider-failure.js";
import { getQuotaProviderShape } from "../lib/provider-metadata.js";
import {
  formatNativeSettingsCopyDiagnostics,
  type NativeSettingsCopyDiagnosticsInput,
  type NativeSettingsCopyProviderReason,
  type NativeSettingsCopyProviderStatus,
  projectNativeSettingsCopyDiagnostics,
} from "./settings-copy-diagnostics.js";

export interface SettingsCopyDiagnosticsOptions {
  readonly appVersion?: NativeSettingsCopyDiagnosticsInput["appVersion"];
  readonly hostVersion?: NativeSettingsCopyDiagnosticsInput["hostVersion"];
  readonly quotaUnavailable?: boolean;
  readonly settingsUnavailable?: boolean;
}

function statusFromCounts(params: {
  enabledCount?: number;
  availableCount: number;
  cardCount: number;
  errorCount: number;
}): NonNullable<NativeSettingsCopyDiagnosticsInput["quota"]>["status"] {
  if (params.errorCount > 0) return params.availableCount > 0 ? "partial" : "error";
  if (params.cardCount === 0) return "no_data";
  if (params.enabledCount !== undefined && params.availableCount < params.enabledCount) {
    return "partial";
  }
  return "success";
}

function providerStatusesFromSnapshot(
  quota: QuotaSnapshot,
): NonNullable<NativeSettingsCopyDiagnosticsInput["providerStatuses"]> {
  const summaries = new Map<
    string,
    {
      cardCount: number;
      errorCardCount: number;
      hasRows: boolean;
      errorCount: number;
      reasons: Set<NativeSettingsCopyProviderReason>;
    }
  >();
  const summaryFor = (providerId: string) => {
    let summary = summaries.get(providerId);
    if (!summary) {
      summary = {
        cardCount: 0,
        errorCardCount: 0,
        hasRows: false,
        errorCount: 0,
        reasons: new Set(),
      };
      summaries.set(providerId, summary);
    }
    return summary;
  };

  for (const card of quota.providers.cards) {
    const providerId = getQuotaProviderShape(card.providerId)?.id;
    if (!providerId) continue;
    const summary = summaryFor(providerId);
    summary.cardCount += 1;
    if (Array.isArray(card.rows) && card.rows.length > 0) summary.hasRows = true;
    const errors = Array.isArray(card.errors) ? card.errors : [];
    if (errors.length > 0) {
      summary.errorCardCount += 1;
      summary.errorCount += errors.length;
      for (const error of errors) {
        summary.reasons.add(
          isProviderFailureCategory(error.failureCategory) ? error.failureCategory : "unknown",
        );
      }
    }
  }

  const enabledProviders = quota.providers.enabledProviders;
  if (Array.isArray(enabledProviders)) {
    for (const configuredId of enabledProviders) {
      if (typeof configuredId !== "string") continue;
      const providerId = getQuotaProviderShape(configuredId)?.id;
      if (providerId) summaryFor(providerId);
    }
  }

  return [...summaries].map(([providerId, summary]) => {
    let status: NativeSettingsCopyProviderStatus;
    let reasons: NativeSettingsCopyProviderReason[] | undefined;
    if (summary.cardCount === 0) {
      status = "unknown";
      reasons = ["unknown"];
    } else if (summary.errorCount > 0) {
      status = summary.hasRows || summary.errorCardCount < summary.cardCount ? "partial" : "error";
      reasons = [...summary.reasons].sort();
      if (reasons.length === 0) reasons = ["unknown"];
    } else if (summary.hasRows) {
      status = "success";
    } else {
      status = "no_data";
      reasons = ["no_data"];
    }
    return {
      providerId,
      status,
      ...(reasons === undefined ? {} : { reasons }),
    };
  });
}

function configurationSource(
  settings: SettingsSnapshot,
): NonNullable<NativeSettingsCopyDiagnosticsInput["configuration"]>["source"] {
  const provenance = settings.provenance;
  if (!provenance) return undefined;
  const entries = Object.values(provenance);
  if (entries.length === 0) return undefined;
  const validScopes = ["defaults", "global", "workspace", "project", "legacy"];
  if (!entries.every((entry) => validScopes.includes(entry.scope))) return undefined;
  return entries.every((entry) => entry.scope === "defaults") ? "defaults" : "files";
}

function quotaSummary(quota: QuotaSnapshot, pageStale: boolean) {
  const cards = quota.providers.cards;
  const enabled = Array.isArray(quota.providers.enabledProviders)
    ? new Set(quota.providers.enabledProviders)
    : undefined;
  const providerIds = new Set<string>();
  const providersWithErrors = new Set<string>();
  let errorCount = 0;

  for (const card of cards) {
    providerIds.add(card.providerId);
    const errors = Array.isArray(card.errors) ? card.errors : [];
    errorCount += errors.length;
    if (errors.length > 0) providersWithErrors.add(card.providerId);
  }

  const availableCount = [...providerIds].filter(
    (providerId) => !providersWithErrors.has(providerId) && (!enabled || enabled.has(providerId)),
  ).length;
  const enabledCount = enabled?.size;
  const status = statusFromCounts({
    enabledCount,
    availableCount,
    cardCount: cards.length,
    errorCount,
  });

  return {
    quota: {
      status,
      stale: pageStale || quota.stale,
      providerCount: providerIds.size,
      cardCount: cards.length,
      errorCount,
    },
    providerAvailability: {
      ...(enabledCount === undefined ? {} : { enabledCount }),
      availableCount,
      status,
    },
  };
}

/** Derive only aggregates from the snapshots already loaded by the page. */
export function settingsDiagnosticsFromSnapshots(
  quota: QuotaSnapshot | undefined,
  settings: SettingsSnapshot | undefined,
  stale: boolean,
  options: SettingsCopyDiagnosticsOptions = {},
): string {
  try {
    const quotaProjection = quota ? quotaSummary(quota, stale) : undefined;
    const diagnostics: NativeSettingsCopyDiagnosticsInput = {
      appVersion: options.appVersion,
      hostVersion: options.hostVersion,
      quota:
        quotaProjection?.quota ??
        (options.quotaUnavailable ? { status: "unavailable", stale: true } : undefined),
      providerAvailability: quotaProjection?.providerAvailability,
      providerStatuses: quota ? providerStatusesFromSnapshot(quota) : undefined,
      configuration: settings
        ? {
            source: configurationSource(settings),
            status: settings.issues.length > 0 ? "issues" : "ready",
            issueCount: settings.issues.length,
          }
        : options.settingsUnavailable
          ? { status: "unavailable" }
          : undefined,
      temporal: quota?.temporal ? { providers: quota.temporal.providers } : undefined,
    };
    return formatNativeSettingsCopyDiagnostics(projectNativeSettingsCopyDiagnostics(diagnostics));
  } catch {
    // The snapshot seam is normally validated by the RPC client. If a malformed
    // or hostile object crosses it, omit everything rather than copy any detail.
    return formatNativeSettingsCopyDiagnostics(projectNativeSettingsCopyDiagnostics({}));
  }
}

export async function copySettingsDiagnostics(
  makeText: () => string | Promise<string>,
  writeText: ((text: string) => Promise<void>) | undefined,
  notify: (tone: "success" | "error", message: string) => void,
): Promise<void> {
  try {
    if (!writeText) throw new Error("Clipboard unavailable");
    await writeText(await makeText());
    notify("success", "Diagnostics copied to clipboard.");
  } catch {
    notify("error", "Could not copy diagnostics. Check clipboard permissions and try again.");
  }
}
