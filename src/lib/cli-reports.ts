/**
 * The reports behind `opencode-quota-gui show` and `status`. The terminal command builds them
 * in its own process (`cli-show.ts`) and prints them.
 */
import { sanitizeQuotaRenderData } from "./display-sanitize.js";
import { formatQuotaRows } from "./format.js";
import { formatQuotaModeHeading } from "./format-utils.js";
import { buildStatusReportData } from "./quota-dialog-commands.js";
import { buildQuotaExport, createExportProviderContext } from "./quota-export.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  type QuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { QuotaToastConfig } from "./types.js";
import { getPackageVersion } from "./version.js";

export type CliReport = { exitCode: number; stdout: string; stderr: string };

function line(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

const QUOTA_DISABLED: CliReport = {
  exitCode: 1,
  stdout: "",
  stderr: line("Quota disabled in config (enabled: false)."),
};

function cloneCliConfig(config: QuotaToastConfig): QuotaToastConfig {
  return {
    ...config,
    enabledProviders: Array.isArray(config.enabledProviders)
      ? [...config.enabledProviders]
      : config.enabledProviders,
    opencodeGoWindows: [...config.opencodeGoWindows],
    pricingSnapshot: { ...config.pricingSnapshot },
    layout: { ...config.layout },
    showSessionTokens: false,
  };
}

/** `show`: live quota rows as text. Exit 1 when no provider returned a row. */
export async function buildCliShowText(params: {
  runtime: QuotaRuntimeContext;
  providerId?: string;
}): Promise<CliReport> {
  const { runtime, providerId } = params;

  if (!runtime.config.enabled) {
    return QUOTA_DISABLED;
  }

  const config = cloneCliConfig(runtime.config);
  if (providerId) {
    config.enabledProviders = [providerId];
  }

  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: true,
    formatStyle: resolveQuotaFormatStyle(config.formatStyle),
    providers: runtime.providers,
  });

  if (!result.data) {
    return { exitCode: 1, stdout: "", stderr: line("No provider data available.") };
  }

  const data = sanitizeQuotaRenderData(result.data);
  const version = (await getPackageVersion()) ?? "";
  const output = formatQuotaRows({
    version,
    layout: config.layout,
    entries: data.entries,
    errors: data.errors,
    style: resolveQuotaFormatStyle(config.formatStyle),
    percentDisplayMode: config.percentDisplayMode,
    percentLabelStyle: config.percentLabelStyle,
    accountingDetail: config.accountingDetail,
    resetTimeDecimals: config.resetTimeDecimals,
    resetTimeSpaced: config.resetTimeSpaced,
  });

  if (!output.trim()) {
    return { exitCode: 1, stdout: "", stderr: line("No provider data available.") };
  }

  return {
    exitCode: data.entries.length > 0 ? 0 : 1,
    stdout: line(
      config.percentLabelStyle === "bare"
        ? `${formatQuotaModeHeading(config.percentDisplayMode)}\n\n${output}`
        : output,
    ),
    stderr: "",
  };
}

/**
 * `show --json`: cached quota as export JSON. With a threshold, exit 1 when a comparable
 * percentage is below it and 2 when the data is incomplete or has no comparable percentage.
 */
export async function buildCliShowJson(params: {
  runtime: QuotaRuntimeContext;
  providerId?: string;
  threshold?: number;
}): Promise<CliReport> {
  const { runtime, providerId, threshold } = params;

  if (!runtime.config.enabled) {
    return QUOTA_DISABLED;
  }

  const config = cloneCliConfig(runtime.config);
  if (providerId) {
    config.enabledProviders = [providerId];
  }

  const allProviders = runtime.providers.filter((p) => {
    if (config.enabledProviders === "auto") return true;
    return config.enabledProviders.includes(p.id);
  });

  // Read cached quota through the shared export context so the cache key
  // matches the one the TUI background writer used. Without this, a user with
  // onlyCurrentModel:true would compute a different key and every provider
  // would read back as "unavailable".
  const ctx = createExportProviderContext(runtime);
  const exportData = await buildQuotaExport({
    providers: allProviders,
    ctx,
    ttlMs: config.minIntervalMs,
    fromCache: true,
  });

  const report = (exitCode: number): CliReport => ({
    exitCode,
    stdout: line(JSON.stringify(exportData, null, 2)),
    stderr: "",
  });

  if (threshold !== undefined) {
    const providerResults = Object.values(exportData.providers);
    if (providerResults.some((provider) => provider.status !== "ok")) {
      return report(2);
    }

    const okProviders = providerResults.filter(
      (p): p is Extract<typeof p, { status: "ok" }> => p.status === "ok",
    );

    if (okProviders.length === 0) {
      // No cached quota to compare against: distinct from "below threshold" (1).
      return report(2);
    }

    let hasComparablePercent = false;
    for (const provider of okProviders) {
      const percents = provider.entries
        .filter((entry) => entry.renderType === "percent")
        .map((entry) => entry.percentRemaining);
      if (percents.length === 0) continue;
      hasComparablePercent = true;
      const minPercent = Math.min(...percents);
      if (minPercent < threshold) {
        return report(1);
      }
    }

    if (!hasComparablePercent) {
      return report(2);
    }
  }

  return report(0);
}

/**
 * `status`: the Quota Status report as text, or its payload as JSON. With JSON, exit 2 when
 * no provider produced comparable data.
 */
export async function buildCliStatus(params: {
  runtime: QuotaRuntimeContext;
  providerId?: string;
  json: boolean;
}): Promise<CliReport> {
  const { runtime, providerId, json } = params;

  if (!runtime.config.enabled) {
    return QUOTA_DISABLED;
  }

  const data = await buildStatusReportData({
    runtime,
    generatedAtMs: Date.now(),
    providerFilterId: providerId,
  });

  if (!data.output || !data.payload) {
    return QUOTA_DISABLED;
  }

  if (json) {
    return {
      exitCode: data.hasComparableProviderData ? 0 : 2,
      stdout: line(JSON.stringify(data.payload, null, 2)),
      stderr: "",
    };
  }

  return { exitCode: 0, stdout: line(data.output), stderr: "" };
}
