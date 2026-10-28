#!/usr/bin/env node
/**
 * Analytics model benchmark: retained rollup memory plus warmed read latency.
 *
 * The synthetic fixture covers 32,000 and 128,000 completed assistant rows,
 * a 365-day row horizon (session metadata starts 30 days earlier, so lifetime
 * plans ~396 daily buckets), 35 deterministic provider/model pairs, and the
 * existing fixed fork-copy pattern. Rows are generated lazily from an index, so the
 * benchmark never retains an input array. Every memory sample calls
 * `global.gc()` twice; pricing is warmed in a disposable model first so a lazy
 * models.dev snapshot does not land inside a measured sample.
 *
 * Read scenarios compare the existing Home view (`home`) with the grouped
 * analytics view (`groups`) for all four ranges and both dimensions. Each read
 * is warmed, then repeated without retaining results. A separate GC-backed
 * sample reports the retained bytes of one Home and one grouped result. The
 * grouped result must agree with Home totals/counts, map every grouped
 * lifetime boundary into Home (Home may lead with metadata-only buckets),
 * start lifetime at the fixture's earliest owned day, keep rows bucket-free,
 * and keep bucket arrays bounded to the series (top five + Other).
 *
 * Analytics reads come from the model's owned in-memory steps only. The script
 * never queries the OpenCode analytics database/storage. Pricing resolution may
 * read the bundled or runtime models.dev pricing snapshot files, so this is not
 * a claim of zero filesystem I/O. `rawDbReads: 0` is harness method metadata,
 * not an instrumented counter.
 *
 * Output is anonymous aggregate timings/bytes only. No real session data is read.
 *
 * Usage:
 *   node scripts/benchmark-analytics-model.mjs
 *   node scripts/benchmark-analytics-model.mjs --model dist/gui/analytics-model.js --json
 *   node scripts/benchmark-analytics-model.mjs --sizes 32000,128000 --reads 5
 *   node scripts/benchmark-analytics-model.mjs --home-only --model <baseline-model.js>
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
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const LIFESPAN_DAYS = 365;

/**
 * Realistic provider/model identity variety. Some ids intentionally resolve to
 * local/unknown pricing so the fixture also exercises the unpriced path.
 */
const PROVIDER_MODELS = [
  ["openai", "gpt-5"],
  ["openai", "gpt-5-mini"],
  ["openai", "o3"],
  ["openai", "o4-mini"],
  ["anthropic", "claude-sonnet-4-5"],
  ["anthropic", "claude-opus-4-5"],
  ["anthropic", "claude-haiku-4-5"],
  ["anthropic", "claude-opus-4-1"],
  ["google", "gemini-2.5-pro"],
  ["google", "gemini-2.5-flash"],
  ["google", "gemini-2.0-flash"],
  ["google", "gemini-3-pro-preview"],
  ["xai", "grok-4"],
  ["xai", "grok-3"],
  ["xai", "grok-code-fast-1"],
  ["xai", "grok-2"],
  ["zai", "glm-4.7"],
  ["zai", "glm-4.5"],
  ["zai", "glm-4.5-air"],
  ["zai", "glm-4.6"],
  ["moonshotai", "kimi-k2"],
  ["moonshotai", "kimi-k2-thinking"],
  ["moonshotai", "kimi-k3"],
  ["moonshotai", "kimi-k2-0905"],
  ["deepseek", "deepseek-chat"],
  ["deepseek", "deepseek-reasoner"],
  ["alibaba", "qwen3-coder-plus"],
  ["alibaba", "qwen3-max"],
  ["mistral", "mistral-large-latest"],
  ["mistral", "codestral-latest"],
  ["github-copilot", "gpt-5"],
  ["github-copilot", "claude-sonnet-4-5"],
  ["openrouter", "deepseek-chat"],
  ["openrouter", "qwen3-coder-plus"],
  ["local-labs", "local-model"],
];
const PAIR_COUNT = PROVIDER_MODELS.length;
const PROVIDER_COUNT = new Set(PROVIDER_MODELS.map((pair) => pair[0])).size;
const MODEL_COUNT = new Set(PROVIDER_MODELS.map((pair) => pair[1])).size;
const PROJECT_COUNT = 7;
const FORK_BLOCK = 16;
const FORK_COPIES = 4;
const READ_RANGES = ["24h", "7d", "30d", "lifetime"];
const READ_DIMENSIONS = ["model", "provider"];
const READ_WARMUP = 2;
const MEMORY_SAMPLES = 3;

