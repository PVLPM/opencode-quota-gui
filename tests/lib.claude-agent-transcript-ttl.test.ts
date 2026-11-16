import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeTranscriptPath,
  parseTranscriptTail,
  readClaudeObservedTtl,
} from "../src/lib/claude-agent-transcript-ttl.js";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKENS = { input: 3, read: 100, write: 50 };

function record(
  over: { uuid?: string; id?: string; type?: string; usage?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    type: over.type ?? "assistant",
    uuid: over.uuid ?? UUID,
    message: {
      id: over.id ?? "msg_1",
      content: [{ type: "text", text: "SECRET-SYNTHETIC-CONTENT" }],
      usage: over.usage ?? {
        input_tokens: 3,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
}

describe("parseTranscriptTail", () => {
  it("returns only numeric counters for the matched message", () => {
    expect(parseTranscriptTail(`${record()}\n`, UUID)).toEqual({
      input: 3,
      read: 100,
      write: 50,
      oneHour: 50,
      fiveMinute: 0,
    });
  });

  it("merges records that repeat a message id with the max of each counter", () => {
    const a = record({ uuid: "11111111-1111-4111-8111-111111111111", usage: { input_tokens: 1 } });
    const b = record({
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
      },
    });
    expect(parseTranscriptTail(`${a}\n${b}\n`, UUID)).toMatchObject({ input: 3, oneHour: 50 });
  });

  it("ignores a partial trailing line and a missing uuid record", () => {
    expect(parseTranscriptTail(`${record()}`, UUID)).toBeUndefined();
    expect(parseTranscriptTail(`${record({ uuid: "x" })}\n`, UUID)).toBeUndefined();
    expect(parseTranscriptTail(`${record({ type: "user" })}\n`, UUID)).toBeUndefined();
    expect(parseTranscriptTail(`not json\n${record()}\n{"partial`, UUID)).toMatchObject({
      write: 50,
    });
  });

  it("leaves missing counters undefined instead of zero", () => {
    const parsed = parseTranscriptTail(`${record({ usage: { input_tokens: 3 } })}\n`, UUID);
    expect(parsed).toEqual({ input: 3 });
  });

  it("reports a missing split as undefined fields", () => {
    const line = record({
      usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    });
    const parsed = parseTranscriptTail(`${line}\n`, UUID);
    expect(parsed?.oneHour).toBeUndefined();
    expect(parsed?.fiveMinute).toBeUndefined();
  });
});

describe("claudeTranscriptPath", () => {
  it("encodes every non-alphanumeric cwd character as a dash under the config dir", () => {
    const path = claudeTranscriptPath({
      directory: "C:\\Users\\Test User\\proj.one",
      nativeSessionId: SID,
      env: { CLAUDE_CONFIG_DIR: join(tmpdir(), "cfg") },
      home: "unused",
    });
    expect(path).toBe(
      join(tmpdir(), "cfg", "projects", "C--Users-Test-User-proj-one", `${SID}.jsonl`),
    );
  });

  it("defaults to ~/.claude", () => {
    expect(
      claudeTranscriptPath({ directory: "/a/b", nativeSessionId: SID, env: {}, home: "/home/u" }),
    ).toBe(join("/home/u", ".claude", "projects", "-a-b", `${SID}.jsonl`));
  });

  it.each([
    "../x",
    `${SID}/..`,
    "",
    "not-a-uuid",
    `${SID}.jsonl`,
    `${SID}\\..\\x`,
  ])("rejects non-UUID session id %j", (id) => {
    expect(
      claudeTranscriptPath({ directory: "/a", nativeSessionId: id, env: {}, home: "/h" }),
    ).toBeUndefined();
  });

  it("treats an encoded name longer than 200 characters as unavailable", () => {
    expect(
      claudeTranscriptPath({
        directory: `/${"a".repeat(200)}`,
        nativeSessionId: SID,
        env: {},
        home: "/h",
      }),
    ).toBeUndefined();
    expect(
      claudeTranscriptPath({
        directory: `/${"a".repeat(199)}`,
        nativeSessionId: SID,
        env: {},
        home: "/h",
      }),
    ).toBeDefined();
  });
});

describe("readClaudeObservedTtl", () => {
  let root: string;
  let directory: string;
  const env = () => ({ CLAUDE_CONFIG_DIR: root });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocq-claude-ttl-"));
    directory = "C:\\Users\\Synthetic User\\repo";
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(content: string): Promise<string> {
    const path = claudeTranscriptPath({
      directory,
      nativeSessionId: SID,
      env: env(),
      home: "unused",
    })!;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }
  const read = (tokens = TOKENS, deps?: Parameters<typeof readClaudeObservedTtl>[1]) =>
    readClaudeObservedTtl(
      {
        directory,
        nativeSessionId: SID,
        nativeMessageId: UUID,
        tokens,
        env: env(),
        home: "unused",
      },
      deps,
    );

  const FRESH_1H = {
    input_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 50,
    cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
  };
  const FRESH_TOKENS = { input: 3, read: 0, write: 50 };

  it("upgrades 1h-only writes with confirmed zero cache reads", async () => {
    await write(`${record({ usage: FRESH_1H })}\n`);
    expect(await read(FRESH_TOKENS)).toBe("1h");
  });

  it("does not promote 1h writes that accompany cache reads of unknown TTL", async () => {
    // A large read of earlier (possibly 5-minute) entries beside a small new 1h write.
    await write(`${record()}\n`);
    expect(await read()).toBe("unchanged");
  });

  it("does not trust a host-normalized zero read when the SDK record shows reads", async () => {
    await write(`${record()}\n`);
    expect(await read({ input: 3, read: 0, write: 50 })).toBe("unchanged");
  });

  it("does not promote when the SDK record lacks a read counter", async () => {
    const { cache_read_input_tokens: _omit, ...withoutRead } = FRESH_1H;
    await write(`${record({ usage: withoutRead })}\n`);
    expect(await read(FRESH_TOKENS)).toBe("unchanged");
  });

  it.each([
    ["5m writes", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50 }],
    ["mixed writes", { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 30 }],
    ["zero writes", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }],
    ["unparseable split", { ephemeral_1h_input_tokens: "50", ephemeral_5m_input_tokens: 0 }],
    ["missing 5m", { ephemeral_1h_input_tokens: 50 }],
  ])("leaves %s unchanged", async (_name, split) => {
    await write(
      `${record({
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens:
            split.ephemeral_1h_input_tokens === 0 && split.ephemeral_5m_input_tokens === 0 ? 0 : 50,
          cache_creation: split,
        },
      })}\n`,
    );
    const tokens =
      split.ephemeral_1h_input_tokens === 0 && split.ephemeral_5m_input_tokens === 0
        ? { ...TOKENS, write: 0 }
        : TOKENS;
    expect(await read(tokens)).toBe("unchanged");
  });

  it("leaves a 1h count below the total writes unchanged", async () => {
    await write(
      `${record({
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 },
        },
      })}\n`,
    );
    expect(await read()).toBe("unchanged");
  });

  it.each([
    ["cache_creation_input_tokens", { input_tokens: 3, cache_read_input_tokens: 100 }],
    ["input_tokens", { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }],
    ["cache_read_input_tokens", { input_tokens: 3, cache_creation_input_tokens: 0 }],
  ])("never treats a missing %s as zero", async (_name, usage) => {
    await write(
      `${record({
        usage: {
          ...usage,
          cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
        },
      })}\n`,
    );
    expect(await read({ input: 0, read: 0, write: 0 })).toBe("unchanged");
    expect(await read({ input: 3, read: 100, write: 0 })).toBe("unchanged");
  });

  it("parses later records after a tail cut inside a multi-byte character", async () => {
    const filler = `${record({ uuid: "22222222-2222-4222-8222-222222222222", id: "msg_0", usage: { input_tokens: 1 } }).replace("SECRET-SYNTHETIC-CONTENT", "日本語😀日本語")}\n`;
    // Pad so the 256 KiB boundary falls inside a 3/4-byte character at several offsets.
    for (const pad of ["", "a", "ab", "abc"]) {
      await write(`${pad}${filler.repeat(4000)}${record({ usage: FRESH_1H })}\n`);
      expect(await read(FRESH_TOKENS)).toBe("1h");
    }
  });

  it("leaves a counter mismatch unchanged", async () => {
    await write(`${record()}\n`);
    expect(await read({ ...TOKENS, input: 4 })).toBe("unchanged");
    expect(await read({ ...TOKENS, read: 99 })).toBe("unchanged");
    expect(await read({ ...TOKENS, write: 51 })).toBe("unchanged");
  });

  it("asks for a retry when the file or the uuid record is not there yet", async () => {
    expect(await read()).toBe("retry");
    await write(`${record({ uuid: "11111111-1111-4111-8111-111111111111" })}\n`);
    expect(await read()).toBe("retry");
  });

  it("is unchanged for an invalid session id and never opens a file", async () => {
    const openSpy = vi.fn();
    const result = await readClaudeObservedTtl(
      {
        directory,
        nativeSessionId: "../etc/passwd",
        nativeMessageId: UUID,
        tokens: TOKENS,
        env: env(),
        home: "x",
      },
      { open: openSpy as unknown as typeof open },
    );
    expect(result).toBe("unchanged");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a relative path", "relative/claude"],
    ["a whitespace-padded path", ` ${join(tmpdir(), "cfg")} `],
    ["an empty value", ""],
    ["a UNC path", "\\\\server\\share\\claude"],
    ["a forward-slash UNC path", "//server/share/claude"],
  ])("fails closed for CLAUDE_CONFIG_DIR as %s", async (_name, configDir) => {
    const openSpy = vi.fn();
    const result = await readClaudeObservedTtl(
      {
        directory,
        nativeSessionId: SID,
        nativeMessageId: UUID,
        tokens: TOKENS,
        env: { CLAUDE_CONFIG_DIR: configDir },
        home: "unused",
      },
      { open: openSpy as unknown as typeof open },
    );
    expect(result).toBe("unchanged");
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      claudeTranscriptPath({
        directory,
        nativeSessionId: SID,
        env: { CLAUDE_CONFIG_DIR: configDir },
        home: "unused",
      }),
    ).toBeUndefined();
  });

  it("rejects a non-regular file without reading it and closes the handle", async () => {
    const readSpy = vi.fn();
    const close = vi.fn(async () => undefined);
    const fakeOpen = vi.fn(async () => ({
      stat: async () => ({ isFile: () => false, size: 10 }),
      read: readSpy,
      close,
    }));
    expect(await read(TOKENS, { open: fakeOpen as unknown as typeof open })).toBe("unchanged");
    expect(readSpy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens read-only", async () => {
    await write(`${record()}\n`);
    const openSpy = vi.fn(open);
    await read(TOKENS, { open: openSpy as typeof open });
    const flags = openSpy.mock.calls[0]?.[1] as number | string;
    const { constants } = await import("node:fs");
    expect(typeof flags === "number" ? flags & constants.O_ACCMODE : flags).toBe(
      typeof flags === "number" ? constants.O_RDONLY : "r",
    );
  });

  it("opens exactly the one computed path", async () => {
    const path = await write(`${record({ usage: FRESH_1H })}\n`);
    const openSpy = vi.fn(open);
    expect(await read(FRESH_TOKENS, { open: openSpy as typeof open })).toBe("1h");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0]).toBe(path);
  });

  it("reads only the tail of a large file and ignores the cut first line", async () => {
    const filler =
      `${record({ uuid: "22222222-2222-4222-8222-222222222222", id: "msg_0" })}\n`.repeat(3000);
    await write(`${filler}${record({ usage: FRESH_1H })}\n`);
    expect(await read(FRESH_TOKENS)).toBe("1h");
  });
});
