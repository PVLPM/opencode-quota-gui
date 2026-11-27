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
import { hashUsageImport } from "../src/lib/usage-import.js";
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
const CODEX_ACCOUNT = "acct-SECRET-0001";
const CODEX_PROMPT = "SECRET-CODEX-PROMPT";
const CODEX_PATH = "C:\\SECRET-CODEX-WORKSPACE";

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
          resets_at: Number(RESET_SECONDARY),
        },
        plan_type: "pro",
        limit_id: "codex",
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
        cli_version: "0.1.0",
        model_provider: "openai",
      },
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
    expect(imported.every((series) => series.providerId === "openai")).toBe(true);
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
    expect(fiveHourRuns[0]?.resetAtMs).toBe(Number(RESET_PRIMARY) * 1000);
    expect(weekRuns[0]?.resetAtMs).toBe(Number(RESET_SECONDARY) * 1000);
  });

  it("persists no raw ids, paths or prompt text in any text column", async () => {
    await writeClaude(claudeLine() + claudeLine({ requestId: "req-SECRET-0002" }));
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
    await recorder.close();

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
        CODEX_THREAD,
        CODEX_ACCOUNT,
        CODEX_PROMPT,
        CODEX_PATH,
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