function parseArgs(argv) {
  const options = {
    modelPath: "dist/gui/analytics-model.js",
    sizes: [32_000, 128_000],
    reads: 5,
    json: false,
    homeOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--home-only") options.homeOnly = true;
    else if (arg === "--model") {
      options.modelPath = argv[index + 1] ?? options.modelPath;
      index += 1;
    } else if (arg === "--sizes") {
      options.sizes = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      index += 1;
    } else if (arg === "--reads") {
      const reads = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(reads) && reads > 0 && reads <= 50) options.reads = reads;
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
  const [providerID, modelID] = PROVIDER_MODELS[source % PAIR_COUNT];
  const createdAtMs =
    NOW - ((source * 37) % (LIFESPAN_DAYS * 24)) * HOUR_MS - (source % 11) * 60_000;
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
    providerID,
    modelID,
  };
}

function* rowsBetween(start, end, sessions, stride = 1) {
  for (let index = start; index < end; index += stride) yield rowAt(index, sessions);
}

/**
 * Earliest positive owned completion in the deterministic fixture, floored to
 * the model's UTC day boundary. Every fork block owns at least one copy at its
 * source row's completion time and every generated row has positive tokens, so
 * the earliest completion over all generated rows is the earliest owned one.
 * This is intentionally independent of Home's metadata-derived lifetime start.
 */
function fixtureEarliestOwnedDayStart(rows) {
  let earliest = Number.POSITIVE_INFINITY;
  const sessions = sessionCountFor(rows);
  for (let index = 0; index < rows; index += 1) {
    const completedAtMs = rowAt(index, sessions).completedAtMs;
    if (completedAtMs < earliest) earliest = completedAtMs;
  }
  return Number.isFinite(earliest) ? Math.floor(earliest / DAY_MS) * DAY_MS : undefined;
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
        // Metadata predates the 365-day row horizon by 30 days, so a lifetime
        // query plans ~396 daily buckets even though rows span 365 days.
        created: NOW - (LIFESPAN_DAYS + 30) * DAY_MS + index * 60_000,
        updated: NOW - (index % LIFESPAN_DAYS) * DAY_MS,
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

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function readSink(result) {
  if (!result || typeof result !== "object") return 0;
  const totals = result.totals ?? result.usage?.totals;
  return typeof totals?.total === "number" ? totals.total : 0;
}

function summarizeDurations(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    meanMs: round(total / durations.length, 2),
    medianMs: round(median, 2),
    minMs: round(sorted[0] ?? 0, 2),
    maxMs: round(sorted.at(-1) ?? 0, 2),
  };
}

function timedRead(read, iterations) {
  const durations = [];
  let sink = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = read();
    durations.push(performance.now() - started);
    sink += readSink(result);
  }
  return { stats: summarizeDurations(durations), sink };
}

