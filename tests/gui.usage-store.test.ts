/**
 * Usage observation store and recorder (v1.4.0 workstream B).
 *
 * Covers genuine-measurement identity, run extension and continuity, exclusion
 * of retained/cooldown/error cycles, restart and concurrent-writer behaviour,
 * out-of-order splitting, missing-row evidence and the privacy-safe schema.
 */
import { mkdtemp, rm } from "node:fs/promises";
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

  it("counts an out-of-order same-value sample without moving run endpoints", async () => {
    const db = await store();
    db.recordCycle(observation([sample(ROW_A, BASE, 50)]));
    db.recordCycle(observation([sample(ROW_A, BASE + MINUTE, 50)], { collectorRunId: "run-2" }));
    db.recordCycle(observation([sample(ROW_A, BASE + 30_000, 50)], { collectorRunId: "run-3" }));
    const runs = runsOf(db, ROW_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sampleCount).toBe(3);
    expect(runs[0]?.lastAtMs).toBe(BASE + MINUTE);
    expect(db.query({ startMs: BASE, endMs: BASE + MINUTE }).conflicts).toEqual([]);
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
});
