import { isAlibabaModelId } from "../lib/alibaba-auth.js";
import {
  type AlibabaCodingPlanQuotaResult,
  type AlibabaCodingPlanUsageWindow,
  queryAlibabaCodingPlanQuota,
} from "../lib/alibaba-coding-plan-cli.js";
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext, QuotaToastEntry } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  attemptedErrorResult,
  attemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const CLI_LABEL = "Bailian CLI";

const QUOTA_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "local_cli",
  ownership: "maintained",
  authority: "provider_reported",
} as const satisfies QuotaToastEntry["accounting"];

const STATUS_ACCOUNTING = {
  ...QUOTA_ACCOUNTING,
  resultType: "status",
} as const satisfies QuotaToastEntry["accounting"];

function windowEntry(
  window: AlibabaCodingPlanUsageWindow | undefined,
  params: { group: string; suffix: string; label: string },
): QuotaToastEntry | undefined {
  if (!window) return undefined;

  const name = `${params.group} ${params.suffix}`;
  const resetTime = window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {};
  if (window.percentage !== undefined) {
    const hasCounts = window.used !== undefined && window.total !== undefined && window.total > 0;
    return {
      accounting: { ...QUOTA_ACCOUNTING },
      name,
      group: params.group,
      label: params.label,
      ...(hasCounts ? { right: `${window.used}/${window.total}` } : {}),
      percentRemaining: Math.max(0, Math.min(100, (1 - window.percentage) * 100)),
      ...resetTime,
    };
  }

  if (window.resetTimeIso) {
    return {
      kind: "value",
      accounting: { ...STATUS_ACCOUNTING },
      name,
      group: params.group,
      label: params.label,
      value: "Quota details unavailable",
      ...resetTime,
    };
  }

  return undefined;
}

function entriesFromUsage(
  result: Extract<AlibabaCodingPlanQuotaResult, { state: "success" }>,
): QuotaToastEntry[] {
  const instanceType = result.usage.instanceType
    ? sanitizeSingleLineDisplayText(result.usage.instanceType).trim().slice(0, 40)
    : "";
  const group = `Alibaba Coding Plan${instanceType ? ` (${instanceType})` : ""} (CLI)`;
  return [
    windowEntry(result.usage.fiveHour, { group, suffix: "5h", label: "5h:" }),
    windowEntry(result.usage.weekly, { group, suffix: "Weekly", label: "Weekly:" }),
    windowEntry(result.usage.monthly, { group, suffix: "Monthly", label: "Monthly:" }),
  ].filter((entry): entry is QuotaToastEntry => entry !== undefined);
}

function failureCategoryFor(kind: string): "credentials" | "local" | "provider_api" {
  if (kind === "not_authenticated") return "credentials";
  if (
    kind === "invalid_json" ||
    kind === "invalid_schema" ||
    kind === "nonzero_exit" ||
    kind === "output_truncated" ||
    kind === "no_quota_data"
  ) {
    return "provider_api";
  }
  return "local";
}

function resultWithCliStatus(
  result: ReturnType<typeof attemptedResult>,
  statusDetails: ReturnType<typeof statusDetailsFromRecord>,
  status: string,
) {
  return withStatusDetails(result, [
    ...statusDetails,
    ...statusDetailsFromRecord({ alibaba_coding_plan_cli_status: status }),
  ]);
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const selected = await isCanonicalProviderAvailable({
      ctx,
      providerId: "alibaba-coding-plan",
      fallbackOnError: false,
    });
    if (selected) return true;
    if (
      ctx.config.currentProviderID === "alibaba-coding-plan" ||
      ctx.config.currentProviderID === "alibaba"
    ) {
      return true;
    }
    const currentModel = ctx.config.currentModel;
    return typeof currentModel === "string" && currentModel.length > 0
      ? isAlibabaModelId(currentModel)
      : false;
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "alibaba-coding-plan" ||
          context.currentProviderID === "alibaba"
      : isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext) {
    const result = await queryAlibabaCodingPlanQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
      runtime: { cwd: ctx.workspaceRoot },
    });
    const statusDetails = statusDetailsFromRecord({
      alibaba_coding_plan_source: "bl usage coding-plan --output json",
    });
    if (result.state === "error") {
      return resultWithCliStatus(
        attemptedErrorResult(`${CLI_LABEL} Coding Plan usage`, result.error.message, {
          retryable: result.error.retryable,
          failureCategory: failureCategoryFor(result.error.kind),
        }),
        statusDetails,
        result.error.kind,
      );
    }
    if (result.state === "no-subscription") {
      return resultWithCliStatus(attemptedResult([]), statusDetails, "no-subscription");
    }

    const entries = entriesFromUsage(result);
    if (entries.length === 0) {
      return resultWithCliStatus(
        attemptedErrorResult(
          `${CLI_LABEL} Coding Plan usage`,
          "Bailian CLI returned no usable Coding Plan quota data.",
          {
            failureCategory: "provider_api",
          },
        ),
        statusDetails,
        "no-quota-data",
      );
    }
    return resultWithCliStatus(attemptedResult(entries), statusDetails, "success");
  },
};