function retainedReadBytes(read) {
  const samples = [];
  for (let index = 0; index < MEMORY_SAMPLES; index += 1) {
    let result = read();
    globalThis.gc();
    globalThis.gc();
    const held = process.memoryUsage().heapUsed;
    // Keep the result live through `held`, then measure the same heap after it
    // is dropped. This isolates the DTO from unrelated pre-read garbage.
    const marker = readSink(result);
    result = null;
    globalThis.gc();
    globalThis.gc();
    const dropped = process.memoryUsage().heapUsed;
    samples.push(held - dropped);
    if (!Number.isFinite(marker)) throw new Error("read result has no finite token total");
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

function serializedBytes(read) {
  return Buffer.byteLength(JSON.stringify(read()));
}

function totalsMatch(actual, expected) {
  const keys = [
    "input",
    "cacheRead",
    "cacheWrite",
    "output",
    "reasoning",
    "total",
    "unpricedTokens",
    "unknownTokens",
  ];
  return (
    keys.every((key) => actual[key] === expected[key]) &&
    actual.apiEquivalentCostUsd === expected.apiEquivalentCostUsd
  );
}

function rowsWithoutBuckets(rows) {
  return rows.every((row) => !("buckets" in row) && rowsWithoutBuckets(row.children));
}

const COSTED_KEYS = [
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "total",
  "unpricedTokens",
  "unknownTokens",
];

/** Sum one series' bucket arrays into a complete CostedTokens shape. */
function sumSeriesBuckets(buckets) {
  const sums = {};
  for (const key of COSTED_KEYS) sums[key] = 0;
  let seriesCost = 0;
  let anyPriced = false;
  for (const bucket of buckets) {
    for (const key of COSTED_KEYS) sums[key] += bucket[key];
    if (bucket.apiEquivalentCostUsd !== null) {
      anyPriced = true;
      seriesCost += bucket.apiEquivalentCostUsd;
    }
  }
  sums.apiEquivalentCostUsd = anyPriced ? seriesCost : null;
  return sums;
}

/**
 * Full CostedTokens equality, with the same floating-point tolerance the
 * benchmark uses for summed costs. Numeric cost status must match exactly.
 */
function costedTotalsConserved(actual, expected) {
  for (const key of COSTED_KEYS) {
    if (actual[key] !== expected[key]) return false;
  }
  if (expected.apiEquivalentCostUsd === null) return actual.apiEquivalentCostUsd === null;
  if (actual.apiEquivalentCostUsd === null) return false;
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected.apiEquivalentCostUsd));
  return Math.abs(actual.apiEquivalentCostUsd - expected.apiEquivalentCostUsd) <= tolerance;
}

/** Compare the selected series against one exact Home bucket boundary. */
function bucketTotalsMatch(homeTokens, series, index) {
  const sums = {};
  for (const key of COSTED_KEYS) sums[key] = 0;
  let seriesCost = 0;
  let anyPriced = false;
  for (const entry of series) {
    const bucket = entry.buckets[index];
    if (!bucket) return false;
    for (const key of COSTED_KEYS) sums[key] += bucket[key];
    if (bucket.apiEquivalentCostUsd !== null) {
      anyPriced = true;
      seriesCost += bucket.apiEquivalentCostUsd;
    }
  }

  for (const key of COSTED_KEYS) {
    if (sums[key] !== homeTokens[key]) return false;
  }

  const expectedCost = homeTokens.apiEquivalentCostUsd;
  if (expectedCost === null) return !anyPriced;
  if (!anyPriced) return false;
  const tolerance = 1e-9 * Math.max(1, Math.abs(expectedCost));
  return Math.abs(seriesCost - expectedCost) <= tolerance;
}

/**
 * Sum the selected series per bucket and compare each category against the
 * corresponding Home usage bucket. This checks the full CostedTokens shape,
 * not only the aggregate token total.
 *
 * Finite ranges must align exactly. Grouped lifetime intentionally starts at
 * the first positive owned step while Home lifetime also considers older
 * session metadata, so Home may have extra leading buckets. This fixture
 * guarantees that, so every grouped lifetime boundary must still map exactly
 * to a Home bucket; the caller separately pins the precise first boundary.
 */
