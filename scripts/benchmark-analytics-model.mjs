#!/usr/bin/env node
/**
 * Model-only analytics memory benchmark.
 *
 * Measures retained heap for the rollup model alone over deterministic
 * synthetic rows: 32,000 and 128,000 completed assistant rows. Rows are
 * generated lazily from an index, so the benchmark never retains an input
 * array. Every sample calls `global.gc()` twice; pricing is warmed in a
 * disposable model first so a lazy models.dev snapshot does not land inside
 * the measured baseline.
 *
 * Saved rows include a fixed fork-copy pattern: every 16th block repeats one
 * fingerprint in four sessions, exercising deterministic ownership without
 * changing the per-row workload.
 *
 * Output is anonymous aggregate bytes/timings only. No real data is read.
 *
 * Usage:
 *   node scripts/benchmark-analytics-model.mjs
 *   node scripts/benchmark-analytics-model.mjs --model dist/gui/analytics-model.js --json
 *   node scripts/benchmark-analytics-model.mjs --sizes 32000,128000
 *
 * The script relaunches itself with `--expose-gc` when needed.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

if (typeof globalThis.gc !== "function" && process.env.OCQ_MODEL_BENCH_GC !== "1") {
  const child = spawnSync(process.execPath, ["--expose-gc", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, OCQ_MODEL_BENCH_GC: "1" },
  });
  process.exit(child.status ?? 1);
}
if (typeof globalThis.gc !== "function") {
  console.error("analytics model benchmark requires --expose-gc");
  process.exit(2);
}

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const PROVIDERS = [
  ["openai", "gpt-5"],
  ["anthropic", "claude-sonnet-4-5"],
  ["google", "gemini-2.5-pro"],
  ["xai", "grok-4"],
];
const PROJECT_COUNT = 7;
const FORK_BLOCK = 16;
const FORK_COPIES = 4;

function parseArgs(argv) {
  const options = {
    modelPath: "dist/gui/analytics-model.js",
    sizes: [32_000, 128_000],
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--model") {
      options.modelPath = argv[index + 1] ?? options.modelPath;
      index += 1;
    } else if (arg === "--sizes") {
      options.sizes = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      index += 1;
    }
  }
  if (options.sizes.length === 0) options.sizes = [32_000, 128_000];
  return options;
}

function sessionCountFor(rows) {
  return rows >= 128_000 ? 420 : 210;
}

function sessionId(index) {
  return `ses_${index.toString(36)}`;
}

/**
 * One deterministic physical row. Indexes in the first three slots of every
 * block are fork copies of that block's first row: same fingerprint, different
 * session and message id. All other rows are unique because `cost` carries the
 * source index into the fingerprint.
 */
function rowAt(index, sessions) {
  const blockStart = index - (index % FORK_BLOCK);
  const copy = index % FORK_BLOCK;
  const isCopy = copy > 0 && copy < FORK_COPIES;
  const source = isCopy ? blockStart : index;
  const sessionIndex = isCopy ? (blockStart + copy * 97) % sessions : index % sessions;
  const provider = PROVIDERS[source % PROVIDERS.length];
  const createdAtMs = NOW - ((source * 37) % (45 * 24)) * HOUR_MS - (source % 11) * 60_000;
  const completedAtMs = createdAtMs + 20_000 + (source % 7) * 1_000;
  return {
    sessionID: sessionId(sessionIndex),
    messageID: isCopy ? `msg_${index.toString(36)}` : `msg_${source.toString(36)}`,
    createdAtMs,
    completedAtMs,
    tokens: {
      input: 100 + (source % 9_973),
      output: 10 + (source % 101),
      reasoning: source % 17,
      cacheRead: (source % 4_093) * 7,
      cacheWrite: source % 19,
    },
    cost: source,
    providerID: provider[0],
    modelID: provider[1],
  };
}

function* rowsBetween(start, end, sessions, stride = 1) {
  for (let index = start; index < end; index += stride) yield rowAt(index, sessions);
}

function metadataFor(sessions) {
  const sessionRecords = {};
  for (let index = 0; index < sessions; index += 1) {
    sessionRecords[sessionId(index)] = {
      id: sessionId(index),
      title: `session ${index}`,
      projectID: `proj_${index % PROJECT_COUNT}`,
      directory: `C:\\synthetic\\project-${index % PROJECT_COUNT}`,
      time: {
        created: NOW - 60 * 24 * HOUR_MS + index * 60_000,
        updated: NOW - (index % 30) * 24 * HOUR_MS,
      },
    };
  }
  const projectRecords = {};
  for (let index = 0; index < PROJECT_COUNT; index += 1) {
    projectRecords[`proj_${index}`] = {
      id: `proj_${index}`,
      name: `Synthetic project ${index}`,
      directories: [`C:\\synthetic\\project-${index}`],
      worktrees: [],
    };
  }
  return { sessions: sessionRecords, projects: projectRecords };
}

