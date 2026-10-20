#!/usr/bin/env node
/**
 * Analytics performance/persistence benchmark suite (pre-optimization baseline).
 *
 * Synthetic profiles (fixed seed and relative clock distribution):
 *   - dense-30d: 128,000 assistant rows / 420 sessions over 45 days, billions
 *     of cache-read tokens.
 *   - long-lifetime: 54,000 rows / 180 sessions over 18 months.
 *   - deep-session-tree: a 47-session tree, 46 descendants across six depths,
 *     fork copies, compactions, and growing-context token patterns.
 *
 * Every profile runs the real tsc-built analytics worker behind the real
 * loopback dashboard server. GET / and /api/v1/health are probed separately.
 * Cold 7d, 30d extension, lifetime, warm view switches, large tree/subsession,
 * and no-change / 100 / 1000 / two-day deltas are measured. Synthetic deltas
 * mutate only the disposable temp database; real-local mode never writes.
 * A synthetic cold-resume case restarts a fresh worker on an isolated persisted
 * snapshot after a simulated two-day source delta.
 *
 * `--real-local` resolves OPENCODE_DB exactly as production does, opens it
 * read-only, and emits only anonymous aggregate counts/timings. It requires no
 * real fixture and always uses a disposable snapshot/presentation directory.
 *
 * Usage:
 *   pnpm exec tsc
 *   node scripts/benchmark-analytics.mjs                 # human table, all profiles
 *   node scripts/benchmark-analytics.mjs --json          # stable JSON on stdout
 *   node scripts/benchmark-analytics.mjs --json-out docs/performance/local/before.json
 *   node scripts/benchmark-analytics.mjs --real-local --json
 *   bun scripts/benchmark-analytics.mjs
 *
 * Env:
 *   ANALYTICS_BENCH_MEMORY_CAP_MIB  retained worker delta cap (default 100)
 *   ANALYTICS_BENCH_DENSE_SESSIONS  dense profile session override
 *   ANALYTICS_BENCH_DENSE_ROWS      dense profile row override
 *   ANALYTICS_BENCH_SESSIONS        legacy dense session override
 *   ANALYTICS_BENCH_STEPS           legacy dense rows = sessions * steps
 *   OCQ_BENCH_TMP_DIR               benchmark temp parent (default <tmp>/opencode)
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  appendDeltaRows,
  createSyntheticDatabase,
  DAY_MS,
  detectRuntime,
  SYNTHETIC_PROFILES,
} from "./analytics-benchmark-fixtures.mjs";
import {
  assertSanitized,
  BenchError,
  createAnalyticsService,
  diffPhaseSnapshots,
  hostMemory,
  loadDistModules,
  phaseSnapshot,
  printHumanTable,
  retainedWorker,
  safeErrorCode,
  sleep,
  startDashboard,
  startHostSampler,
  startHttpProbes,
  summarize,
  summarizeWorkerMemory,
  toMiB,
  WORKER_PHASE_LABELS,
  workerStats,
} from "./analytics-benchmark-harness.mjs";
import { resolveRealSource, selectRealSource } from "./analytics-benchmark-real.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = detectRuntime();

if (runtime === "node" && typeof globalThis.gc !== "function" && process.env.OCQ_BENCH_GC !== "1") {
  const child = spawnSync(process.execPath, ["--expose-gc", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, OCQ_BENCH_GC: "1" },
  });
  process.exit(child.status ?? 1);
}

const DURATION_KEYS = [
  "coldHome7d",
  "extensionHome30d",
  "lifetimeHome",
  "projectDense30d",
  "projectLongLifetime",
  "largeTreeSession",
  "subSession",
  "warmReopenHome7d",
  "warmReopenProject30d",
  "deltaNoChangeRefresh",
  "deltaNoChangeHome7d",
  "deltaAdd100Refresh",
  "deltaAdd100Home7d",
  "deltaAdd1000Refresh",
  "deltaAdd1000Home7d",
  "deltaTwoDayRefresh",
  "deltaTwoDayHome7d",
  "coldResumeHomeAfterRestart",
  "coldResumeRefresh",
  "coldResumeHomeAfterRefresh",
];

function buildInstrumentation(profiles) {
  const available = profiles.some((profile) => profile.phases.available);
  return {
    available,
    status: available ? "available" : "unavailable",
    source: available ? "AnalyticsWorkerMemoryStats.phases (stats command)" : null,
    reason: available ? null : "worker stats did not expose the fixed phase metrics in this build",
    semantics: available
      ? "Cumulative fixed-label worker timings; the suite differences adjacent stats marks. Async persistence/aggregation can cross an interval boundary, so interval totals are not exclusive per-call breakdowns. Cache hits and queueing are excluded by production."
      : "No phase seam detected; wall-clock call durations are never relabeled as phases.",
    labels: WORKER_PHASE_LABELS,
  };
}

function parseOptions(argv) {
  const options = {
    profiles: [],
    json: false,
    jsonOut: null,
    realLocal: false,
    help: false,
    memoryCapMiB: Number(process.env.ANALYTICS_BENCH_MEMORY_CAP_MIB ?? 100),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--real-local") {
      options.realLocal = true;
    } else if (argument === "--profile") {
      const value = argv[index + 1];
      index += 1;
      if (!value) throw new BenchError("bad-argument");
      for (const name of value.split(",")) {
        const trimmed = name.trim();
        if (trimmed) options.profiles.push(trimmed);
      }
    } else if (argument === "--json-out") {
      const value = argv[index + 1];
      index += 1;
      if (!value) throw new BenchError("bad-argument");
      options.jsonOut = value;
    } else if (argument === "--memory-cap-mib") {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value < 0) throw new BenchError("bad-argument");
      options.memoryCapMiB = value;
    } else {
      throw new BenchError("bad-argument");
    }
  }
  if (!Number.isFinite(options.memoryCapMiB) || options.memoryCapMiB < 0) {
    throw new BenchError("bad-argument");
  }
  options.profiles = [...new Set(options.profiles)];
  if (options.realLocal) {
    const invalid = options.profiles.filter((name) => name !== "real-local" && name !== "all");
    if (invalid.length > 0) throw new BenchError("bad-argument");
    options.profiles = ["real-local"];
  } else if (options.profiles.length === 0 || options.profiles.includes("all")) {
    options.profiles = Object.keys(SYNTHETIC_PROFILES);
  } else {
    const unknown = options.profiles.filter((name) => !SYNTHETIC_PROFILES[name]);
    if (unknown.length > 0) throw new BenchError("unknown-profile");
  }
  return options;
}

function usage() {
  return `Analytics benchmark suite

Usage:
  node scripts/benchmark-analytics.mjs [--profile <name[,name]>] [--json] [--json-out <path>]
  node scripts/benchmark-analytics.mjs --real-local [--json] [--json-out <path>]

Profiles:
  dense-30d, long-lifetime, deep-session-tree (default: all)

Real-local:
  Resolves OPENCODE_DB like production, opens the source read-only, selects
  anonymous dense/long/large-tree targets, and never writes to the source.
  Only no-change deltas run; mutation and cold-resume scenarios are skipped.

Environment:
  ANALYTICS_BENCH_MEMORY_CAP_MIB, ANALYTICS_BENCH_DENSE_SESSIONS,
  ANALYTICS_BENCH_DENSE_ROWS, ANALYTICS_BENCH_SESSIONS, ANALYTICS_BENCH_STEPS,
  ANALYTICS_BENCH_SUITE_TIMEOUT_MS, OCQ_BENCH_TMP_DIR`;
}

const KEEPALIVE_INTERVAL_MS = 1_000;
const DEFAULT_SUITE_TIMEOUT_MS = 20 * 60_000;
const activeTempRoots = new Set();

function benchmarkTempRoot() {
  const parent = process.env.OCQ_BENCH_TMP_DIR?.trim() || join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "ocq-analytics-bench-"));
  activeTempRoots.add(root);
  return root;
}

function removeTempRoot(root) {
  activeTempRoots.delete(root);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A temp directory cleanup failure never changes benchmark results.
  }
}

function suiteTimeoutMs() {
  const configured = Number(process.env.ANALYTICS_BENCH_SUITE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SUITE_TIMEOUT_MS;
}

const ENV_KEYS = [
  "OPENCODE_DB",
  "OPENCODE_CONFIG_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

/** Isolate every runtime dir, then pin OPENCODE_DB explicitly. */
function isolateEnvironment(root, dbPath) {
  const previous = new Map();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  const dirs = {
    data: join(root, "xdg-data"),
    config: join(root, "xdg-config"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  process.env.OPENCODE_DB = dbPath;
  process.env.OPENCODE_CONFIG_DIR = join(dirs.config, "opencode");
  process.env.XDG_DATA_HOME = dirs.data;
  process.env.XDG_CONFIG_HOME = dirs.config;
  process.env.XDG_CACHE_HOME = dirs.cache;
  process.env.XDG_STATE_HOME = dirs.state;
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function denseOverrides() {
  const sessions = Number(
    process.env.ANALYTICS_BENCH_DENSE_SESSIONS ?? process.env.ANALYTICS_BENCH_SESSIONS,
  );
  const rows = Number(process.env.ANALYTICS_BENCH_DENSE_ROWS);
  const legacySteps = Number(process.env.ANALYTICS_BENCH_STEPS);
  const overrides = {};
  if (Number.isFinite(sessions) && sessions > 0) overrides.sessions = Math.floor(sessions);
  if (Number.isFinite(rows) && rows > 0) overrides.rows = Math.floor(rows);
  else if (Number.isFinite(legacySteps) && legacySteps > 0 && overrides.sessions) {
    overrides.rows = overrides.sessions * Math.floor(legacySteps);
  }
  return overrides;
}

function createAssetRoot(root) {
  const assetRoot = join(root, "ui");
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(join(assetRoot, "index.html"), "<!doctype html><title>bench</title>ok");
  return assetRoot;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function maxNumber(...values) {
  let result = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > result) result = value;
  }
  return result;
}

function createDurations() {
  return Object.fromEntries(DURATION_KEYS.map((key) => [key, null]));
}

function measure(started) {
  return Number((performance.now() - started).toFixed(2));
}

async function timed(durations, key, job) {
  const started = performance.now();
  const value = await job();
  durations[key] = measure(started);
  return value;
}

async function measureWarmSwitches(service, internal, rounds) {
  const operations = [
    ["home24h", () => service.home({ range: "24h" })],
    ["home7d", () => service.home({ range: "7d" })],
    ["home30d", () => service.home({ range: "30d" })],
    ["homeLifetime", () => service.home({ range: "lifetime" })],
    [
      "projectDense30d",
      () => service.project({ projectId: internal.denseProjectId, range: "30d" }),
    ],
    [
      "projectLongLifetime",
      () => service.project({ projectId: internal.longProjectId, range: "lifetime" }),
    ],
    ["sessionRoot", () => service.session({ sessionId: internal.largeTreeRootId })],
    ["sessionDeep", () => service.session({ sessionId: internal.subSessionId })],
  ];
  const samples = new Map(operations.map(([name]) => [name, []]));
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, operation] of operations) {
      const callStarted = performance.now();
      await operation();
      samples.get(name).push(measure(callStarted));
    }
  }
  const all = [...samples.values()].flat().sort((a, b) => a - b);
  const operationsOut = {};
  for (const [name, values] of samples) {
    operationsOut[name] = summarize(values);
  }
  return {
    rounds,
    calls: all.length,
    totalMs: measure(started),
    p50Ms: summarize(all).p50Ms,
    p95Ms: summarize(all).p95Ms,
    operations: operationsOut,
  };
}

