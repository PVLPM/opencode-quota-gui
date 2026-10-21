import { describe, expect, it } from "vitest";
import type { HomeSnapshot } from "../src/contracts/dashboard.js";
import { planRangeBuckets } from "../src/contracts/ranges.js";
import {
  isValidTimeZone,
  nextZonedUnitStart,
  startOfZonedUnit,
} from "../src/contracts/time-zone.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import { createAnalyticsEngine } from "../src/gui/analytics-engine.js";
import type { AnalyticsReader } from "../src/gui/analytics-reader.js";
import type { WarmAnalyticsPresentation } from "../src/gui/analytics-state.js";
import type {
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
  OpenCodeSourceIdentity,
  OpenCodeStorageSnapshot,
  OpenCodeStorageSnapshotResult,
  ReadMessageRevisionsParams,
} from "../src/lib/opencode-storage.js";

/**
 * Production analytics resolves one IANA zone on the Node host and uses it for
 * every bucket boundary and DTO label. These tests pin that contract for DST
 * transitions, half-hour offsets, a skipped local midnight, lifetime ranges,
 * zone-aligned aggregation, and the engine's warm-DTO zone check. Every zone is
 * passed explicitly, so the host machine's own zone never leaks into a result.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NEW_YORK = "America/New_York";
const KOLKATA = "Asia/Kolkata";
const SANTIAGO = "America/Santiago";

const iso = (value: string): number => Date.parse(value);

function expectContiguous(buckets: readonly { startMs: number; endMs: number }[]): void {
  expect(buckets.length).toBeGreaterThan(0);
  for (let index = 1; index < buckets.length; index += 1) {
    expect(buckets[index]?.startMs).toBe(buckets[index - 1]?.endMs);
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function labelFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Local wall label of an epoch instant, read through Intl rather than guessed. */
function zonedLabel(ms: number, timeZone: string): string {
  const parts = labelFormatter(timeZone).formatToParts(new Date(ms));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "??";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

function utcMinutes(ms: number): number {
  return new Date(ms).getUTCMinutes();
}

// ---------------------------------------------------------------------------
// Minimal raw dataset fixtures (shape mirrors tests/gui.steps.test.ts)
// ---------------------------------------------------------------------------

const ZONE_MOMENT_MS = iso("2026-10-18T19:00:00.000Z");
const ZONE_NOW_MS = iso("2026-10-19T12:00:00.000Z");
const ENGINE_NOW_MS = ZONE_NOW_MS;

function makeDataset(opts: {
  atMs: number;
  sessionCreatedMs?: number;
  input?: number;
}): UsageAnalyticsDataset {
  const createdMs = opts.sessionCreatedMs ?? opts.atMs;
  const session: OpenCodeSessionInfo = {
    id: "ses_zone",
    title: "Zone session",
    projectID: "proj_zone",
    time: { created: createdMs, updated: opts.atMs },
  };
  const project: OpenCodeProjectInfo = {
    id: "proj_zone",
    name: "Zone project",
    directories: [],
    worktrees: [],
  };
  const message: OpenCodeRawAssistantRow = {
    sessionID: "ses_zone",
    messageID: "msg_zone",
    createdAtMs: opts.atMs,
    completedAtMs: opts.atMs,
    tokens: { input: opts.input ?? 123, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    sessions: { ses_zone: session },
    projects: { proj_zone: project },
    messages: [message],
    compactions: [],
  };
}

// ---------------------------------------------------------------------------
// Fake reader for the engine zone-mismatch integration test
// ---------------------------------------------------------------------------

interface ReadCounts {
  loadCompletedRows: number;
}

function sourceIdentity(): OpenCodeSourceIdentity {
  return {
    dbPath: "/db",
    exists: true,
    status: "ok",
    realPath: "/db",
    device: "1",
    inode: "10",
    birthtimeMs: 200,
    schemaToken: "session_v2(a)|session_message(a)",
    sizeBytes: 100,
    mtimeMs: 100,
  };
}

function createEngineReader(dataset: UsageAnalyticsDataset): {
  reader: AnalyticsReader;
  counts: ReadCounts;
} {
  const counts: ReadCounts = { loadCompletedRows: 0 };
  const identity = sourceIdentity();
  const rows = dataset.messages;

  const revisionsFor = (params: ReadMessageRevisionsParams) => {
    let selected = [...rows];
    if (params.sessionIDs !== undefined) {
      const ids = new Set(params.sessionIDs);
      selected = selected.filter((row) => ids.has(row.sessionID));
    }
    if (params.messageIDs !== undefined) {
      const ids = new Set(params.messageIDs);
      selected = selected.filter((row) => ids.has(row.messageID));
    }
    return selected.map((row) => ({
      messageID: row.messageID,
      sessionID: row.sessionID,
      type: "assistant",
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.completedAtMs,
      completedAtMs: row.completedAtMs,
    }));
  };

  const reader: AnalyticsReader = {
    async withSnapshot<T>(
      read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
    ): Promise<OpenCodeStorageSnapshotResult<T>> {
      const snapshot: OpenCodeStorageSnapshot = {
        dbPath: identity.dbPath,
        identity,
        readAllSessionsIndex: () => structuredClone(dataset.sessions),
        readProjectsIndex: () => structuredClone(dataset.projects),
        readCompletedAssistantRows: (params = {}) => {
          counts.loadCompletedRows += 1;
          let selected = [...rows];
          if (params.sessionIDs !== undefined) {
            const ids = new Set(params.sessionIDs);
            selected = selected.filter((row) => ids.has(row.sessionID));
          }
          if (params.messageIDs !== undefined) {
            const ids = new Set(params.messageIDs);
            selected = selected.filter((row) => ids.has(row.messageID));
          }
          if (params.completedAtTimes !== undefined) {
            const times = new Set(params.completedAtTimes);
            selected = selected.filter((row) => times.has(row.completedAtMs));
          }
          const sinceMs = params.completedSinceMs;
          if (sinceMs !== undefined) {
            selected = selected.filter((row) => row.completedAtMs >= sinceMs);
          }
          const untilMs = params.completedUntilMs;
          if (untilMs !== undefined) {
            selected = selected.filter((row) => row.completedAtMs <= untilMs);
          }
          return selected.map((row) => ({ ...row, tokens: { ...row.tokens } }));
        },
        readCompactionMarkers: () => [],
        readMessageRevisions: (params = {}) => ({
          available: true,
          updatedAtAvailable: true,
          completedAtAvailable: true,
          revisions: revisionsFor(params),
        }),
        readMessageRevisionFrontier: () => ({
          available: true,
          updatedAtAvailable: true,
          maxUpdatedAtMs: rows.reduce<number | null>(
            (max, row) => (max === null || row.completedAtMs > max ? row.completedAtMs : max),
            null,
          ),
        }),
      };
      return { status: "ok", value: await read(snapshot) };
    },
  };
  return { reader, counts };
}

function warmPresentation(
  dataset: UsageAnalyticsDataset,
  timeZone: string,
  nowMs: number,
): WarmAnalyticsPresentation {
  const home = createUsageAnalytics(dataset, { timeZone }).home("7d", nowMs);
  const snapshot: HomeSnapshot = {
    generatedAtMs: nowMs,
    range: "7d",
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: nowMs },
    usage: home.usage,
    projects: home.projects,
  };
  return {
    home: { "7d": snapshot },
    project: [],
    sourceIdentity: sourceIdentity(),
    savedAtMs: nowMs,
    frontierAtMs: nowMs,
    coverage: { sinceMs: nowMs - 7 * DAY_MS, untilMs: nowMs },
  };
}

function createZoneEngine(dataset: UsageAnalyticsDataset, presentation: WarmAnalyticsPresentation) {
  const { reader, counts } = createEngineReader(dataset);
  const engine = createAnalyticsEngine({
    reader,
    now: () => ENGINE_NOW_MS,
    timeZone: KOLKATA,
    refreshIntervalMs: 10 * 365 * DAY_MS,
    snapshotPath: "memory.json",
    loadSnapshot: async () => undefined,
    saveSnapshot: async () => true,
    loadPresentation: async () => presentation,
    savePresentation: async () => true,
  });
  return { engine, counts };
}

// ---------------------------------------------------------------------------
// Zone validation
// ---------------------------------------------------------------------------

describe("isValidTimeZone", () => {
  it("rejects empty, unknown, and non-string zones and accepts real IANA zones", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone({ timeZone: "UTC" })).toBe(false);

    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone(KOLKATA)).toBe(true);
    expect(isValidTimeZone(NEW_YORK)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Spring forward: America/New_York, 2026-03-08
// ---------------------------------------------------------------------------

describe("America/New_York spring-forward (2026-03-08)", () => {
  const nowMs = iso("2026-03-08T12:00:00.000Z");

  it("starts the local day at 05:00Z and keeps 24 contiguous hourly buckets", () => {
    const dayStart = startOfZonedUnit(nowMs, "day", NEW_YORK);
    expect(dayStart).toBe(iso("2026-03-08T05:00:00.000Z"));
    expect(zonedLabel(dayStart, NEW_YORK)).toBe("2026-03-08 00:00");

    // Intl confirms the instants around the skipped hour before relying on them.
    expect(zonedLabel(iso("2026-03-08T06:00:00.000Z"), NEW_YORK)).toBe("2026-03-08 01:00");
    expect(zonedLabel(iso("2026-03-08T07:00:00.000Z"), NEW_YORK)).toBe("2026-03-08 03:00");

    const buckets = planRangeBuckets("24h", nowMs, undefined, { timeZone: NEW_YORK });
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.startMs).toBe(nowMs - DAY_MS);
    expect(buckets[buckets.length - 1]?.endMs).toBe(nowMs);
    expectContiguous(buckets);

    const labels = buckets.map((bucket) => zonedLabel(bucket.startMs, NEW_YORK));
    expect(labels).toContain("2026-03-08 01:00");
    expect(labels).toContain("2026-03-08 03:00");
    expect(labels.some((label) => label.endsWith(" 02:00"))).toBe(false);
  });

  it("plans the spring-forward local day as a 23-hour daily bucket", () => {
    const dayStart = startOfZonedUnit(nowMs, "day", NEW_YORK);
    expect(nextZonedUnitStart(dayStart, "day", NEW_YORK)).toBe(iso("2026-03-09T04:00:00.000Z"));
    expect(iso("2026-03-09T04:00:00.000Z") - dayStart).toBe(23 * HOUR_MS);

    const week = planRangeBuckets("7d", iso("2026-03-09T12:00:00.000Z"), undefined, {
      timeZone: NEW_YORK,
    });
    const bucket = week.find((entry) => entry.startMs === dayStart);
    expect(bucket).toBeDefined();
    expect((bucket?.endMs ?? 0) - (bucket?.startMs ?? 0)).toBe(23 * HOUR_MS);
  });
});

// ---------------------------------------------------------------------------
// Fall back: America/New_York, 2026-11-01
// ---------------------------------------------------------------------------

describe("America/New_York fall-back (2026-11-01)", () => {
  it("floors each pass of the repeated 01:xx hour to its own occurrence", () => {
    const firstPass = iso("2026-11-01T05:30:00.000Z");
    const secondPass = iso("2026-11-01T06:30:00.000Z");
    // Both instants share the same wall label; only their UTC offsets differ.
    expect(zonedLabel(firstPass, NEW_YORK)).toBe("2026-11-01 01:30");
    expect(zonedLabel(secondPass, NEW_YORK)).toBe("2026-11-01 01:30");

    expect(startOfZonedUnit(firstPass, "hour", NEW_YORK)).toBe(iso("2026-11-01T05:00:00.000Z"));
    expect(startOfZonedUnit(secondPass, "hour", NEW_YORK)).toBe(iso("2026-11-01T06:00:00.000Z"));
  });

  it("keeps 24 contiguous hourly buckets and emits both 01:00 occurrences", () => {
    const nowMs = iso("2026-11-01T12:00:00.000Z");
    const buckets = planRangeBuckets("24h", nowMs, undefined, { timeZone: NEW_YORK });
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.startMs).toBe(nowMs - DAY_MS);
    expect(buckets[buckets.length - 1]?.endMs).toBe(nowMs);
    expectContiguous(buckets);

    const repeated = buckets
      .filter((bucket) => zonedLabel(bucket.startMs, NEW_YORK) === "2026-11-01 01:00")
      .map((bucket) => bucket.startMs);
    expect(repeated).toEqual([iso("2026-11-01T05:00:00.000Z"), iso("2026-11-01T06:00:00.000Z")]);
  });

  it("plans the fall-back local day as a 25-hour daily bucket", () => {
    const dayStart = startOfZonedUnit(iso("2026-11-01T12:00:00.000Z"), "day", NEW_YORK);
    expect(dayStart).toBe(iso("2026-11-01T04:00:00.000Z"));
    expect(zonedLabel(dayStart, NEW_YORK)).toBe("2026-11-01 00:00");
    expect(nextZonedUnitStart(dayStart, "day", NEW_YORK)).toBe(iso("2026-11-02T05:00:00.000Z"));

    const week = planRangeBuckets("7d", iso("2026-11-02T12:00:00.000Z"), undefined, {
      timeZone: NEW_YORK,
    });
    const bucket = week.find((entry) => entry.startMs === dayStart);
    expect(bucket).toBeDefined();
    expect((bucket?.endMs ?? 0) - (bucket?.startMs ?? 0)).toBe(25 * HOUR_MS);
  });
});

// ---------------------------------------------------------------------------
// Half-hour offset: Asia/Kolkata (UTC+05:30, no DST)
// ---------------------------------------------------------------------------

describe("Asia/Kolkata half-hour offset", () => {
  it("floors hours and days to :30 UTC boundaries", () => {
    const nowMs = iso("2026-10-19T12:00:00.000Z");

    const hourStart = startOfZonedUnit(nowMs, "hour", KOLKATA);
    expect(hourStart).toBe(iso("2026-10-19T11:30:00.000Z"));
    expect(utcMinutes(hourStart)).toBe(30);
    expect(zonedLabel(hourStart, KOLKATA)).toBe("2026-10-19 17:00");

    const dayStart = startOfZonedUnit(nowMs, "day", KOLKATA);
    expect(dayStart).toBe(iso("2026-10-18T18:30:00.000Z"));
    expect(utcMinutes(dayStart)).toBe(30);
    expect(zonedLabel(dayStart, KOLKATA)).toBe("2026-10-19 00:00");
    expect(nextZonedUnitStart(dayStart, "day", KOLKATA)).toBe(iso("2026-10-19T18:30:00.000Z"));
  });

  it("yields 24 local-hour buckets when the plan starts on a local hour", () => {
    const nowMs = iso("2026-10-19T12:30:00.000Z"); // 18:00 IST, on a local hour
    expect(zonedLabel(nowMs, KOLKATA)).toBe("2026-10-19 18:00");

    const buckets = planRangeBuckets("24h", nowMs, undefined, { timeZone: KOLKATA });
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.startMs).toBe(nowMs - DAY_MS);
    expect(buckets[buckets.length - 1]?.endMs).toBe(nowMs);
    expectContiguous(buckets);
    for (const bucket of buckets) expect(utcMinutes(bucket.startMs)).toBe(30);

    expect(zonedLabel(buckets[0]?.startMs ?? 0, KOLKATA)).toBe("2026-10-18 18:00");
    const localMidnight = buckets.find(
      (bucket) => bucket.startMs === iso("2026-10-18T18:30:00.000Z"),
    );
    expect(localMidnight).toBeDefined();
    expect(zonedLabel(localMidnight?.startMs ?? 0, KOLKATA)).toBe("2026-10-19 00:00");
  });

  it("clips a mid-local-hour 24h plan to the exact window edges", () => {
    const nowMs = iso("2026-10-19T12:00:00.000Z"); // 17:30 IST, mid local hour
    expect(zonedLabel(nowMs, KOLKATA)).toBe("2026-10-19 17:30");

    const buckets = planRangeBuckets("24h", nowMs, undefined, { timeZone: KOLKATA });
    // A mid-hour anchor yields a clipped partial bucket at each edge: 23 full
    // hours plus two half-hour edges, matching the documented clipping rule.
    expect(buckets).toHaveLength(25);
    expect(buckets[0]?.startMs).toBe(nowMs - DAY_MS);
    expect(buckets[buckets.length - 1]?.endMs).toBe(nowMs);
    expectContiguous(buckets);
    for (const bucket of buckets.slice(1)) expect(utcMinutes(bucket.startMs)).toBe(30);
    expect((buckets[0]?.endMs ?? 0) - (buckets[0]?.startMs ?? 0)).toBe(HOUR_MS / 2);
    expect(
      (buckets[buckets.length - 1]?.endMs ?? 0) - (buckets[buckets.length - 1]?.startMs ?? 0),
    ).toBe(HOUR_MS / 2);
    expect(buckets.reduce((sum, bucket) => sum + (bucket.endMs - bucket.startMs), 0)).toBe(DAY_MS);
  });
});

