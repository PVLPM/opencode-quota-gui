import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CodexImportCursor,
  parseCodexRolloutLine,
  readCodexHistory,
  resolveCodexHome,
} from "../src/lib/codex-history.js";

const THREAD_ID = "019a9f1a-0000-7000-8000-000000000001";
const ACCOUNT_ID = "account-SECRET-123";
const SECRET_PROMPT = "SECRET-CODEX-PROMPT";
const SECRET_CWD = "C:\\SECRET-WORKSPACE\\codex";
const START = "2026-11-01T10:00:00.000Z";
const SECOND = "2026-11-01T10:00:30.000Z";
const THIRD = "2026-11-01T10:01:00.000Z";

function line(
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
  ordinal?: number,
): string {
  return `${JSON.stringify({ timestamp, ...(ordinal === undefined ? {} : { ordinal }), type, payload })}\n`;
}

function sessionMeta(): string {
  return line(START, "session_meta", {
    id: THREAD_ID,
    session_id: THREAD_ID,
    cli_version: "0.164.0",
    model_provider: "openai",
    creator_account_id: ACCOUNT_ID,
    creator_user_id: "user-SECRET-456",
    cwd: SECRET_CWD,
    base_instructions: { text: SECRET_PROMPT },
    git: { repository_url: "https://SECRET.example/repo" },
  });
}

function turnContext(model = "gpt-5.1-codex", effort = "high"): string {
  return line(SECOND, "turn_context", {
    model,
    effort,
    turn_id: "turn-SECRET-1",
    cwd: SECRET_CWD,
    approval_policy: "on-request",
    sandbox_policy: { mode: "workspace-write" },
  });
}

function counters(over: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    input_tokens: 1000,
    cached_input_tokens: 400,
    cache_write_input_tokens: 200,
    output_tokens: 300,
    reasoning_output_tokens: 100,
    total_tokens: 1300,
    ...over,
  };
}

function tokenCount(
  timestamp: string,
  total: Record<string, number> | null,
  options: {
    last?: Record<string, number>;
    ordinal?: number;
    rateLimits?: Record<string, unknown> | null;
  } = {},
): string {
  return line(
    timestamp,
    "event_msg",
    {
      type: "token_count",
      info:
        total === null
          ? null
          : {
              total_token_usage: total,
              last_token_usage:
                options.last ??
                counters({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 }),
              model_context_window: 200_000,
            },
      rate_limits: options.rateLimits === undefined ? null : options.rateLimits,
    },
    options.ordinal,
  );
}

function fullRollout(): string {
  return [
    sessionMeta(),
    turnContext(),
    tokenCount(SECOND, counters(), {
      ordinal: 1,
      rateLimits: {
        limit_id: "codex",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_893_456_000 },
        secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_893_542_400 },
        plan_type: "pro",
      },
    }),
    tokenCount(
      THIRD,
      counters({
        input_tokens: 1500,
        cached_input_tokens: 600,
        cache_write_input_tokens: 250,
        output_tokens: 450,
        reasoning_output_tokens: 150,
        total_tokens: 1950,
      }),
      { ordinal: 2 },
    ),
  ].join("");
}

