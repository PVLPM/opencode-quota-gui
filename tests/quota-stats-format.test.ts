import { describe, expect, it } from "vitest";
import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import type { AggregateResult } from "../src/lib/quota-stats.js";
import {
  buildQuotaStatsReportDocument,
  formatQuotaStatsReport,
} from "../src/lib/quota-stats-format.js";

function makeEmptyResult(overrides?: Partial<AggregateResult>): AggregateResult {
  return {
    window: { sinceMs: 0, untilMs: 1 },
    totals: {
      priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      costUsd: 0,
      messageCount: 0,
      sessionCount: 0,
    },
    bySourceProvider: [],
    bySourceModel: [],
    byModel: [],
    bySession: [],
    unknown: [],
    unpriced: [],
    ...overrides,
  };
}

function makeSessionRow(
  overrides?: Partial<AggregateResult["bySession"][number]>,
): AggregateResult["bySession"][number] {
  return {
    sessionID: "ses_default",
    title: "Default Session",
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    costUsd: 0,
    messageCount: 0,
    ...overrides,
  };
}

describe("formatQuotaStatsReport (markdown)", () => {
  it("renders a markdown table for models with separator rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 1.23,
        messageCount: 2,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 2,
        },
        {
          sourceProviderID: "cursor",
          sourceModelID: "gpt-5.2",
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.01,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      topModels: 99,
    });
    expect(out).toMatch(
      /^# Tokens used \(Last 24 Hours\) \(\/tokens_daily\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );
    expect(out).toContain("## Model breakdown");
    expect(out).toContain("| Source");
    // blank separator row between sources
    expect(out).toContain("|          |");
    expect(out).toContain("OpenCode");
    expect(out).toContain("Cursor");
  });

  it("compacts token dialog table headers and middle-ellipsizes long model names when requested", () => {
    const longModel = "openai/gpt-5.2-super-long-context-2026-06-16";
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 100, cache_write: 50 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 1.23,
        messageCount: 2,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "openai",
          sourceModelID: longModel,
          tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 100, cache_write: 50 },
          costUsd: 1.23,
          messageCount: 2,
        },
      ],
    });

    const standard = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
    });
    expect(standard).toContain(longModel);
    expect(standard).toContain("Input");
    expect(standard).toContain("Output");
    expect(standard).toContain("Cache read");

    const compact = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      tableOptions: {
        compactHeaders: true,
        modelNameMaxWidth: 20,
      },
    });

    expect(compact).not.toContain(longModel);
    expect(compact).toContain("openai/gpt…026-06-16");
    expect(compact).toContain("Msgs");
    expect(compact).toContain("Sess");
    expect(compact).toContain("Tok");
    expect(compact).toContain("In");
    expect(compact).toContain("Out");
    expect(compact).toContain("C.Rd");
    expect(compact).toContain("C.Wr");
    expect(compact).not.toContain("Input");
    expect(compact).not.toContain("Output");
    expect(compact).not.toContain("Cache read");
    expect(compact).not.toContain("Cache write");

    // The document keeps each table's full labels next to the compact ones, for the TUI dialog.
    const document = buildQuotaStatsReportDocument({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      tableOptions: { compactHeaders: true },
    });
    const models = document.sections.find((section) => section.id === "models")?.blocks[0];
    expect(models).toMatchObject({
      headers: ["Source", "Model", "In", "Out", "C.Rd", "C.Wr", "Tok", "Cost"],
      fullHeaders: [
        "Source",
        "Model",
        "Input",
        "Output",
        "Cache read",
        "Cache write",
        "Tokens",
        "Cost",
      ],
    });
  });

  it("abbreviates antigravity model names before width enforcement", () => {
    const sourceModelID = "antigravity-gemini-3-pro-preview";
    const r = makeEmptyResult({
      totals: {
        priced: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 6, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 7, output: 8, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.01,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "google-antigravity",
          sourceModelID,
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.01,
          messageCount: 1,
        },
      ],
      unpriced: [
        {
          key: {
            sourceProviderID: "google-antigravity",
            sourceModelID,
            mappedProvider: "google",
            mappedModel: "gemini-3-pro-preview",
            reason: "snapshot missing model",
          },
          tokens: { input: 7, output: 8, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
      unknown: [
        {
          key: {
            sourceProviderID: "google-antigravity",
            sourceModelID,
            mappedProvider: "google",
            mappedModel: "gemini-3-pro-preview",
          },
          tokens: { input: 5, output: 6, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      tableOptions: {
        compactHeaders: true,
        modelNameMaxWidth: 20,
      },
    });

    expect(out).not.toContain("antigravity");
    expect(out).toContain("agy-gemini…o-preview");
  });

  it("omits Reasoning column when all reasoning is zero", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "gpt-5.2",
          tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      topModels: 99,
    });
    expect(out).not.toContain("Reasoning");
  });

  it("sessionOnly mode hides Window/Sessions columns and Top sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Current Session) (/tokens_session)",
      result: r,
      sessionOnly: true,
    });

    // Title should be present
    expect(out).toMatch(
      /^# Tokens used \(Current Session\) \(\/tokens_session\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );

    // Summary table should NOT have Window or Sessions columns
    expect(out).not.toContain("| Window");
    expect(out).not.toContain("| Sessions");

    // Summary table SHOULD have Messages, Tokens, Cost columns
    expect(out).toContain("Messages");
    expect(out).toContain("Tokens");
    expect(out).toContain("Cost");

    // Top sessions section should NOT be present
    expect(out).not.toContain("## Top sessions");
  });

  it("session_tree mode renders a session breakdown and counts zero-usage descendants", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 4,
        sessionCount: 2,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_parent",
          title: "Parent Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
        {
          sessionID: "ses_child",
          title: "Child Session",
          tokens: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Current Session Tree) (/tokens_session_all)",
      result: r,
      reportKind: "session_tree",
      sessionTree: {
        rootSessionID: "ses_parent",
        nodes: [
          { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
          {
            sessionID: "ses_child",
            parentID: "ses_parent",
            title: "Child Session",
            depth: 1,
          },
          {
            sessionID: "ses_grandchild",
            parentID: "ses_child",
            title: "Grandchild Session",
            depth: 2,
          },
        ],
      },
    });

    expect(out).toContain("| Messages");
    expect(out).toContain("| Sessions");
    expect(out).toContain("## Session tree");
    expect(out).toContain("current");
    expect(out).toContain("child");
    expect(out).toContain("grandchild");
    expect(out).toContain("ses_parent");
    expect(out).toContain("ses_grandchild");
    expect(out).toContain("$0.00");
    expect(out).not.toContain("## Top sessions");
  });

  it("standard mode includes Window/Sessions columns and Top sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      sessionOnly: false, // explicit false, same as omitting
    });

    // Summary table SHOULD have Window and Sessions columns
    expect(out).toContain("Window");
    expect(out).toContain("Sessions");

    // Top sessions section SHOULD be present
    expect(out).toContain("## Top sessions");
    // Marker column should be named and not render as an empty header
    expect(out).toContain("| Current");
    expect(out).toContain("| Session");
  });

  it("uses a Unicode ellipsis when shortening visible session titles", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_long_title",
            title: "abcdefghij-very-long-middle-section-klmnopqrst",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.75,
            messageCount: 4,
          }),
        ],
      }),
    });

    expect(out).toContain("abcdefghij…klmnopqrst");
    expect(out).not.toContain("abcdefghij...klmnopqrst");
  });

  it("does not render a concrete focus session id when the current session is outside the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.75,
            messageCount: 4,
          }),
        ],
      }),
      focusSessionID: "ses_missing",
    });

    expect(out).toContain("(current session not in selected window)");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_missing");
    expect(out).not.toContain("No current session");
  });

  it("does not render a concrete focus session id when it has no token usage in the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 50, output: 75, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.25,
            messageCount: 3,
          }),
        ],
      }),
      focusSessionID: "ses_zero",
    });

    expect(out).toContain("(current session has no token usage in selected window)");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("filters zero-token session rows from top sessions", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.05,
            messageCount: 1,
          }),
        ],
      }),
    });

    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("shows provider candidates for ambiguous unknown pricing rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      unknown: [
        {
          key: {
            sourceProviderID: "opencode",
            sourceModelID: " foo-model ",
            mappedModel: "foo-model",
            providerCandidates: ["openai", "anthropic"],
          },
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
    });

    expect(out).toContain("candidates: openai,anthropic");
    expect(out).toContain("| OpenCode |  foo-model  |");
  });

  it("locks the full markdown report layout for the shared report-document renderer", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 6,
          sessionCount: 2,
        },
        bySourceModel: [
          {
            sourceProviderID: "opencode",
            sourceModelID: "claude-opus-4-5-high",
            tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 1.23,
            messageCount: 2,
          },
        ],
        bySession: [
          {
            sessionID: "ses_123",
            title: "Test Session",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.5,
            messageCount: 3,
          },
        ],
        unpriced: [
          {
            key: {
              sourceProviderID: "cursor",
              sourceModelID: "foo-model",
              mappedProvider: "openai",
              mappedModel: "foo-model",
              reason: "snapshot missing model",
            },
            tokens: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
        unknown: [
          {
            key: {
              sourceProviderID: "opencode",
              sourceModelID: "bar-model",
              mappedProvider: "openai",
              mappedModel: "bar-model",
              providerCandidates: ["openai", "anthropic"],
            },
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
      }),
    });

    const [heading, blank, ...body] = out.split("\n");
    expect(heading).toMatch(
      /^# Tokens used \(Last 24 Hours\) \(\/tokens_daily\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(blank).toBe("");

    expect(body.join("\n")).toMatchInlineSnapshot(`
      "| Window   | Messages | Sessions | Tokens |            Cost |
      | -------- | -------: | -------: | -----: | --------------: |
      | all time |        6 |        2 |   3.1K | $1.23 (partial) |

      Cost is partial: $1.23 is the known subtotal; tokens without published rates are unpriced.

      ## Model breakdown

      | Source   | Model                | Input | Output | Cache read | Cache write | Tokens |  Cost |
      | -------- | -------------------- | ----: | -----: | ---------: | ----------: | -----: | ----: |
      | OpenCode | claude-opus-4-5-high |  1.0K |   2.0K |          0 |           0 |   3.0K | $1.23 |

      ## Top sessions

      | Current | Session |  Cost | Tokens | Messages | Title        |
      | ------- | ------- | ----: | -----: | -------: | ------------ |
      |         | ses_123 | $0.50 |    300 |        3 | Test Session |

      ## Models with no token prices

      | Source | Model     | Mapped           | Reason                 | Tokens | Messages |
      | ------ | --------- | ---------------- | ---------------------- | -----: | -------: |
      | Cursor | foo-model | openai/foo-model | snapshot missing model |     70 |        1 |

      ## Models without pricing

      | Source   | Model     | Mapped                                          | Tokens | Messages |
      | -------- | --------- | ----------------------------------------------- | -----: | -------: |
      | OpenCode | bar-model | openai/bar-model (candidates: openai,anthropic) |     30 |        1 |

      Run /quota_status to see the full pricing diagnostics report."
    `);
  });

  it("marks partial costs and states the known subtotal", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 1_000_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 0, output: 2_000_000, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 2,
          messageCount: 1,
          sessionCount: 1,
          partialCostUsd: 2,
          partialMessageCount: 1,
        },
        bySourceModel: [
          {
            sourceProviderID: "opencode",
            sourceModelID: "mixed-rate-model",
            tokens: {
              input: 1_000_000,
              output: 2_000_000,
              reasoning: 0,
              cache_read: 0,
              cache_write: 0,
            },
            costUsd: 2,
            messageCount: 1,
            partialMessageCount: 1,
          },
        ],
        bySession: [
          {
            sessionID: "ses_partial",
            title: "Partial Session",
            tokens: {
              input: 1_000_000,
              output: 2_000_000,
              reasoning: 0,
              cache_read: 0,
              cache_write: 0,
            },
            costUsd: 2,
            messageCount: 1,
            partialMessageCount: 1,
          },
        ],
      }),
    });

    const partialCells = out.match(/\$2\.00 \(partial\)/g) ?? [];
    expect(partialCells).toHaveLength(3);
    expect(out).toContain(
      "Cost is partial: $2.00 is the known subtotal; tokens without published rates are unpriced.",
    );
  });

  it("marks totals mixing priced usage with fully unpriced or unknown usage", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 1_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 10, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.5,
          messageCount: 3,
          sessionCount: 2,
        },
        bySourceModel: [
          {
            sourceProviderID: "opencode",
            sourceModelID: "priced-model",
            tokens: { input: 1_000, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 1.5,
            messageCount: 1,
          },
        ],
        bySession: [
          {
            sessionID: "ses_mixed",
            title: "Mixed Session",
            tokens: { input: 1_030, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 1.5,
            messageCount: 2,
            pricedMessageCount: 1,
            unpricedMessageCount: 1,
          },
          {
            sessionID: "ses_unpriced",
            title: "Unpriced Session",
            tokens: { input: 10, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0,
            messageCount: 1,
            unpricedMessageCount: 1,
          },
        ],
        unpriced: [
          {
            key: {
              sourceProviderID: "cursor",
              sourceModelID: "foo-model",
              mappedProvider: "openai",
              mappedModel: "foo-model",
              reason: "snapshot missing model",
            },
            tokens: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
        unknown: [
          {
            key: { sourceProviderID: "opencode", sourceModelID: "bar-model" },
            tokens: { input: 10, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
      }),
    });

    const lines = out.split("\n");
    const summaryLine = lines.find((line) => line.startsWith("| all time"));
    const modelLine = lines.find((line) => line.includes("priced-model"));
    const mixedLine = lines.find((line) => line.includes("ses_mixed"));
    const unpricedLine = lines.find((line) => line.includes("ses_unpriced"));

    expect(summaryLine).toContain("$1.50 (partial)");
    expect(modelLine).not.toContain("(partial)");
    expect(mixedLine).toContain("$1.50 (partial)");
    expect(unpricedLine).toContain("$0.00");
    expect(unpricedLine).not.toContain("(partial)");
    expect(out).toContain(
      "Cost is partial: $1.50 is the known subtotal; tokens without published rates are unpriced.",
    );
  });

  it("keeps entirely unpriced totals unmarked", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
          sessionCount: 1,
        },
      }),
    });

    const summaryLine = out.split("\n").find((line) => line.startsWith("| all time"));
    expect(summaryLine).toContain("$0.00");
    expect(summaryLine).not.toContain("(partial)");
    expect(out).not.toContain("Cost is partial");
  });

  it("keeps the title line in text and gives the dialog only the facts its title lacks", () => {
    const generatedAtMs = Date.UTC(2026, 8, 29, 14, 0);
    const time = formatLocalCallTimestamp(generatedAtMs);
    const weekly = {
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult(),
      generatedAtMs,
    };
    const between = {
      title: "Tokens used (2026-01-01 .. 2026-01-15) (/tokens_between)",
      titleDetail: "2026-01-01 .. 2026-01-15",
      result: makeEmptyResult(),
      generatedAtMs,
    };

    expect(formatQuotaStatsReport(weekly).split("\n")[0]).toBe(
      `# Tokens used (Last 7 Days) (/tokens_weekly) ${time}`,
    );
    expect(buildQuotaStatsReportDocument(weekly).heading?.subtitle).toBe(time);
    expect(formatQuotaStatsReport(between).split("\n")[0]).toBe(
      `# Tokens used (2026-01-01 .. 2026-01-15) (/tokens_between) ${time}`,
    );
    expect(buildQuotaStatsReportDocument(between).heading?.subtitle).toBe(
      `2026-01-01 .. 2026-01-15 · ${time}`,
    );
    // The sections, which the dialog draws, never repeat the title.
    const sectionsText = formatQuotaStatsReport(weekly).split("\n").slice(1).join("\n");
    expect(sectionsText).not.toContain("Tokens used");
  });
});