function bucketSeriesMatch(homeUsage, snapshot, allowScopedStart) {
  if (!allowScopedStart && homeUsage.buckets.length !== snapshot.buckets.length) return false;
  const groupedLast = snapshot.buckets.at(-1);
  const homeLast = homeUsage.buckets.at(-1);
  if (!groupedLast || !homeLast || groupedLast.endMs !== homeLast.endMs) return false;
  const homeByStart = new Map(homeUsage.buckets.map((bucket) => [bucket.startMs, bucket]));
  let compared = 0;
  for (let index = 0; index < snapshot.buckets.length; index += 1) {
    const groupedBucket = snapshot.buckets[index];
    if (!groupedBucket) return false;
    const homeBucket = homeByStart.get(groupedBucket.startMs);
    if (!homeBucket || homeBucket.endMs !== groupedBucket.endMs) return false;
    if (!bucketTotalsMatch(homeBucket.tokens, snapshot.series, index)) return false;
    compared += 1;
  }
  return compared === snapshot.buckets.length;
}

function seriesConservation(snapshot, homeUsage, allowScopedStart, expectedLifetimeStartMs) {
  const bucketCount = snapshot.buckets.length;
  const bucketSlots = snapshot.series.reduce((sum, series) => sum + series.buckets.length, 0);
  const aligned = snapshot.series.every((series) => series.buckets.length === bucketCount);
  const contiguous = snapshot.buckets.every(
    (bucket, index) => index === 0 || snapshot.buckets[index - 1]?.endMs === bucket.startMs,
  );
  // Every bucket contributes to its series across the full CostedTokens shape,
  // independent of whether Home exposes a boundary for that bucket.
  const perSeries = snapshot.series.every((series) =>
    costedTotalsConserved(sumSeriesBuckets(series.buckets), series.tokens),
  );
  const seriesTotal = snapshot.series.reduce((sum, series) => sum + series.tokens.total, 0);
  const bucketMatch = bucketSeriesMatch(homeUsage, snapshot, allowScopedStart);
  const firstLifetimeBoundaryMatches =
    !allowScopedStart ||
    (expectedLifetimeStartMs !== undefined &&
      snapshot.buckets[0]?.startMs === expectedLifetimeStartMs);
  return {
    bucketSlots,
    bucketMatch,
    firstLifetimeBoundaryMatches,
    ok:
      aligned &&
      contiguous &&
      perSeries &&
      seriesTotal === snapshot.totals.total &&
      bucketSlots <= 6 * bucketCount &&
      bucketMatch &&
      firstLifetimeBoundaryMatches,
  };
}

function measureReadScenario(model, range, dimension, iterations, expectedLifetimeStartMs) {
  const homeRead = () => model.home(range, NOW);
  const groupedRead = () => model.groups({ range, dimension }, NOW);

  let warmHome = homeRead();
  let warmGrouped = groupedRead();
  for (let index = 1; index < READ_WARMUP; index += 1) {
    warmHome = homeRead();
    warmGrouped = groupedRead();
  }

  const matchHome =
    totalsMatch(warmGrouped.totals, warmHome.usage.totals) &&
    warmGrouped.stepCount === warmHome.usage.stepCount &&
    warmGrouped.sessionCount === warmHome.usage.sessionCount;
  // Only lifetime can intentionally start at a different boundary than Home:
  // grouped lifetime anchors on owned data, Home lifetime also includes older
  // session metadata. This fixture guarantees Home starts earlier.
  const allowScopedStart = range === "lifetime";
  const conservation = seriesConservation(
    warmGrouped,
    warmHome.usage,
    allowScopedStart,
    expectedLifetimeStartMs,
  );
  const bucketCount = warmGrouped.buckets.length;
  const homeBucketCount = warmHome.usage.buckets.length;
  const firstBucketStartMs = warmGrouped.buckets[0]?.startMs ?? null;
  const rowCount = warmGrouped.rows.length;
  const seriesCount = warmGrouped.series.length;
  const cleanRows = rowsWithoutBuckets(warmGrouped.rows);

  // Do not let the warm DTOs inflate the repeated-read heap during timing.
  warmHome = null;
  warmGrouped = null;

  const homeTiming = timedRead(homeRead, iterations);
  const groupedTiming = timedRead(groupedRead, iterations);
  const homeRetainedBytes = retainedReadBytes(homeRead);
  const groupedRetainedBytes = retainedReadBytes(groupedRead);
  const homePayloadBytes = serializedBytes(homeRead);
  const groupedPayloadBytes = serializedBytes(groupedRead);
  const overheadMs = round(groupedTiming.stats.meanMs - homeTiming.stats.meanMs, 2);
  const overheadRatio =
    homeTiming.stats.meanMs > 0
      ? round(groupedTiming.stats.meanMs / homeTiming.stats.meanMs, 3)
      : null;

  return {
    range,
    dimension,
    buckets: bucketCount,
    homeBuckets: homeBucketCount,
    firstBucketStartMs,
    expectedLifetimeStartMs: allowScopedStart ? (expectedLifetimeStartMs ?? null) : null,
    bucketMatchScope: allowScopedStart ? "scoped-lifetime-subset" : "exact",
    rows: rowCount,
    series: seriesCount,
    iterations,
    warmup: READ_WARMUP,
    home: homeTiming.stats,
    grouped: groupedTiming.stats,
    overheadMs,
    overheadRatio,
    homeRetainedBytes,
    groupedRetainedBytes,
    homePayloadBytes,
    groupedPayloadBytes,
    bucketSlots: conservation.bucketSlots,
    bucketSeriesMatch: conservation.bucketMatch,
    rowsWithoutBuckets: cleanRows,
    seriesConserved: conservation.ok,
    matchHome,
  };
}