describe("parseCodexRolloutLine", () => {
  it("keeps only hashed identities and counter metadata", () => {
    const parsed = parseCodexRolloutLine(sessionMeta().trim());
    expect(parsed).toMatchObject({
      kind: "session-meta",
      cliVersion: "0.164.0",
      provider: "openai",
    });
    expect(parsed?.kind === "session-meta" ? parsed.threadKey : "").toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain(THREAD_ID);
    expect(JSON.stringify(parsed)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(parsed)).not.toContain(SECRET_CWD);
    expect(JSON.stringify(parsed)).not.toContain(SECRET_PROMPT);
  });

  it("parses cumulative usage and fixed and relative reset times", () => {
    const parsed = parseCodexRolloutLine(
      tokenCount(SECOND, counters(), {
        ordinal: 7,
        rateLimits: {
          limit_id: "codex",
          primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 600 },
          secondary: { used_percent: 40, resets_at: 1_893_542_400 },
          plan_type: "pro",
        },
      }).trim(),
    );
    expect(parsed).toMatchObject({
      kind: "token-count",
      atMs: Date.parse(SECOND),
      ordinal: 7,
      info: {
        total: { input: 1000, cached: 400, cacheWrite: 200, output: 300, reasoning: 100 },
      },
      rateLimits: {
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsInSeconds: 600 },
        secondary: { usedPercent: 40, resetsAtMs: 1_893_542_400_000 },
        planType: "pro",
        limitId: "codex",
      },
    });
  });

  it("returns token-count metadata when info is null", () => {
    expect(
      parseCodexRolloutLine(
        tokenCount(SECOND, null, {
          rateLimits: { primary: { used_percent: 1, resets_at: 1_893_456_000 } },
        }).trim(),
      ),
    ).toMatchObject({ kind: "token-count", rateLimits: { primary: {} } });
    expect(
      parseCodexRolloutLine(
        tokenCount(SECOND, null, {
          rateLimits: { primary: { used_percent: 1, resets_at: 1_893_456_000 } },
        }).trim(),
      ),
    ).not.toHaveProperty("info");
  });
});

