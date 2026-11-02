import type { ProviderFailureCategory } from "../contracts/provider-failure.js";
import {
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanErrorKind,
  type AlibabaTokenPlanWindow,
  isAlibabaTokenPlanSupportedPlatform,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { REQUEST_TIMEOUT_MS } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const GROUP = "Alibaba Personal Token Plan";
const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "local_cli",
  ownership: "maintained",
  authority: "provider_reported",
} as const satisfies QuotaToastEntry["accounting"];

function windowEntry(
  window: AlibabaTokenPlanWindow,
  suffix: string,
  label: string,
): QuotaToastEntry {
  return {
    accounting: { ...ACCOUNTING },
    name: `${GROUP} ${suffix}`,
    group: GROUP,
    label,
    percentRemaining: window.percentRemaining,
    ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
  };
}

function statusDetailsFromResult(
  result: AlibabaTokenPlanClosedResult,
  platform: NodeJS.Platform,
): ReturnType<typeof statusDetailsFromRecord> {
  if (result.ok) {
    const windows = [
      result.fiveHour ? "5h" : undefined,
      result.weekly ? "weekly" : undefined,
    ].filter((value): value is string => value !== undefined);
    return statusDetailsFromRecord({
      cli_available: "true",
      platform,
      windows: windows.join(",") || "(none)",
    });
  }
  return statusDetailsFromRecord({
    cli_available: result.error.kind === "executable_not_found" ? "false" : "true",
    platform,
    failure_kind: result.error.kind,
  });
}

function alibabaFailureCategory(
  kind: AlibabaTokenPlanErrorKind,
): ProviderFailureCategory | undefined {
  switch (kind) {
    case "executable_not_found":
    case "shell_launcher_rejected":
    case "workspace_path_rejected":
    case "spawn_failed":
      return "local";
    case "not_authenticated":
      return "credentials";
    default:
      // Timeout, malformed output, nonzero exit, and unavailable data can come
      // from either the CLI process or the remote console. Absence fails closed.
      return undefined;
  }
}

function mapClosedResult(result: AlibabaTokenPlanClosedResult): QuotaProviderResult {
  if (result.ok) {
    const entries: QuotaToastEntry[] = [];
    if (result.fiveHour) entries.push(windowEntry(result.fiveHour, "5h", "5h:"));
    if (result.weekly) entries.push(windowEntry(result.weekly, "Weekly", "Weekly:"));
    return attemptedResult(entries);
  }
  if (result.error.kind === "unsupported_platform") {
    return notAttemptedResult();
  }
  const failureCategory = alibabaFailureCategory(result.error.kind);
  return attemptedErrorResult(GROUP, result.error.message, {
    retryable: result.error.retryable === true,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
  });
}

export const alibabaTokenPlanProvider: QuotaProvider = {
  id: "alibaba-token-plan",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (!isAlibabaTokenPlanSupportedPlatform()) return false;

    const selected = await isCanonicalProviderAvailable({
      ctx,
      providerId: "alibaba-token-plan",
      fallbackOnError: false,
    });
    if (selected) return true;
    if (ctx.config.currentProviderID === "alibaba-token-plan") return true;
    const currentModel = ctx.config.currentModel;
    return typeof currentModel === "string" && currentModel.length > 0
      ? modelProviderMatchesRuntimeId(currentModel, "alibaba-token-plan")
      : false;
  },

  matchesCurrentModel(model: string, context): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID === "alibaba-token-plan";
    }
    return modelProviderMatchesRuntimeId(model, "alibaba-token-plan");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryAlibabaTokenPlanQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      runtime: { cwd: ctx.workspaceRoot },
    });
    return withStatusDetails(
      mapClosedResult(result),
      statusDetailsFromResult(result, process.platform),
    );
  },
};
