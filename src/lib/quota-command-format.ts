/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */

import {
  type AccountingRowInterpretation,
  formatAccountingWindowLabel,
  interpretAccountingRow,
} from "./accounting-format.js";
import type {
  AccountingWindow,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./entries.js";
import { isPercentEntry, isValueEntry } from "./entries.js";
import {
  bar,
  formatDisplayedPercentLabel,
  formatLocalCallTimestamp,
  formatQuotaModeHeading,
  formatResetCountdown,
  formatTokenCount,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import { formatQuotaRunway } from "./quota-exhaustion-projection.js";
import {
  type ReportDocument,
  type ReportQuotaRow,
  type ReportSection,
  renderPlainTextReport,
} from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";
import type { QuotaToastConfig } from "./types.js";

/** The time until the reset, or "reset" when it is due; "" without a valid reset time. */
function formatCommandCountdown(iso?: string, spaced?: boolean): string {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return "";
  return formatResetCountdown(iso, { spaced });
}

function formatCommandReset(iso?: string, spaced?: boolean): string {
  const countdown = formatCommandCountdown(iso, spaced);
  return countdown === "reset" || !countdown ? countdown : `reset ${countdown}`;
}

export const QUOTA_COMMAND_BAR_WIDTH = 10;
export const QUOTA_COMMAND_LABEL_WIDTH = 12;

function normalizeMetricText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

const COMMAND_WINDOW_LABELS: Readonly<Partial<Record<QuotaWindowKind, string>>> = {
  rpm: "RPM",
  five_hour: "5h",
  hour: "Hour",
  week: "Week",
  day: "Day",
  month: "Month",
  year: "Year",
};

function getCommandWindowLabel(entry: QuotaToastEntry): string | null {
  const kind = classifyQuotaWindowText(normalizeMetricText(entry.label || entry.name));
  return kind ? (COMMAND_WINDOW_LABELS[kind] ?? null) : null;
}

/** The time windows, which name a quota alone in the TUI dialog. */
const DIALOG_TIME_WINDOWS: ReadonlySet<AccountingWindow> = new Set([
  "rpm",
  "hour",
  "five_hour",
  "day",
  "week",
  "month",
  "year",
]);

/**
 * The TUI dialog's label for a row: a time window's quota drops "quota" ("5h quota" is
 * "5h", "Weekly quota" is "Weekly"), since the dialog's table heads that column "window".
 * Other labels, such as "Month spend" or "Fable", stay whole.
 */
function getDialogMetricLabel(entry: QuotaToastEntry, metricLabel: string): string {
  const metric = entry.semantic?.metric;
  const window = !metric
    ? getCommandWindowLabel(entry)
    : metric.kind === "window" && DIALOG_TIME_WINDOWS.has(metric.window)
      ? formatAccountingWindowLabel(metric.window)
      : null;
  return window && metricLabel === `${window} quota` ? window : metricLabel;
}

function getCommandMetricLabel(entry: QuotaToastEntry, semanticLabel: string): string {
  if (entry.semantic) return semanticLabel;

  const window = getCommandWindowLabel(entry);
  const resultType = entry.accounting?.resultType;

  if (resultType === "balance") return "Balance";
  if (resultType === "status") return "Status";

  const explicit = normalizeMetricText(entry.label);
  const metricLabel = normalizeMetricText(entry.metricLabel);
  const noun =
    resultType === "budget"
      ? "budget"
      : resultType === "usage"
        ? "usage"
        : resultType === "spend"
          ? "spend"
          : resultType === "quota" || resultType === "rate_limit"
            ? "quota"
            : "";

  if (noun) {
    return window ? `${window} ${noun}` : metricLabel || noun[0]!.toUpperCase() + noun.slice(1);
  }
  if (window) return `${window} quota`;

  return explicit || (isValueEntry(entry) ? "Value" : "Quota");
}

function formatCommandDetails(
  entry: QuotaToastEntry,
  rightWidth: number,
  resetTimeSpaced?: boolean,
): string {
  const right = entry.right?.trim();
  const reset = formatCommandReset(entry.resetTimeIso, resetTimeSpaced);
  const runway = isPercentEntry(entry) ? formatQuotaRunway(entry.runway) : "";
  if (!runway) {
    if (right && reset) return ` | ${padRight(right, rightWidth)} | ${reset}`;
    if (right) return ` | ${right}`;
    if (reset) return ` | ${reset}`;
    return "";
  }

  const details = [
    ...(right ? [padRight(right, rightWidth)] : []),
    ...(reset ? [reset] : []),
    `Runs out ${runway}`,
  ];
  return ` | ${details.join(" | ")}`;
}

function getCommandBasisDetails(basis: AccountingRowInterpretation["basis"]): string[] {
  if (!basis) return [];
  return basis.kind === "detailed"
    ? basis.facts.map((fact) => fact.text)
    : basis.text
      ? [basis.text]
      : [];
}

export function buildQuotaCommandDocument(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  percentLabelStyle?: QuotaToastConfig["percentLabelStyle"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
  resetTimeSpaced?: boolean;
}): ReportDocument {
  const groups = groupQuotaEntries(params.entries, "quota");

  const sections: ReportSection[] = groups.map((group, index) => {
    const lines: string[] = [];
    const rows: ReportQuotaRow[] = [];
    const interpretedRows = group.entries.map((entry) => ({
      entry,
      interpretation: interpretAccountingRow(entry, {
        booleanWording: "semantic",
        basis:
          (params.accountingDetail ?? "summary") === "detailed"
            ? { kind: "detailed" }
            : { kind: "summary", mode: params.percentDisplayMode ?? "remaining" },
      }),
    }));
    const rightWidth = Math.max(
      0,
      ...interpretedRows.map(({ entry }) => entry.right?.trim().length ?? 0),
    );
    const labelWidth = Math.max(
      QUOTA_COMMAND_LABEL_WIDTH,
      ...interpretedRows
        .filter(({ entry }) => Boolean(entry.semantic))
        .map(
          ({ entry, interpretation }) => getCommandMetricLabel(entry, interpretation.label).length,
        ),
    );
    for (const { entry: row, interpretation } of interpretedRows) {
      const metricLabel = getCommandMetricLabel(row, interpretation.label);
      const label = padRight(metricLabel, labelWidth);
      const details = formatCommandDetails(row, rightWidth, params.resetTimeSpaced);
      const dialogLabel = getDialogMetricLabel(row, metricLabel);
      // The RPC output must be plain JSON, so absent parts are left out, never undefined.
      const usage = row.right?.trim();
      const countdown = formatCommandCountdown(row.resetTimeIso, params.resetTimeSpaced);
      const reset = countdown === "reset" ? "now" : countdown;
      const usageAndReset = { ...(usage ? { usage } : {}), ...(reset ? { reset } : {}) };

      if (interpretation.display.kind === "value") {
        lines.push(`  ${label}  ${interpretation.display.text}${details}`);
        rows.push({
          label: dialogLabel,
          value: interpretation.display.text,
          ...usageAndReset,
          notes: [],
        });
        continue;
      }

      const pctLabel = formatDisplayedPercentLabel(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
        params.percentLabelStyle,
      );
      const displayedPercent = resolveDisplayedPercent(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
      );
      lines.push(
        `  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, Math.max(9, pctLabel.length))}${details}`,
      );
      const basisDetails = getCommandBasisDetails(interpretation.basis);
      lines.push(...basisDetails.map((detail) => `    ${detail}`));
      const runway = isPercentEntry(row) ? formatQuotaRunway(row.runway) : "";
      rows.push({
        label: dialogLabel,
        barPercent: displayedPercent,
        value: `${displayedPercent}%`,
        ...usageAndReset,
        notes: [...(runway ? [`Runs out ${runway}`] : []), ...basisDetails],
      });
    }
    return {
      id: `group-${index}`,
      title: `→ ${formatGroupedHeader(group.group)}`,
      blocks: [
        {
          kind: "quota",
          // The dialog's provider rows drop the brackets, as the compact line does.
          provider: formatGroupedHeader(group.group).replace(/^\[([^\]]+)\]/u, "$1"),
          percentMode: params.percentDisplayMode ?? "remaining",
          lines,
          rows,
        },
      ],
    };
  });

  if (params.sessionTokens && params.sessionTokens.models.length > 0) {
    sections.push({
      id: "session-tokens",
      title: SESSION_TOKEN_SECTION_HEADING,
      blocks: [
        {
          kind: "lines",
          lines: params.sessionTokens.models.map((model) => {
            const metrics = [`${formatTokenCount(model.input)} in`];
            if ((model.cachedInput ?? 0) > 0) {
              metrics.push(`${formatTokenCount(model.cachedInput ?? 0)} cached`);
            }
            metrics.push(`${formatTokenCount(model.output)} out`);
            return `  ${model.modelID}: ${metrics.join(" | ")}`;
          }),
        },
      ],
    });
  }

  if (params.errors.length > 0) {
    sections.push({
      id: "errors",
      title: "Partial failures",
      blocks: [
        {
          kind: "lines",
          lines: params.errors.map((err) => `  ${err.label}: ${err.message}`),
        },
      ],
    });
  }

  // With bare percent labels, only the heading tells whether the percentages are used or left.
  const bare = params.percentLabelStyle === "bare";
  const time = formatLocalCallTimestamp(params.generatedAtMs);
  return {
    heading: {
      line: `${bare ? formatQuotaModeHeading(params.percentDisplayMode) : "Quota"} (/quota) ${time}`,
      subtitle: bare
        ? `${params.percentDisplayMode === "used" ? "Percent used" : "Percent remaining"} · ${time}`
        : time,
    },
    sections,
  };
}

export function formatQuotaCommand(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  percentLabelStyle?: QuotaToastConfig["percentLabelStyle"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
  resetTimeSpaced?: boolean;
}): string {
  return renderPlainTextReport(buildQuotaCommandDocument(params));
}