// ---------------------------------------------------------------------------
// Skipped local midnight: America/Santiago, 2026-09-06
// ---------------------------------------------------------------------------

describe("America/Santiago skipped local midnight (2026-09-06)", () => {
  it("starts the date at the first instant of that local date and never crashes", () => {
    const dayStart = startOfZonedUnit(iso("2026-09-06T12:00:00.000Z"), "day", SANTIAGO);
    // Local midnight does not exist; 01:00 local (04:00Z) is the first instant.
    expect(dayStart).toBe(iso("2026-09-06T04:00:00.000Z"));
    expect(zonedLabel(dayStart, SANTIAGO)).toBe("2026-09-06 01:00");

    const nextStart = nextZonedUnitStart(dayStart, "day", SANTIAGO);
    expect(nextStart).toBe(iso("2026-09-07T03:00:00.000Z"));
    expect(zonedLabel(nextStart, SANTIAGO)).toBe("2026-09-07 00:00");

    const week = planRangeBuckets("7d", iso("2026-09-07T12:00:00.000Z"), undefined, {
      timeZone: SANTIAGO,
    });
    const bucket = week.find((entry) => entry.startMs === dayStart);
    expect(bucket).toBeDefined();
    expect(zonedLabel(bucket?.startMs ?? 0, SANTIAGO)).toBe("2026-09-06 01:00");
  });
});

