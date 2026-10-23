import { formatLocalCallTimestamp } from "./format-utils.js";
import { renderMarkdownTable, type WidthMode } from "./markdown-table.js";
import type { PercentDisplayMode } from "./types.js";

/**
 * A report's first line. The text shows `line`. The TUI dialog has its own title, so it
 * shows `subtitle` instead: the facts in the line that its title lacks, and the time.
 */
export type ReportHeading = {
  line: string;
  subtitle?: string;
};

export type ReportKvRow = {
  key: string;
  value?: string;
  indent?: 0 | 1;
  trailingColon?: boolean;
};

/**
 * One /quota row, split into the parts the TUI dialog lays out in its tables. A percent row
 * has `barPercent` and its percent as `value`; a value row has only its text as `value`.
 */
export type ReportQuotaRow = {
  /** The dialog's label, e.g. "5h" for the text's "5h quota" (its table says "window"). */
  label: string;
  /** The displayed percent the bar fills, 0-100 (a percent row only). */
  barPercent?: number;
  /** The displayed percent, e.g. "85%", or a value row's text, e.g. "USD 0.00". */
  value: string;
  /** Used over limit, e.g. "30.4/200". */
  usage?: string;
  /** The time until the reset, e.g. "1d 8h 18m" ("now" when it is due). */
  reset?: string;
  /** Lines under the row: the run-out projection and the accounting basis. */
  notes: string[];
};

export type ReportBlock =
  | { kind: "lines"; lines: string[] }
  /**
   * One provider's /quota rows: the text shows `lines`, the TUI dialog lays out `rows` in
   * its tables, under `provider` (e.g. "Copilot (individual)"). `percentMode` tells whether
   * the percents are the part left or the part used.
   */
  | {
      kind: "quota";
      provider: string;
      percentMode: PercentDisplayMode;
      lines: string[];
      rows: ReportQuotaRow[];
    }
  | { kind: "kv"; rows: ReportKvRow[] }
  | {
      kind: "table";
      headers: string[];
      /** Longer labels, one per column, that the TUI dialog shows when the table fits with them. */
      fullHeaders?: string[];
      rows: string[][];
      aligns: Array<"left" | "right">;
      widthMode?: WidthMode;
    };

export type ReportSection = {
  id: string;
  title?: string;
  blocks: ReportBlock[];
};

export type ReportDocument = {
  heading?: ReportHeading;
  sections: ReportSection[];
};

function hasBlockContent(block: ReportBlock): boolean {
  switch (block.kind) {
    case "lines":
    case "quota":
      return block.lines.length > 0;
    case "kv":
      return block.rows.length > 0;
    case "table":
      return block.headers.length > 0 || block.rows.length > 0;
  }
}

/** The sections every renderer shows: empty blocks dropped, then sections left with nothing. */
export function renderableSections(document: ReportDocument): ReportSection[] {
  return document.sections
    .map((section) => ({ ...section, blocks: section.blocks.filter(hasBlockContent) }))
    .filter((section) => section.title || section.blocks.length > 0);
}

/**
 * A command report's heading: "# <title> <time>" in text, "<detail> · <time>" in the dialog.
 * The title echoes the command, e.g. "Quota Status (opencode-quota-gui v5.0.0) (/quota_status)";
 * the detail repeats the facts in it that the dialog title lacks, e.g. "opencode-quota-gui v5.0.0".
 */
export function commandHeading(params: {
  title: string;
  detail?: string;
  generatedAtMs?: number;
}): ReportHeading {
  const time = formatLocalCallTimestamp(params.generatedAtMs);
  return {
    line: `# ${params.title} ${time}`,
    subtitle: params.detail ? `${params.detail} · ${time}` : time,
  };
}

/** A document of one plain message; it renders back to the same text. */
export function messageDocument(text: string): ReportDocument {
  return { sections: [{ id: "message", blocks: [{ kind: "lines", lines: text.split("\n") }] }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptional(value: unknown, type: "string" | "number" | "boolean"): boolean {
  return value === undefined || typeof value === type;
}

function isReportKvRow(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.key === "string" &&
    isOptional(value.value, "string") &&
    (value.indent === undefined || value.indent === 0 || value.indent === 1) &&
    isOptional(value.trailingColon, "boolean")
  );
}

function isReportQuotaRow(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.label === "string" &&
    isOptional(value.barPercent, "number") &&
    typeof value.value === "string" &&
    isOptional(value.usage, "string") &&
    isOptional(value.reset, "string") &&
    isStringArray(value.notes)
  );
}

function isReportBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "lines":
      return isStringArray(value.lines);
    case "quota":
      return (
        typeof value.provider === "string" &&
        (value.percentMode === "remaining" || value.percentMode === "used") &&
        isStringArray(value.lines) &&
        Array.isArray(value.rows) &&
        value.rows.every(isReportQuotaRow)
      );
    case "kv":
      return Array.isArray(value.rows) && value.rows.every(isReportKvRow);
    case "table":
      return (
        isStringArray(value.headers) &&
        (value.fullHeaders === undefined ||
          (isStringArray(value.fullHeaders) &&
            value.fullHeaders.length === value.headers.length)) &&
        Array.isArray(value.rows) &&
        value.rows.every(isStringArray) &&
        Array.isArray(value.aligns) &&
        value.aligns.every((align) => align === "left" || align === "right") &&
        (value.widthMode === undefined ||
          value.widthMode === "raw" ||
          value.widthMode === "markdown-conceal")
      );
    default:
      return false;
  }
}

/** Checks the shape of a document read back from stored message metadata. */
export function isReportDocument(value: unknown): value is ReportDocument {
  if (!isObject(value)) return false;
  const heading = value.heading;
  if (
    heading !== undefined &&
    !(
      isObject(heading) &&
      typeof heading.line === "string" &&
      isOptional(heading.subtitle, "string")
    )
  ) {
    return false;
  }
  return (
    Array.isArray(value.sections) &&
    value.sections.every(
      (section) =>
        isObject(section) &&
        typeof section.id === "string" &&
        isOptional(section.title, "string") &&
        Array.isArray(section.blocks) &&
        section.blocks.every(isReportBlock),
    )
  );
}

export function renderKvRow(row: ReportKvRow): string {
  const indent = row.indent === 1 ? "  " : "";
  if (row.value !== undefined) {
    return `${indent}- ${row.key}: ${row.value}`;
  }
  return `${indent}- ${row.key}${row.trailingColon ? ":" : ""}`;
}

function renderPlainTextBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
    case "quota":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

function renderMarkdownBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
    case "quota":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

export function renderPlainTextReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) lines.push(document.heading.line);

  for (const section of renderableSections(document)) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(section.title);
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderPlainTextBlock(block));
    }
  }

  return lines.join("\n");
}

export function renderMarkdownReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) lines.push(document.heading.line);

  for (const section of renderableSections(document)) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(`## ${section.title}`);
      if (section.blocks.length > 0) lines.push("");
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderMarkdownBlock(block));
    }
  }

  return lines.join("\n");
}
