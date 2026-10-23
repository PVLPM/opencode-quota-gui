/**
 * On OpenCode 2, quota slash commands post their report into the chat as a user message
 * that never starts a model turn. These helpers mark such messages so the server plugin
 * can keep them out of every model request, and the TUI can show them in its dialog.
 */
import type { QuotaDialogCommandId } from "./quota-dialog-command-specs.js";
import { isReportDocument, type ReportDocument } from "./report-document.js";

/** Metadata key on every quota report message. OpenCode stores message metadata with the message. */
export const QUOTA_REPORT_METADATA_KEY = "opencodeQuotaGui";

export type QuotaReportMetadata = {
  command: QuotaDialogCommandId;
  title: string;
  at: number;
  /** The report, structured, so the TUI can show it in its dialog. */
  document: ReportDocument;
};

/**
 * First and last line of every quota report message; Web and Desktop show them too.
 * When OpenCode compacts a session, it copies recent message text into the checkpoint
 * before plugin hooks run, so the metadata is lost there. These lines let the plugin cut
 * the report back out of that text.
 */
const QUOTA_REPORT_START = "[OpenCode Quota GUI report]";
const QUOTA_REPORT_END = "[End of OpenCode Quota GUI report]";
const QUOTA_REPORT_BLOCKS =
  /\[OpenCode Quota GUI report\][\s\S]*?\[End of OpenCode Quota GUI report\]/g;

export function formatQuotaReportMessage(report: string): string {
  return `${QUOTA_REPORT_START}\n${report}\n${QUOTA_REPORT_END}`;
}

export function containsQuotaReport(text: string): boolean {
  return text.includes(QUOTA_REPORT_START);
}

/** Cuts every complete quota report, first to last line, out of the text. */
export function removeQuotaReports(text: string): string {
  return text.replace(QUOTA_REPORT_BLOCKS, "");
}

export function readQuotaReportMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): QuotaReportMetadata | undefined {
  const value = metadata?.[QUOTA_REPORT_METADATA_KEY];
  if (!value || typeof value !== "object") return undefined;
  const { command, title, at, document } = value as Record<string, unknown>;
  if (
    typeof command !== "string" ||
    typeof title !== "string" ||
    typeof at !== "number" ||
    !isReportDocument(document)
  ) {
    return undefined;
  }
  return { command: command as QuotaDialogCommandId, title, at, document };
}