function emptyDelta(status) {
  return {
    status,
    insertedRows: 0,
    days: 0,
    expectedStepDelta: 0,
    observedStepDelta: null,
    refreshMs: null,
    homeMs: null,
    passed: null,
  };
}

async function measureDeltas(options) {
  const { mode, dbPath, service, targetSessionId, anchorMs, durations } = options;
  const deltas = {
    mutationMode: mode === "synthetic" ? "synthetic-temp-source" : "none",
    externalWriterPossible: mode === "real-local",
    finalStepCount: null,
    scenarios: {},
  };
  let baseline = (await service.home({ range: "7d" })).usage.stepCount;
  const definitions = [
    { name: "noChange", mutation: false, insertedRows: 0, days: 0 },
    { name: "add100", mutation: true, insertedRows: 100, days: 1 },
    { name: "add1000", mutation: true, insertedRows: 1_000, days: 1 },
    { name: "twoDay", mutation: true, insertedRows: 400, days: 2 },
  ];

  for (const definition of definitions) {
    const prefix = `delta${definition.name[0].toUpperCase()}${definition.name.slice(1)}`;
    if (mode === "real-local" && definition.mutation) {
      deltas.scenarios[definition.name] = emptyDelta("skipped");
      continue;
    }
    let insertedRows = 0;
    if (definition.mutation) {
      const appended = await appendDeltaRows({
        dbPath,
        targetSessionId,
        scenario: definition.name,
        anchorMs,
      });
      insertedRows = appended.insertedRows;
    }
    const refreshStarted = performance.now();
    await service.refresh();
    durations[`${prefix}Refresh`] = measure(refreshStarted);
    const homeStarted = performance.now();
    const home = await service.home({ range: "7d" });
    durations[`${prefix}Home7d`] = measure(homeStarted);
    const observedStepDelta = home.usage.stepCount - baseline;
    baseline = home.usage.stepCount;
    const expectedStepDelta = definition.insertedRows;
    const passed =
      mode === "real-local" && definition.name === "noChange"
        ? observedStepDelta === 0
          ? true
          : null
        : observedStepDelta === expectedStepDelta;
    deltas.scenarios[definition.name] = {
      status: definition.mutation ? "applied" : "not-mutated",
      insertedRows,
      days: definition.days,
      expectedStepDelta,
      observedStepDelta,
      refreshMs: durations[`${prefix}Refresh`],
      homeMs: durations[`${prefix}Home7d`],
      passed,
    };
  }
  deltas.finalStepCount = baseline;
  return deltas;
}