function measureHomeScenario(model, range, iterations) {
  const homeRead = () => model.home(range, NOW);
  let warm = homeRead();
  for (let index = 1; index < READ_WARMUP; index += 1) warm = homeRead();
  const bucketCount = warm.usage.buckets.length;
  const stepCount = warm.usage.stepCount;
  warm = null;

  const timing = timedRead(homeRead, iterations);
  return {
    range,
    buckets: bucketCount,
    steps: stepCount,
    iterations,
    warmup: READ_WARMUP,
    home: timing.stats,
    retainedBytes: retainedReadBytes(homeRead),
    payloadBytes: serializedBytes(homeRead),
  };
}

function measureHomeReads(model, iterations) {
  const ownedSteps = model.ownedStepCount();
  const scenarios = READ_RANGES.map((range) => measureHomeScenario(model, range, iterations));
  return {
    iterations,
    warmup: READ_WARMUP,
    readSource: "owned-steps",
    rawDbReads: 0,
    rawDbReadsIsMeasured: false,
    ownedSteps,
    ownedStepsStable: model.ownedStepCount() === ownedSteps,
    scenarios,
  };
}

function measureGroupedReads(model, iterations, expectedLifetimeStartMs) {
  const ownedSteps = model.ownedStepCount();
  const scenarios = [];
  for (const range of READ_RANGES) {
    for (const dimension of READ_DIMENSIONS) {
      scenarios.push(
        measureReadScenario(model, range, dimension, iterations, expectedLifetimeStartMs),
      );
    }
  }
  return {
    pairs: PAIR_COUNT,
    providers: PROVIDER_COUNT,
    models: MODEL_COUNT,
    iterations,
    warmup: READ_WARMUP,
    readSource: "owned-steps",
    rawDbReads: 0,
    rawDbReadsIsMeasured: false,
    ownedSteps,
    ownedStepsStable: model.ownedStepCount() === ownedSteps,
    scenarios,
  };
}

