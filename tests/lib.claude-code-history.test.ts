import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaudeCodeImportCursor,
  claudeCodeMessageKey,
  claudeCodeMessageUuidKey,
  claudeCodeSessionKey,
  parseClaudeCodeLine,
  readClaudeCodeHistory,
  resolveClaudeCodeConfigDir,
} from "../src/lib/claude-code-history.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_ID = "msg-SECRET-0001";
const REQUEST_ID = "req-SECRET-0001";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET_PROMPT = "SECRET-CLAUDE-PROMPT";
const SECRET_PATH = "C:\\SECRET-WORKSPACE\\claude";
const START = "2026-11-01T10:00:00.000Z";
const SECOND = "2026-11-01T10:01:00.000Z";

interface AssistantOptions {
  id?: string;
  requestId?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  model?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  usage?: Record<string, unknown>;
}

function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
    ...over,
  };
}

function assistant(options: AssistantOptions = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: options.uuid ?? UUID,
    sessionId: options.sessionId ?? SESSION_ID,
    requestId: options.requestId ?? REQUEST_ID,
    timestamp: options.timestamp ?? START,
    isSidechain: options.isSidechain ?? false,
    isApiErrorMessage: options.isApiErrorMessage ?? false,
    cwd: SECRET_PATH,
    message: {
      id: options.id ?? MESSAGE_ID,
      model: options.model ?? "claude-sonnet-4-5",
      content: [{ type: "text", text: SECRET_PROMPT }],
      usage: options.usage ?? usage(),
    },
  })}\n`;
}

describe("parseClaudeCodeLine", () => {
  it("keeps only hashed ids and numeric counters", () => {
    const parsed = parseClaudeCodeLine(assistant().trim());
    expect(parsed).toMatchObject({
      atMs: Date.parse(START),
      model: "claude-sonnet-4-5",
      usage: {
        input: 10,
        read: 100,
        write: 50,
        output: 20,
        oneHour: 20,
        fiveMinute: 30,
      },
      sidechain: false,
    });
    expect(parsed?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed?.nativeSessionKey).toBe(claudeCodeSessionKey(SESSION_ID));
    expect(parsed?.nativeMessageKeys[0]).toBe(claudeCodeMessageUuidKey(UUID));
    expect(claudeCodeMessageKey(MESSAGE_ID)).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(MESSAGE_ID);
    expect(serialized).not.toContain(REQUEST_ID);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(UUID);
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_PATH);
  });

  it("skips API errors and the synthetic model", () => {
    expect(parseClaudeCodeLine(assistant({ isApiErrorMessage: true }).trim())).toBeUndefined();
    expect(parseClaudeCodeLine(assistant({ model: "<synthetic>" }).trim())).toBeUndefined();
  });
});

describe("readClaudeCodeHistory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocq-claude-history-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function transcriptPath(name = `${SESSION_ID}.jsonl`, project = "project-a"): string {
    return join(root, "projects", project, name);
  }

  async function writeTranscript(content: string, path = transcriptPath()): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  it("counts one split response once with per-counter maxima", async () => {
    await writeTranscript(
      assistant({ usage: usage({ output_tokens: 5 }) }) +
        assistant({
          uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          usage: usage({ output_tokens: 20, cache_read_input_tokens: 120 }),
        }),
    );
    const batch = await readClaudeCodeHistory({ root });
    expect(batch.available).toBe(true);
    expect(batch.invocations).toHaveLength(1);
    expect(batch.invocations[0]?.tokens).toEqual({
      input: 10,
      cacheRead: 120,
      cacheWrite: 50,
      output: 20,
      reasoning: 0,
    });
    expect(batch.invocations[0]?.nativeMessageKeys).toHaveLength(2);
  });

  it("merges duplicate copies across files with maxima and one dedupe key", async () => {
    await writeTranscript(assistant({ usage: usage({ output_tokens: 5 }) }));
    await writeTranscript(
      assistant({ usage: usage({ output_tokens: 20, cache_read_input_tokens: 120 }) }),
      transcriptPath(`${SESSION_ID}.jsonl`, "project-b"),
    );
    const batch = await readClaudeCodeHistory({ root });
    expect(batch.invocations).toHaveLength(1);
    expect(batch.invocations[0]?.tokens.cacheRead).toBe(120);
    expect(batch.invocations[0]?.tokens.output).toBe(20);
  });

  it("drops a sidechain replay of a parent message id but keeps a unique sidechain response", async () => {
    await writeTranscript(assistant());
    await writeTranscript(
      assistant({
        requestId: "req-SECRET-REPLAY",
        isSidechain: true,
        usage: usage({ input_tokens: 999, output_tokens: 999 }),
      }) +
        assistant({
          id: "msg-SECRET-SIDECHAIN",
          requestId: "req-SECRET-SIDECHAIN",
          isSidechain: true,
          usage: usage({ input_tokens: 7, output_tokens: 3 }),
        }),
      join(root, "projects", "project-a", SESSION_ID, "subagents", "agent-1.jsonl"),
    );
    const batch = await readClaudeCodeHistory({ root });
    expect(batch.invocations).toHaveLength(2);
    expect(
      batch.invocations.map((invocation) => invocation.tokens.input).sort((a, b) => a - b),
    ).toEqual([7, 10]);
  });

  it("keeps dropping sidechain replays in later runs from the carried parent hashes", async () => {
    const path = await writeTranscript(assistant());
    const first = await readClaudeCodeHistory({ root });
    expect(first.invocations).toHaveLength(1);
    await appendFile(
      path,
      assistant({
        requestId: "req-SECRET-REPLAY",
        isSidechain: true,
        usage: usage({ input_tokens: 999, output_tokens: 999 }),
      }),
    );
    const second = await readClaudeCodeHistory({ root, cursor: first.cursor });
    expect(second.invocations).toEqual([]);
  });

  it("skips API errors and synthetic responses without token records", async () => {
    await writeTranscript(
      assistant({ isApiErrorMessage: true }) +
        assistant({ id: "msg-synthetic", model: "<synthetic>" }) +
        assistant({ id: "msg-real", requestId: "req-real" }),
    );
    const batch = await readClaudeCodeHistory({ root });
    expect(batch.invocations).toHaveLength(1);
    expect(batch.invocations[0]?.tokens.input).toBe(10);
  });

  it("reads only appended bytes and leaves a partial trailing line", async () => {
    const path = await writeTranscript(assistant());
    const first = await readClaudeCodeHistory({ root });
    const firstSize = (await stat(path)).size;
    expect(first.invocations).toHaveLength(1);
    expect(Object.values(first.cursor.files)[0]?.byteOffset).toBe(firstSize);

    const next = assistant({
      id: "msg-next",
      requestId: "req-next",
      uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      timestamp: SECOND,
      usage: usage({ input_tokens: 4, output_tokens: 2 }),
    });
    await appendFile(path, next.slice(0, 25));
    const partial = await readClaudeCodeHistory({ root, cursor: first.cursor });
    expect(partial.invocations).toEqual([]);
    expect(Object.values(partial.cursor.files)[0]?.byteOffset).toBe(firstSize);

    await appendFile(path, next.slice(25));
    const complete = await readClaudeCodeHistory({ root, cursor: partial.cursor });
    expect(complete.invocations).toHaveLength(1);
    expect(complete.invocations[0]?.tokens.input).toBe(4);
    expect(Object.values(complete.cursor.files)[0]?.byteOffset).toBe((await stat(path)).size);
  });

  it("re-reads a truncated transcript with stable dedupe keys", async () => {
    const path = await writeTranscript(
      assistant() +
        assistant({
          id: "msg-second",
          requestId: "req-second",
          uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          timestamp: SECOND,
        }),
    );
    const first = await readClaudeCodeHistory({ root });
    expect(first.invocations).toHaveLength(2);
    const originalKeys = first.invocations.map((invocation) => invocation.dedupeKey);

    await writeFile(path, `${assistant()}`);
    const second = await readClaudeCodeHistory({ root, cursor: first.cursor });
    expect(second.invocations).toHaveLength(1);
    expect(second.invocations[0]?.dedupeKey).toBe(originalKeys[0]);
  });

  it("reports unavailable without touching a missing root and keeps the supplied cursor", async () => {
    const cursor: ClaudeCodeImportCursor = { version: 1, files: {}, parentReplayKeys: [] };
    const batch = await readClaudeCodeHistory({ root: join(root, "missing"), cursor });
    expect(batch.available).toBe(false);
    expect(batch.invocations).toEqual([]);
    expect(batch.cursor).toBe(cursor);
  });

  it("never exposes prompts, cwd, raw ids, or file paths", async () => {
    const path = await writeTranscript(assistant());
    const serialized = JSON.stringify(await readClaudeCodeHistory({ root }));
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain(MESSAGE_ID);
    expect(serialized).not.toContain(REQUEST_ID);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain(UUID);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(path);
  });
});

describe("resolveClaudeCodeConfigDir", () => {
  const absolute = join(tmpdir(), "synthetic-claude");

  it("uses CLAUDE_CONFIG_DIR when absolute, otherwise ~/.claude", () => {
    expect(
      resolveClaudeCodeConfigDir({ env: { CLAUDE_CONFIG_DIR: absolute }, home: "unused" }),
    ).toBe(absolute);
    expect(resolveClaudeCodeConfigDir({ env: {}, home: join(tmpdir(), "synthetic-home") })).toBe(
      join(tmpdir(), "synthetic-home", ".claude"),
    );
  });

  it.each([
    ["a relative path", "relative/claude"],
    ["a whitespace-padded path", ` ${absolute} `],
    ["an empty value", ""],
    ["a UNC path", "\\\\server\\share\\claude"],
    ["a forward-slash UNC path", "//server/share/claude"],
  ])("fails closed for CLAUDE_CONFIG_DIR as %s", (_name, configDir) => {
    expect(
      resolveClaudeCodeConfigDir({ env: { CLAUDE_CONFIG_DIR: configDir }, home: "unused" }),
    ).toBeUndefined();
  });
});