/** Age only the isolated snapshot's cursor clocks to simulate a two-day pause. */
function ageIsolatedSnapshot(path, days) {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const shiftMs = days * DAY_MS;
  let sourceCursorShifted = false;
  let repairClockShifted = false;
  if (typeof snapshot.sourceCursorAtMs === "number") {
    snapshot.sourceCursorAtMs = Math.max(0, snapshot.sourceCursorAtMs - shiftMs);
    sourceCursorShifted = true;
  }
  if (typeof snapshot.lastFullRepairAtMs === "number") {
    snapshot.lastFullRepairAtMs = Math.max(0, snapshot.lastFullRepairAtMs - shiftMs);
    repairClockShifted = true;
  }
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
  return { sourceCursorShifted, repairClockShifted };
}

function emptyColdResume(status, reason = null) {
  return {
    status,
    reason,
    simulatedInactivityDays: 0,
    actualInactivityMs: null,
    clockSimulation: null,
    snapshotReused: false,
    snapshotSource: null,
    insertedRows: 0,
    expectedStepDelta: 0,
    observedStepDelta: null,
    homeAfterRestartMs: null,
    refreshMs: null,
    homeAfterRefreshMs: null,
    passed: null,
  };
}

/**
 * Genuine synthetic cold resume: persist a worker snapshot, close the worker,
 * append two-day-spread rows while no worker is running, then start a fresh
 * worker against an isolated copy of that snapshot. The snapshot-copy/write
 * gap is real; the two-day inactivity is simulated by two-day row timestamps
 * plus a two-day shift of only the isolated snapshot's cursor clocks. The
 * actual wall-clock gap is reported.
 */
