import { abbreviateDisplayedModelName } from "./format-utils.js";
import type { WidthMode } from "./markdown-table.js";
import type { AggregateResult, SessionTreeNode, TokenBuckets } from "./quota-stats.js";
import {
  commandHeading,
  type ReportBlock,
  type ReportDocument,
  type ReportSection,
  renderMarkdownReport,
} from "./report-document.js";
import { emptyTokenBuckets, totalTokenBuckets } from "./token-buckets.js";

/** Use markdown-conceal for proper TUI alignment (strips markdown syntax for width calc) */
const TABLE_WIDTH_MODE: WidthMode = "markdown-conceal";

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/**
 * A cost that only covers priced tokens is a known subtotal, not complete
 * spend. Mark it so the report never presents a partial number as final.
 */
type CostBearingRow = {
  partialMessageCount?: number;
  pricedMessageCount?: number;
  unpricedMessageCount?: number;
};

function rowCostIsPartial(row: CostBearingRow | undefined): boolean {
  if (!row) return false;
  return (
    (row.partialMessageCount ?? 0) > 0 ||
    ((row.pricedMessageCount ?? 0) > 0 && (row.unpricedMessageCount ?? 0) > 0)
  );
}

function fmtCostCell(costUsd: number, partial: boolean): string {
  const formatted = fmtUsd(costUsd);
  return partial ? `${formatted} (partial)` : formatted;
}

function partialCostNote(totals: AggregateResult["totals"]): string {
  return `Cost is partial: ${fmtUsd(totals.costUsd)} is the known subtotal; tokens without published rates are unpriced.`;
}

type SessionReportRow = AggregateResult["bySession"][number];
type QuotaStatsReportKind = "standard" | "session" | "session_tree";

type QuotaStatsReportTableOptions = {
  compactHeaders?: boolean;
  modelNameMaxWidth?: number;
};

/**
 * A table's header labels: the compact ones when asked for, else the full ones. The full
 * labels also ride along, so the TUI dialog can show them when the table fits with them.
 */
function tableHeaders(
  options: QuotaStatsReportTableOptions,
  compact: string[],
  full: string[],
): { headers: string[]; fullHeaders: string[] } {
  return { headers: options.compactHeaders ? compact : full, fullHeaders: full };
}

function hasRenderableSessionUsage(row: SessionReportRow): boolean {
  return totalTokenBuckets(row.tokens) > 0 || row.costUsd > 0;
}

function appendSessionRow(sessionRows: string[][], row: SessionReportRow, current = ""): void {
  sessionRows.push([
    current,
    row.sessionID,
    fmtCostCell(row.costUsd, rowCostIsPartial(row)),
    fmtCompact(totalTokenBuckets(row.tokens)),
    fmtCompact(row.messageCount),
    truncateTitle(row.title),
  ]);
}

function treeRelationLabel(depth: number): string {
  if (depth <= 0) return "current";
  if (depth === 1) return "child";
  if (depth === 2) return "grandchild";
  return `descendant(${depth})`;
}

function missingFocusSessionLabel(hasRawFocus: boolean): string {
  return hasRawFocus
    ? "(current session has no token usage in selected window)"
    : "(current session not in selected window)";
}

/**
 * Format a timestamp as human-readable local time: "HH:MM YYYY-MM-DD"
 */
function fmtLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} ${year}-${month}-${day}`;
}

function fmtWindow(params: { sinceMs?: number; untilMs?: number }): string {
  if (!params.sinceMs && !params.untilMs) return "all time";
  const since = typeof params.sinceMs === "number" ? fmtLocalDateTime(params.sinceMs) : "-";
  const until = typeof params.untilMs === "number" ? fmtLocalDateTime(params.untilMs) : "now";
  return `${since} .. ${until}`;
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const units: Array<{ v: number; s: string }> = [
    { v: 1_000_000_000, s: "B" },
    { v: 1_000_000, s: "M" },
    { v: 1_000, s: "K" },
  ];
  for (const u of units) {
    if (abs >= u.v) {
      const x = abs / u.v;
      // Keep output stable and compact: 1 decimal unless very large.
      const digits = x >= 100 ? 0 : 1;
      return `${sign}${x.toFixed(digits)}${u.s}`;
    }
  }
  return `${Math.trunc(n)}`;
}

function normalizeSourceName(providerID: string): string {
  const p = (providerID ?? "unknown").toLowerCase();
  if (p === "opencode" || p.includes("opencode")) return "OpenCode";
  if (p.includes("cursor")) return "Cursor";
  if (p.includes("claude") || p.includes("anthropic")) return "Claude";
  if (p.includes("github") || p.includes("copilot")) return "Copilot";
  if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return "OpenAI";
  if (p.includes("google") || p.includes("antigravity") || p.includes("gemini")) return "Google";
  // Common OpenCode provider ids people use
  if (p.includes("azure")) return "Azure";
  return providerID || "Unknown";
}

function normalizeSourceModelId(modelID: string): string {
  return (modelID ?? "unknown").trim();
}

function middleEllipsize(text: string, maxWidth: number): string {
  const safeWidth = Math.trunc(maxWidth);
  if (!Number.isFinite(safeWidth) || safeWidth <= 0) return "";
  if (text.length <= safeWidth) return text;
  if (safeWidth === 1) return "…";

  const keep = safeWidth - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}

function formatSourceModelId(modelID: string, maxWidth?: number): string {
  const displayed = abbreviateDisplayedModelName(normalizeSourceModelId(modelID));
  return maxWidth ? middleEllipsize(displayed, maxWidth) : displayed;
}

function formatDiagnosticSourceModelId(modelID: string, maxWidth?: number): string {
  if (!maxWidth) return abbreviateDisplayedModelName(modelID);
  return middleEllipsize(abbreviateDisplayedModelName(normalizeSourceModelId(modelID)), maxWidth);
}

function sourceSortKey(source: string): number {
  const s = source.toLowerCase();
  if (s === "opencode") return 1;
  if (s === "claude") return 2;
  if (s === "cursor") return 3;
  if (s === "copilot") return 4;
  if (s === "openai") return 5;
  if (s === "google") return 6;
  if (s === "azure") return 7;
  return 99;
}

/**
 * Truncate a title to first 10 + last 10 chars with ellipsis in the middle.
 */
function truncateTitle(title: string | undefined): string {
  if (!title) return "(untitled)";
  const trimmed = title.trim();
  if (trimmed.length <= 23) return trimmed;
  // first 10 + ellipsis + last 10
  return trimmed.slice(0, 10) + "…" + trimmed.slice(-10);
}

type QuotaStatsReportParams = {
  title: string;
  /** Facts in the title that the TUI dialog title lacks, like the date range; see commandHeading. */
  titleDetail?: string;
  result: AggregateResult;
  topModels?: number;
  topSessions?: number;
  focusSessionID?: string;
  /** When true, hides Window/Sessions columns and the Top sessions section (for session-only reports) */
  sessionOnly?: boolean;
  reportKind?: QuotaStatsReportKind;
  sessionTree?: {
    rootSessionID: string;
    nodes: SessionTreeNode[];
  };
  generatedAtMs?: number;
  tableOptions?: QuotaStatsReportTableOptions;
};

export function formatQuotaStatsReport(params: QuotaStatsReportParams): string {
  return renderMarkdownReport(buildQuotaStatsReportDocument(params));
}

export function buildQuotaStatsReportDocument(params: QuotaStatsReportParams): ReportDocument {
  const topModels = params.topModels ?? 12;
  const topSessions = params.topSessions ?? 8;
  const r = params.result;
  const tableOptions = params.tableOptions ?? {};
  const reportKind = params.reportKind ?? (params.sessionOnly ? "session" : "standard");
  const sessionOnly = reportKind === "session";
  const sessionTreeMode = reportKind === "session_tree";
  const sessionTree = params.sessionTree;
  if (sessionTreeMode && !sessionTree) {
    throw new Error("formatQuotaStatsReport requires sessionTree for session_tree reports");
  }
  const combinedTokens =
    totalTokenBuckets(r.totals.priced) +
    totalTokenBuckets(r.totals.unknown) +
    totalTokenBuckets(r.totals.unpriced);
  const totalsArePartial =
    (r.totals.partialMessageCount ?? 0) > 0 ||
    (totalTokenBuckets(r.totals.priced) > 0 &&
      totalTokenBuckets(r.totals.unpriced) + totalTokenBuckets(r.totals.unknown) > 0);

  const sections: ReportSection[] = [];
  const partialNotes: ReportBlock[] = totalsArePartial
    ? [{ kind: "lines", lines: [partialCostNote(r.totals)] }]
    : [];

  // Session-scoped reports use a compact summary without the time window column.
  if (sessionOnly) {
    sections.push({
      id: "summary",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(tableOptions, ["Msgs", "Tok", "Cost"], ["Messages", "Tokens", "Cost"]),
          aligns: ["right", "right", "right"],
          widthMode: TABLE_WIDTH_MODE,
          rows: [
            [
              fmtCompact(r.totals.messageCount),
              fmtCompact(combinedTokens),
              fmtCostCell(r.totals.costUsd, totalsArePartial),
            ],
          ],
        },
        ...partialNotes,
      ],
    });
  } else if (sessionTreeMode) {
    sections.push({
      id: "summary",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(
            tableOptions,
            ["Msgs", "Sess", "Tok", "Cost"],
            ["Messages", "Sessions", "Tokens", "Cost"],
          ),
          aligns: ["right", "right", "right", "right"],
          widthMode: TABLE_WIDTH_MODE,
          rows: [
            [
              fmtCompact(r.totals.messageCount),
              fmtCompact(sessionTree!.nodes.length),
              fmtCompact(combinedTokens),
              fmtCostCell(r.totals.costUsd, totalsArePartial),
            ],
          ],
        },
        ...partialNotes,
      ],
    });
  } else {
    sections.push({
      id: "summary",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(
            tableOptions,
            ["Window", "Msgs", "Sess", "Tok", "Cost"],
            ["Window", "Messages", "Sessions", "Tokens", "Cost"],
          ),
          aligns: ["left", "right", "right", "right", "right"],
          widthMode: TABLE_WIDTH_MODE,
          rows: [
            [
              fmtWindow(r.window),
              fmtCompact(r.totals.messageCount),
              fmtCompact(r.totals.sessionCount),
              fmtCompact(combinedTokens),
              fmtCostCell(r.totals.costUsd, totalsArePartial),
            ],
          ],
        },
        ...partialNotes,
      ],
    });
  }

  const hasAnyReasoning =
    r.totals.priced.reasoning > 0 ||
    r.totals.unknown.reasoning > 0 ||
    r.totals.unpriced.reasoning > 0;

  const compactLabels = ["Source", "Model", "In", "Out", "C.Rd", "C.Wr"];
  const fullLabels = ["Source", "Model", "Input", "Output", "Cache read", "Cache write"];
  const aligns: Array<"left" | "right"> = ["left", "left", "right", "right", "right", "right"];
  if (hasAnyReasoning) {
    compactLabels.push("Rsn");
    fullLabels.push("Reasoning");
    aligns.push("right");
  }
  compactLabels.push("Tok", "Cost");
  fullLabels.push("Tokens", "Cost");
  aligns.push("right", "right");
  const { headers, fullHeaders } = tableHeaders(tableOptions, compactLabels, fullLabels);

  const rows: string[][] = [];
  const grouped = new Map<string, AggregateResult["bySourceModel"]>();
  for (const row of r.bySourceModel) {
    const src = normalizeSourceName(row.sourceProviderID);
    const list = grouped.get(src);
    if (list) list.push(row);
    else grouped.set(src, [row]);
  }

  const sources = Array.from(grouped.keys()).sort((a, b) => {
    const ka = sourceSortKey(a);
    const kb = sourceSortKey(b);
    if (ka !== kb) return ka - kb;
    return a.localeCompare(b);
  });

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const list = grouped.get(src)!;
    list.sort((a, b) => b.costUsd - a.costUsd);

    for (const row of list.slice(0, topModels)) {
      const t = row.tokens;
      const out: string[] = [
        src,
        formatSourceModelId(row.sourceModelID, tableOptions.modelNameMaxWidth),
        fmtCompact(t.input),
        fmtCompact(t.output),
        fmtCompact(t.cache_read),
        fmtCompact(t.cache_write),
      ];
      if (hasAnyReasoning) out.push(fmtCompact(t.reasoning));
      out.push(fmtCompact(totalTokenBuckets(t)), fmtCostCell(row.costUsd, rowCostIsPartial(row)));
      rows.push(out);
    }

    // blank separator row between source groups
    if (i !== sources.length - 1) {
      rows.push(new Array(headers.length).fill(""));
    }
  }

  if (rows.length > 0) {
    sections.push({
      id: "models",
      title: "Model breakdown",
      blocks: [
        {
          kind: "table",
          headers,
          fullHeaders,
          rows,
          aligns,
          widthMode: TABLE_WIDTH_MODE,
        },
      ],
    });
  }

  if (sessionTreeMode) {
    const sessionUsageByID = new Map(r.bySession.map((row) => [row.sessionID, row]));
    const sessionTreeRows = sessionTree!.nodes.map((node) => {
      const usage = sessionUsageByID.get(node.sessionID);
      return [
        treeRelationLabel(node.depth),
        node.parentID ?? "-",
        node.sessionID,
        fmtCostCell(usage?.costUsd ?? 0, rowCostIsPartial(usage)),
        fmtCompact(totalTokenBuckets(usage?.tokens ?? emptyTokenBuckets())),
        fmtCompact(usage?.messageCount ?? 0),
        truncateTitle(node.title ?? usage?.title),
      ];
    });

    sections.push({
      id: "session-tree",
      title: "Session tree",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(
            tableOptions,
            ["Rel", "Parent", "Session", "Cost", "Tok", "Msgs", "Title"],
            ["Relation", "Parent", "Session", "Cost", "Tokens", "Messages", "Title"],
          ),
          aligns: ["left", "left", "left", "right", "right", "right", "left"],
          widthMode: TABLE_WIDTH_MODE,
          rows: sessionTreeRows,
        },
      ],
    });
  }

  // Skip Top sessions for session-scoped reports (e.g., /tokens_session, /tokens_session_all).
  if (reportKind === "standard") {
    const sessionRows: string[][] = [];
    const visibleSessions = r.bySession.filter(hasRenderableSessionUsage);

    const focus = params.focusSessionID
      ? visibleSessions.find((s) => s.sessionID === params.focusSessionID)
      : undefined;
    const rawFocus = params.focusSessionID
      ? r.bySession.find((s) => s.sessionID === params.focusSessionID)
      : undefined;

    if (focus) {
      appendSessionRow(sessionRows, focus, "*");

      // After showing the current session, show top sessions excluding it.
      const rest = visibleSessions.filter((s) => s.sessionID !== params.focusSessionID);
      for (const row of rest.slice(0, topSessions)) {
        appendSessionRow(sessionRows, row);
      }
    } else if (params.focusSessionID) {
      sessionRows.push(["*", missingFocusSessionLabel(Boolean(rawFocus)), "-", "-", "-", "-"]);

      for (const row of visibleSessions.slice(0, topSessions)) {
        appendSessionRow(sessionRows, row);
      }
    } else {
      // No focus session, just list top sessions.
      for (const row of visibleSessions.slice(0, topSessions)) {
        appendSessionRow(sessionRows, row);
      }
    }

    sections.push({
      id: "top-sessions",
      title: "Top sessions",
      blocks:
        sessionRows.length > 0
          ? [
              {
                kind: "table",
                ...tableHeaders(
                  tableOptions,
                  ["Cur", "Session", "Cost", "Tok", "Msgs", "Title"],
                  ["Current", "Session", "Cost", "Tokens", "Messages", "Title"],
                ),
                aligns: ["left", "left", "right", "right", "right", "left"],
                widthMode: TABLE_WIDTH_MODE,
                rows: sessionRows,
              },
            ]
          : [{ kind: "lines", lines: ["(no sessions)"] }],
    });
  }

  if (r.unpriced.length > 0) {
    sections.push({
      id: "unpriced-models",
      title: "Models with no token prices",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(
            tableOptions,
            ["Source", "Model", "Map", "Reason", "Tok", "Msgs"],
            ["Source", "Model", "Mapped", "Reason", "Tokens", "Messages"],
          ),
          aligns: ["left", "left", "left", "left", "right", "right"],
          widthMode: TABLE_WIDTH_MODE,
          rows: r.unpriced.slice(0, 20).map((u) => {
            const mapped = `${u.key.mappedProvider}/${u.key.mappedModel}`;
            return [
              normalizeSourceName(u.key.sourceProviderID),
              formatDiagnosticSourceModelId(u.key.sourceModelID, tableOptions.modelNameMaxWidth),
              mapped,
              u.key.reason,
              fmtCompact(totalTokenBuckets(u.tokens)),
              fmtCompact(u.messageCount),
            ];
          }),
        },
      ],
    });
  }

  if (r.unknown.length > 0) {
    sections.push({
      id: "unknown-pricing",
      title: "Models without pricing",
      blocks: [
        {
          kind: "table",
          ...tableHeaders(
            tableOptions,
            ["Source", "Model", "Map", "Tok", "Msgs"],
            ["Source", "Model", "Mapped", "Tokens", "Messages"],
          ),
          aligns: ["left", "left", "left", "right", "right"],
          widthMode: TABLE_WIDTH_MODE,
          rows: r.unknown.slice(0, 20).map((u) => {
            const mappedBase =
              u.key.mappedProvider && u.key.mappedModel
                ? `${u.key.mappedProvider}/${u.key.mappedModel}`
                : "-";
            const candidateSuffix =
              u.key.providerCandidates && u.key.providerCandidates.length > 0
                ? `candidates: ${u.key.providerCandidates.join(",")}`
                : "";
            const mapped =
              candidateSuffix.length > 0
                ? mappedBase === "-"
                  ? candidateSuffix
                  : `${mappedBase} (${candidateSuffix})`
                : mappedBase;
            return [
              normalizeSourceName(u.key.sourceProviderID),
              formatDiagnosticSourceModelId(u.key.sourceModelID, tableOptions.modelNameMaxWidth),
              mapped,
              fmtCompact(totalTokenBuckets(u.tokens)),
              fmtCompact(u.messageCount),
            ];
          }),
        },
        {
          kind: "lines",
          lines: ["Run /quota_status to see the full pricing diagnostics report."],
        },
      ],
    });
  }

  return {
    heading: commandHeading({
      title: params.title,
      detail: params.titleDetail,
      generatedAtMs: params.generatedAtMs,
    }),
    sections,
  };
}
