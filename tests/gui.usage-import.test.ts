/**
 * Opt-in Claude Code / Codex history import (v1.4.0 D10).
 *
 * Every fixture lives under a temporary root. No test reads a real ~/.claude or
 * ~/.codex directory. The suite covers the disabled no-access guarantee,
 * retrospective and incremental import, restart resume, Claude growing-duplicate
 * upsert-max, cross-harness exclusion, Codex rate-limit series, pricing and the
 * privacy-safe text columns.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderCard, QuotaCardRow, QuotaSnapshot } from "../src/contracts/dashboard.js";
import type { RowId } from "../src/contracts/identity.js";
import {
  markQuotaObservationCycle,
  markQuotaObservationLive,
} from "../src/gui/quota-observation.js";
import { createUsageRecorder, type UsageRecorder } from "../src/gui/usage-recorder.js";
import { openOpenCodeSqliteReadOnly } from "../src/lib/opencode-sqlite.js";
import { hashUsageImport, sanitizeUsageImportModelId } from "../src/lib/usage-import.js";
import { openUsageStore, type UsageStore } from "../src/lib/usage-store.js";

const BASE = Date.parse("2026-11-01T10:00:00.000Z");
const MINUTE = 60_000;
const ROW_KEY = "window:five_hour|quota:percent";

const CLAUDE_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const CLAUDE_SESSION_B = "223e4567-e89b-42d3-a456-426614174000";
const CLAUDE_SESSION_C = "323e4567-e89b-42d3-a456-426614174000";
const CLAUDE_MESSAGE = "msg-SECRET-0001";
const CLAUDE_REQUEST = "req-SECRET-0001";
const CLAUDE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLAUDE_PROMPT = "SECRET-CLAUDE-PROMPT";
const CLAUDE_PATH = "C:\\SECRET-CLAUDE-WORKSPACE";
const CODEX_THREAD = "thread-SECRET-0001";
const CODEX_THREAD_B = "thread-SECRET-0002";
const CODEX_ACCOUNT = "acct-SECRET-0001";
const CODEX_PROMPT = "SECRET-CODEX-PROMPT";
const CODEX_PATH = "C:\\SECRET-CODEX-WORKSPACE";
const CODEX_CLI = "SECRET-CLI-VERSION";
const CODEX_PROVIDER = "C:\\SECRET-CODEX-PROVIDER";
const CODEX_LIMIT = "SECRET-LIMIT-ID";
const CODEX_PLAN = "SECRET-PLAN";
const CODEX_MODEL = "sk-SECRET-CODEX-MODEL@example.com";
const CODEX_EFFORT = "SECRET-EFFORT";
const CODEX_EMAIL = "SECRET-EMAIL@example.com";
const CLAUDE_MODEL = "sk-SECRET-CLAUDE-MODEL@example.com";

let root: string;
let dbPath: string;
let claudeRoot: string;
let codexRoot: string;
let stores: UsageStore[];
let recorders: UsageRecorder[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocq-usage-import-"));
  dbPath = join(root, "usage-history.sqlite");
  claudeRoot = join(root, "claude");
  codexRoot = join(root, "codex");
  stores = [];
  recorders = [];
});

afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    await recorder.close().catch(() => undefined);
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // best effort
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function store(): Promise<UsageStore> {
  const opened = await openUsageStore(dbPath);
  stores.push(opened);
  return opened;
}

function card(): ProviderCard {
  const row: QuotaCardRow = {
    rowId: `card-a#${ROW_KEY}` as RowId,
    label: "Quota",
    kind: "percent",
    resultType: "quota",
    percentRemaining: 80,
    metric: { kind: "window", window: "five_hour" },
  };
  return {
    cardId: "card-a" as ProviderCard["cardId"],
    providerId: "alpha",
    providerLabel: "Alpha",
    labelSource: "provider",
    rows: [row],
    errors: [],
  };
}

function liveSnapshot(atMs = BASE): QuotaSnapshot {
  const value: QuotaSnapshot = {
    generatedAtMs: atMs,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [card()], enabledProviders: "auto", polledAtMs: atMs },
  };
  markQuotaObservationCycle(value, {
    measuredAtByCard: new Map([["card-a", atMs]]),
    intervalMs: MINUTE,
    providerIds: ["alpha"],
  });
  return markQuotaObservationLive(value);
}

interface ClaudeLine {
  id?: string;
  requestId?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  model?: string;
  tokens?: Record<string, number>;
}

function claudeLine(options: ClaudeLine = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: options.uuid ?? CLAUDE_UUID,
    sessionId: options.sessionId ?? CLAUDE_SESSION,
    requestId: options.requestId ?? CLAUDE_REQUEST,
    timestamp: options.timestamp ?? "2026-11-01T10:01:00.000Z",
    isSidechain: false,
    cwd: CLAUDE_PATH,
    message: {
      id: options.id ?? CLAUDE_MESSAGE,
      model: options.model ?? "claude-sonnet-4-5",
      content: [{ type: "tool_use", input: { command: CLAUDE_PROMPT } }],
      usage: options.tokens ?? {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        output_tokens: 20,
      },
    },
  })}\n`;
}

async function writeClaude(lines: string): Promise<string> {
  const path = join(claudeRoot, "projects", "-SECRET-PROJECT", `${CLAUDE_SESSION}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines);
  return path;
}

const RESET_PRIMARY = String(Math.floor(Date.parse("2026-11-01T15:00:00.000Z") / 1000));
const RESET_SECONDARY = String(Math.floor(Date.parse("2026-11-08T10:00:00.000Z") / 1000));

function codexLine(
  total: Record<string, number>,
  usedPrimary: number,
  usedSecondary: number,
  timestamp: string,
): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          cache_write_input_tokens: 0,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning,
          total_tokens: total.input + total.output,
        },
        last_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          cache_write_input_tokens: 0,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning,
          total_tokens: total.input + total.output,
        },
      },
      rate_limits: {
        primary: {
          used_percent: usedPrimary,
          window_minutes: 300,
          resets_at: Number(RESET_PRIMARY),
        },
        secondary: {
          used_percent: usedSecondary,
          window_minutes: 10080,
          resets_in_seconds: Number(RESET_SECONDARY) - Math.floor(Date.parse(timestamp) / 1000),
        },
        plan_type: CODEX_PLAN,
        limit_id: CODEX_LIMIT,
      },
    },
  })}\n`;
}

async function writeCodex(): Promise<string> {
  const path = join(codexRoot, "sessions", "rollout-2026-11-01T10-00-00.jsonl");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-11-01T10:00:30.000Z",
      payload: {
        id: CODEX_THREAD,
        creator_account_id: CODEX_ACCOUNT,
        creator_user_id: CODEX_EMAIL,
        cli_version: CODEX_CLI,
        model_provider: CODEX_PROVIDER,
        cwd: CODEX_PATH,
        base_instructions: { text: CODEX_PROMPT },
      },
    })}\n` +
      `${JSON.stringify({
        type: "turn_context",
        timestamp: "2026-11-01T10:00:35.000Z",
        payload: { model: CODEX_MODEL, effort: CODEX_EFFORT, turn_id: "turn-SECRET-1" },
      })}\n` +
      `${JSON.stringify({
        type: "turn_context",
        timestamp: "2026-11-01T10:00:40.000Z",
        payload: { model: "gpt-5", effort: "high" },
      })}\n` +
      `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-11-01T10:00:50.000Z",
        payload: { type: "message", content: CODEX_PROMPT, cwd: CODEX_PATH },
      })}\n` +
      codexLine(
        { input: 1000, cached: 200, output: 100, reasoning: 20 },
        20,
        40,
        "2026-11-01T10:01:10.000Z",
      ) +
      codexLine(
        { input: 2000, cached: 400, output: 200, reasoning: 40 },
        30,
        50,
        "2026-11-01T10:02:10.000Z",
      ),
  );
  return path;
}

function makeRecorder(options: {
  store: UsageStore;
  settings: { claudeCode: boolean; codex: boolean };
  now: () => number;
  rootFor?: (harness: string) => string | undefined;
}): UsageRecorder {
  const recorder = createUsageRecorder({
    store: options.store,
    now: options.now,
    loadImportSettings: async () => options.settings,
    importRootFor:
      options.rootFor ?? ((harness) => (harness === "claude-code" ? claudeRoot : codexRoot)),
  });
  recorders.push(recorder);
  return recorder;
}

describe("usage import", () => {
  it("disabled never resolves or reads a harness root", async () => {
    await writeClaude(claudeLine());
    await writeCodex();
    const db = await store();
    let rootLookups = 0;
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: false, codex: false },
      now: () => BASE,
      rootFor: () => {
        rootLookups += 1;
        throw new Error("disabled import must not resolve a root");
      },
    });

    recorder.observe(liveSnapshot());
    await recorder.flush();

    expect(rootLookups).toBe(0);
    expect((await recorder.importStatus()).map((entry) => entry.status)).toEqual([
      "disabled",
      "disabled",
    ]);
    const activity = await recorder.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    expect(activity.intervals[0]?.entries).toEqual([]);
    expect(db.getImportState("claude-code")?.enabled).toBe(false);
  });

  it("enabling imports retrospectively from offset 0 and prices the activity", async () => {
    await writeClaude(claudeLine());
    await writeCodex();
    const db = await store();
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: true, codex: true },
      now: () => BASE,
    });

    recorder.observe(liveSnapshot());
    await recorder.flush();

    const result = await recorder.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    const entries = result.intervals[0]?.entries ?? [];
    expect(entries).toHaveLength(2);
    const claude = entries.find((entry) => entry.providerId === "anthropic");
    const codex = entries.find((entry) => entry.providerId === "openai");
    expect(claude).toMatchObject({ modelId: "claude-sonnet-4-5", stepCount: 1 });
    expect(claude?.tokens).toMatchObject({ input: 10, cacheRead: 100, cacheWrite: 50, output: 20 });
    expect(claude?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(claude?.tokens.apiEquivalentCostUsd ?? 0).toBeGreaterThan(0);
    expect(codex).toMatchObject({ modelId: "gpt-5", effort: "high", stepCount: 2 });
    expect(codex?.tokens).toMatchObject({
      input: 1600,
      cacheRead: 400,
      output: 200,
      reasoning: 40,
    });
    expect(codex?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(codex?.tokens.apiEquivalentCostUsd ?? 0).toBeGreaterThan(0);

    const status = await recorder.importStatus();
    expect(status).toEqual([
      { harness: "claude-code", enabled: true, lastImportedAtMs: BASE, status: "ok" },
      { harness: "codex", enabled: true, lastImportedAtMs: BASE, status: "ok" },
    ]);
  });

  it("imports only appended history on the next opportunity", async () => {
    const path = await writeClaude(claudeLine());
    await writeCodex();
    const db = await store();
    let clock = BASE;
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: true, codex: true },
      now: () => clock,
    });

    recorder.observe(liveSnapshot());
    await recorder.flush();
    await appendFile(
      path,
      claudeLine({
        id: "msg-SECRET-0002",
        requestId: "req-SECRET-0002",
        uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        timestamp: "2026-11-01T10:03:00.000Z",
        tokens: {
          input_tokens: 7,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
        },
      }),
    );

    clock = BASE + 2 * MINUTE;
    recorder.observe(liveSnapshot(clock));
    await recorder.flush();

    const result = await recorder.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    const claude = result.intervals[0]?.entries.find((entry) => entry.providerId === "anthropic");
    expect(claude?.stepCount).toBe(2);
    expect(claude?.tokens.input).toBe(17);
    expect(claude?.tokens.output).toBe(23);
  });

  it("resumes from the persisted cursor after a restart", async () => {
    await writeClaude(claudeLine());
    await writeCodex();
    const first = await store();
    const recorder = makeRecorder({
      store: first,
      settings: { claudeCode: true, codex: true },
      now: () => BASE,
    });
    recorder.observe(liveSnapshot());
    await recorder.flush();

    const persisted = first.getImportState("claude-code");
    expect(persisted?.cursor).toBeTypeOf("string");
    expect(persisted?.enabled).toBe(true);
    await recorder.close();

    const second = await store();
    const restarted = makeRecorder({
      store: second,
      settings: { claudeCode: true, codex: true },
      now: () => BASE + 2 * MINUTE,
    });
    restarted.observe(liveSnapshot(BASE + 2 * MINUTE));
    await restarted.flush();

    const result = await restarted.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    const claude = result.intervals[0]?.entries.find((entry) => entry.providerId === "anthropic");
    expect(claude?.stepCount).toBe(1);
    expect(claude?.tokens.input).toBe(10);
  });

  it("upserts a growing Claude duplicate by per-counter maximum", async () => {
    const db = await store();
    const invocation = (input: number, output: number) => ({
      atMs: BASE,
      model: "claude-sonnet-4-5",
      tokens: { input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0 },
      dedupeKey: hashUsageImport("claude-invocation", CLAUDE_MESSAGE, CLAUDE_REQUEST),
      nativeSessionKey: hashUsageImport("claude-session", CLAUDE_SESSION),
    });
    db.recordImportedInvocations("claude-code", [invocation(5, 2)]);
    db.recordImportedInvocations("claude-code", [invocation(20, 7)]);

    const result = db.queryImportedActivity(
      {
        intervals: [{ startMs: 0, endMs: BASE + MINUTE }],
        providerIds: ["alpha"],
      },
      ["claude-code"],
    );
    const entry = result.intervals[0]?.entries[0];
    expect(entry?.stepCount).toBe(1);
    expect(entry?.tokens.input).toBe(20);
    expect(entry?.tokens.output).toBe(7);
  });

  it("excludes whole and per-message Claude Code records owned by OpenCode", async () => {
    await writeClaude(
      claudeLine() +
        claudeLine({
          id: "msg-SECRET-0002",
          requestId: "req-SECRET-0002",
          uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          sessionId: CLAUDE_SESSION_B,
          timestamp: "2026-11-01T10:02:00.000Z",
        }) +
        claudeLine({
          id: "msg-SECRET-0003",
          requestId: "req-SECRET-0003",
          uuid: "cccccccc-dddd-4eee-8fff-ffffffffffff",
          sessionId: CLAUDE_SESSION_C,
          timestamp: "2026-11-01T10:03:00.000Z",
        }),
    );
    const db = await store();
    let codexRootLookups = 0;
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: true, codex: false },
      now: () => BASE,
      rootFor: (harness) => {
        if (harness === "codex") {
          codexRootLookups += 1;
          throw new Error("disabled harness root");
        }
        return claudeRoot;
      },
    });

    // The first session and the second session's message uuid belong to
    // OpenCode's Claude Agent integration; the third session is independent.
    recorder.recordClaudeOwnership(CLAUDE_SESSION, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    await recorder.flush();

    recorder.observe(liveSnapshot());
    await recorder.flush();

    const result = await recorder.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    const claude = result.intervals[0]?.entries ?? [];
    expect(claude).toHaveLength(1);
    expect(claude[0]?.tokens.input).toBe(10);
    expect(codexRootLookups).toBe(0);
  });

  it("stores Codex rate limits as separate provider-observed series with resets", async () => {
    await writeCodex();
    const db = await store();
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: false, codex: true },
      now: () => BASE,
    });
    recorder.observe(liveSnapshot());
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + 60 * MINUTE });
    const imported = slice.series.filter((series) => series.source === "codex-import");
    expect(imported.map((series) => series.rowKey).sort()).toEqual([
      "window:five_hour",
      "window:week",
    ]);
    const account = `codex-import:${hashUsageImport("codex-account", CODEX_ACCOUNT)}`;
    expect(imported.every((series) => series.cardId === account)).toBe(true);
    expect(imported.every((series) => series.providerId === "codex-import")).toBe(true);
    expect(imported.every((series) => series.measurement === "provider-observed")).toBe(true);

    const fiveHour = imported.find((series) => series.rowKey === "window:five_hour");
    const week = imported.find((series) => series.rowKey === "window:week");
    expect(fiveHour).toBeDefined();
    expect(week).toBeDefined();
    if (fiveHour === undefined || week === undefined) return;
    const runsFor = (rowId: string) => slice.runs.filter((run) => run.seriesId === rowId);
    const fiveHourRuns = runsFor(fiveHour.rowId);
    const weekRuns = runsFor(week.rowId);
    expect(fiveHourRuns.map((run) => run.remainingPercent)).toEqual([80, 70]);
    expect(weekRuns.map((run) => run.remainingPercent)).toEqual([60, 50]);
    expect(fiveHourRuns.map((run) => run.reset_precision)).toEqual(["exact", "exact"]);
    expect(weekRuns.map((run) => run.reset_precision)).toEqual(["estimated", "estimated"]);
    expect(fiveHourRuns[0]?.resetAtMs).toBe(Number(RESET_PRIMARY) * 1000);
    expect(weekRuns[0]?.resetAtMs).toBe(Number(RESET_SECONDARY) * 1000);
  });

  it("scopes identity-less Codex readings to the session they came from", async () => {
    await writeCodex();
    // A second rollout of an unattributed account: Codex records no
    // creator_account_id, so nothing proves it is the same subscription.
    await writeFile(
      join(codexRoot, "sessions", "rollout-2026-11-01T11-00-00.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-11-01T11:00:30.000Z",
        payload: { id: CODEX_THREAD_B },
      })}
` +
        codexLine(
          { input: 10, cached: 0, output: 5, reasoning: 0 },
          90,
          10,
          "2026-11-01T11:01:10.000Z",
        ) +
        codexLine(
          { input: 20, cached: 0, output: 5, reasoning: 0 },
          95,
          15,
          "2026-11-01T11:02:10.000Z",
        ),
    );
    const db = await store();
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: false, codex: true },
      now: () => BASE,
    });
    recorder.observe(liveSnapshot());
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + 24 * 60 * MINUTE });
    const imported = slice.series.filter((series) => series.source === "codex-import");
    const account = `codex-import:${hashUsageImport("codex-account", CODEX_ACCOUNT)}`;
    const session = `codex-import:unknown:${hashUsageImport("codex-thread", CODEX_THREAD_B)}`;
    expect([...new Set(imported.map((series) => series.cardId))].sort()).toEqual(
      [account, session].sort(),
    );

    const runsFor = (cardId: string, rowKey: string) =>
      slice.runs.filter((run) => run.seriesId === `${cardId}#${rowKey}`);
    // Each subscription keeps its own trajectory: the unattributed session is
    // never inserted between the attributed account's readings.
    expect(runsFor(account, "window:five_hour").map((run) => run.remainingPercent)).toEqual([
      80, 70,
    ]);
    expect(runsFor(session, "window:five_hour").map((run) => run.remainingPercent)).toEqual([
      10, 5,
    ]);
  });

  it("re-reads the enabled flag before each harness scan so a disable stops Codex", async () => {
    await writeClaude(claudeLine());
    await writeCodex();
    const db = await store();
    let codexEnabled = true;
    let codexRootLookups = 0;
    const recorder = createUsageRecorder({
      store: db,
      now: () => BASE,
      loadImportSettings: async () => ({ claudeCode: true, codex: codexEnabled }),
      importRootFor: (harness) => {
        if (harness === "claude-code") {
          // The disable lands while the Claude Code scan is in flight.
          codexEnabled = false;
          return claudeRoot;
        }
        codexRootLookups += 1;
        return codexRoot;
      },
    });
    recorders.push(recorder);

    recorder.observe(liveSnapshot());
    await recorder.flush();

    expect(codexRootLookups).toBe(0);
    expect(db.getImportState("codex")?.enabled).toBe(false);
    const result = await recorder.queryImportedActivity({
      intervals: [{ startMs: 0, endMs: BASE + 60 * MINUTE }],
      providerIds: ["alpha"],
    });
    const entries = result.intervals[0]?.entries ?? [];
    expect(entries.some((entry) => entry.providerId === "openai")).toBe(false);
    expect(entries.some((entry) => entry.providerId === "anthropic")).toBe(true);
  });

  it("hashes opaque Codex limit ids and shows a neutral label", async () => {
    const path = join(codexRoot, "sessions", "rollout-2026-11-01T10-00-00.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-11-01T10:00:00.000Z",
        payload: { id: CODEX_THREAD, creator_account_id: CODEX_ACCOUNT },
      })}\n${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-11-01T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            primary: { used_percent: 10, window_minutes: 45, resets_at: Number(RESET_PRIMARY) },
            limit_id: CODEX_LIMIT,
            plan_type: CODEX_PLAN,
          },
        },
      })}\n`,
    );
    const db = await store();
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: false, codex: true },
      now: () => BASE,
    });
    recorder.observe(liveSnapshot());
    await recorder.flush();

    const slice = db.query({ startMs: 0, endMs: BASE + 60 * MINUTE });
    const named = slice.series.find((series) => series.rowKey.startsWith("named:codex-"));
    expect(named).toBeDefined();
    expect(named?.rowKey).not.toContain(CODEX_LIMIT);
    expect(named?.metricJson).not.toContain(CODEX_LIMIT);
    expect(named?.label).toMatch(/^Codex limit [0-9a-f]{6} \(primary 45m\)$/);
    expect(slice.series.every((series) => !series.label.includes(CODEX_LIMIT))).toBe(true);
  });

  it("aggregates imported activity across intervals in one ordered pass", async () => {
    const db = await store();
    const tokens = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 };
    db.recordImportedInvocations("claude-code", [
      {
        atMs: BASE + 1_000,
        model: "claude-sonnet-4-5",
        tokens,
        dedupeKey: hashUsageImport("claude-invocation", "interval-a"),
      },
      {
        atMs: BASE + 10_000,
        model: "claude-sonnet-4-5",
        tokens,
        dedupeKey: hashUsageImport("claude-invocation", "interval-b"),
      },
    ]);
    db.recordImportedInvocations("codex", [
      {
        atMs: BASE + 20_000,
        model: "gpt-5",
        effort: "high",
        tokens,
        dedupeKey: hashUsageImport("codex-invocation", "interval-c"),
      },
    ]);

    const result = db.queryImportedActivity(
      {
        intervals: [
          { startMs: BASE, endMs: BASE + 10_000 },
          { startMs: BASE + 10_000, endMs: BASE + 30_000 },
        ],
        providerIds: ["alpha"],
      },
      ["claude-code", "codex"],
    );
    const first = result.intervals[0]?.entries ?? [];
    const second = result.intervals[1]?.entries ?? [];
    expect(first).toHaveLength(1);
    expect(first[0]?.providerId).toBe("anthropic");
    expect(first[0]?.stepCount).toBe(2);
    expect(second).toHaveLength(1);
    expect(second[0]?.providerId).toBe("openai");
    expect(second[0]?.stepCount).toBe(1);
  });

  it("re-reads settings before each Claude ownership write", async () => {
    const db = await store();
    let claudeCode = true;
    const recorder = createUsageRecorder({
      store: db,
      now: () => BASE,
      loadImportSettings: async () => ({ claudeCode, codex: false }),
      importRootFor: () => undefined,
    });
    recorders.push(recorder);

    const exclusionCount = async (): Promise<number> => {
      const reader = await openOpenCodeSqliteReadOnly(dbPath);
      try {
        return (
          reader.get<{ count: number }>("SELECT COUNT(*) AS count FROM usage_import_exclusions")
            ?.count ?? 0
        );
      } finally {
        reader.close();
      }
    };

    recorder.recordClaudeOwnership(CLAUDE_SESSION, CLAUDE_UUID);
    await recorder.flush();
    expect(await exclusionCount()).toBe(2);

    // The old 30s settings cache would still see claudeCode:true here.
    claudeCode = false;
    recorder.recordClaudeOwnership(CLAUDE_SESSION_B, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    await recorder.flush();
    expect(await exclusionCount()).toBe(2);
  });

  it("persists no raw ids, paths, prompt text, models, efforts or limits in any text column", async () => {
    await writeClaude(
      claudeLine() +
        claudeLine({
          id: "msg-SECRET-0002",
          requestId: "req-SECRET-0002",
          uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          model: CLAUDE_MODEL,
        }),
    );
    await writeCodex();
    const db = await store();
    const recorder = makeRecorder({
      store: db,
      settings: { claudeCode: true, codex: true },
      now: () => BASE,
    });
    recorder.recordClaudeOwnership(CLAUDE_SESSION, CLAUDE_UUID);
    recorder.observe(liveSnapshot());
    await recorder.flush();
    const codexCursor = db.getImportState("codex")?.cursor ?? "";
    await recorder.close();

    // The persisted cursor is itself a text column; it must not carry the
    // transcript-controlled fields the parser dropped.
    for (const secret of [
      CODEX_CLI,
      CODEX_PROVIDER,
      CODEX_LIMIT,
      CODEX_PLAN,
      CODEX_MODEL,
      CODEX_EFFORT,
    ]) {
      expect(codexCursor).not.toContain(secret);
    }

    const reader = await openOpenCodeSqliteReadOnly(dbPath);
    try {
      const tables = reader
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .map((row) => row.name);
      const text: string[] = [];
      for (const table of tables) {
        for (const row of reader.all<Record<string, unknown>>(`SELECT * FROM ${table}`)) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") text.push(value);
          }
        }
      }
      const serialized = text.join("\n");
      for (const secret of [
        CLAUDE_SESSION,
        CLAUDE_MESSAGE,
        CLAUDE_REQUEST,
        CLAUDE_UUID,
        CLAUDE_PROMPT,
        CLAUDE_PATH,
        CLAUDE_MODEL,
        CODEX_THREAD,
        CODEX_ACCOUNT,
        CODEX_PROMPT,
        CODEX_PATH,
        CODEX_CLI,
        CODEX_PROVIDER,
        CODEX_LIMIT,
        CODEX_PLAN,
        CODEX_MODEL,
        CODEX_EFFORT,
        CODEX_EMAIL,
        claudeRoot,
        codexRoot,
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      reader.close();
    }
  });
});

describe("imported model id recognition", () => {
  it("accepts only model ids the pricing catalog knows", () => {
    // A transcript may carry any string; the persisted identity must be a
    // catalog id so analytics pricing and model keys stay sound.
    expect(sanitizeUsageImportModelId("gpt-5")).toBe("gpt-5");
    expect(sanitizeUsageImportModelId("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(sanitizeUsageImportModelId("projects/private.jsonl")).toBeUndefined();
    expect(sanitizeUsageImportModelId("model-0123456789abcdef")).toBeUndefined();
    expect(sanitizeUsageImportModelId("sk-SECRET-model")).toBeUndefined();
    expect(sanitizeUsageImportModelId(undefined)).toBeUndefined();
  });
});
