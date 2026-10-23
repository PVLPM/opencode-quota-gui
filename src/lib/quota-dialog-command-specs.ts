/**
 * Ids, titles and dialog sizes of the quota commands. They live apart from the report
 * builders in quota-dialog-commands.ts so code that only lists or names the commands
 * does not load the quota and token report code.
 */
import { formatYmd, type Ymd } from "./command-parsing.js";
import type { ReportDocument } from "./report-document.js";

export type QuotaDialogCommandId =
  | "quota"
  | "quota_status"
  | "quota_announcements"
  | "pricing_refresh"
  | TokenReportCommandId;

export type QuotaDialogCommandSpec = {
  id: QuotaDialogCommandId;
  slashName: string;
  title: string;
  description: string;
  dialogSize: "medium" | "large" | "xlarge";
  requiresSession?: boolean;
};

export type QuotaDialogCommandOutputResult =
  | {
      state: "output";
      command: QuotaDialogCommandId;
      title: string;
      /** The report as text, for the chat, the quota_status tool, and the CLI. */
      output: string;
      /** The same report, structured; the TUI dialog renders it. */
      document: ReportDocument;
      dialogSize: "medium" | "large" | "xlarge";
    }
  | {
      state: "noop";
      command: QuotaDialogCommandId;
      reason: "disabled";
    };

export type TokenReportCommandId =
  | "tokens_today"
  | "tokens_daily"
  | "tokens_weekly"
  | "tokens_monthly"
  | "tokens_all"
  | "tokens_session"
  | "tokens_session_all"
  | "tokens_between";

export type TokenReportCommandSpec =
  | {
      id: Exclude<TokenReportCommandId, "tokens_between">;
      template: `/${string}`;
      description: string;
      title: string;
      metadataTitle: string;
      kind: "rolling" | "today" | "all" | "session" | "session_tree";
      windowMs?: number;
      topModels?: number;
      topSessions?: number;
    }
  | {
      id: "tokens_between";
      template: "/tokens_between";
      description: string;
      titleForRange: (startYmd: Ymd, endYmd: Ymd) => string;
      metadataTitle: string;
      kind: "between";
    };

export const TOKEN_REPORT_COMMANDS: readonly TokenReportCommandSpec[] = [
  {
    id: "tokens_today",
    template: "/tokens_today",
    description: "Token + deterministic cost summary for today (calendar day, local timezone).",
    title: "Tokens used (Today) (/tokens_today)",
    metadataTitle: "Tokens used (Today)",
    kind: "today",
  },
  {
    id: "tokens_daily",
    template: "/tokens_daily",
    description: "Token + deterministic cost summary for the last 24 hours (rolling).",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    metadataTitle: "Tokens used (Last 24 Hours)",
    kind: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_weekly",
    template: "/tokens_weekly",
    description: "Token + deterministic cost summary for the last 7 days (rolling).",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    metadataTitle: "Tokens used (Last 7 Days)",
    kind: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_monthly",
    template: "/tokens_monthly",
    description: "Token + deterministic cost summary for the last 30 days (rolling).",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    metadataTitle: "Tokens used (Last 30 Days)",
    kind: "rolling",
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_all",
    template: "/tokens_all",
    description: "Token + deterministic cost summary for all locally saved OpenCode history.",
    title: "Tokens used (All Time) (/tokens_all)",
    metadataTitle: "Tokens used (All Time)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  {
    id: "tokens_session",
    template: "/tokens_session",
    description: "Token + deterministic cost summary for current session only.",
    title: "Tokens used (Current Session) (/tokens_session)",
    metadataTitle: "Tokens used (Current Session)",
    kind: "session",
  },
  {
    id: "tokens_session_all",
    template: "/tokens_session_all",
    description:
      "Token + deterministic cost summary for current session and all descendant child/subagent sessions.",
    title: "Tokens used (Current Session Tree) (/tokens_session_all)",
    metadataTitle: "Tokens used (Current Session Tree)",
    kind: "session_tree",
  },
  {
    id: "tokens_between",
    template: "/tokens_between",
    description:
      "Token + deterministic cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
    titleForRange: (startYmd: Ymd, endYmd: Ymd) => {
      return `Tokens used (${formatYmd(startYmd)} .. ${formatYmd(endYmd)}) (/tokens_between)`;
    },
    metadataTitle: "Tokens used (Date Range)",
    kind: "between",
  },
] as const;

export const QUOTA_DIALOG_COMMANDS: readonly QuotaDialogCommandSpec[] = [
  {
    id: "quota",
    slashName: "quota",
    title: "OpenCode Quota GUI",
    description: "Show deterministic quota output.",
    dialogSize: "xlarge",
    requiresSession: true,
  },
  {
    id: "quota_status",
    slashName: "quota_status",
    title: "OpenCode Quota GUI Status",
    description: "Diagnostics for quota, TUI, pricing, and local storage.",
    dialogSize: "xlarge",
    requiresSession: true,
  },
  {
    id: "quota_announcements",
    slashName: "quota_announcements",
    title: "OpenCode Quota GUI Announcements",
    description: "List active bundled maintainer announcements.",
    dialogSize: "xlarge",
  },
  {
    id: "pricing_refresh",
    slashName: "pricing_refresh",
    title: "OpenCode Quota GUI Pricing Refresh",
    description: "Refresh the local runtime pricing snapshot from models.dev.",
    dialogSize: "xlarge",
  },
  ...TOKEN_REPORT_COMMANDS.map(
    (spec): QuotaDialogCommandSpec => ({
      id: spec.id,
      slashName: spec.id,
      title: spec.kind === "between" ? "OpenCode Quota GUI Token Report" : spec.metadataTitle,
      description: spec.description,
      dialogSize: "xlarge",
      requiresSession: spec.kind === "session" || spec.kind === "session_tree",
    }),
  ),
] as const;

export const QUOTA_DIALOG_COMMANDS_BY_ID: ReadonlyMap<
  QuotaDialogCommandId,
  QuotaDialogCommandSpec
> = (() => {
  const map = new Map<QuotaDialogCommandId, QuotaDialogCommandSpec>();
  for (const spec of QUOTA_DIALOG_COMMANDS) {
    map.set(spec.id, spec);
  }
  return map;
})();

export function isQuotaDialogCommand(command: string): command is QuotaDialogCommandId {
  return QUOTA_DIALOG_COMMANDS_BY_ID.has(command as QuotaDialogCommandId);
}

/**
 * Reads prompt text as a typed quota slash command. As in OpenCode, the command name ends
 * at the first whitespace; like the server command, the rest is trimmed into its arguments.
 * Returns undefined when the text is not exactly one of the quota commands.
 */
export function parseQuotaSlashCommand(
  text: string,
): { command: QuotaDialogCommandId; argumentsText: string | undefined } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const name = trimmed.slice(1).split(/\s/, 1)[0];
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.slashName === name);
  if (!spec) return undefined;
  return { command: spec.id, argumentsText: trimmed.slice(1 + name.length).trim() || undefined };
}