function heapSample() {
  globalThis.gc();
  globalThis.gc();
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function bytesPerRow(deltaBytes, rows) {
  return rows > 0 ? Number((deltaBytes / rows).toFixed(2)) : null;
}

async function measureSize(createAnalyticsModel, rows, warmMetadata) {
  const sessions = sessionCountFor(rows);
  const metadata = metadataFor(sessions);

  // Pricing warm: one row per provider/model in a disposable model. The
  // snapshot and resolution caches are module-process state, not model state.
  const warm = createAnalyticsModel();
  warm.setMetadata(warmMetadata.sessions, warmMetadata.projects);
  // Indexes 4..7 are block offsets that are not fork copies, so their
  // fingerprints cover every provider/model pair.
  warm.apply(rowsBetween(4, 4 + PROVIDERS.length, sessions), []);
  warm.clear();

  const baseline = heapSample();

  const model = createAnalyticsModel();
  model.setMetadata(metadata.sessions, metadata.projects);
  const afterMetadata = heapSample();

  const loadStarted = performance.now();
  model.apply(rowsBetween(0, rows, sessions), []);
  const loadMs = performance.now() - loadStarted;
  const afterLoad = heapSample();
  const ownedSteps = model.ownedStepCount();

  const repeatedStarted = performance.now();
  model.apply(rowsBetween(0, rows, sessions), []);
  const repeatedMs = performance.now() - repeatedStarted;
  const afterRepeated = heapSample();

  // Churn: drop every tenth row, then re-add the same rows. Both passes
  // regenerate inputs from the index; no row array is retained.
  const removalStarted = performance.now();
  model.apply([], rowsBetween(0, rows, sessions, 10));
  const churnRemoveMs = performance.now() - removalStarted;
  const afterChurnRemove = heapSample();

  const readdStarted = performance.now();
  model.apply(rowsBetween(0, rows, sessions, 10), []);
  const churnReaddMs = performance.now() - readdStarted;
  const afterChurnReadd = heapSample();

  const fullRemovalStarted = performance.now();
  model.apply([], rowsBetween(0, rows, sessions));
  const fullRemovalMs = performance.now() - fullRemovalStarted;
  const afterRemoval = heapSample();
  const removedOwnedSteps = model.ownedStepCount();

  model.clear();
  const afterClear = heapSample();

  return {
    rows,
    sessions,
    ownedSteps,
    loadMs: Number(loadMs.toFixed(1)),
    repeatedMs: Number(repeatedMs.toFixed(1)),
    churnRemoveMs: Number(churnRemoveMs.toFixed(1)),
    churnReaddMs: Number(churnReaddMs.toFixed(1)),
    fullRemovalMs: Number(fullRemovalMs.toFixed(1)),
    removedOwnedSteps,
    baseline,
    afterMetadata,
    afterLoad,
    afterRepeated,
    afterChurnRemove,
    afterChurnReadd,
    afterRemoval,
    afterClear,
    metadataBytes: afterMetadata.heapUsed - baseline.heapUsed,
    loadDeltaBytes: afterLoad.heapUsed - afterMetadata.heapUsed,
    loadBytesPerRow: bytesPerRow(afterLoad.heapUsed - afterMetadata.heapUsed, rows),
    totalBytesPerRow: bytesPerRow(afterLoad.heapUsed - baseline.heapUsed, rows),
    repeatedDeltaBytes: afterRepeated.heapUsed - afterLoad.heapUsed,
    churnRemoveDeltaBytes: afterChurnRemove.heapUsed - afterRepeated.heapUsed,
    churnReaddDeltaBytes: afterChurnReadd.heapUsed - afterChurnRemove.heapUsed,
    removalResidualBytes: afterRemoval.heapUsed - afterMetadata.heapUsed,
    clearResidualBytes: afterClear.heapUsed - afterMetadata.heapUsed,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function printTable(results) {
  console.log("model: analytics-model");
  for (const result of results) {
    console.log(
      [
        `rows=${result.rows}`,
        `sessions=${result.sessions}`,
        `owned=${result.ownedSteps}`,
        `load=${result.loadMs}ms`,
        `loadDelta=${formatMiB(result.loadDeltaBytes)}`,
        `bytes/row=${result.loadBytesPerRow}`,
        `repeatDelta=${formatMiB(result.repeatedDeltaBytes)}`,
        `churnRemoveDelta=${formatMiB(result.churnRemoveDeltaBytes)}`,
        `churnReaddDelta=${formatMiB(result.churnReaddDeltaBytes)}`,
        `removalResidual=${formatMiB(result.removalResidualBytes)}`,
        `clearResidual=${formatMiB(result.clearResidualBytes)}`,
      ].join(" "),
    );
  }
}

const options = parseArgs(process.argv.slice(2));
const modelPath = resolve(options.modelPath);
const { createAnalyticsModel } = await import(pathToFileURL(modelPath).href).catch(() => {
  console.error("analytics model benchmark could not load the model build");
  process.exit(2);
});
const warmMetadata = metadataFor(sessionCountFor(Math.max(...options.sizes)));
const results = [];
for (const rows of options.sizes) {
  results.push(await measureSize(createAnalyticsModel, rows, warmMetadata));
}

if (options.json) {
  console.log(JSON.stringify({ model: "analytics-model", results }, null, 2));
} else {
  printTable(results);
}