async function measureColdResume(options) {
  const {
    mode,
    dbPath,
    targetSessionId,
    anchorMs,
    snapshotPath,
    root,
    modules,
    durations,
    baselineStepCount,
    inactivityStarted = performance.now(),
  } = options;

  if (mode !== "synthetic") {
    return {
      result: emptyColdResume("skipped", "real-source-is-never-mutated"),
      workerBefore: null,
      workerAfter: null,
    };
  }
  if (fileSize(snapshotPath) <= 0) {
    return {
      result: emptyColdResume("skipped", "snapshot-unavailable"),
      workerBefore: null,
      workerAfter: null,
    };
  }

  const isolatedSnapshotPath = join(root, "cold-resume-analytics-v3.json");
  copyFileSync(snapshotPath, isolatedSnapshotPath);
  const appended = await appendDeltaRows({
    dbPath,
    targetSessionId,
    scenario: "coldResume",
    anchorMs,
  });
  const clockShift = ageIsolatedSnapshot(isolatedSnapshotPath, appended.days);
  const actualInactivityMs = measure(inactivityStarted);

  const service = createAnalyticsService(modules, {
    snapshotPath: isolatedSnapshotPath,
    refreshIntervalMs: 3_600_000,
    requestTimeoutMs: 600_000,
  });
  try {
    const workerBefore = await workerStats(service);
    await timed(durations, "coldResumeHomeAfterRestart", () => service.home({ range: "7d" }));
    await timed(durations, "coldResumeRefresh", () => service.refresh());
    const homeAfterRefresh = await timed(durations, "coldResumeHomeAfterRefresh", () =>
      service.home({ range: "7d" }),
    );
    const workerAfter = await workerStats(service);
    const observedStepDelta = homeAfterRefresh.usage.stepCount - baselineStepCount;
    return {
      result: {
        status: "applied",
        reason: null,
        simulatedInactivityDays: appended.days,
        actualInactivityMs,
        clockSimulation: {
          mode: "aged-isolated-snapshot",
          days: appended.days,
          sourceCursorShifted: clockShift.sourceCursorShifted,
          repairClockShifted: clockShift.repairClockShifted,
        },
        snapshotReused: true,
        snapshotSource: "persisted-worker-snapshot",
        insertedRows: appended.insertedRows,
        expectedStepDelta: appended.insertedRows,
        observedStepDelta,
        homeAfterRestartMs: durations.coldResumeHomeAfterRestart,
        refreshMs: durations.coldResumeRefresh,
        homeAfterRefreshMs: durations.coldResumeHomeAfterRefresh,
        passed: observedStepDelta === appended.insertedRows,
      },
      workerBefore,
      workerAfter,
    };
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function executeProfile(options) {
  const {
    name,
    mode,
    dbPath,
    anchorMs,
    root,
    modules,
    memoryCapMiB,
    selection,
    synthetic,
    sourceCounts,
    sourceAccess,
  } = options;
  const assetRoot = createAssetRoot(root);
  const snapshotPath = join(root, "analytics-v3.json");
  const presentationPath = `${snapshotPath}.presentation.json`;
  const durations = createDurations();
  const checks = {
    coldProvidersEmpty: null,
    rangeStepCountsMonotonic: null,
    warmProvidersEmpty: null,
    largeTreeNodesMatch: null,
    subSessionNodesMatch: null,
    deltaNoChangePassed: null,
    deltaAdd100Passed: null,
    deltaAdd1000Passed: null,
    deltaTwoDayPassed: null,
    coldResumeDeltaPassed: null,
    httpIndexNoFailures: null,
    httpHealthNoFailures: null,
    persistenceSnapshotWritten: null,
    workerRetainedBounded: null,
  };
  const phaseWorkerMemory = {};
  const phaseMarks = {};
  const markPhases = (name, stats) => {
    phaseMarks[name] = phaseSnapshot(stats);
  };
  const current = { service: null };
  let server = null;
  let probes = null;
  let hostSampler = null;
  let workerBefore = null;
  let workerAfterCold = null;
  let workerAfterLifetime = null;
  let workerWarmBefore = null;
  let workerRetainedResult = { stats: null, gcAvailable: false };
  let coldSnapshot = null;
  let extensionSnapshot = null;
  let lifetimeSnapshot = null;
  let largeTreeSnapshot = null;
  let subSessionSnapshot = null;
  const hostBaseline = hostMemory();

  try {
    const serviceA = createAnalyticsService(modules, {
      snapshotPath,
      refreshIntervalMs: 3_600_000,
      requestTimeoutMs: 600_000,
    });
    current.service = serviceA;
    server = await startDashboard({
      modules,
      assetRoot,
      getService: () => current.service,
    });
    probes = startHttpProbes(server.url);
    hostSampler = startHostSampler();
    probes.setPhase("idle");
    await sleep(400);
    probes.setPhase("active");

    workerBefore = await workerStats(serviceA);
    markPhases("before", workerBefore);
    coldSnapshot = await timed(durations, "coldHome7d", () => serviceA.home({ range: "7d" }));
    workerAfterCold = await workerStats(serviceA);
    markPhases("cold7d", workerAfterCold);
    phaseWorkerMemory.cold = summarizeWorkerMemory(workerAfterCold);
    checks.coldProvidersEmpty =
      coldSnapshot.providers.cards.length === 0 &&
      coldSnapshot.providers.enabledProviders.length === 0;
    extensionSnapshot = await timed(durations, "extensionHome30d", () =>
      serviceA.home({ range: "30d" }),
    );
    const workerAfterExtension = await workerStats(serviceA);
    markPhases("extension30d", workerAfterExtension);
    phaseWorkerMemory.extension = summarizeWorkerMemory(workerAfterExtension);
    lifetimeSnapshot = await timed(durations, "lifetimeHome", () =>
      serviceA.home({ range: "lifetime" }),
    );
    workerAfterLifetime = await workerStats(serviceA);
    markPhases("lifetimeHome", workerAfterLifetime);
    phaseWorkerMemory.lifetime = summarizeWorkerMemory(workerAfterLifetime);
    checks.rangeStepCountsMonotonic =
      coldSnapshot.usage.stepCount <= extensionSnapshot.usage.stepCount &&
      extensionSnapshot.usage.stepCount <= lifetimeSnapshot.usage.stepCount;

    await timed(durations, "projectDense30d", () =>
      serviceA.project({ projectId: selection.internal.denseProjectId, range: "30d" }),
    );
    const workerAfterDenseProject = await workerStats(serviceA);
    markPhases("projectDense30d", workerAfterDenseProject);
    await timed(durations, "projectLongLifetime", () =>
      serviceA.project({ projectId: selection.internal.longProjectId, range: "lifetime" }),
    );
    const workerAfterLongProject = await workerStats(serviceA);
    markPhases("projectLongLifetime", workerAfterLongProject);
    largeTreeSnapshot = await timed(durations, "largeTreeSession", () =>
      serviceA.session({ sessionId: selection.internal.largeTreeRootId }),
    );
    const workerAfterLargeTree = await workerStats(serviceA);
    markPhases("largeTreeSession", workerAfterLargeTree);
    subSessionSnapshot = await timed(durations, "subSession", () =>
      serviceA.session({ sessionId: selection.internal.subSessionId }),
    );
    const workerAfterScopes = await workerStats(serviceA);
    markPhases("subSession", workerAfterScopes);
    phaseWorkerMemory.scopes = summarizeWorkerMemory(workerAfterScopes);
    checks.largeTreeNodesMatch =
      largeTreeSnapshot.nodes.length === selection.summary.largestTree.members;
    checks.subSessionNodesMatch =
      subSessionSnapshot.nodes.length === selection.summary.largestTree.subSessionSubtreeMembers;

    const coldRetained = await retainedWorker(serviceA);
    phaseWorkerMemory.coldRetained = summarizeWorkerMemory(coldRetained.stats);
    await serviceA.close();
    current.service = null;
    const snapshotBytes = fileSize(snapshotPath);
    const presentationBytes = fileSize(presentationPath);
    checks.persistenceSnapshotWritten = snapshotBytes > 0;

    const serviceB = createAnalyticsService(modules, {
      snapshotPath,
      refreshIntervalMs: 3_600_000,
      requestTimeoutMs: 600_000,
    });
    current.service = serviceB;
    workerWarmBefore = await workerStats(serviceB);
    markPhases("warmBefore", workerWarmBefore);
    const warmHome = await timed(durations, "warmReopenHome7d", () =>
      serviceB.home({ range: "7d" }),
    );
    const workerAfterWarmHome = await workerStats(serviceB);
    markPhases("warmReopenHome7d", workerAfterWarmHome);
    checks.warmProvidersEmpty = warmHome.providers.cards.length === 0;
    await timed(durations, "warmReopenProject30d", () =>
      serviceB.project({ projectId: selection.internal.denseProjectId, range: "30d" }),
    );
    const workerAfterWarmProject = await workerStats(serviceB);
    markPhases("warmReopenProject30d", workerAfterWarmProject);
    const warmSwitches = await measureWarmSwitches(serviceB, selection.internal, 3);
    const workerAfterWarmSwitches = await workerStats(serviceB);
    markPhases("warmSwitches", workerAfterWarmSwitches);
    probes.setPhase("delta");
    const deltas = await measureDeltas({
      mode,
      dbPath,
      service: serviceB,
      targetSessionId: selection.internal.deltaTargetSessionId,
      anchorMs,
      durations,
    });
    for (const name of ["noChange", "add100", "add1000", "twoDay"]) {
      const scenario = deltas.scenarios[name];
      const key = `delta${name[0].toUpperCase()}${name.slice(1)}Passed`;
      if (scenario && typeof scenario.passed === "boolean") checks[key] = scenario.passed;
    }

    workerRetainedResult = await retainedWorker(serviceB);
    markPhases("deltas", workerRetainedResult.stats);
    phaseWorkerMemory.warmRetained = summarizeWorkerMemory(workerRetainedResult.stats);
    const coldResumeBaselineStepCount = deltas.finalStepCount;
    if (globalThis.gc) globalThis.gc();
    await sleep(150);
    const hostRetained = hostMemory();
    const hostPeaks = await hostSampler.stop();
    hostSampler = null;
    await probes.stop();
    const probeSamples = probes.samples;
    probes = null;

    const coldResumeGapStarted = performance.now();
    await serviceB.close();
    current.service = null;
    await server.close();
    server = null;
    const hostAfterClose = hostMemory();

    const cold = await measureColdResume({
      mode,
      dbPath,
      targetSessionId: selection.internal.deltaTargetSessionId,
      anchorMs,
      snapshotPath,
      root,
      modules,
      durations,
      baselineStepCount: coldResumeBaselineStepCount,
      inactivityStarted: coldResumeGapStarted,
    });
    if (cold.workerBefore) markPhases("coldResumeBefore", cold.workerBefore);
    if (cold.workerAfter) {
      markPhases("coldResumeAfter", cold.workerAfter);
      phaseWorkerMemory.coldResume = summarizeWorkerMemory(cold.workerAfter);
    }
    const coldResume = cold.result;
    if (typeof coldResume.passed === "boolean") checks.coldResumeDeltaPassed = coldResume.passed;

    const indexIdle = summarize(probeSamples.idle.index);
    const indexActive = summarize(probeSamples.active.index);
    const indexDelta = summarize(probeSamples.delta.index);
    const healthIdle = summarize(probeSamples.idle.health);
    const healthActive = summarize(probeSamples.active.health);
    const healthDelta = summarize(probeSamples.delta.health);
    checks.httpIndexNoFailures = indexActive.failures === 0 && indexDelta.failures === 0;
    checks.httpHealthNoFailures = healthActive.failures === 0 && healthDelta.failures === 0;

    const retainedStats = workerRetainedResult.stats;
    const warmBaselineStats = workerWarmBefore;
    const retainedDeltaBytes =
      retainedStats && warmBaselineStats ? retainedStats.heapUsed - warmBaselineStats.heapUsed : 0;
    const retainedDeltaMiB = toMiB(retainedDeltaBytes);
    checks.workerRetainedBounded = retainedStats !== null && retainedDeltaMiB <= memoryCapMiB;

    const workerSummaries = [
      summarizeWorkerMemory(workerBefore),
      summarizeWorkerMemory(workerAfterCold),
      summarizeWorkerMemory(workerAfterLifetime),
      summarizeWorkerMemory(warmBaselineStats),
      summarizeWorkerMemory(retainedStats),
    ].filter((value) => value !== null);
    const peakHeapUsedMiB = maxNumber(
      ...workerSummaries.map((value) => Math.max(value.heapUsedMiB, value.peakHeapUsedMiB)),
    );
    const peakRssMiB = maxNumber(
      ...workerSummaries.map((value) => Math.max(value.rssMiB, value.peakRssMiB)),
    );

    const phaseIntervals = {
      cold7d: diffPhaseSnapshots(phaseMarks.before, phaseMarks.cold7d),
      extension30d: diffPhaseSnapshots(phaseMarks.cold7d, phaseMarks.extension30d),
      lifetimeHome: diffPhaseSnapshots(phaseMarks.extension30d, phaseMarks.lifetimeHome),
      projectDense30d: diffPhaseSnapshots(phaseMarks.lifetimeHome, phaseMarks.projectDense30d),
      projectLongLifetime: diffPhaseSnapshots(
        phaseMarks.projectDense30d,
        phaseMarks.projectLongLifetime,
      ),
      largeTreeSession: diffPhaseSnapshots(
        phaseMarks.projectLongLifetime,
        phaseMarks.largeTreeSession,
      ),
      subSession: diffPhaseSnapshots(phaseMarks.largeTreeSession, phaseMarks.subSession),
      warmReopenHome7d: diffPhaseSnapshots(phaseMarks.warmBefore, phaseMarks.warmReopenHome7d),
      warmReopenProject30d: diffPhaseSnapshots(
        phaseMarks.warmReopenHome7d,
        phaseMarks.warmReopenProject30d,
      ),
      warmSwitches: diffPhaseSnapshots(phaseMarks.warmReopenProject30d, phaseMarks.warmSwitches),
      deltas: diffPhaseSnapshots(phaseMarks.warmSwitches, phaseMarks.deltas),
      coldResume: diffPhaseSnapshots(phaseMarks.coldResumeBefore, phaseMarks.coldResumeAfter),
    };
    const phases = {
      available: Object.values(phaseMarks).some((value) => value !== null),
      attribution: "interval-between-cumulative-stats-marks",
      semantics:
        "Production reports cumulative fixed-label phase timings. The suite differences adjacent stats marks taken outside timed calls. Asynchronous persistence or aggregation started by earlier work can land in a later interval, so an interval total is not an exclusive per-call breakdown. Cache hits and queueing are excluded by production.",
      labels: WORKER_PHASE_LABELS,
      intervals: phaseIntervals,
      marks: phaseMarks,
    };

    return {
      name,
      mode,
      source:
        mode === "synthetic"
          ? {
              kind: "synthetic",
              access: "disposable-temp-write",
              queryOnly: null,
              mutations: "generated-temp-db",
              counts: {
                sessions: synthetic.sessions,
                assistantRows: synthetic.rows,
                projects: synthetic.projects,
                spanDays: synthetic.spanDays,
              },
            }
          : {
              kind: "real-local",
              access: "read-only",
              queryOnly: sourceAccess?.queryOnly === true,
              mutations: "none",
              externalWriterPossible: true,
              counts: sourceCounts,
            },
      synthetic,
      selected: selection.summary,
      durationsMs: durations,
      phases,
      warmSwitches,
      deltas,
      coldResume,
      http: {
        loopback: true,
        index: { idle: indexIdle, active: indexActive, delta: indexDelta },
        health: { idle: healthIdle, active: healthActive, delta: healthDelta },
      },
      memory: {
        host: {
          baselineRssMiB: toMiB(hostBaseline.rss),
          retainedHeapUsedMiB: toMiB(hostRetained.heapUsed),
          retainedDeltaMiB: toMiB(hostRetained.heapUsed - hostBaseline.heapUsed),
          peakHeapUsedMiB: toMiB(hostPeaks.peakHeap),
          peakRssMiB: toMiB(hostPeaks.peakRss),
          afterCloseRssMiB: toMiB(hostAfterClose.rss),
          afterCloseHeapUsedMiB: toMiB(hostAfterClose.heapUsed),
        },
        worker: {
          before: summarizeWorkerMemory(workerBefore),
          afterCold: summarizeWorkerMemory(workerAfterCold),
          afterLifetime: summarizeWorkerMemory(workerAfterLifetime),
          afterScopes: phaseWorkerMemory.scopes ?? null,
          warmBefore: summarizeWorkerMemory(warmBaselineStats),
          retained: summarizeWorkerMemory(retainedStats),
          retainedDeltaMiB,
          peakHeapUsedMiB,
          peakRssMiB,
          gcAvailable: workerRetainedResult.gcAvailable,
          capTargetMiB: memoryCapMiB,
          withinCap: checks.workerRetainedBounded,
        },
        phases: phaseWorkerMemory,
      },
      persistence: {
        snapshotBytes,
        presentationBytes,
        snapshotWritten: checks.persistenceSnapshotWritten,
      },
      payload: {
        coldHomeJsonBytes: JSON.stringify(coldSnapshot).length,
        lifetimeHomeJsonBytes: JSON.stringify(lifetimeSnapshot).length,
        largeTreeJsonBytes: JSON.stringify(largeTreeSnapshot).length,
      },
      checks,
      limitations:
        mode === "synthetic"
          ? [
              "Synthetic database, clock offsets, token distributions, and identifiers; no real OpenCode source is read.",
              "The installed schema may not index session_message.time_updated, so timestamp/revision passes can scan SQLite rather than an index. Results describe installed-schema behavior.",
              "Project/session measurements use the production global revision pass, including cross-scope fork-owner discovery; the runner does not filter or synthesize scope.",
              "Wall-clock samples are single-run evidence; compare before/after on the same machine and runtime.",
              "Host memory peak values are the maximum of 25 ms samples, not true process peaks.",
              "GET / and GET /api/v1/health are real loopback HTTP probes; they do not execute dashboard analytics reads.",
              "Worker RSS is process-wide for Node worker threads; heap/arrayBuffers are per-isolate after best-effort GC.",
              "Phase counters are cumulative; interval totals are not exclusive per-call attribution. See docs/performance/README.md.",
              "Cold resume copies the persisted snapshot and shifts only its sourceCursorAtMs and lastFullRepairAtMs back two days in the isolated copy; source row timestamps are unchanged. The actual wall-clock gap is reported; this is not a two-day wall-clock pause. The older live-service twoDay delta is not a cold resume.",
            ]
          : [
              "Real-local mode is read-only and emits anonymous aggregate counts/timings only.",
              "Real-local selection uses assistant-row counts as a workload proxy; titles, names, paths, contents, and identifiers are never emitted.",
              "The selector verifies PRAGMA query_only on a read-only connection, but a live source can be changed by external writers. The benchmark never writes to or hashes the live source.",
              "The installed schema may not index session_message.time_updated, so timestamp/revision passes can scan SQLite rather than an index. Results describe installed-schema behavior.",
              "Project/session measurements use the production global revision pass, including cross-scope fork-owner discovery; the runner does not filter or synthesize scope.",
              "External OpenCode activity can change a no-change delta; the benchmark itself never writes.",
              "No cold-resume scenario runs in real-local mode because the source is never mutated.",
              "Host memory peak values are the maximum of 25 ms samples, not true process peaks.",
              "GET / and GET /api/v1/health are real loopback HTTP probes; they do not execute dashboard analytics reads.",
              "Phase counters are cumulative; interval totals are not exclusive per-call attribution. See docs/performance/README.md.",
            ],
    };
  } finally {
    if (hostSampler) await hostSampler.stop().catch(() => undefined);
    if (probes) await probes.stop().catch(() => undefined);
    if (current.service) await current.service.close().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
  }
}

async function runSyntheticSuite(options, modules) {
  const profiles = [];
  const overrides = denseOverrides();
  for (const name of options.profiles) {
    const root = benchmarkTempRoot();
    const anchorMs = Date.now();
    const restoreEnvironment = isolateEnvironment(root, join(root, "opencode.db"));
    try {
      const fixture = await createSyntheticDatabase({
        profileName: name,
        root,
        anchorMs,
        overrides: name === "dense-30d" ? overrides : {},
      });
      const profile = await executeProfile({
        name,
        mode: "synthetic",
        dbPath: fixture.dbPath,
        anchorMs,
        root,
        modules,
        memoryCapMiB: options.memoryCapMiB,
        selection: fixture.selection,
        synthetic: fixture.synthetic,
        sourceCounts: null,
      });
      profiles.push(profile);
    } finally {
      restoreEnvironment();
      removeTempRoot(root);
    }
  }
  return profiles;
}

async function runRealLocal(options, modules) {
  const root = benchmarkTempRoot();
  let restoreEnvironment = () => {};
  try {
    const dbPath = resolveRealSource(modules.getOpenCodeDbPath);
    restoreEnvironment = isolateEnvironment(root, dbPath);
    const anchorMs = Date.now();
    const real = await selectRealSource(dbPath, anchorMs);
    const profile = await executeProfile({
      name: "real-local",
      mode: "real-local",
      dbPath,
      anchorMs,
      root,
      modules,
      memoryCapMiB: options.memoryCapMiB,
      selection: real.selection,
      synthetic: null,
      sourceCounts: real.counts,
      sourceAccess: real.access,
    });
    return [profile];
  } finally {
    restoreEnvironment();
    removeTempRoot(root);
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`benchmark failed: ${safeErrorCode(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let keepalive = null;
  let watchdog = null;
  try {
    // Production unrefs the analytics worker. Once the probes/server close, an
    // unref'd worker alone cannot keep this CLI alive while an awaited
    // cold-resume request is pending. This bounded interval is the only
    // benchmark-owned referenced handle; finally clears it.
    keepalive = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);
    watchdog = setTimeout(() => {
      process.stderr.write("benchmark failed: suite-timeout\n");
      for (const root of activeTempRoots) removeTempRoot(root);
      process.exit(1);
    }, suiteTimeoutMs());
    const modules = await loadDistModules(repoRoot);
    const profiles = options.realLocal
      ? await runRealLocal(options, modules)
      : await runSyntheticSuite(options, modules);
    const result = {
      schemaVersion: 1,
      suite: "analytics-benchmark",
      mode: options.realLocal ? "real-local" : "synthetic",
      environment: {
        runtime,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      instrumentation: buildInstrumentation(profiles),
      profiles,
      limitations: [
        "Single-process benchmark; no external load generator or multi-user concurrency.",
        "Synthetic profiles are deterministic, but measured times depend on machine, runtime, and filesystem cache.",
        "Installed sources may lack a session_message.time_updated index; timestamp/revision filtering can scan SQLite. The suite does not add indexes or claim an indexed best case.",
        "The production global revision pass and cross-scope fork-owner discovery are preserved; the runner does not filter or fake scope.",
        "Real-local output is aggregate only and is not persisted by default.",
      ],
    };
    assertSanitized(result);
    if (options.jsonOut) {
      const outputPath = resolve(options.jsonOut);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stderr.write(`${printHumanTable(result)}\n`);
    } else {
      process.stdout.write(`${printHumanTable(result)}\n`);
    }
    const failed = profiles.flatMap((profile) =>
      Object.entries(profile.checks)
        .filter(([, value]) => value === false)
        .map(([name]) => `${profile.name}.${name}`),
    );
    if (failed.length > 0) {
      process.stderr.write(`Failed checks: ${failed.join(", ")}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const code = safeErrorCode(error);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, suite: "analytics-benchmark", error: { code } }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`benchmark failed: ${code}\n`);
    }
    process.exitCode = 1;
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (watchdog) clearTimeout(watchdog);
  }
}

main().catch((error) => {
  process.stderr.write(`benchmark failed: ${safeErrorCode(error)}\n`);
  process.exitCode = 1;
});