// ---------------------------------------------------------------------------
// Lifetime ranges
// ---------------------------------------------------------------------------

describe("lifetime buckets", () => {
  const lifetimeNowMs = iso("2026-01-20T12:00:00.000Z");
  // 2026-01-15T18:30Z is local midnight of 2026-01-16 in Asia/Kolkata.
  const earliestMs = iso("2026-01-15T18:30:00.000Z");

  it("starts at the earliest activity's local midnight and ends at now", () => {
    expect(zonedLabel(earliestMs, KOLKATA)).toBe("2026-01-16 00:00");

    const buckets = planRangeBuckets("lifetime", lifetimeNowMs, earliestMs, {
      timeZone: KOLKATA,
    });
    expect(buckets).toHaveLength(5);
    expect(buckets[0]?.startMs).toBe(earliestMs);
    expect(buckets[0]?.endMs).toBe(iso("2026-01-16T18:30:00.000Z"));
    expect(zonedLabel(buckets[0]?.startMs ?? 0, KOLKATA)).toBe("2026-01-16 00:00");
    expect(buckets[buckets.length - 1]?.endMs).toBe(lifetimeNowMs);
    expect(zonedLabel(buckets[buckets.length - 1]?.startMs ?? 0, KOLKATA)).toBe("2026-01-20 00:00");
    expectContiguous(buckets);
  });

  it("keeps trailing empty days after the last activity", () => {
    const dataset = makeDataset({ atMs: earliestMs, input: 77 });
    const usage = createUsageAnalytics(dataset, { timeZone: KOLKATA }).home(
      "lifetime",
      lifetimeNowMs,
    ).usage;

    expect(usage.buckets).toHaveLength(5);
    expect(usage.buckets[0]?.tokens.input).toBe(77);
    expect(usage.buckets.slice(1).every((bucket) => bucket.tokens.input === 0)).toBe(true);
  });

  it("returns exactly one bucket for the current local day without earliestMs", () => {
    const buckets = planRangeBuckets("lifetime", lifetimeNowMs, undefined, {
      timeZone: KOLKATA,
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual({
      startMs: iso("2026-01-19T18:30:00.000Z"),
      endMs: lifetimeNowMs,
    });
    expect(zonedLabel(buckets[0]?.startMs ?? 0, KOLKATA)).toBe("2026-01-20 00:00");
  });
});

// ---------------------------------------------------------------------------
// createUsageAnalytics calendar alignment
// ---------------------------------------------------------------------------

describe("createUsageAnalytics calendar zone", () => {
  it("places one message in its local daily bucket and labels the usage zone", () => {
    const dataset = makeDataset({
      atMs: ZONE_MOMENT_MS,
      sessionCreatedMs: ZONE_MOMENT_MS - HOUR_MS,
    });

    const kolkata = createUsageAnalytics(dataset, { timeZone: KOLKATA }).home("7d", ZONE_NOW_MS);
    expect(kolkata.usage.timeZone).toBe(KOLKATA);
    const localBucket = kolkata.usage.buckets.find(
      (bucket) => bucket.startMs === iso("2026-10-18T18:30:00.000Z"),
    );
    expect(localBucket).toBeDefined();
    expect(localBucket?.tokens.input).toBe(123);
    expect(localBucket?.endMs).toBe(ZONE_NOW_MS);

    const utc = createUsageAnalytics(dataset, { timeZone: "UTC" }).home("7d", ZONE_NOW_MS);
    expect(utc.usage.timeZone).toBe("UTC");
    const utcBucket = utc.usage.buckets.find(
      (bucket) => bucket.startMs === iso("2026-10-18T00:00:00.000Z"),
    );
    expect(utcBucket).toBeDefined();
    expect(utcBucket?.tokens.input).toBe(123);
    const utcNextDayBucket = utc.usage.buckets.find(
      (bucket) => bucket.startMs === iso("2026-10-19T00:00:00.000Z"),
    );
    expect(utcNextDayBucket).toBeDefined();
    expect(utcNextDayBucket?.tokens.input).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Engine warm-presentation zone check
// ---------------------------------------------------------------------------

describe("createAnalyticsEngine warm presentation zone", () => {
  it("treats a warm DTO from another zone as a miss and performs a real read", async () => {
    const dataset = makeDataset({
      atMs: ZONE_MOMENT_MS,
      sessionCreatedMs: ZONE_MOMENT_MS - HOUR_MS,
    });
    const warm = warmPresentation(dataset, "UTC", ENGINE_NOW_MS);
    const { engine, counts } = createZoneEngine(dataset, warm);
    try {
      const snapshot = await engine.home("7d");
      expect(counts.loadCompletedRows).toBeGreaterThan(0);
      expect(snapshot.usage.timeZone).toBe(KOLKATA);
      const localBucket = snapshot.usage.buckets.find(
        (bucket) => bucket.startMs === iso("2026-10-18T18:30:00.000Z"),
      );
      expect(localBucket?.tokens.input).toBe(123);
    } finally {
      await engine.close();
    }
  });

  it("serves a warm DTO whose zone matches without reading completed rows", async () => {
    const dataset = makeDataset({
      atMs: ZONE_MOMENT_MS,
      sessionCreatedMs: ZONE_MOMENT_MS - HOUR_MS,
    });
    const warm = warmPresentation(dataset, KOLKATA, ENGINE_NOW_MS);
    const { engine, counts } = createZoneEngine(dataset, warm);
    try {
      const snapshot = await engine.home("7d");
      expect(counts.loadCompletedRows).toBe(0);
      expect(snapshot.usage.timeZone).toBe(KOLKATA);
      expect(snapshot.generatedAtMs).toBe(ENGINE_NOW_MS);
      expect(snapshot.stale).toBe(false);
    } finally {
      await engine.close();
    }
  });
});
