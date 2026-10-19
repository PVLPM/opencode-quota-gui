#!/usr/bin/env node
/**
 * Synthetic analytics integration benchmark (round 2).
 *
 * Builds a disposable SQLite database shaped like OpenCode 2's storage, runs
 * the real tsc-built analytics worker behind the real dashboard HTTP server
 * (`/` and `/api/v1/health`), and samples phase latency plus host/worker memory
 * (heap, external, arrayBuffers) at 120k rows. No real database, path,
 * credential, or project is read; every value is generated here.
 *
 * Usage: pnpm exec tsc && node scripts/benchmark-analytics.mjs
 *        pnpm exec tsc && bun scripts/benchmark-analytics.mjs
 * Env:   ANALYTICS_BENCH_SESSIONS (default 400)
 *        ANALYTICS_BENCH_STEPS (default 300 -> 120,000 rows)
 *        ANALYTICS_BENCH_MEMORY_CAP_MIB (default 100)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = mkdtempSync(join(tmpdir(), "ocq-analytics-bench-"));
const dbPath = join(root, "opencode.db");
const snapshotPath = join(root, "analytics-v3.json");
const assetRoot = join(root, "ui");
const workerPath = resolve("dist/gui/analytics-worker.js");
const runtime = typeof Bun !== "undefined" ? "bun" : "node";

// Node needs --expose-gc to measure retained heap honestly; re-exec once.
if (runtime === "node" && typeof globalThis.gc !== "function" && process.env.OCQ_BENCH_GC !== "1") {
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["--expose-gc", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, OCQ_BENCH_GC: "1" },
  });
  process.exit(child.status ?? 1);
}

if (!existsSync(workerPath)) {
  console.error("Missing dist worker. Run `pnpm exec tsc` first.");
  process.exit(2);
}

const sessionCount = Number(process.env.ANALYTICS_BENCH_SESSIONS ?? 400);
const stepsPerSession = Number(process.env.ANALYTICS_BENCH_STEPS ?? 300);
const memoryCapMiB = Number(process.env.ANALYTICS_BENCH_MEMORY_CAP_MIB ?? 100);
const projects = 6;
const now = Date.now();
const DAY = 24 * 3_600_000;
const MiB = 1_048_576;

async function openDatabase(path) {
  if (runtime === "bun") {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

async function buildDatabase() {
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(join(assetRoot, "index.html"), "<!doctype html><title>bench</title>ok");

  const db = await openDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, parent_id TEXT,
      project_id TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);
  `);

  const insertSession = db.prepare(
    "INSERT INTO session_v2 (id, title, parent_id, project_id, directory, time_created, time_updated) VALUES (?,?,?,?,?,?,?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
  );
  const insertProject = db.prepare("INSERT INTO project (id, name) VALUES (?,?)");

  db.exec("BEGIN");
  const sessionIds = [];
  for (let p = 0; p < projects; p += 1) insertProject.run(`proj_${p}`, `Project ${p}`);
  for (let s = 0; s < sessionCount; s += 1) {
    const project = `proj_${s % projects}`;
    const id = `ses_bench_${String(s).padStart(5, "0")}`;
    const created = now - (s % 30) * DAY - 3_600_000;
    insertSession.run(
      id,
      `Synthetic session ${s}`,
      null,
      project,
      `C:\\work\\${project}`,
      created,
      created + 1_000,
    );
    sessionIds.push(id);
  }
  for (let s = 0; s < sessionCount; s += 1) {
    const id = sessionIds[s];
    for (let m = 0; m < stepsPerSession; m += 1) {
      const completed = now - (s % 30) * DAY - ((m * 37) % 600) * 60_000;
      const created = completed - 5_000;
      const messageID = `msg_${String(s).padStart(5, "0")}_${String(m).padStart(4, "0")}`;
      const data = JSON.stringify({
        time: { created, completed },
        model: { providerID: "openai", id: "gpt-5" },
        tokens: {
          input: 100 + (m % 7) * 10,
          output: 20 + (m % 5),
          reasoning: 2,
          cache: { read: 30, write: 4 },
        },
        cost: 0.001 * (m + 1),
        agent: "build",
      });
      insertMessage.run(messageID, id, "assistant", created, completed, data);
    }
  }
  db.exec("COMMIT");
  db.close();
  return sessionIds;
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function summarize(samples) {
  const valid = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    samples: samples.length,
    failures: samples.length - valid.length,
    p50Ms: percentile(valid, 0.5),
    p95Ms: percentile(valid, 0.95),
    maxMs: valid.length ? Number(valid[valid.length - 1].toFixed(2)) : null,
  };
}

function hostMemory() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function toMiB(value) {
  return Number((value / MiB).toFixed(1));
}

async function sleep(ms) {
  return await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function createSettingsStub() {
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
    importPreview: async () => ({ from: "bench", keys: [], issues: [], expectedRevision: "bench" }),
    importApply: async () => ({ revision: "bench", applied: {}, warnings: [] }),
  };
}

async function main() {
  const sessionIds = await buildDatabase();
  process.env.OPENCODE_DB = dbPath;

  const [{ createAnalyticsReadService }, { createDashboardServer }, { createGuiLogger }] =
    await Promise.all([
      import("../dist/gui/analytics-service.js"),
      import("../dist/gui/server.js"),
      import("../dist/gui/log.js"),
    ]);

  const hostBaseline = hostMemory();
  const service = createAnalyticsReadService({
    snapshotPath,
    refreshIntervalMs: 600_000,
    requestTimeoutMs: 180_000,
    logger: createGuiLogger({ sink: () => {} }),
  });
  const workerStats = async () => {
    try {
      return (await service.stats?.()) ?? null;
    } catch {
      return null;
    }
  };

  const server = await createDashboardServer({
    port: 0,
    source: {
      home: (input) => service.home(input),
      project: (input) => service.project(input),
      session: (input) => service.session(input),
      quota: async () => ({
        generatedAtMs: Date.now(),
        stale: false,
        providers: { cards: [], enabledProviders: [], polledAtMs: Date.now() },
      }),
      refreshAnalytics: () => service.refresh(),
      close: () => service.close(),
    },
    settings: createSettingsStub(),
    assetRoot,
    analyticsIntervalMs: 600_000,
    logger: createGuiLogger({ sink: () => {} }),
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const result = {
    runtime,
    synthetic: {
      sessions: sessionCount,
      stepsPerSession,
      messages: sessionCount * stepsPerSession,
      projects,
      worker: "dist/gui/analytics-worker.js",
    },
    durationsMs: {},
    http: {},
    memory: {},
    checks: {},
    limitations: [],
  };

  const phaseMemory = {};
  const samplePhase = async (label, serviceRef = warmService) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await serviceRef.gc?.();
      await sleep(120);
    }
    const sample = (await serviceRef.stats?.()) ?? null;
    if (sample) {
      phaseMemory[label] = {
        heapUsedMiB: toMiB(sample.heapUsed),
        rssMiB: toMiB(sample.rss),
      };
    }
  };

  const workerBase = await workerStats();
  result.memory.workerBaseline = workerBase
    ? {
        heapUsedMiB: toMiB(workerBase.heapUsed),
        rssMiB: toMiB(workerBase.rss),
        externalMiB: toMiB(workerBase.external),
        arrayBuffersMiB: toMiB(workerBase.arrayBuffers),
      }
    : null;

  let sampling = true;
  let probePhase = "idle";
  let peakHostRss = hostMemory().rss;
  let peakHostHeap = hostMemory().heapUsed;
  let peakWorkerHeap = workerBase?.heapUsed ?? 0;
  let peakWorkerRss = workerBase?.rss ?? 0;
  const httpSamples = { idle: [], active: [] };

  const memorySampler = (async () => {
    let tick = 0;
    while (sampling) {
      const host = hostMemory();
      if (host.rss > peakHostRss) peakHostRss = host.rss;
      if (host.heapUsed > peakHostHeap) peakHostHeap = host.heapUsed;
      tick += 1;
      if (tick % 5 === 0) {
        const worker = await workerStats();
        if (worker) {
          if (worker.heapUsed > peakWorkerHeap) peakWorkerHeap = worker.heapUsed;
          if (worker.rss > peakWorkerRss) peakWorkerRss = worker.rss;
        }
      }
      await sleep(25);
    }
  })();

  const httpSampler = (async () => {
    while (sampling) {
      const started = performance.now();
      try {
        const [index, health] = await Promise.all([
          fetch(`${baseUrl}/`),
          fetch(`${baseUrl}/api/v1/health`),
        ]);
        await Promise.all([index.arrayBuffer(), health.arrayBuffer()]);
        if (index.status !== 200 || health.status !== 200) throw new Error("status");
        httpSamples[probePhase].push(performance.now() - started);
      } catch {
        httpSamples[probePhase].push(Number.NaN);
      }
      await sleep(20);
    }
  })();

  async function timed(name, job) {
    const started = performance.now();
    const value = await job();
    result.durationsMs[name] = Number((performance.now() - started).toFixed(2));
    return value;
  }

  await sleep(250);
  probePhase = "active";

  const coldHome = await timed("coldHome24h", () => service.home({ range: "24h" }));
  result.checks.coldProvidersEmpty =
    coldHome.providers.cards.length === 0 && coldHome.providers.enabledProviders.length === 0;
  result.hostPayload = { homeJsonBytes: JSON.stringify(coldHome).length };

  await service.close();
  const warmService = createAnalyticsReadService({
    snapshotPath,
    refreshIntervalMs: 600_000,
    requestTimeoutMs: 180_000,
    logger: createGuiLogger({ sink: () => {} }),
  });
  const warmHome = await timed("warmHome24h", () => warmService.home({ range: "24h" }));
  result.checks.warmProvidersEmpty = warmHome.providers.cards.length === 0;
  result.memory.warmHomeServedStale = warmHome.stale === true;
  await samplePhase("warmSidecarOnly");

  for (const range of ["24h", "7d", "30d", "lifetime"]) {
    await timed(`home_${range}`, () => warmService.home({ range }));
    await samplePhase(`home_${range}`);
  }
  await timed("project30d", () => warmService.project({ projectId: "proj_0", range: "30d" }));
  await samplePhase("project30d");
  await timed("sessionDetail", () => warmService.session({ sessionId: sessionIds[0] }));
  await samplePhase("sessionDetail");

  const beforeDelta = await warmService.home({ range: "24h" });
  const deltaRows = 25;
  const writer = await openDatabase(dbPath);
  writer.exec("BEGIN");
  const insert = writer.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
  );
  for (let index = 0; index < deltaRows; index += 1) {
    const completed = now - 60_000 + index;
    insert.run(
      `msg_delta_${index}`,
      sessionIds[0],
      "assistant",
      completed - 1_000,
      completed,
      JSON.stringify({
        time: { created: completed - 1_000, completed },
        model: { providerID: "openai", id: "gpt-5" },
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.0001,
      }),
    );
  }
  writer.exec("COMMIT");
  writer.close();

  await timed("deltaRefresh", () => warmService.refresh());
  const afterDelta = await timed("deltaHome24h", () => warmService.home({ range: "24h" }));
  result.checks.deltaStepCountGrew =
    afterDelta.usage.stepCount >= beforeDelta.usage.stepCount + deltaRows;

  await timed("rapidMixed", () =>
    Promise.all([
      warmService.home({ range: "24h" }),
      warmService.home({ range: "7d" }),
      warmService.home({ range: "30d" }),
      warmService.project({ projectId: "proj_1", range: "7d" }),
      warmService.session({ sessionId: sessionIds[0] }),
      warmService.refresh(),
    ]),
  );

  // Idle settle: retained = after explicit GC where the runtime exposes it,
  // so the cap measures live state rather than V8 garbage.
  await sleep(1_500);
  let gcAvailable = false;
  let workerRetained = (await warmService.stats?.()) ?? null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    gcAvailable = (await warmService.gc?.()) ?? gcAvailable;
    await sleep(250);
    const sample = await warmService.stats?.();
    if (sample && (!workerRetained || sample.heapUsed < workerRetained.heapUsed)) {
      workerRetained = sample;
    }
  }
  if (globalThis.gc) globalThis.gc();
  await sleep(100);
  const workerRetainedAfterGc = (await warmService.stats?.()) ?? null;
  if (
    workerRetainedAfterGc &&
    (!workerRetained || workerRetainedAfterGc.heapUsed < workerRetained.heapUsed)
  ) {
    workerRetained = workerRetainedAfterGc;
  }
  const hostRetained = hostMemory();
  result.memory.gcAvailable = gcAvailable || typeof globalThis.gc === "function";
  result.memory.phases = phaseMemory;

  sampling = false;
  await memorySampler;
  await httpSampler;
  result.http = {
    idle: summarize(httpSamples.idle),
    active: summarize(httpSamples.active),
  };

  // Close the worker while the HTTP listener still keeps the loop alive; the
  // bridge waits (bounded) for the engine's persistence drain. Closing the
  // server first can make a bare benchmark process exit before that promise
  // resolves because worker handles are intentionally unref'd.
  await warmService.close();
  await server.close();

  const hostAfterClose = hostMemory();
  result.memory.host = {
    baselineRssMiB: toMiB(hostBaseline.rss),
    retainedHeapUsedMiB: toMiB(hostRetained.heapUsed),
    retainedDeltaMiB: toMiB(hostRetained.heapUsed - hostBaseline.heapUsed),
    peakHeapUsedMiB: toMiB(peakHostHeap),
    peakRssMiB: toMiB(peakHostRss),
    afterCloseRssMiB: toMiB(hostAfterClose.rss),
    afterCloseHeapUsedMiB: toMiB(hostAfterClose.heapUsed),
  };
  result.memory.worker = workerRetained
    ? {
        retainedHeapUsedMiB: toMiB(workerRetained.heapUsed),
        retainedDeltaMiB: toMiB(workerRetained.heapUsed - (workerBase?.heapUsed ?? 0)),
        retainedRssMiB: toMiB(workerRetained.rss),
        retainedExternalMiB: toMiB(workerRetained.external),
        retainedArrayBuffersMiB: toMiB(workerRetained.arrayBuffers),
        peakHeapUsedMiB: toMiB(Math.max(peakWorkerHeap, workerRetained.peakHeapUsed ?? 0)),
        peakRssMiB: toMiB(Math.max(peakWorkerRss, workerRetained.peakRss ?? 0)),
      }
    : null;

  const workerRetainedDeltaMiB = workerRetained
    ? (workerRetained.heapUsed - (workerBase?.heapUsed ?? 0)) / MiB
    : Number.POSITIVE_INFINITY;
  result.checks.workerRetainedBounded = workerRetainedDeltaMiB <= memoryCapMiB;
  result.memory.capTargetMiB = memoryCapMiB;
  result.memory.workerRetainedDeltaMiB = Number(workerRetainedDeltaMiB.toFixed(1));

  result.limitations = [
    "Synthetic database, clock, and payloads; not a real OpenCode runtime.",
    "HTTP liveness uses the real dashboard server on loopback only.",
    "Worker-reported RSS is process-wide resident memory (Node worker threads share the process); heap/arrayBuffers are live-isolate samples after explicit GC.",
    `Runtime: ${runtime}; cross-runtime parity is sampled, not guaranteed.`,
  ];

  console.log(JSON.stringify(result, null, 2));

  const failed = Object.entries(result.checks).filter(([, value]) => value !== true);
  if (failed.length > 0) {
    console.error(`Failed checks: ${failed.map(([name]) => name).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
