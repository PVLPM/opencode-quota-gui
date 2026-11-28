/**
 * Usage observation store and recorder (v1.4.0 workstream B).
 *
 * Covers genuine-measurement identity, run extension and continuity, exclusion
 * of retained/cooldown/error cycles, restart and concurrent-writer behaviour,
 * out-of-order splitting, missing-row evidence and the privacy-safe schema.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderCard, QuotaCardRow, QuotaSnapshot } from "../src/contracts/dashboard.js";
import type { RowId } from "../src/contracts/identity.js";
import { createGuiLogger } from "../src/gui/log.js";
import {
  markQuotaObservationCycle,
  markQuotaObservationLive,
} from "../src/gui/quota-observation.js";
import { createUsageRecorder } from "../src/gui/usage-recorder.js";
import { openOpenCodeSqliteReadOnly } from "../src/lib/opencode-sqlite.js";
import {
  openUsageStore,
  USAGE_READ_BUSY_TIMEOUT_MS,
  type UsageCycleObservation,
  type UsageCycleSample,
  type UsageSeriesInfo,
  type UsageStore,
} from "../src/lib/usage-store.js";

const BASE = Date.parse("2026-02-01T00:00:00.000Z");
const MINUTE = 60_000;
const ROW_A = "card-a#window:five_hour|quota:percent";
const ROW_B = "card-b#window:week|quota:percent";
const ROW_C = "card-a#window:week|quota:percent";

let root: string;
let path: string;
let stores: UsageStore[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocq-usage-store-"));
  path = join(root, "usage-history.sqlite");
  stores = [];
});

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // best effort
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function store(): Promise<UsageStore> {
  const opened = await openUsageStore(path);
  stores.push(opened);
  return opened;
}

function series(rowId: string, overrides: Partial<UsageSeriesInfo> = {}): UsageSeriesInfo {
  const hash = rowId.indexOf("#");
  const cardId = rowId.slice(0, hash);
  return {
    rowId,
    cardId,
    rowKey: rowId.slice(hash + 1),
    providerId: "alpha",
    providerLabel: "Alpha",
    label: "Quota",
    measurement: "provider-observed",
    source: "opencode-poll",
    firstAtMs: 0,
    lastAtMs: 0,
    ...overrides,
  };
}

function sample(
  rowId: string,
  measuredAtMs: number,
  remainingPercent: number,
  overrides: Partial<UsageCycleSample> = {},
): UsageCycleSample {
  return {
    series: series(rowId),
    remainingPercent,
    measuredAtMs,
    ...overrides,
  };
}

function observation(
  samples: readonly UsageCycleSample[],
  overrides: Partial<UsageCycleObservation> = {},
): UsageCycleObservation {
  const cards = new Map<string, { cardId: string; providerId: string; atMs: number }>();
  for (const item of samples) {
    cards.set(item.series.cardId, {
      cardId: item.series.cardId,
      providerId: item.series.providerId,
      atMs: item.measuredAtMs,
    });
  }
  return {
    collectorRunId: "run-1",
    collectorSessionId: "session-1",
    intervalMs: MINUTE,
    observedCards: [...cards.values()],
    providerIds: ["alpha"],
    samples,
    interruptions: [],
    nowMs:
      samples.length > 0
        ? Math.max(...samples.map((item) => item.measuredAtMs))
        : (overrides.nowMs ?? BASE),
    ...overrides,
  };
}

function row(cardId: string, rowKey: string, percentRemaining: number): QuotaCardRow {
  return {
    rowId: `${cardId}#${rowKey}` as RowId,
    label: "Quota",
    kind: "percent",
    resultType: "quota",
    percentRemaining,
    metric: { kind: "window", window: "five_hour" },
  };
}

function card(
  cardId: string,
  rows: QuotaCardRow[],
  overrides: Partial<ProviderCard> = {},
): ProviderCard {
  return {
    cardId: cardId as ProviderCard["cardId"],
    providerId: "alpha",
    providerLabel: "Alpha",
    labelSource: "provider",
    rows,
    errors: [],
    ...overrides,
  };
}

function snapshot(cards: ProviderCard[], overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    generatedAtMs: BASE,
    stale: false,
    timeZone: "UTC",
    providers: { cards, enabledProviders: "auto", polledAtMs: BASE },
    ...overrides,
  };
}

function live(
  value: QuotaSnapshot,
  measuredAtByCard: Map<string, number>,
  intervalMs = MINUTE,
): QuotaSnapshot {
  markQuotaObservationCycle(value, {
    measuredAtByCard,
    intervalMs,
    providerIds: ["alpha", "cursor"],
  });
  return markQuotaObservationLive(value);
}

function runsOf(store: UsageStore, rowId: string) {
  return store
    .query({ startMs: 0, endMs: BASE + 24 * 60 * MINUTE })
    .runs.filter((run) => run.seriesId === rowId);
}

describe("usage store: series identity and run compression", () => {
  it("keeps multiple accounts and windows as stable independent series", async () => {
    const db = await store();
    const beta = series(ROW_B, { providerLabel: "Beta" });
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80), sample(ROW_B, BASE, 40, { series: beta })]),
    );
    db.recordCycle(
      observation(
        [sample(ROW_A, BASE + MINUTE, 80), sample(ROW_B, BASE + MINUTE, 40, { series: beta })],
        { collectorRunId: "run-2" },
      ),
    );

    const slice = db.query({ startMs: BASE, endMs: BASE + 2 * MINUTE });
    expect(slice.series.map((item) => item.rowId).sort()).toEqual([ROW_A, ROW_B].sort());
    expect(slice.series.find((item) => item.rowId === ROW_A)?.cardId).toBe("card-a");
    expect(slice.series.find((item) => item.rowId === ROW_B)?.providerLabel).toBe("Beta");
    expect(slice.runs).toHaveLength(2);
    expect(slice.runs.every((run) => run.sampleCount === 2)).toBe(true);
    expect(slice.runs.every((run) => run.linked === false)).toBe(true);
  });

  it("extends one run for identical consecutive samples and starts again after a gap", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 50)], { collectorRunId: "run-2" }));

    let runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(2);
    expect(runs[0]?.firstAtMs).toBe(BASE);
    expect(runs[0]?.lastAtMs).toBe(BASE + MINUTE);

    db.recordCycle(observation([sample(ROW_A, BASE + 181_000, 50)], { collectorRunId: "run-3" }));
    runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.linked).toBe(false);
    expect(runs[1]?.sampleCount).toBe(1);
  });

  it("does not extend a run across a collector-session restart", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 50)], {
        collectorRunId: "run-2",
        collectorSessionId: "session-2",
      }),
    );
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.linked).toBe(false);
  });

  it("ignores an identical replay of the same measurement", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(observation([sample(ROW_A, BASE, 50)], { collectorRunId: "run-2" }));
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(1);
  });

  it("records an out-of-order different value as conflict evidence, never as a split step", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 50)], { collectorRunId: "run-2" }));

    db.recordCycle(observation([sample(ROW_A, BASE + 30_000, 40)], { collectorRunId: "run-3" }));
    let runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.remainingPercent).toBe(50);
    expect(runs[0]?.firstAtMs).toBe(BASE);
    expect(runs[0]?.lastAtMs).toBe(BASE + MINUTE);
    expect(runs[0]?.sampleCount).toBe(2);
    let slice = db.query({ startMs: BASE, endMs: BASE + MINUTE });
    expect(slice.conflicts).toEqual([
      {
        conflictId: expect.any(Number),
        seriesId: ROW_A,
        atMs: BASE + 30_000,
        remainingPercent: 40,
        existingRemainingPercent: 50,
        kind: "inside-run",
      },
    ]);

    // A replay of the conflicting sample is idempotent evidence.
    db.recordCycle(observation([sample(ROW_A, BASE + 30_000, 40)], { collectorRunId: "run-4" }));
    slice = db.query({ startMs: BASE, endMs: BASE + MINUTE });
    expect(slice.conflicts).toHaveLength(1);
    runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
  });

  it("does not count an interior replay of a compressed run as a new sample", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 50)], { collectorRunId: "run-2" }));
    db.recordCycle(observation([sample(ROW_A, BASE + 30_000, 50)], { collectorRunId: "run-3" }));
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(2);
    expect(runs[0]?.lastAtMs).toBe(BASE + MINUTE);
    expect(db.query({ startMs: BASE, endMs: BASE + MINUTE }).conflicts).toEqual([]);
  });

  it("treats same-time same-value reset-only differences as a duplicate observation", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80, { resetAtMs: BASE + 10 * MINUTE })], {
        collectorRunId: "run-1",
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80, { resetAtMs: BASE + 11 * MINUTE })], {
        collectorRunId: "run-2",
      }),
    );
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(1);
    expect(runs[0]?.resetAtMs).toBe(BASE + 10 * MINUTE);
    expect(db.query({ startMs: BASE, endMs: BASE + MINUTE }).conflicts).toEqual([]);
  });

  it("does not advance the success watermark on a replayed measurement", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80)], {
        collectorRunId: "run-1",
        attemptedAtMs: BASE,
      }),
    );
    db.recordCycle(
      observation([], {
        collectorRunId: "failed",
        attemptedAtMs: BASE + 30_000,
        interruptions: [
          { cardId: "card-a", providerId: "alpha", kind: "error", atMs: BASE + 30_000 },
        ],
      }),
    );
    // A cache replay returns the original measurement time under a new cycle id.
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80)], {
        collectorRunId: "replay",
        attemptedAtMs: BASE + MINUTE,
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 2 * MINUTE, 70)], {
        collectorRunId: "run-2",
        attemptedAtMs: BASE + 2 * MINUTE,
      }),
    );

    const runs = runsOf(db, ROW_A);
    expect(runs.map((run) => run.remainingPercent)).toEqual([80, 70]);
    // The failed attempt is still between the two genuine measurements, so the
    // following run is not continuously linked.
    expect(runs[1]?.linked).toBe(false);
  });

  it("never links across a recorded interruption inside the continuity tolerance", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80)], {
        collectorRunId: "run-1",
        attemptedAtMs: BASE,
      }),
    );
    db.recordCycle(
      observation([], {
        collectorRunId: "cooldown",
        attemptedAtMs: BASE + 30_000,
        interruptions: [
          { cardId: "card-a", providerId: "alpha", kind: "cooldown", atMs: BASE + 30_000 },
        ],
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 70)], {
        collectorRunId: "run-2",
        attemptedAtMs: BASE + MINUTE,
      }),
    );

    // One minute is inside the 2x poll-interval scheduling tolerance, but the
    // recorded cooldown is explicit evidence that the gap was not monitored.
    expect(runsOf(db, ROW_A).map((run) => run.linked)).toEqual([false, false]);
  });

  it("inserts a gap sample as an unlinked run and unlinks the following run", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 80)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 70)], { collectorRunId: "run-2" }));
    db.recordCycle(observation([sample(ROW_A, BASE + 30_000, 75)], { collectorRunId: "run-3" }));
    const runs = runsOf(db, ROW_A);
    expect(runs.map((run) => run.remainingPercent)).toEqual([80, 75, 70]);
    expect(runs.map((run) => run.linked)).toEqual([false, false, false]);
    expect(db.query({ startMs: BASE, endMs: BASE + MINUTE }).conflicts).toEqual([]);
  });

  it("keeps an earlier sample inserted after a later one", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 60)]));
    db.recordCycle(observation([sample(ROW_A, BASE, 80)], { collectorRunId: "run-2" }));
    const slice = db.query({ startMs: BASE, endMs: BASE + MINUTE });
    expect(slice.runs.map((run) => run.remainingPercent)).toEqual([80, 60]);
    expect(slice.series[0]?.firstAtMs).toBe(BASE);
    expect(slice.series[0]?.lastAtMs).toBe(BASE + MINUTE);
  });
});

describe("usage store: latest epoch reads", () => {
  it("returns only the newest epoch, using replenishment and reset evidence", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 90)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 80)], { collectorRunId: "run-2" }));
    db.recordCycle(
      observation([sample(ROW_A, BASE + 2 * MINUTE, 95)], { collectorRunId: "run-3" }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 3 * MINUTE, 90)], { collectorRunId: "run-4" }),
    );

    const beta = series(ROW_B, { providerLabel: "Beta" });
    db.recordCycle(
      observation(
        [
          sample(ROW_B, BASE, 50, {
            series: beta,
            resetAtMs: BASE + 30_000,
          }),
        ],
        { collectorRunId: "run-b1" },
      ),
    );
    db.recordCycle(
      observation(
        [
          sample(ROW_B, BASE + MINUTE, 50, {
            series: beta,
            resetAtMs: BASE + 90_000,
          }),
        ],
        { collectorRunId: "run-b2" },
      ),
    );

    const slice = db.queryLatestEpochs();
    const runsOf = (rowId: string) =>
      slice.runs.filter((run) => run.seriesId === rowId).map((run) => run.remainingPercent);
    expect(runsOf(ROW_A)).toEqual([95, 90]);
    expect(runsOf(ROW_B)).toEqual([50]);
    expect(slice.runs.find((run) => run.seriesId === ROW_B)?.firstAtMs).toBe(BASE + MINUTE);
    // The run that opened each latest epoch is returned as start evidence, not
    // as a displayed point.
    expect(slice.preceding.map((run) => [run.seriesId, run.remainingPercent])).toEqual([
      [ROW_A, 80],
      [ROW_B, 50],
    ]);
  });

  it("starts a new epoch when a passed reset has no successor reset evidence", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80, { resetAtMs: BASE + 2 * MINUTE })], {
        collectorRunId: "run-1",
      }),
    );
    // The known boundary at +2 min is in the past, and this reading carries no
    // reset of its own: whether it is still the same window is unknown.
    db.recordCycle(
      observation([sample(ROW_A, BASE + 5 * MINUTE, 60)], { collectorRunId: "run-2" }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 6 * MINUTE, 55)], { collectorRunId: "run-3" }),
    );

    const slice = db.queryLatestEpochs();
    expect(slice.runs.map((run) => run.remainingPercent)).toEqual([60, 55]);
    expect(slice.preceding.map((run) => run.remainingPercent)).toEqual([80]);
  });

  it("keeps one epoch while the known boundary has not passed", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80, { resetAtMs: BASE + 10 * MINUTE })], {
        collectorRunId: "run-1",
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 5 * MINUTE, 70)], { collectorRunId: "run-2" }),
    );

    const slice = db.queryLatestEpochs();
    expect(slice.runs.map((run) => run.remainingPercent)).toEqual([80, 70]);
    expect(slice.preceding).toEqual([]);
  });

  it("reports one presence span per card from its earliest evidence to its latest", async () => {
    const db = await store();
    const alphaB = series(ROW_B, { providerId: "alpha", providerLabel: "Alpha" });
    const dormantRow = "card-dormant#window:five_hour|quota:percent";
    const dormant = series(dormantRow, { providerId: "alpha", providerLabel: "Alpha" });
    const betaRow = "card-beta#window:five_hour|quota:percent";
    const beta = series(betaRow, { providerId: "beta", providerLabel: "Beta" });
    const betaImportRow = "codex-import:beta#window:five_hour|quota:percent";
    const betaImport = series(betaImportRow, {
      providerId: "beta",
      providerLabel: "Beta (imported)",
      source: "codex-import",
    });

    // Historical runs: the dormant account's latest epoch is far older.
    db.recordCycle(observation([sample(ROW_A, BASE, 80)], { collectorRunId: "history-a" }));
    db.recordCycle(
      observation([sample(ROW_B, BASE - 10 * MINUTE, 40, { series: alphaB })], {
        collectorRunId: "history-b",
      }),
    );
    db.recordCycle(
      observation([sample(dormantRow, BASE, 60, { series: dormant })], {
        collectorRunId: "history-dormant",
      }),
    );
    db.recordCycle(
      observation([sample(betaImportRow, BASE, 70, { series: betaImport })], {
        collectorRunId: "history-import",
      }),
    );
    // Displayed latest epochs: alpha has two live accounts; beta has one live
    // account and one imported series.
    db.recordCycle(
      observation([sample(ROW_A, BASE + 100 * MINUTE, 75)], { collectorRunId: "latest-a" }),
    );
    db.recordCycle(
      observation([sample(ROW_B, BASE + 100 * MINUTE, 55, { series: alphaB })], {
        collectorRunId: "latest-b",
      }),
    );
    db.recordCycle(
      observation([sample(betaRow, BASE + 100 * MINUTE, 65, { series: beta })], {
        collectorRunId: "latest-beta",
      }),
    );

    const slice = db.queryLatestEpochs();
    // A rival's presence starts at its earliest evidence, including history
    // that predates the displayed latest epoch (D8.1).
    expect(slice.presenceSpans).toContainEqual({
      cardId: "card-b",
      providerId: "alpha",
      firstAtMs: BASE - 10 * MINUTE,
      lastAtMs: BASE + 100 * MINUTE,
    });
    expect(slice.presenceSpans).toContainEqual({
      cardId: "card-dormant",
      providerId: "alpha",
      firstAtMs: BASE,
      lastAtMs: BASE,
    });
    // An imported series is never an OpenCode account presence.
    expect(slice.presenceSpans.every((span) => span.cardId !== "codex-import:beta")).toBe(true);
    expect(slice.presenceSpans.map((span) => span.cardId)).toEqual([
      "card-a",
      "card-b",
      "card-dormant",
      "card-beta",
    ]);
    // The span is whole-history even when the queried range is not.
    expect(
      db
        .query({ startMs: BASE + 100 * MINUTE, endMs: BASE + 100 * MINUTE })
        .presenceSpans.find((span) => span.cardId === "card-b")?.firstAtMs,
    ).toBe(BASE - 10 * MINUTE);
  });

  it("reports presence spans for failed-only cards and never for missing rows", async () => {
    const db = await store();
    // card-b never produces a sample, only a failed attempt.
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80)], {
        collectorRunId: "cycle-1",
        observedCards: [
          { cardId: "card-a", providerId: "alpha", atMs: BASE },
          { cardId: "card-b", providerId: "alpha", atMs: BASE },
        ],
        interruptions: [{ cardId: "card-b", providerId: "alpha", kind: "error", atMs: BASE }],
      }),
    );
    // card-a leaves the snapshot while its provider is still attempted.
    db.recordCycle(
      observation([], {
        collectorRunId: "cycle-2",
        nowMs: BASE + MINUTE,
        observedCards: [{ cardId: "card-b", providerId: "alpha", atMs: BASE + MINUTE }],
        providerIds: ["alpha"],
        interruptions: [
          { cardId: "card-b", providerId: "alpha", kind: "error", atMs: BASE + MINUTE },
        ],
      }),
    );

    const slice = db.query({ startMs: 0, endMs: BASE + MINUTE });
    expect(slice.interruptions.map((item) => [item.cardId, item.kind])).toEqual([
      ["card-b", "error"],
      ["card-a", "missing-row"],
    ]);
    expect(slice.presenceSpans).toEqual([
      { cardId: "card-a", providerId: "alpha", firstAtMs: BASE, lastAtMs: BASE },
      {
        cardId: "card-b",
        providerId: "alpha",
        firstAtMs: BASE,
        lastAtMs: BASE + MINUTE,
      },
    ]);
    // The latest-epoch read carries the same evidence, interruptions included.
    expect(db.queryLatestEpochs().presenceSpans).toEqual(slice.presenceSpans);
  });
});

describe("usage store: interruptions and missing rows", () => {
  it("records retained, cooldown and error cards as run-length compressed evidence", async () => {
    const db = await store();
    db.recordCycle(
      observation([], {
        observedCards: [{ cardId: "card-a", providerId: "alpha", atMs: BASE }],
        interruptions: [{ cardId: "card-a", providerId: "alpha", kind: "retained", atMs: BASE }],
      }),
    );
    db.recordCycle(
      observation([], {
        collectorRunId: "run-2",
        observedCards: [{ cardId: "card-a", providerId: "alpha", atMs: BASE + MINUTE }],
        interruptions: [
          { cardId: "card-a", providerId: "alpha", kind: "retained", atMs: BASE + MINUTE },
        ],
      }),
    );
    const slice = db.query({ startMs: 0, endMs: BASE + MINUTE });
    expect(slice.runs).toHaveLength(0);
    expect(slice.interruptions).toEqual([
      {
        interruptionId: expect.any(Number),
        cardId: "card-a",
        providerId: "alpha",
        kind: "retained",
        firstAtMs: BASE,
        lastAtMs: BASE + MINUTE,
        count: 2,
      },
    ]);
  });

  it("records a missing row for an observed card and a card dropped with its provider", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 80), sample(ROW_C, BASE, 70)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 75)], { collectorRunId: "run-2" }));

    const slice = db.query({ startMs: 0, endMs: BASE + MINUTE });
    const missing = slice.interruptions.filter((item) => item.kind === "missing-row");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.cardId).toBe("card-a");

    // The card disappears entirely while its provider is still attempted.
    db.recordCycle(
      observation([], {
        collectorRunId: "run-3",
        nowMs: BASE + 2 * MINUTE,
        providerIds: ["alpha"],
      }),
    );
    const second = db.query({ startMs: BASE + 2 * MINUTE, endMs: BASE + 2 * MINUTE });
    expect(second.interruptions).toHaveLength(1);
    expect(second.interruptions[0]?.kind).toBe("missing-row");
  });
});

describe("usage store: persistence and concurrent writers", () => {
  it("survives a restart without linking across the new collector session", async () => {
    const first = await store();
    first.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    first.close();

    const second = await openUsageStore(path);
    stores.push(second);
    second.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 50)], {
        collectorRunId: "run-2",
        collectorSessionId: "session-2",
      }),
    );
    const runs = runsOf(second, ROW_A);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.sampleCount).toBe(1);
    expect(runs[1]?.linked).toBe(false);
  });

  it("lets two connections write the same measurement idempotently", async () => {
    const first = await store();
    const second = await store();
    const shared = observation([sample(ROW_A, BASE, 50)]);
    first.recordCycle(shared);
    second.recordCycle(shared);
    second.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 50)], { collectorRunId: "run-2" }),
    );
    first.recordCycle(
      observation([sample(ROW_A, BASE + 2 * MINUTE, 50)], { collectorRunId: "run-3" }),
    );

    const verification = await store();
    const runs = runsOf(verification, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(3);
  });
});

describe("usage store: duplicate, interruption and identity policy", () => {
  it("makes a repeated per-cycle observation idempotent by cycle id", async () => {
    const db = await store();
    const cycle = observation([sample(ROW_A, BASE, 80)], { collectorRunId: "cycle-a" });
    db.recordCycle(cycle);
    db.recordCycle(cycle);
    expect(runsOf(db, ROW_A)[0]?.sampleCount).toBe(1);

    const interrupted = observation([], {
      collectorRunId: "cycle-b",
      observedCards: [{ cardId: "card-a", providerId: "alpha", atMs: BASE }],
      interruptions: [
        { cardId: "card-a", providerId: "alpha", kind: "retained", atMs: BASE + MINUTE },
      ],
    });
    db.recordCycle(interrupted);
    db.recordCycle(interrupted);
    const slice = db.query({ startMs: BASE, endMs: BASE + MINUTE });
    expect(slice.interruptions.find((item) => item.kind === "retained")?.count).toBe(1);
  });

  it("breaks a link after a failed attempt between two successes and ends spans on success", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 80)], { collectorRunId: "run-1" }));
    db.recordCycle(
      observation([], {
        collectorRunId: "run-2",
        nowMs: BASE + MINUTE,
        observedCards: [{ cardId: "card-a", providerId: "alpha", atMs: BASE }],
        interruptions: [
          { cardId: "card-a", providerId: "alpha", kind: "error", atMs: BASE + MINUTE },
        ],
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 2 * MINUTE, 70)], { collectorRunId: "run-3" }),
    );
    db.recordCycle(
      observation([], {
        collectorRunId: "run-4",
        nowMs: BASE + 3 * MINUTE,
        observedCards: [{ cardId: "card-a", providerId: "alpha", atMs: BASE }],
        interruptions: [
          { cardId: "card-a", providerId: "alpha", kind: "error", atMs: BASE + 3 * MINUTE },
        ],
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + 4 * MINUTE, 60)], { collectorRunId: "run-5" }),
    );

    const runs = runsOf(db, ROW_A);
    expect(runs.map((run) => run.remainingPercent)).toEqual([80, 70, 60]);
    expect(runs.map((run) => run.linked)).toEqual([false, false, false]);
    const errors = db
      .query({ startMs: BASE, endMs: BASE + 4 * MINUTE })
      .interruptions.filter((item) => item.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors.map((item) => [item.firstAtMs, item.lastAtMs])).toEqual([
      [BASE + MINUTE, BASE + MINUTE],
      [BASE + 3 * MINUTE, BASE + 3 * MINUTE],
    ]);
  });

  it("carries reset precision and tolerates estimated reset jitter in one run", async () => {
    const db = await store();
    const estimated = (minute: number, resetAtMs: number) =>
      sample(ROW_A, BASE + minute * MINUTE, 80, { resetAtMs, resetPrecision: "estimated" });
    db.recordCycle(observation([estimated(0, BASE + 60 * MINUTE)], { collectorRunId: "run-1" }));
    db.recordCycle(
      observation([estimated(1, BASE + 60 * MINUTE + 30_000)], { collectorRunId: "run-2" }),
    );
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(2);
    expect(runs[0]?.reset_precision).toBe("estimated");
    expect(runs[0]?.resetAtMs).toBe(BASE + 60 * MINUTE + 30_000);
  });

  it("treats a capacity change as an identity boundary", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80, { capacityKey: "limit:100:req" })], {
        collectorRunId: "run-1",
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 80, { capacityKey: "limit:200:req" })], {
        collectorRunId: "run-2",
      }),
    );
    const runs = runsOf(db, ROW_A);
    expect(runs.map((run) => run.capacityKey)).toEqual(["limit:100:req", "limit:200:req"]);
    expect(runs[1]?.linked).toBe(true);
  });

  it("keeps newer series metadata when a late sample arrives", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE + MINUTE, 80, { series: series(ROW_A, { label: "New" }) })], {
        collectorRunId: "run-1",
      }),
    );
    db.recordCycle(
      observation([sample(ROW_A, BASE, 70, { series: series(ROW_A, { label: "Old" }) })], {
        collectorRunId: "run-2",
      }),
    );
    const info = db.query({ startMs: BASE, endMs: BASE + MINUTE }).series[0];
    expect(info?.label).toBe("New");
    expect(info?.firstAtMs).toBe(BASE);
    expect(info?.lastAtMs).toBe(BASE + MINUTE);
  });

  it("scopes missing-row evidence to cards observed in the same collector session", async () => {
    const db = await store();
    db.recordCycle(
      observation([sample(ROW_A, BASE, 80)], {
        collectorRunId: "session-1-run",
        collectorSessionId: "session-1",
      }),
    );
    // A different collector/credential scope sees another card and must not
    // report the first session's card as missing.
    db.recordCycle(
      observation([sample(ROW_B, BASE + MINUTE, 70, { series: series(ROW_B) })], {
        collectorRunId: "session-2-run",
        collectorSessionId: "session-2",
        observedCards: [{ cardId: "card-b", providerId: "alpha", atMs: BASE + MINUTE }],
        providerIds: ["alpha"],
      }),
    );
    const missing = db
      .query({ startMs: BASE, endMs: BASE + MINUTE })
      .interruptions.filter((item) => item.kind === "missing-row");
    expect(missing).toEqual([]);
  });

  it("makes repeated Codex rate-limit imports idempotent", async () => {
    const db = await store();
    const point = {
      atMs: BASE,
      window: "primary" as const,
      windowMinutes: 300,
      usedPercent: 20,
      planType: "pro",
    };
    db.recordCodexRateLimitObservations([point]);
    db.recordCodexRateLimitObservations([point]);
    const slice = db.query({ startMs: BASE, endMs: BASE + MINUTE });
    const codex = slice.runs.filter((run) => run.seriesId.startsWith("codex-import:"));
    expect(codex).toHaveLength(1);
    expect(codex[0]?.sampleCount).toBe(1);
    expect(
      slice.series.find((item) => item.rowId === codex[0]?.seriesId)?.planLabel,
    ).toBeUndefined();
  });
});

describe("usage store: imported Codex account isolation", () => {
  const FIVE_HOUR = "window:five_hour";
  const SPAN = { startMs: 0, endMs: BASE + 24 * 60 * MINUTE };

  function importedRuns(db: UsageStore) {
    return db.query(SPAN).runs.filter((run) => run.seriesId.startsWith("codex-import:"));
  }

  function importedSeries(db: UsageStore) {
    return db.query(SPAN).series.filter((series) => series.source === "codex-import");
  }

  it("scopes identity-less readings to the session they came from", async () => {
    const db = await store();
    db.recordCodexRateLimitObservations([
      {
        atMs: BASE,
        window: "primary",
        windowMinutes: 300,
        usedPercent: 20,
        threadKey: "thread-1",
      },
      {
        atMs: BASE + MINUTE,
        window: "primary",
        windowMinutes: 300,
        usedPercent: 60,
        threadKey: "thread-2",
      },
    ]);

    // Two sessions with no account identity must never become one quota series:
    // their readings are unrelated measurements, not one account's trajectory.
    expect(
      importedSeries(db)
        .map((series) => series.cardId)
        .sort(),
    ).toEqual(["codex-import:unknown:thread-1", "codex-import:unknown:thread-2"]);
    expect(importedRuns(db).map((run) => run.remainingPercent)).toEqual([80, 40]);
    const first = importedRuns(db).find((run) =>
      run.seriesId.startsWith("codex-import:unknown:thread-1"),
    );
    expect(first?.seriesId).toBe(`codex-import:unknown:thread-1#${FIVE_HOUR}`);
  });

  it("keeps an account switch inside one import in separate series", async () => {
    const db = await store();
    db.recordCodexRateLimitObservations([
      { atMs: BASE, window: "primary", windowMinutes: 300, usedPercent: 10, accountHint: "acct-a" },
      {
        atMs: BASE + MINUTE,
        window: "primary",
        windowMinutes: 300,
        usedPercent: 30,
        threadKey: "thread-x",
      },
      {
        atMs: BASE + 2 * MINUTE,
        window: "primary",
        windowMinutes: 300,
        usedPercent: 80,
        accountHint: "acct-b",
      },
    ]);

    expect(
      importedSeries(db)
        .map((series) => series.cardId)
        .sort(),
    ).toEqual(["codex-import:acct-a", "codex-import:acct-b", "codex-import:unknown:thread-x"]);
    // One reading each: the derivation has no pair of unrelated readings that
    // could become a measured consumption interval.
    for (const series of importedSeries(db)) {
      const runs = importedRuns(db).filter((run) => run.seriesId === series.rowId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.sampleCount).toBe(1);
    }
  });

  it("keeps the account-hinted rowId stable for existing history", async () => {
    const db = await store();
    db.recordCodexRateLimitObservations([
      {
        atMs: BASE,
        window: "primary",
        windowMinutes: 300,
        usedPercent: 20,
        accountHint: "acct-a",
        threadKey: "thread-1",
        planType: "pro",
      },
    ]);
    // Golden id: an account-hinted reading keeps `codex-import:<account>`.
    expect(importedSeries(db).map((series) => series.rowId)).toEqual([
      `codex-import:acct-a#${FIVE_HOUR}`,
    ]);
  });

  it("re-imports an identity-less batch idempotently", async () => {
    const db = await store();
    const batch = [
      {
        atMs: BASE,
        window: "primary" as const,
        windowMinutes: 300,
        usedPercent: 20,
        threadKey: "thread-1",
      },
      {
        atMs: BASE + MINUTE,
        window: "primary" as const,
        windowMinutes: 300,
        usedPercent: 25,
        threadKey: "thread-1",
      },
    ];
    db.recordCodexRateLimitObservations(batch);
    db.recordCodexRateLimitObservations(batch);

    const runs = importedRuns(db);
    expect(runs.map((run) => run.remainingPercent)).toEqual([80, 75]);
    expect(runs.map((run) => run.sampleCount)).toEqual([1, 1]);
    expect(importedSeries(db)).toHaveLength(1);
  });
});

describe("usage recorder: live capture, exclusions and measurement identity", () => {
  it("records only live cycles and prefers provider observation time", async () => {
    const db = await store();
    const observedAt = new Date(BASE).toISOString();
    const value = live(
      snapshot([
        card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)], {
          observedAtIso: observedAt,
        }),
      ]),
      new Map([["card-a", BASE + 5 * MINUTE]]),
    );
    const recorder = createUsageRecorder({ store: db, now: () => BASE });
    recorder.observe(value);
    await recorder.flush();

    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.firstAtMs).toBe(BASE);

    // A cached replay of the same live payload is not a live observation.
    recorder.observe(
      snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 70)])]),
    );
    await recorder.flush();
    expect(runsOf(db, ROW_A)).toHaveLength(1);
  });

  it("notifies after an import opportunity completes", async () => {
    const db = await store();
    let notified = 0;
    const recorder = createUsageRecorder({
      store: db,
      now: () => BASE,
      loadImportSettings: async () => ({ claudeCode: false, codex: false }),
      onActivityImported: () => {
        notified += 1;
      },
    });
    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
        new Map([["card-a", BASE]]),
      ),
    );
    await recorder.flush();
    expect(notified).toBe(1);
    await recorder.close();
  });

  it("marks Cursor as locally estimated", async () => {
    const db = await store();
    const cursorCard = card("card-cursor", [row("card-cursor", "window:day|quota:percent", 60)], {
      providerId: "cursor",
      providerLabel: "Cursor",
    });
    const value = live(snapshot([cursorCard]), new Map([["card-cursor", BASE]]));
    const recorder = createUsageRecorder({ store: db, now: () => BASE });
    recorder.observe(value);
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + MINUTE });
    expect(slice.series[0]?.measurement).toBe("locally-estimated");
  });

  it("excludes retained, cooldown and retry-after cards and breaks continuity", async () => {
    const db = await store();
    const recorder = createUsageRecorder({ store: db, now: () => BASE });
    const rowKey = "window:five_hour|quota:percent";
    const measured = (minute: number) => new Map([["card-a", BASE + minute * MINUTE]]);

    recorder.observe(live(snapshot([card("card-a", [row("card-a", rowKey, 80)])]), measured(0)));
    await recorder.flush();

    recorder.observe(
      live(
        snapshot(
          [
            card("card-a", [row("card-a", rowKey, 80)], {
              stale: true,
            }),
          ],
          { stale: true },
        ),
        measured(1),
      ),
    );
    await recorder.flush();

    recorder.observe(
      live(
        snapshot([
          card("card-a", [row("card-a", rowKey, 80)], {
            errors: [
              {
                label: "Alpha",
                message: "Rate limited",
                retryAtMs: BASE + 10 * MINUTE,
                attemptOutcome: "cooldown",
              },
            ],
          }),
        ]),
        measured(2),
      ),
    );
    await recorder.flush();

    recorder.observe(
      live(
        snapshot([
          card("card-a", [row("card-a", rowKey, 80)], {
            errors: [
              {
                label: "Alpha",
                message: "Unavailable",
                retryable: true,
                retryAtMs: BASE + 20 * MINUTE,
              },
            ],
          }),
        ]),
        measured(3),
      ),
    );
    await recorder.flush();

    recorder.observe(live(snapshot([card("card-a", [row("card-a", rowKey, 70)])]), measured(4)));
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + 5 * MINUTE });
    expect(slice.runs.map((run) => run.remainingPercent)).toEqual([80, 70]);
    expect(slice.runs[1]?.linked).toBe(false);
    expect(slice.interruptions.map((item) => item.kind)).toEqual(["retained", "cooldown", "error"]);
  });

  it("stores provider/row labels but never account or plan labels", async () => {
    const db = await store();
    const value = live(
      snapshot([
        card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)], {
          providerLabel: "Alpha",
          accountLabel: "work@example.com",
          planLabel: "Pro",
        }),
      ]),
      new Map([["card-a", BASE]]),
    );
    const recorder = createUsageRecorder({ store: db, now: () => BASE });
    recorder.observe(value);
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + MINUTE });
    expect(slice.series[0]).toMatchObject({
      providerLabel: "Alpha",
      label: "Quota",
    });
    expect(slice.series[0]?.accountLabel).toBeUndefined();
    expect(slice.series[0]?.planLabel).toBeUndefined();
    expect(JSON.stringify(slice)).not.toContain("work@example.com");
    expect(JSON.stringify(slice)).not.toContain("Pro");

    const reader = await openOpenCodeSqliteReadOnly(path);
    try {
      const stored = reader.get<{ account_label: string | null; plan_label: string | null }>(
        "SELECT account_label, plan_label FROM usage_series",
      );
      expect(stored).toEqual({ account_label: null, plan_label: null });
      const columnsOf = (table: string): string[] =>
        reader
          .all<{ name: string }>(`PRAGMA table_info(${table})`)
          .map((column) => column.name)
          .sort();
      expect(columnsOf("usage_series")).toEqual(
        [
          "account_label",
          "card_id",
          "first_at_ms",
          "label",
          "last_at_ms",
          "measurement",
          "metric_json",
          "plan_label",
          "provider_id",
          "provider_label",
          "row_key",
          "series_id",
          "source",
        ].sort(),
      );
      expect(columnsOf("usage_runs")).toEqual(
        [
          "attempted_at_ms",
          "capacity_key",
          "collector_interval_ms",
          "collector_run_id",
          "collector_session_id",
          "first_at_ms",
          "last_at_ms",
          "linked",
          "quantity_decimal",
          "quantity_unit_json",
          "remaining_percent",
          "reset_at_ms",
          "reset_precision",
          "run_id",
          "sample_count",
          "series_id",
        ].sort(),
      );
      expect(columnsOf("usage_conflicts")).toEqual(
        [
          "at_ms",
          "collector_run_id",
          "collector_session_id",
          "conflict_id",
          "existing_remaining_percent",
          "kind",
          "remaining_percent",
          "series_id",
        ].sort(),
      );
      expect(columnsOf("usage_interruptions")).toEqual(
        [
          "card_id",
          "collector_session_id",
          "count",
          "first_at_ms",
          "interruption_id",
          "kind",
          "last_at_ms",
          "provider_id",
        ].sort(),
      );
    } finally {
      reader.close();
    }
  });

  it("rejects an unmarked success and is idempotent on close", async () => {
    const db = await store();
    const logs: string[] = [];
    const recorder = createUsageRecorder({
      store: db,
      now: () => BASE,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });
    recorder.observe(
      markQuotaObservationLive(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
      ),
    );
    await recorder.flush();
    expect(runsOf(db, ROW_A)).toHaveLength(0);
    expect(logs.some((line) => line.includes("measurement-unmarked"))).toBe(true);

    const first = recorder.close();
    const second = recorder.close();
    expect(second).toBe(first);
    await first;
  });

  it("drains an admitted observation when close starts before it reaches the store", async () => {
    const recorded: UsageCycleObservation[] = [];
    const fake = {
      path: "memory",
      recordCycle(value: UsageCycleObservation) {
        recorded.push(value);
      },
      close() {},
    } as unknown as UsageStore;
    const recorder = createUsageRecorder({ store: fake, now: () => BASE });
    const epoch = recorder.epoch();
    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
        new Map([["card-a", BASE]]),
      ),
    );

    // Closing stops new admissions but must not disown the cycle that was
    // already admitted, nor change the owner epoch.
    const closing = recorder.close();
    expect(recorder.epoch()).toBe(epoch);
    await closing;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.samples[0]?.remainingPercent).toBe(80);

    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 70)])]),
        new Map([["card-a", BASE + MINUTE]]),
      ),
    );
    await recorder.flush();
    expect(recorded).toHaveLength(1);
  });
});

describe("usage recorder: store recovery and lock carry-over", () => {
  it("retains cycles across a failed store open and retries on a later observation", async () => {
    const logs: string[] = [];
    const nested = join(root, "not-yet", "usage-history.sqlite");
    // A directory at the DB path makes the first open fail deterministically.
    await mkdir(nested, { recursive: true });
    const recorder = createUsageRecorder({
      path: nested,
      now: () => BASE,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });

    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
        new Map([["card-a", BASE]]),
      ),
    );
    await recorder.flush();
    expect(logs.some((line) => line.includes("store-unavailable"))).toBe(true);

    await rm(nested, { recursive: true, force: true });
    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 70)])]),
        new Map([["card-a", BASE + MINUTE]]),
      ),
    );
    await recorder.flush();
    expect(existsSync(nested)).toBe(true);
    const opened = await openUsageStore(nested);
    stores.push(opened);
    // Read-only history opens must never inherit the 5 s writer default.
    expect(USAGE_READ_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(250);
    const reader = await openOpenCodeSqliteReadOnly(nested, {
      busyTimeoutMs: USAGE_READ_BUSY_TIMEOUT_MS,
    });
    expect(reader.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({
      timeout: USAGE_READ_BUSY_TIMEOUT_MS,
    });
    reader.close();
    // Both queued cycles are drained in order; the failed open lost nothing.
    expect(runsOf(opened, ROW_A).map((run) => run.remainingPercent)).toEqual([80, 70]);
    await recorder.close();
  });

  it("carries a cycle over after a write lock and records it on the next observation", async () => {
    const recorded: UsageCycleObservation[] = [];
    let failures = 2;
    const fake = {
      path: "memory",
      recordCycle(value: UsageCycleObservation) {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        recorded.push(value);
      },
      close() {},
    } as unknown as UsageStore;
    const recorder = createUsageRecorder({ store: fake, now: () => BASE });

    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
        new Map([["card-a", BASE]]),
      ),
    );
    // The first write and the flush retry both hit the lock: bounded carry-over.
    await recorder.flush();
    expect(recorded).toHaveLength(0);

    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 70)])]),
        new Map([["card-a", BASE + MINUTE]]),
      ),
    );
    await recorder.flush();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.samples[0]?.remainingPercent).toBe(80);
    expect(recorded[1]?.samples[0]?.remainingPercent).toBe(70);
    await recorder.close();
  });

  it("commits several polls in order after one held write lock is released", async () => {
    const recorded: UsageCycleObservation[] = [];
    let locked = true;
    const fake = {
      path: "memory",
      recordCycle(value: UsageCycleObservation) {
        if (locked) {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        recorded.push(value);
      },
      close() {},
    } as unknown as UsageStore;
    const logs: string[] = [];
    const recorder = createUsageRecorder({
      store: fake,
      now: () => BASE,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });

    for (const [minute, remaining] of [
      [0, 80],
      [1, 70],
      [2, 60],
    ] as const) {
      recorder.observe(
        live(
          snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", remaining)])]),
          new Map([["card-a", BASE + minute * MINUTE]]),
        ),
      );
    }
    await recorder.flush();
    expect(recorded).toHaveLength(0);
    expect(logs.some((line) => line.includes("write-busy"))).toBe(true);

    locked = false;
    await recorder.flush();
    expect(recorded.map((cycle) => cycle.samples[0]?.remainingPercent)).toEqual([80, 70, 60]);
    await recorder.close();
  });

  it("discards cycles queued before a source-owner handoff", async () => {
    const recorded: UsageCycleObservation[] = [];
    let locked = true;
    const fake = {
      path: "memory",
      recordCycle(value: UsageCycleObservation) {
        if (locked) {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        recorded.push(value);
      },
      close() {},
    } as unknown as UsageStore;
    const logs: string[] = [];
    const recorder = createUsageRecorder({
      store: fake,
      now: () => BASE,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });

    recorder.observe(
      live(
        snapshot([card("card-a", [row("card-a", "window:five_hour|quota:percent", 80)])]),
        new Map([["card-a", BASE]]),
      ),
    );
    // Let the capture enqueue and hit the held lock before the handoff.
    await recorder.flush();
    recorder.sourceChanged();
    locked = false;
    await recorder.flush();
    expect(recorded).toHaveLength(0);
    expect(logs.some((line) => line.includes("carry-over-handoff"))).toBe(true);
    await recorder.close();
  });
});
