import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeConfigDirectoryCandidate } from "./anthropic.js";

/**
 * Observed-retention reader for one Claude Agent invocation. It stats/reads exactly one
 * computed transcript path (no directory listing), keeps only numeric cache counters, and
 * never returns, logs or stores transcript content, paths or ids.
 */

export type ClaudeObservedTtlResult = "1h" | "unchanged" | "retry";

/** Numeric counters of one grouped API message; nothing else leaves the parser. */
export interface TranscriptUsage {
  input?: number;
  read?: number;
  write?: number;
  oneHour?: number;
  fiveMinute?: number;
}

export interface ClaudeTranscriptQuery {
  /** The OpenCode session directory the SDK ran in (its `cwd`). */
  directory: string;
  /** Claude SDK session UUID (`native.sessionID`). */
  nativeSessionId: string;
  /** Transcript record `uuid` (`native.messageID`). */
  nativeMessageId: string;
  /** The step's reported tokens.input / cache.read / cache.write. */
  tokens: { input: number; read: number; write: number };
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only the tail is read; a flushed final record is always near the end. */
const TAIL_BYTES = 256 * 1024;
/**
 * shortcut: the SDK's long-path truncation/hash scheme could not be verified from source
 * (the SDK is not available locally), so longer encoded names yield no evidence; revisit
 * if the SDK's encoding becomes verifiable.
 */
const MAX_ENCODED_DIRECTORY_LENGTH = 200;

/** The single candidate transcript path, or undefined when it cannot be computed safely. */
export function claudeTranscriptPath(
  query: Pick<ClaudeTranscriptQuery, "directory" | "nativeSessionId" | "env" | "home">,
): string | undefined {
  if (!UUID_PATTERN.test(query.nativeSessionId) || query.directory.length === 0) return undefined;
  const encoded = query.directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length > MAX_ENCODED_DIRECTORY_LENGTH) return undefined;
  const env = query.env ?? process.env;
  // Fail closed on a present-but-invalid override (relative, padded, empty) instead of
  // reading another directory; UNC/network paths are never read either.
  const configured = parseClaudeConfigDirectoryCandidate(env.CLAUDE_CONFIG_DIR);
  if (configured === null || (configured !== undefined && /^(?:\\\\|\/\/)/.test(configured))) {
    return undefined;
  }
  const configDir = configured ?? join(query.home ?? homedir(), ".claude");
  return join(configDir, "projects", encoded, `${query.nativeSessionId}.jsonl`);
}

const counter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const maxOf = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * Groups assistant records by `message.id` (records repeat it per content block; the max of
 * each counter wins) and returns the group of the record whose `uuid` matches. Only text up
 * to the last newline is parsed, so a partially flushed trailing line is ignored.
 */
export function parseTranscriptTail(text: string, uuid: string): TranscriptUsage | undefined {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const groups = new Map<string, Record<keyof TranscriptUsage, number | undefined>>();
  let target: string | undefined;
  for (const line of complete.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as { type?: unknown; uuid?: unknown; message?: unknown };
    if (entry.type !== "assistant" || typeof entry.message !== "object" || entry.message === null) {
      continue;
    }
    const message = entry.message as { id?: unknown; usage?: unknown };
    if (
      typeof message.id !== "string" ||
      typeof message.usage !== "object" ||
      message.usage === null
    ) {
      continue;
    }
    if (entry.uuid === uuid) target = message.id;
    const usage = message.usage as Record<string, unknown>;
    const split =
      typeof usage.cache_creation === "object" && usage.cache_creation !== null
        ? (usage.cache_creation as Record<string, unknown>)
        : {};
    const group = groups.get(message.id) ?? {
      input: undefined,
      read: undefined,
      write: undefined,
      oneHour: undefined,
      fiveMinute: undefined,
    };
    group.input = maxOf(group.input, counter(usage.input_tokens));
    group.read = maxOf(group.read, counter(usage.cache_read_input_tokens));
    group.write = maxOf(group.write, counter(usage.cache_creation_input_tokens));
    group.oneHour = maxOf(group.oneHour, counter(split.ephemeral_1h_input_tokens));
    group.fiveMinute = maxOf(group.fiveMinute, counter(split.ephemeral_5m_input_tokens));
    groups.set(message.id, group);
  }
  const group = target === undefined ? undefined : groups.get(target);
  if (group === undefined) return undefined;
  return {
    ...(group.input === undefined ? {} : { input: group.input }),
    ...(group.read === undefined ? {} : { read: group.read }),
    ...(group.write === undefined ? {} : { write: group.write }),
    ...(group.oneHour === undefined ? {} : { oneHour: group.oneHour }),
    ...(group.fiveMinute === undefined ? {} : { fiveMinute: group.fiveMinute }),
  };
}

/** Tail text; undefined when unreadable or absent (maybe not flushed yet); null for a non-regular file. */
async function readTail(path: string, openFile: typeof open): Promise<string | undefined | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open on POSIX; it is undefined on Windows.
    handle = await openFile(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const { size } = stats;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A tail starting mid-file begins inside a record; drop that cut line.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * "1h" only when the matched message's cache writes are 1-hour-only and its grouped
 * counters equal the step's reported tokens exactly; "retry" when the file or record is not
 * (yet) there; "unchanged" for everything else.
 */
export async function readClaudeObservedTtl(
  query: ClaudeTranscriptQuery,
  deps: { open?: typeof open } = {},
): Promise<ClaudeObservedTtlResult> {
  const path = claudeTranscriptPath(query);
  if (path === undefined || !UUID_PATTERN.test(query.nativeMessageId)) return "unchanged";
  const text = await readTail(path, deps.open ?? open);
  if (text === null) return "unchanged";
  if (text === undefined) return "retry";
  const usage = parseTranscriptTail(text, query.nativeMessageId);
  if (usage === undefined) return "retry";
  const { input, read, write } = query.tokens;
  if (usage.input !== input || usage.read !== read || usage.write !== write) return "unchanged";
  // 1h-only: no 5m writes and the 1h count equals the total writes.
  return usage.fiveMinute === 0 &&
    usage.oneHour !== undefined &&
    usage.oneHour > 0 &&
    usage.oneHour === usage.write
    ? "1h"
    : "unchanged";
}
