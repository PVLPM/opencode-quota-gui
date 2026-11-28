/**
 * The official Antigravity CLI names no account, so its Usage history can never
 * prove two measurements came from the same subscription. An account switch
 * between polls must not become observed consumption; observations stay.
 * The Google AGY companion keeps its own (account-scoped) behavior.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UsageRangeKey } from "../src/contracts/usage.js";
import type { UsageActivityQuery } from "../src/contracts/usage-activity.js";
import { createUsageSnapshotBuilder } from "../src/gui/usage-service.js";
import { hasUnconfirmedUsageAccountContinuity } from "../src/lib/provider-metadata.js";
import { buildCardId, buildProviderScopeCardId } from "../src/lib/quota-identity.js";
import {
  openUsageStore,
  type UsageSeriesMetadata,
  type UsageStore,
} from "../src/lib/usage-store.js";

const BASE = Date.parse("2026-05-01T00:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number): number => BASE + minutes * MINUTE;

let root: string;
let stores: UsageStore[];
let runSequence: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocq-usage-agy-cli-"));
  stores = [];
  runSequence = 0;
});

afterEach(async () => {
  for (const store of stores) store.close();
  await rm(root, { recursive: true, force: true });
});

async function store(): Promise<UsageStore> {
  const opened = await openUsageStore(join(root, "usage-history.sqlite"));
  stores.push(opened);
  return opened;
}

function agyCliSeries(): UsageSeriesMetadata {
  const cardId = buildProviderScopeCardId("antigravity-cli");
  const rowKey = "named:gemini-weekly";
  return {
    rowId: `${cardId}#${rowKey}`,
    cardId,
    rowKey,
    providerId: "antigravity-cli",
    providerLabel: "Antigravity CLI",
    label: "Weekly",
    measurement: "provider-observed",
    source: "opencode-poll",
  };
}

function googleAgySeries(): UsageSeriesMetadata {
  const cardId = buildCardId("google-agy", "account-a");
  const rowKey = "window:week|quota:percent";
  return {
    rowId: `${cardId}#${rowKey}`,
    cardId,
    rowKey,
    providerId: "google-agy",
    providerLabel: "Google AGY",
    label: "Weekly",
    metricJson: JSON.stringify({ kind: "window", window: "week" }),
    measurement: "provider-observed",
    source: "opencode-poll",
  };
}

function record(
  db: UsageStore,
  atMs: number,
  series: UsageSeriesMetadata,
  remaining: number,
  resetAtMs?: number,
): void {
  db.recordCycle({
    collectorRunId: `run-${runSequence}`,
    collectorSessionId: "session-1",
    intervalMs: MINUTE,
    observedCards: [{ cardId: series.cardId, providerId: series.providerId, atMs }],
    providerIds: [series.providerId],
    samples: [
      {
        series,
        remainingPercent: remaining,
        measuredAtMs: atMs,
        ...(resetAtMs !== undefined ? { resetAtMs, resetPrecision: "exact" as const } : {}),
      },
    ],
    interruptions: [],
    nowMs: atMs,
  });
  runSequence += 1;
}

async function windowFor(db: UsageStore, range: UsageRangeKey) {
  const snapshot = await createUsageSnapshotBuilder({
    store: db,
    now: () => at(10),
    timeZone: "UTC",
    activity: async (query: UsageActivityQuery) => ({
      intervals: query.intervals.map((interval) => ({
        startMs: interval.startMs,
        endMs: interval.endMs,
        entries: [],
        incomplete: false,
        unpricedTokens: 0,
        unknownTokens: 0,
      })),
      coverage: { complete: true, stale: false },
    }),
  }).usage({ range });
  expect(snapshot.accounts).toHaveLength(1);
  return snapshot.accounts[0]?.windows[0];
}

describe("usage history: Antigravity CLI account continuity", () => {
  it("is declared by registration for the official CLI only", () => {
    expect(hasUnconfirmedUsageAccountContinuity("antigravity-cli")).toBe(true);
    expect(hasUnconfirmedUsageAccountContinuity("agy")).toBe(true);
    expect(hasUnconfirmedUsageAccountContinuity("google-agy")).toBe(false);
  });

  // Account A reads 90%, then the CLI is signed in to account B (40%), then
  // account B is used down to 30%. Nothing in the output names either account.
  for (const variant of [
    { name: "absent reset timestamps", resetAtMs: undefined },
    { name: "identical reset timestamps", resetAtMs: at(7 * 24 * 60) },
  ]) {
    it(`never reads an account switch as consumption with ${variant.name}`, async () => {
      const db = await store();
      const series = agyCliSeries();
      record(db, at(0), series, 90, variant.resetAtMs);
      record(db, at(1), series, 90, variant.resetAtMs);
      record(db, at(2), series, 40, variant.resetAtMs);
      record(db, at(3), series, 30, variant.resetAtMs);

      for (const range of ["lifetime", "current"] as const) {
        const window = await windowFor(db, range);
        // Every observation is preserved...
        expect(window?.points.map((point) => point.remainingPercent)).toEqual([90, 40, 30]);
        // ...but no drop between measurements is claimed as consumption.
        expect(window?.links).toEqual([
          { kind: "boundary", boundary: "uncertain" },
          { kind: "boundary", boundary: "uncertain" },
        ]);
        expect(
          window?.intervals.filter((interval) => (interval.burnPercentPoints ?? 0) > 0),
        ).toEqual([]);
        expect(window?.totals.observedBurnPercentPoints).toBe(0);
        expect(window?.totals.attributedBurnPercentPoints).toBe(0);
      }
    });
  }

  it("keeps the Google AGY companion's account-scoped consumption unchanged", async () => {
    const db = await store();
    const series = googleAgySeries();
    record(db, at(0), series, 90);
    record(db, at(1), series, 40);
    record(db, at(2), series, 30);

    const window = await windowFor(db, "lifetime");
    expect(window?.links).toEqual([{ kind: "observed" }, { kind: "observed" }]);
    expect(window?.totals.observedBurnPercentPoints).toBe(60);
  });
});
