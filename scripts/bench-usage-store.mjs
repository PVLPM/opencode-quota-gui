#!/usr/bin/env node
/**
 * Usage-history read/write micro-benchmark: 200,000 stored runs over 4 series.
 *
 * The store never deletes (D1), so long histories must stay fast. This seeds
 * one synthetic year-plus of alternating samples through the public store API
 * and measures the write path, a full-lifetime read and a 24h range read.
 *
 * Usage:
 *   pnpm exec tsc
 *   node scripts/bench-usage-store.mjs
 *   node scripts/bench-usage-store.mjs --json
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleRoot = join(repoRoot, "dist", "lib");
const { openUsageStore } = await import(pathToFileURL(join(moduleRoot, "usage-store.js")).href);

const BASE = Date.parse("2025-01-01T00:00:00.000Z");
const MINUTE = 60_000;
const SERIES_COUNT = 4;
const SAMPLES_PER_SERIES_PER_CYCLE = 25;
const CYCLES = 2_000;
const TOTAL_RUNS = SERIES_COUNT * SAMPLES_PER_SERIES_PER_CYCLE * CYCLES;

function series(index) {
  const cardId = `card-${index}`;
  return {
    rowId: `${cardId}#window:five_hour|quota:percent`,
    cardId,
    rowKey: "window:five_hour|quota:percent",
    providerId: `provider-${index}`,
    providerLabel: `Provider ${index}`,
    label: "5h",
    measurement: "provider-observed",
    source: "opencode-poll",
    firstAtMs: 0,
    lastAtMs: 0,
  };
}

const root = await mkdtemp(join(tmpdir(), "ocq-usage-bench-"));
const path = join(root, "usage-history.sqlite");
let store;
try {
  store = await openUsageStore(path);
  const seriesList = Array.from({ length: SERIES_COUNT }, (_, index) => series(index));
  const samplesPerCycle = SERIES_COUNT * SAMPLES_PER_SERIES_PER_CYCLE;

  const seedStart = performance.now();
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const samples = [];
    for (let position = 0; position < samplesPerCycle; position += 1) {
      const seriesIndex = position % SERIES_COUNT;
      const step = Math.floor(position / SERIES_COUNT);
      const index = cycle * SAMPLES_PER_SERIES_PER_CYCLE + step;
      samples.push({
        series: seriesList[seriesIndex],
        measuredAtMs: BASE + index * MINUTE,
        remainingPercent: 90 - (index % 4) * 10,
      });
    }
    store.recordCycle({
      collectorRunId: `run-${cycle}`,
      collectorSessionId: "bench-session",
      intervalMs: MINUTE,
      observedCards: seriesList.map((item) => ({
        cardId: item.cardId,
        providerId: item.providerId,
        atMs: BASE,
      })),
      providerIds: seriesList.map((item) => item.providerId),
      samples,
      interruptions: [],
      nowMs: BASE + cycle * MINUTE,
    });
  }
  const writeMs = performance.now() - seedStart;

  // One dormant account in an existing provider: its only run is old, so a
  // naive Current rival scan starts at the epoch and walks the whole history.
  const dormantSeries = {
    ...series(0),
    rowId: "card-dormant#window:five_hour|quota:percent",
    cardId: "card-dormant",
    providerLabel: "Provider 0",
  };
  store.recordCycle({
    collectorRunId: "run-dormant",
    collectorSessionId: "bench-session",
    intervalMs: MINUTE,
    observedCards: [{ cardId: dormantSeries.cardId, providerId: "provider-0", atMs: BASE }],
    providerIds: ["provider-0"],
    samples: [{ series: dormantSeries, measuredAtMs: BASE, remainingPercent: 50 }],
    interruptions: [],
    nowMs: BASE,
  });

  const lifetimeStart = performance.now();
  const lifetime = store.query({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
  const lifetimeQueryMs = performance.now() - lifetimeStart;

  const lastEnd = BASE + CYCLES * SAMPLES_PER_SERIES_PER_CYCLE * MINUTE;
  const dayStart = performance.now();
  const day = store.query({ startMs: lastEnd - 24 * 60 * MINUTE, endMs: lastEnd });
  const range24hQueryMs = performance.now() - dayStart;

  const currentStart = performance.now();
  const current = store.queryLatestEpochs();
  const currentQueryMs = performance.now() - currentStart;

  if (lifetime.runs.length !== TOTAL_RUNS + 1) {
    throw new Error(`expected ${TOTAL_RUNS + 1} runs, got ${lifetime.runs.length}`);
  }
  if (lifetime.series.length !== SERIES_COUNT + 1) {
    throw new Error(`expected ${SERIES_COUNT + 1} series, got ${lifetime.series.length}`);
  }
  if (day.runs.length === 0 || day.runs.length >= TOTAL_RUNS) {
    throw new Error(`unexpected 24h range run count ${day.runs.length}`);
  }
  if (current.series.length !== SERIES_COUNT + 1) {
    throw new Error(`unexpected Current series count ${current.series.length}`);
  }

  const result = {
    runs: TOTAL_RUNS,
    series: SERIES_COUNT,
    writeMs: Math.round(writeMs),
    lifetimeQueryMs: Number(lifetimeQueryMs.toFixed(1)),
    range24hQueryMs: Number(range24hQueryMs.toFixed(1)),
    currentQueryMs: Number(currentQueryMs.toFixed(1)),
    currentRivalRuns: current.rivalRuns?.length ?? 0,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `[usage-store bench] runs=${result.runs} series=${result.series} ` +
        `writeMs=${result.writeMs} lifetimeQueryMs=${result.lifetimeQueryMs} ` +
        `range24hQueryMs=${result.range24hQueryMs} currentQueryMs=${result.currentQueryMs} ` +
        `currentRivalRuns=${result.currentRivalRuns}`,
    );
  }
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true });
}