async function measureSize(createAnalyticsModel, rows, warmMetadata, reads, homeOnly) {
  const sessions = sessionCountFor(rows);
  const metadata = metadataFor(sessions);

  // Pricing warm: cover every deterministic provider/model pair in a
  // disposable model. The snapshot and resolution caches are module-process
  // state, not model state.
  const warm = createAnalyticsModel();
  warm.setMetadata(warmMetadata.sessions, warmMetadata.projects);
  warm.apply(
    PROVIDER_MODELS.map(([providerID, modelID], index) => ({
      ...rowAt(index, sessions),
      providerID,
      modelID,
    })),
    [],
  );
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

  // Warmed Home reads, plus the grouped comparison unless this run only needs
  // the existing Home baseline (for a baseline-commit comparison).
  const readResults = homeOnly
    ? { homeRead: measureHomeReads(model, reads) }
    : {
        groupedRead: measureGroupedReads(model, reads, fixtureEarliestOwnedDayStart(rows)),
      };

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
    pairs: PAIR_COUNT,
    providers: PROVIDER_COUNT,
    models: MODEL_COUNT,
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
    ...readResults,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
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

function printHomeOnlyTable(results) {
  console.log(
    "home-only reads: warmed existing Home (synthetic owned steps; rawDbReads metadata=0, not measured)",
  );
  for (const result of results) {
    const homeRead = result.homeRead;
    console.log(
      [
        `rows=${result.rows}`,
        `pairs=${result.pairs}`,
        `reads=${homeRead.iterations}`,
        `warmup=${homeRead.warmup}`,
        `ownedStable=${homeRead.ownedStepsStable}`,
      ].join(" "),
    );
    for (const scenario of homeRead.scenarios) {
      console.log(
        [
          `  ${scenario.range}`,
          `home=${scenario.home.meanMs}ms`,
          `payload=${formatKiB(scenario.payloadBytes)}`,
          `retained=${formatKiB(scenario.retainedBytes)}`,
          `buckets=${scenario.buckets}`,
        ].join(" "),
      );
    }
  }
}

function printGroupedTable(results) {
  console.log(
    "grouped reads: warmed Home vs groups (synthetic owned steps; rawDbReads metadata=0, not measured)",
  );
  for (const result of results) {
    const grouped = result.groupedRead;
    console.log(
      [
        `rows=${result.rows}`,
        `pairs=${grouped.pairs}`,
        `providers=${grouped.providers}`,
        `models=${grouped.models}`,
        `reads=${grouped.iterations}`,
        `warmup=${grouped.warmup}`,
        `ownedStable=${grouped.ownedStepsStable}`,
      ].join(" "),
    );
    for (const scenario of grouped.scenarios) {
      console.log(
        [
          `  ${scenario.range}`,
          scenario.dimension,
          `home=${scenario.home.meanMs}ms`,
          `groups=${scenario.grouped.meanMs}ms`,
          `overhead=${scenario.overheadRatio}x`,
          `retained=${formatKiB(scenario.homeRetainedBytes)}/${formatKiB(
            scenario.groupedRetainedBytes,
          )}`,
          `payload=${formatKiB(scenario.homePayloadBytes)}/${formatKiB(
            scenario.groupedPayloadBytes,
          )}`,
          `match=${scenario.matchHome}`,
          `bucketMatch=${scenario.bucketSeriesMatch}`,
          `series=${scenario.seriesConserved}`,
        ].join(" "),
      );
    }
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
  results.push(
    await measureSize(createAnalyticsModel, rows, warmMetadata, options.reads, options.homeOnly),
  );
}

const payload = {
  model: "analytics-model",
  method: {
    fixture: "synthetic-deterministic-owned-steps",
    now: new Date(NOW).toISOString(),
    lifespanDays: LIFESPAN_DAYS,
    pairs: PAIR_COUNT,
    providers: PROVIDER_COUNT,
    models: MODEL_COUNT,
    forkCopies: FORK_COPIES,
    readIterations: options.reads,
    readWarmup: READ_WARMUP,
    memorySamples: MEMORY_SAMPLES,
    homeOnly: options.homeOnly,
    readSource: "owned-steps",
    rawDbReads: 0,
    rawDbReadsIsMeasured: false,
    pricingSnapshotReads: "possible-bundled-or-runtime",
    gcExposed: typeof globalThis.gc === "function",
  },
  results,
};

if (options.json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  printTable(results);
  if (options.homeOnly) printHomeOnlyTable(results);
  else printGroupedTable(results);
}