describe("readCodexHistory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocq-codex-history-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function sessionsPath(name = "rollout-2026-11-01T10-00-00-019a9f1a.jsonl"): string {
    return join(root, "sessions", "2026", "11", "01", name);
  }

  async function writeRollout(content: string, path = sessionsPath()): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  it("uses cumulative token_count deltas, skips repeats, and handles a baseline decrease", async () => {
    await writeRollout(
      fullRollout() +
        tokenCount(
          "2026-11-01T10:02:00.000Z",
          counters({
            input_tokens: 1500,
            cached_input_tokens: 600,
            cache_write_input_tokens: 250,
            output_tokens: 450,
            reasoning_output_tokens: 150,
            total_tokens: 1950,
          }),
          { ordinal: 3 },
        ) +
        tokenCount(
          "2026-11-01T10:03:00.000Z",
          counters({
            input_tokens: 90,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 110,
          }),
          {
            ordinal: 4,
            last: counters({
              input_tokens: 90,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 110,
            }),
          },
        ),
    );
    const batch = await readCodexHistory({ root });
    expect(batch.available).toBe(true);
    const thread = batch.threads[0];
    expect(thread?.cliVersion).toBe("0.164.0");
    expect(thread?.provider).toBe("openai");
    expect(thread?.invocations).toHaveLength(3);
    expect(thread?.invocations[0]?.tokens).toEqual({
      input: 600,
      cacheRead: 400,
      cacheWrite: 200,
      output: 300,
      reasoning: 100,
    });
    expect(thread?.invocations[1]?.tokens).toEqual({
      input: 300,
      cacheRead: 200,
      cacheWrite: 50,
      output: 150,
      reasoning: 50,
    });
    expect(thread?.invocations[1]?.model).toBe("gpt-5.1-codex");
    expect(thread?.invocations[1]?.effort).toBe("high");
    expect(thread?.invocations[2]?.tokens.input).toBe(90);
  });

  it("counts a total decrease with last_token_usage instead of a negative delta", async () => {
    await writeRollout(
      fullRollout() +
        tokenCount(
          "2026-11-01T10:03:00.000Z",
          counters({
            input_tokens: 90,
            cached_input_tokens: 0,
            output_tokens: 20,
            total_tokens: 110,
          }),
          {
            ordinal: 3,
            last: counters({
              input_tokens: 90,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 110,
            }),
          },
        ),
    );
    const batch = await readCodexHistory({ root });
    const last = batch.threads[0]?.invocations.at(-1);
    expect(last?.tokens).toEqual({
      input: 90,
      cacheRead: 0,
      cacheWrite: 0,
      output: 20,
      reasoning: 5,
    });
  });

  it("emits rate-limit observations with info:null and resolves resets_in_seconds", async () => {
    await writeRollout(
      `${sessionMeta()}${tokenCount(SECOND, null, {
        rateLimits: {
          primary: { used_percent: 25, window_minutes: 300, resets_in_seconds: 3600 },
          secondary: { used_percent: 50, resets_at: 1_893_542_400 },
          plan_type: "plus",
        },
      })}`,
    );
    const batch = await readCodexHistory({ root });
    expect(batch.threads[0]?.invocations).toEqual([]);
    expect(batch.threads[0]?.rateLimitObservations).toEqual([
      {
        atMs: Date.parse(SECOND),
        window: "primary",
        windowMinutes: 300,
        usedPercent: 25,
        resetsAtMs: Date.parse(SECOND) + 3_600_000,
        planType: "plus",
      },
      {
        atMs: Date.parse(SECOND),
        window: "secondary",
        usedPercent: 50,
        resetsAtMs: 1_893_542_400_000,
        planType: "plus",
      },
    ]);
  });

  it("does not double count token_usage_record lines or repeated totals", async () => {
    await writeRollout(
      `${sessionMeta()}${turnContext()}${tokenCount(SECOND, counters(), { ordinal: 1 })}${JSON.stringify(
        {
          timestamp: SECOND,
          type: "token_usage_record",
          payload: {
            thread_id: THREAD_ID,
            turn_id: "turn-SECRET-1",
            session_id: THREAD_ID,
            root_turn_id: "turn-SECRET-1",
            response_id: "resp-SECRET-1",
            usage: counters(),
            turn_token_usage: counters(),
            thread_token_usage: counters(),
          },
        },
      )}\n${tokenCount(THIRD, counters(), { ordinal: 2 })}`,
    );
    const batch = await readCodexHistory({ root });
    expect(batch.threads[0]?.invocations).toHaveLength(1);
  });

  it("reads sessions and archived_sessions and ignores compressed or unrelated files", async () => {
    await writeRollout(`${sessionMeta()}${tokenCount(SECOND, counters(), { ordinal: 1 })}`);
    const archived = join(root, "archived_sessions", "rollout-2026-11-02T10-00-00-019a9f1a.jsonl");
    await mkdir(join(archived, ".."), { recursive: true });
    await writeFile(
      archived,
      line(SECOND, "session_meta", { id: "019a9f1a-0000-7000-8000-000000000002" }) +
        tokenCount(
          THIRD,
          counters({
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 5,
            total_tokens: 15,
          }),
          {
            ordinal: 1,
          },
        ),
    );
    const sessions = join(root, "sessions");
    await writeFile(join(sessions, "rollout-2026-11-01T10-00-00-019a9f1a.jsonl.zst"), "ignored");
    await writeFile(join(sessions, "notes.jsonl"), "ignored");
    const batch = await readCodexHistory({ root });
    expect(batch.threads).toHaveLength(2);
    expect(batch.threads.map((thread) => thread.invocations.length)).toEqual([1, 1]);
  });

  it("reads only appended bytes and carries model and totals across runs", async () => {
    const path = await writeRollout(
      `${sessionMeta()}${turnContext()}${tokenCount(SECOND, counters(), { ordinal: 1 })}`,
    );
    const first = await readCodexHistory({ root });
    const firstOffset = Object.values(first.cursor.files)[0]?.byteOffset;
    expect(first.threads[0]?.invocations).toHaveLength(1);
    expect(firstOffset).toBe((await stat(path)).size);

    await appendFile(
      path,
      tokenCount(
        THIRD,
        counters({
          input_tokens: 1500,
          cached_input_tokens: 600,
          cache_write_input_tokens: 250,
          output_tokens: 450,
          reasoning_output_tokens: 150,
          total_tokens: 1950,
        }),
        { ordinal: 2 },
      ),
    );
    const second = await readCodexHistory({ root, cursor: first.cursor });
    expect(second.threads[0]?.invocations).toHaveLength(1);
    expect(second.threads[0]?.invocations[0]?.tokens.input).toBe(300);
    expect(second.threads[0]?.invocations[0]?.model).toBe("gpt-5.1-codex");
    expect(Object.values(second.cursor.files)[0]?.byteOffset).toBe((await stat(path)).size);
  });

  it("leaves a partial trailing line for the next run", async () => {
    const path = await writeRollout(
      `${sessionMeta()}${turnContext()}${tokenCount(SECOND, counters(), { ordinal: 1 })}`,
    );
    const first = await readCodexHistory({ root });
    const completeSize = (await stat(path)).size;
    const partial = tokenCount(
      THIRD,
      counters({
        input_tokens: 1500,
        cached_input_tokens: 600,
        cache_write_input_tokens: 250,
        output_tokens: 450,
        reasoning_output_tokens: 150,
        total_tokens: 1950,
      }),
      { ordinal: 2 },
    );
    await appendFile(path, partial.slice(0, 20));
    const second = await readCodexHistory({ root, cursor: first.cursor });
    expect(second.threads).toEqual([]);
    expect(Object.values(second.cursor.files)[0]?.byteOffset).toBe(completeSize);

    await appendFile(path, partial.slice(20));
    const third = await readCodexHistory({ root, cursor: second.cursor });
    expect(third.threads[0]?.invocations).toHaveLength(1);
    expect(third.threads[0]?.invocations[0]?.tokens.input).toBe(300);
  });

  it("re-reads a truncated file and reproduces stable dedupe keys", async () => {
    const path = await writeRollout(fullRollout());
    const first = await readCodexHistory({ root });
    const originalKeys = first.threads[0]?.invocations.map((invocation) => invocation.dedupeKey);
    expect(originalKeys).toHaveLength(2);

    await writeFile(path, `${fullRollout().split("\n").slice(0, 3).join("\n")}\n`);
    const second = await readCodexHistory({ root, cursor: first.cursor });
    expect(second.threads[0]?.invocations).toHaveLength(1);
    expect(second.threads[0]?.invocations[0]?.dedupeKey).toBe(originalKeys?.[0]);

    await utimes(path, new Date(), new Date(Date.parse("2026-11-05T00:00:00.000Z")));
    const third = await readCodexHistory({ root, cursor: second.cursor });
    expect(third.threads[0]?.invocations).toHaveLength(1);
    expect(third.threads[0]?.invocations[0]?.dedupeKey).toBe(originalKeys?.[0]);
  });

  it("reports unavailable without touching a missing root and keeps the supplied cursor", async () => {
    const cursor: CodexImportCursor = { version: 1, files: {} };
    const batch = await readCodexHistory({ root: join(root, "missing"), cursor });
    expect(batch.available).toBe(false);
    expect(batch.threads).toEqual([]);
    expect(batch.cursor).toBe(cursor);
  });

  it("never exposes prompts, cwd, raw ids, or file paths", async () => {
    const path = await writeRollout(fullRollout());
    const serialized = JSON.stringify(await readCodexHistory({ root }));
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_CWD);
    expect(serialized).not.toContain(THREAD_ID);
    expect(serialized).not.toContain(ACCOUNT_ID);
    expect(serialized).not.toContain("user-SECRET-456");
    expect(serialized).not.toContain("turn-SECRET-1");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain("repo");
  });
});

describe("resolveCodexHome", () => {
  const absolute = join(tmpdir(), "synthetic-codex");

  it("uses CODEX_HOME when absolute, otherwise ~/.codex", () => {
    expect(resolveCodexHome({ env: { CODEX_HOME: absolute }, home: "unused" })).toBe(absolute);
    expect(resolveCodexHome({ env: {}, home: join(tmpdir(), "synthetic-home") })).toBe(
      join(tmpdir(), "synthetic-home", ".codex"),
    );
  });

  it.each([
    ["a relative path", "relative/codex"],
    ["a whitespace-padded path", ` ${absolute} `],
    ["an empty value", ""],
    ["a UNC path", "\\\\server\\share\\codex"],
    ["a forward-slash UNC path", "//server/share/codex"],
  ])("fails closed for CODEX_HOME as %s", (_name, codexHome) => {
    expect(resolveCodexHome({ env: { CODEX_HOME: codexHome }, home: "unused" })).toBeUndefined();
  });
});
