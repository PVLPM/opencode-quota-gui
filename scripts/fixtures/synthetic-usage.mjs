/**
 * Deterministic synthetic Usage history (v1.4.0).
 *
 * Browser-safe plain data: the same builder feeds the Vitest cases and the
 * synthetic smoke server, so every range, boundary, monitoring gap and
 * attribution outcome has one reviewed shape. Timestamps are derived from the
 * caller's `nowMs`; no real OpenCode data, credential or provider is read.
 *
 * Three accounts:
 * - OpenAI Work: a 5h window with a monitoring gap and a weekly window with a
 *   precise reset boundary.
 * - OpenAI Personal: a 5h window whose reset time is unknown ("reset between
 *   observations").
 * - Claude Agent: 5h, Weekly and Fable weekly windows, including a
 *   locally-estimated window.
 * - Imported activity: separate Claude Code and Codex sections, outside every
 *   quota window and attribution weight.
 */
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const MODELS = [
  { providerId: "openai", modelId: "gpt-5.2-codex" },
  { providerId: "openai", modelId: "gpt-5.2-codex", effort: "high" },
  { providerId: "openai", modelId: "gpt-5.2-codex", effort: "default" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-5", effort: "default" },
  { providerId: "anthropic", modelId: "claude-opus-4-1" },
  { providerId: "anthropic", modelId: "claude-haiku-4-5" },
];

const MODEL = {
  codex: 0,
  codexHigh: 1,
  codexDefault: 2,
  sonnet: 3,
  sonnetDefault: 4,
  opus: 5,
  haiku: 6,
};

function tokens(input, cacheRead, cacheWrite, output, reasoning, costUsd) {
  const total = input + cacheRead + cacheWrite + output + reasoning;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total,
    apiEquivalentCostUsd: costUsd,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

const TOKENS = {
  codex: tokens(18_000, 64_000, 4_000, 12_000, 2_000, 1.28),
  codexHigh: tokens(12_000, 48_000, 2_000, 9_000, 6_000, 0.94),
  codexDefault: tokens(6_000, 22_000, 1_000, 5_000, 1_000, 0.31),
  sonnet: tokens(14_000, 52_000, 3_000, 10_000, 1_000, 0.88),
  sonnetDefault: tokens(8_000, 30_000, 1_000, 6_000, 0, 0.42),
  opus: tokens(5_000, 18_000, 1_000, 4_000, 2_000, 0.71),
  haiku: tokens(3_000, 9_000, 0, 2_000, 0, 0.08),
};

function point(startMs, endMs, remainingPercent, sampleCount, resetAtMs) {
  return {
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    remainingPercent,
    sampleCount,
    source: "opencode-poll",
    ...(resetAtMs === undefined ? {} : { resetAtMs: Math.round(resetAtMs) }),
  };
}

function activity(model, usage, stepCount, estimatedBurnPercentPoints, source = "opencode-poll") {
  return {
    model,
    tokens: usage,
    stepCount,
    ...(estimatedBurnPercentPoints === undefined ? {} : { estimatedBurnPercentPoints }),
    source,
  };
}

function effortTokens(usage, stepCount, estimatedBurnPercentPoints, effort) {
  return {
    tokens: usage,
    stepCount,
    ...(estimatedBurnPercentPoints === undefined ? {} : { estimatedBurnPercentPoints }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function breakdownRow(providerId, modelId, usage, stepCount, estimated, efforts) {
  return {
    providerId,
    modelId,
    tokens: usage,
    stepCount,
    ...(estimated === undefined ? {} : { estimatedBurnPercentPoints: estimated }),
    efforts,
  };
}

/**
 * Builds points, links, intervals, coverage and totals from one ordered track
 * list. `tracks[i].link` describes the relation to `tracks[i + 1]`.
 */
function buildSeries(options) {
  const points = options.tracks.map((track) => track.point);
  const links = options.tracks.slice(0, -1).map((track) => track.link);
  const intervals = [];
  let observedBurn = 0;
  let attributed = 0;
  let unattributed = 0;

  options.tracks.forEach((track, index) => {
    // A stored run is itself inspectable, including a flat run of one sample.
    intervals.push({
      fromPoint: index,
      toPoint: index,
      startMs: track.point.startMs,
      endMs: track.point.endMs,
      previousRemainingPercent: track.point.remainingPercent,
      currentRemainingPercent: track.point.remainingPercent,
      link: "observed",
      burnPercentPoints: 0,
      attributedBurnPercentPoints: 0,
      unattributedBurnPercentPoints: 0,
      activity: [],
    });
    const next = options.tracks[index + 1];
    if (next === undefined) return;
    const isBoundary = track.link.kind === "boundary";
    const burn = isBoundary
      ? null
      : Math.max(0, track.point.remainingPercent - next.point.remainingPercent);
    const attributedForInterval = isBoundary ? 0 : (track.attributed ?? 0);
    const unattributedForInterval = isBoundary
      ? 0
      : Math.max(0, (burn ?? 0) - attributedForInterval);
    observedBurn += burn ?? 0;
    attributed += attributedForInterval;
    unattributed += unattributedForInterval;
    intervals.push({
      fromPoint: index,
      toPoint: index + 1,
      startMs: track.point.endMs,
      endMs: next.point.startMs,
      previousRemainingPercent: track.point.remainingPercent,
      currentRemainingPercent: next.point.remainingPercent,
      link: track.link.kind,
      burnPercentPoints: burn,
      attributedBurnPercentPoints: attributedForInterval,
      unattributedBurnPercentPoints: unattributedForInterval,
      ...(unattributedForInterval > 0 && track.reason ? { unattributedReason: track.reason } : {}),
      activity: track.activity ?? [],
    });
  });

  const first = points[0];
  const last = points[points.length - 1];
  const observedMs = points.reduce((total, entry) => total + (entry.endMs - entry.startMs), 0);
  const sampleCount = points.reduce((total, entry) => total + entry.sampleCount, 0);

  return {
    rowId: options.rowId,
    label: options.label,
    ...(options.metric === undefined ? {} : { metric: options.metric }),
    measurement: options.measurement ?? "provider-observed",
    axis: {
      startMs: Math.round(options.axis.startMs),
      endMs: Math.round(options.axis.endMs),
    },
    coverage: {
      ...(first === undefined ? {} : { firstObservedAtMs: first.startMs }),
      ...(last === undefined ? {} : { lastObservedAtMs: last.endMs }),
      observedMs,
      sampleCount,
    },
    points,
    links,
    intervals,
    totals: {
      observedBurnPercentPoints: observedBurn,
      attributedBurnPercentPoints: attributed,
      unattributedBurnPercentPoints: unattributed,
    },
    breakdown: options.breakdown ?? [],
  };
}

/** The five requested axis spans; `current` keeps one epoch per window. */
function axisFor(range, nowMs, windowLengthMs) {
  switch (range) {
    case "current":
      return { startMs: nowMs - windowLengthMs, endMs: nowMs };
    case "24h":
      return { startMs: nowMs - DAY_MS, endMs: nowMs };
    case "7d":
      return { startMs: nowMs - 7 * DAY_MS, endMs: nowMs };
    case "30d":
      return { startMs: nowMs - 30 * DAY_MS, endMs: nowMs };
    default:
      return { startMs: nowMs - 120 * DAY_MS, endMs: nowMs };
  }
}

function at(axis, fraction) {
  return axis.startMs + (axis.endMs - axis.startMs) * fraction;
}

/** A monitoring gap: comparable endpoints, unobserved trajectory. */
function gapSeries({ rowId, label, axis, measurement, breakdown }) {
  const tracks = [
    {
      point: point(at(axis, 0.15), at(axis, 0.28), 82, 4),
      link: { kind: "unobserved" },
      attributed: 7.5,
      reason: "unobserved-interval",
      activity: [
        activity(MODEL.codex, TOKENS.codex, 4, 5.5),
        activity(MODEL.sonnet, TOKENS.sonnet, 2, 2),
      ],
    },
    {
      point: point(at(axis, 0.34), at(axis, 0.46), 71, 3),
      link: { kind: "observed" },
      attributed: 9,
      reason: "unpriced",
      activity: [
        activity(MODEL.codexHigh, TOKENS.codexHigh, 3, 6),
        activity(MODEL.codexDefault, TOKENS.codexDefault, 2, 3),
      ],
    },
    {
      point: point(at(axis, 0.52), at(axis, 0.66), 58, 5),
      link: { kind: "observed" },
      attributed: 0,
      reason: "no-activity",
      activity: [],
    },
    {
      point: point(at(axis, 0.72), at(axis, 0.86), 44, 3),
      link: { kind: "observed" },
    },
  ];
  return buildSeries({
    rowId,
    label,
    axis,
    measurement,
    tracks,
    breakdown: breakdown ?? [
      breakdownRow("openai", "gpt-5.2-codex", TOKENS.codex, 9, 7.5, [
        effortTokens(TOKENS.codex, 4, 3.5),
        effortTokens(TOKENS.codexHigh, 3, 4, "high"),
        effortTokens(TOKENS.codexDefault, 2, 0, "default"),
      ]),
      breakdownRow("anthropic", "claude-sonnet-4-5", TOKENS.sonnet, 4, 2, [
        effortTokens(TOKENS.sonnet, 2, 2, undefined),
        effortTokens(TOKENS.sonnetDefault, 2, 0, "default"),
      ]),
    ],
  });
}

/** A proven reset: disconnected segments and a marker at the exact time. */
function resetSeries({ rowId, label, axis, measurement, breakdown }) {
  const resetAtMs = at(axis, 0.4);
  const tracks = [
    {
      point: point(at(axis, 0.1), at(axis, 0.22), 25, 4),
      link: { kind: "boundary", boundary: "reset", atMs: resetAtMs },
    },
    {
      point: point(at(axis, 0.46), at(axis, 0.6), 100, 3),
      link: { kind: "observed" },
      attributed: 15,
      reason: "zero-weight",
      activity: [
        activity(MODEL.codex, TOKENS.codex, 5, 9),
        activity(MODEL.codexDefault, TOKENS.codexDefault, 3, 6),
      ],
    },
    {
      point: point(at(axis, 0.68), at(axis, 0.8), 78, 5),
      link: { kind: "observed" },
    },
  ];
  return buildSeries({
    rowId,
    label,
    axis,
    measurement,
    tracks,
    breakdown: breakdown ?? [
      breakdownRow("openai", "gpt-5.2-codex", TOKENS.codex, 8, 9, [
        effortTokens(TOKENS.codex, 5, 9),
      ]),
      breakdownRow("anthropic", "claude-sonnet-4-5", TOKENS.sonnet, 3, 6, [
        effortTokens(TOKENS.sonnet, 3, 6),
      ]),
    ],
  });
}

/** Remaining rose but no observation pins the reset time. */
function unknownResetSeries({ rowId, label, axis, measurement }) {
  const tracks = [
    {
      point: point(at(axis, 0.2), at(axis, 0.35), 12, 2),
      link: { kind: "boundary", boundary: "reset" },
    },
    {
      point: point(at(axis, 0.55), at(axis, 0.7), 100, 2),
      link: { kind: "observed" },
      attributed: 0,
      reason: "no-activity",
      activity: [],
    },
    {
      point: point(at(axis, 0.75), at(axis, 0.9), 100, 1),
      link: { kind: "observed" },
    },
  ];
  return buildSeries({
    rowId,
    label,
    axis,
    measurement,
    tracks,
    breakdown: [],
  });
}

/**
 * Builds the complete synthetic snapshot for one requested Usage range.
 * `models` is the shared identity table every `activity.model` indexes into.
 */
export function buildSyntheticUsageSnapshot({ range, nowMs = Date.now() }) {
  const current5h = axisFor("current", nowMs, 5 * HOUR_MS);
  const currentWeek = axisFor("current", nowMs, 7 * DAY_MS);
  const finite = axisFor(range, nowMs, 5 * HOUR_MS);
  const week = range === "current" ? currentWeek : finite;
  const fiveHour = range === "current" ? current5h : finite;

  const accounts = [
    {
      accountKey: "synthetic-openai-work",
      providerId: "openai",
      providerLabel: "OpenAI",
      planLabel: "ChatGPT Pro",
      accountLabel: "Work",
      source: "opencode-poll",
      windows: [
        gapSeries({
          rowId: "five_hour",
          label: "5h limit",
          axis: fiveHour,
          breakdown: [
            breakdownRow("openai", "gpt-5.2-codex", TOKENS.codex, 12, 9.5, [
              effortTokens(TOKENS.codex, 4, 3.5),
              effortTokens(TOKENS.codexHigh, 3, 4, "high"),
              effortTokens(TOKENS.codexDefault, 2, 2, "default"),
            ]),
            breakdownRow("anthropic", "claude-sonnet-4-5", TOKENS.sonnet, 4, 2, [
              effortTokens(TOKENS.sonnet, 2, 2),
            ]),
          ],
        }),
        resetSeries({
          rowId: "weekly",
          label: "Weekly",
          axis: week,
        }),
      ],
    },
    {
      accountKey: "synthetic-openai-personal",
      providerId: "openai",
      providerLabel: "OpenAI",
      planLabel: "ChatGPT Plus",
      accountLabel: "Personal",
      source: "opencode-poll",
      windows: [
        unknownResetSeries({
          rowId: "five_hour",
          label: "5h limit",
          axis: fiveHour,
        }),
      ],
    },
    {
      accountKey: "synthetic-claude-agent",
      providerId: "claude-agent",
      providerLabel: "Claude Agent",
      planLabel: "Max 20x",
      accountLabel: "Personal",
      source: "opencode-poll",
      windows: [
        gapSeries({
          rowId: "five_hour",
          label: "5h limit",
          axis: fiveHour,
          breakdown: [
            breakdownRow("anthropic", "claude-opus-4-1", TOKENS.opus, 5, 6, [
              effortTokens(TOKENS.opus, 5, 6),
            ]),
            breakdownRow("anthropic", "claude-haiku-4-5", TOKENS.haiku, 3, undefined, [
              effortTokens(TOKENS.haiku, 3, undefined, undefined),
            ]),
          ],
        }),
        resetSeries({
          rowId: "weekly",
          label: "Weekly",
          axis: week,
        }),
        {
          ...gapSeries({
            rowId: "fable_weekly",
            label: "Fable weekly",
            axis: week,
          }),
          measurement: "locally-estimated",
        },
      ],
    },
  ];

  return {
    generatedAtMs: nowMs,
    range,
    timeZone: "UTC",
    ...(range === "current" ? {} : { span: { startMs: finite.startMs, endMs: finite.endMs } }),
    accounts,
    models: MODELS,
    imports: [
      {
        harness: "claude-code",
        enabled: true,
        lastImportedAtMs: nowMs - 2 * HOUR_MS,
        status: "ok",
      },
      {
        harness: "codex",
        enabled: true,
        lastImportedAtMs: nowMs - HOUR_MS,
        status: "ok",
      },
    ],
    importedActivity: [
      {
        harness: "claude-code",
        span: { startMs: finite.startMs, endMs: finite.endMs },
        models: [
          breakdownRow("anthropic", "claude-sonnet-4-5", TOKENS.sonnet, 2, undefined, [
            effortTokens(TOKENS.sonnet, 2, undefined),
          ]),
        ],
        totals: TOKENS.sonnet,
        stepCount: 2,
        incomplete: false,
      },
      {
        harness: "codex",
        span: { startMs: finite.startMs, endMs: finite.endMs },
        models: [
          breakdownRow("openai", "gpt-5.2-codex", TOKENS.codexHigh, 3, undefined, [
            effortTokens(TOKENS.codexHigh, 3, undefined, "high"),
          ]),
        ],
        totals: TOKENS.codexHigh,
        stepCount: 3,
        incomplete: false,
      },
    ],
  };
}

export { MODELS as SYNTHETIC_USAGE_MODELS };
