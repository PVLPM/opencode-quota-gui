/**
 * Shared harness for the analytics benchmark: built-module loading, lifecycle,
 * loopback probes, memory samples, percentiles, sanitization, and the human
 * table. The benchmark deliberately talks to the same worker and HTTP server
 * production uses; analytics code is real, while quota/provider and settings
 * inputs are in-memory stubs.
 */
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const MIB = 1_048_576;

/** Fixed labels exposed by the worker's privacy-safe cumulative phase metrics. */
export const WORKER_PHASE_LABELS = [
  "presentationLoad",
  "indexLoad",
  "metadataRead",
  "revisionDiscovery",
  "historicalPayloadRead",
  "changedPayloadRead",
  "modelUpdate",
  "dtoAggregation",
  "persistenceWrite",
];

export class BenchError extends Error {
  constructor(code) {
    super(code);
    this.name = "BenchError";
    this.code = code;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

export function summarize(samples) {
  const valid = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    samples: samples.length,
    failures: samples.length - valid.length,
    p50Ms: percentile(valid, 0.5),
    p95Ms: percentile(valid, 0.95),
    maxMs: valid.length ? Number(valid[valid.length - 1].toFixed(2)) : null,
  };
}

export function hostMemory() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

export function toMiB(value) {
  return Number((value / MIB).toFixed(1));
}

export function formatMiB(value) {
  return `${toMiB(value).toFixed(1)} MiB`;
}

export function formatMs(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${Number(value).toFixed(value >= 1000 ? 0 : 1)} ms`;
}

export function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "n/a";
}

export function phaseSnapshot(stats) {
  if (!stats || typeof stats.phases !== "object" || stats.phases === null) return null;
  const snapshot = {};
  let sawAny = false;
  for (const label of WORKER_PHASE_LABELS) {
    const entry = stats.phases[label];
    if (entry && typeof entry === "object") {
      sawAny = true;
      snapshot[label] = {
        count: Number(entry.count) || 0,
        totalMs: Number(entry.totalMs) || 0,
      };
    } else {
      snapshot[label] = { count: 0, totalMs: 0 };
    }
  }
  return sawAny ? snapshot : null;
}

export function diffPhaseSnapshots(before, after) {
  if (!before || !after) return null;
  const labels = {};
  let totalMs = 0;
  for (const label of WORKER_PHASE_LABELS) {
    const start = before[label] ?? { count: 0, totalMs: 0 };
    const end = after[label] ?? start;
    const count = Math.max(0, end.count - start.count);
    const elapsed = Math.max(0, end.totalMs - start.totalMs);
    labels[label] = { count, totalMs: Number(elapsed.toFixed(2)) };
    totalMs += elapsed;
  }
  return { totalMs: Number(totalMs.toFixed(2)), labels };
}

export function summarizeWorkerMemory(stats) {
  if (!stats) return null;
  return {
    heapUsedMiB: toMiB(stats.heapUsed),
    heapTotalMiB: toMiB(stats.heapTotal),
    rssMiB: toMiB(stats.rss),
    externalMiB: toMiB(stats.external),
    arrayBuffersMiB: toMiB(stats.arrayBuffers),
    peakHeapUsedMiB: toMiB(stats.peakHeapUsed ?? stats.heapUsed),
    peakRssMiB: toMiB(stats.peakRss ?? stats.rss),
  };
}

export async function workerStats(service) {
  try {
    return (await service.stats?.()) ?? null;
  } catch {
    return null;
  }
}

/** GC and sample retained worker memory, returning the lowest observed heap. */
export async function retainedWorker(service) {
  let gcAvailable = false;
  let best = (await workerStats(service)) ?? null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      gcAvailable = (await service.gc?.()) || gcAvailable;
    } catch {
      // Best effort.
    }
    await sleep(250);
    const sample = await workerStats(service);
    if (sample && (!best || sample.heapUsed < best.heapUsed)) best = sample;
  }
  return { stats: best, gcAvailable };
}

export function createSettingsStub() {
  return {
    settings: async () => ({
      revision: "bench",
      pathLabel: "bench",
      values: {},
      sources: {},
      writable: [],
      dashboard: { port: 0, url: "" },
      visibility: { hiddenCards: [], hiddenRows: [] },
      import: { available: false, from: "bench", keyCount: 0, issues: [] },
      issues: [],
    }),
    saveSettings: async () => ({ revision: "bench", applied: {}, warnings: [] }),
    saveVisibility: async () => ({ revision: "bench", applied: {}, warnings: [] }),
    importPreview: async () => ({
      from: "bench",
      keys: [],
      issues: [],
      expectedRevision: "bench",
    }),
    importApply: async () => ({ revision: "bench", applied: {}, warnings: [] }),
  };
}

export async function loadDistModules(repoRoot) {
  const paths = {
    service: `${repoRoot}/dist/gui/analytics-service.js`,
    server: `${repoRoot}/dist/gui/server.js`,
    snapshots: `${repoRoot}/dist/gui/snapshot-service.js`,
    logger: `${repoRoot}/dist/gui/log.js`,
    dbPath: `${repoRoot}/dist/lib/opencode-db-path.js`,
    worker: `${repoRoot}/dist/gui/analytics-worker.js`,
  };
  const missing = Object.entries(paths)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  if (missing.length > 0) throw new BenchError("dist-missing");
  const [service, server, snapshots, logger, dbPath] = await Promise.all([
    import(pathToFileURL(paths.service).href),
    import(pathToFileURL(paths.server).href),
    import(pathToFileURL(paths.snapshots).href),
    import(pathToFileURL(paths.logger).href),
    import(pathToFileURL(paths.dbPath).href),
  ]);
  return {
    createAnalyticsReadService: service.createAnalyticsReadService,
    createDashboardServer: server.createDashboardServer,
    createSnapshotService: snapshots.createSnapshotService,
    createGuiLogger: logger.createGuiLogger,
    getOpenCodeDbPath: dbPath.getOpenCodeDbPath,
    workerPath: paths.worker,
  };
}

export function createAnalyticsService(modules, options) {
  return modules.createAnalyticsReadService({
    snapshotPath: options.snapshotPath,
    refreshIntervalMs: options.refreshIntervalMs,
    requestTimeoutMs: options.requestTimeoutMs,
    logger: modules.createGuiLogger({ sink: () => {} }),
  });
}

export async function startDashboard(options) {
  const { modules, getService, assetRoot } = options;
  const source = {
    home: (input) => requireService(getService()).home(input),
    project: (input) => requireService(getService()).project(input),
    session: (input) => requireService(getService()).session(input),
    quota: async () => ({
      generatedAtMs: Date.now(),
      stale: false,
      providers: { cards: [], enabledProviders: [], polledAtMs: Date.now() },
    }),
    refreshAnalytics: () => requireService(getService()).refresh(),
    close: async () => {
      const service = getService();
      if (service) await service.close();
    },
  };
  const logger = modules.createGuiLogger({ sink: () => {} });
  const snapshots = modules.createSnapshotService({
    source,
    analyticsIntervalMs: 3_600_000,
    quotaIntervalMs: 3_600_000,
    logger,
  });
  let server;
  try {
    server = await modules.createDashboardServer({
      port: 0,
      snapshots,
      settings: createSettingsStub(),
      assetRoot,
      logger,
    });
  } catch (error) {
    snapshots.close();
    try {
      await source.close();
    } catch {
      // Keep the original start failure.
    }
    throw error;
  }
  let closing;
  return {
    ...server,
    close: () => {
      if (closing === undefined) {
        closing = (async () => {
          try {
            await server.close();
          } finally {
            snapshots.close();
            try {
              await source.close();
            } catch {
              // The benchmark already completed; source cleanup is best effort.
            }
          }
        })();
      }
      return closing;
    },
  };
}

function requireService(service) {
  if (!service) throw new BenchError("service-unavailable");
  return service;
}

/**
 * Sequential loopback probes. GET / and GET /api/v1/health are sampled into
 * separate arrays so their percentiles are never conflated.
 */
export function startHttpProbes(baseUrl, intervalMs = 20) {
  const samples = {
    idle: { index: [], health: [] },
    active: { index: [], health: [] },
    delta: { index: [], health: [] },
  };
  let phase = "idle";
  let running = true;
  const task = (async () => {
    while (running) {
      const bucket = samples[phase] ?? samples.active;
      await probe(bucket.index, `${baseUrl}/`, intervalMs);
      await probe(bucket.health, `${baseUrl}/api/v1/health`, intervalMs);
    }
  })();
  return {
    samples,
    setPhase(next) {
      if (samples[next]) phase = next;
    },
    async stop() {
      running = false;
      await task;
    },
  };
}

async function probe(samples, url, intervalMs) {
  const started = performance.now();
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error("status");
    samples.push(Number((performance.now() - started).toFixed(2)));
  } catch {
    samples.push(Number.NaN);
  }
  await sleep(intervalMs);
}

export function startHostSampler() {
  let running = true;
  let peakRss = hostMemory().rss;
  let peakHeap = hostMemory().heapUsed;
  const task = (async () => {
    while (running) {
      const usage = hostMemory();
      if (usage.rss > peakRss) peakRss = usage.rss;
      if (usage.heapUsed > peakHeap) peakHeap = usage.heapUsed;
      await sleep(25);
    }
  })();
  return {
    async stop() {
      running = false;
      await task;
      return { peakRss, peakHeap };
    },
  };
}

const ALLOWED_ERROR_CODES = new Set([
  "bad-request",
  "project-not-found",
  "session-not-found",
  "unavailable",
  "closed",
  "timeout",
  "dist-missing",
  "real-source-missing",
  "real-source-empty",
  "real-source-unsupported",
  "sanitization-failed",
  "service-unavailable",
  "unknown-profile",
  "unknown-delta",
]);

export function safeErrorCode(error) {
  if (error && typeof error.code === "string" && ALLOWED_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  return "internal-error";
}

const PRIVATE_PATTERNS = [
  /[A-Za-z]:[\\/]/,
  /(?:^|[^A-Za-z])[\\/](?:Users|home|root|tmp)[\\/]/,
  /\b(?:ses|msg|proj)_[A-Za-z0-9]/,
];

/** Refuse to emit output that could carry ids, paths, titles, or contents. */
export function assertSanitized(value) {
  const text = JSON.stringify(value);
  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(text)) throw new BenchError("sanitization-failed");
  }
}

export function printHumanTable(result) {
  const lines = [];
  const instrumentation = result.instrumentation;
  lines.push(
    `Analytics benchmark (${result.mode}) | ${result.environment.runtime} ${result.environment.node} | ${result.environment.platform}/${result.environment.arch}`,
  );
  lines.push(
    `Worker phase instrumentation: ${instrumentation.available ? `available (${instrumentation.source})` : `unavailable (${instrumentation.reason})`}`,
  );
  for (const profile of result.profiles) {
    const duration = profile.durationsMs;
    const worker = profile.memory.worker;
    const http = profile.http;
    const deltas = profile.deltas;
    const source = profile.source;
    lines.push("");
    const sourceText =
      source.kind === "synthetic"
        ? `${formatNumber(profile.synthetic.rows)} rows / ${formatNumber(profile.synthetic.sessions)} sessions / ${formatNumber(profile.synthetic.projects)} projects / ${profile.synthetic.spanDays}d`
        : `real read-only / ${formatNumber(source.counts.sessions)} sessions / ${formatNumber(source.counts.assistantRows)} assistant rows / ${source.counts.projects} projects`;
    lines.push(`== ${profile.name} (${sourceText})`);
    lines.push(
      `  cold7d ${formatMs(duration.coldHome7d)} | extension30d ${formatMs(duration.extensionHome30d)} | lifetime ${formatMs(duration.lifetimeHome)}`,
    );
    lines.push(
      `  dense project 30d ${formatMs(duration.projectDense30d)} | long project lifetime ${formatMs(duration.projectLongLifetime)} | large tree ${formatMs(duration.largeTreeSession)} | subsession ${formatMs(duration.subSession)}`,
    );
    lines.push(
      `  warm switches ${formatMs(profile.warmSwitches.p50Ms)} p50 / ${formatMs(profile.warmSwitches.p95Ms)} p95 (${profile.warmSwitches.calls} calls)`,
    );
    lines.push(
      `  GET / p95 ${formatMs(http.index.active.p95Ms)} (${http.index.active.failures} fail) | health p95 ${formatMs(http.health.active.p95Ms)} (${http.health.active.failures} fail)`,
    );
    lines.push(
      `  worker retained ${worker.retained ? `${worker.retained.heapUsedMiB.toFixed(1)} MiB (delta ${worker.retainedDeltaMiB.toFixed(1)} MiB)` : "n/a"} | heap peak ${worker.peakHeapUsedMiB.toFixed(1)} MiB | rss peak ${worker.peakRssMiB.toFixed(1)} MiB`,
    );
    if (profile.phases?.available) {
      const interval = profile.phases.intervals;
      lines.push(
        `  phase intervals (incl. async work): cold ${formatMs(interval.cold7d?.totalMs)} | extension ${formatMs(interval.extension30d?.totalMs)} | lifetime ${formatMs(interval.lifetimeHome?.totalMs)} | deltas ${formatMs(interval.deltas?.totalMs)}`,
      );
    }
    const deltaText = Object.entries(deltas.scenarios)
      .map(([name, scenario]) => {
        if (scenario.status === "skipped") return `${name} skipped`;
        if (scenario.status === "not-mutated") {
          return `${name} ${scenario.observedStepDelta === 0 ? "stable" : `changed ${scenario.observedStepDelta}`}`;
        }
        return `${name} ${scenario.observedStepDelta}${scenario.passed ? "" : " FAIL"}`;
      })
      .join(" | ");
    lines.push(`  deltas: ${deltaText}`);
    if (profile.coldResume?.status === "applied") {
      lines.push(
        `  cold resume (${profile.coldResume.simulatedInactivityDays}d simulated, actual gap ${formatMs(profile.coldResume.actualInactivityMs)}): first ${formatMs(profile.coldResume.homeAfterRestartMs)} | refresh ${formatMs(profile.coldResume.refreshMs)} | after ${formatMs(profile.coldResume.homeAfterRefreshMs)} | delta ${profile.coldResume.observedStepDelta}${profile.coldResume.passed ? "" : " FAIL"}`,
      );
    } else if (profile.coldResume?.status) {
      lines.push(`  cold resume: ${profile.coldResume.status}`);
    }
    const failed = Object.entries(profile.checks)
      .filter(([, value]) => value === false)
      .map(([name]) => name);
    lines.push(`  checks: ${failed.length === 0 ? "pass" : `fail: ${failed.join(", ")}`}`);
  }
  return lines.join("\n");
}
