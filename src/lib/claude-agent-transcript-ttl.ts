import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeConfigDirectoryCandidate } from "./anthropic.js";
import { parseTranscriptTail } from "./claude-transcript-usage.js";

/**
 * Observed-retention reader for one Claude Agent invocation. It stats/reads exactly one
 * computed transcript path (no directory listing), keeps only numeric cache counters, and
 * never returns, logs or stores transcript content, paths or ids.
 */

export type ClaudeObservedTtlResult = "1h" | "unchanged" | "retry";

export { parseTranscriptTail, type TranscriptUsage } from "./claude-transcript-usage.js";

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

/**
 * The config directory named by `CLAUDE_CONFIG_DIR`, or the default `~/.claude`.
 * A present-but-invalid override (relative, padded, empty, UNC/network) is unresolved so
 * callers fail closed instead of reading another directory.
 */
export function resolveClaudeConfigDirectory(
  query: Pick<ClaudeTranscriptQuery, "env" | "home">,
): string | undefined {
  const env = query.env ?? process.env;
  if (env.CLAUDE_CONFIG_DIR !== undefined && /^(?:\\\\|\/\/)/.test(env.CLAUDE_CONFIG_DIR))
    return undefined;
  const configured = parseClaudeConfigDirectoryCandidate(env.CLAUDE_CONFIG_DIR);
  if (configured === null || (configured !== undefined && /^(?:\\\\|\/\/)/.test(configured))) {
    return undefined;
  }
  return configured ?? join(query.home ?? homedir(), ".claude");
}

/** The single candidate transcript path, or undefined when it cannot be computed safely. */
export function claudeTranscriptPath(
  query: Pick<ClaudeTranscriptQuery, "directory" | "nativeSessionId" | "env" | "home">,
): string | undefined {
  if (!UUID_PATTERN.test(query.nativeSessionId) || query.directory.length === 0) return undefined;
  const encoded = query.directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length > MAX_ENCODED_DIRECTORY_LENGTH) return undefined;
  const configDir = resolveClaudeConfigDirectory(query);
  if (configDir === undefined) return undefined;
  return join(configDir, "projects", encoded, `${query.nativeSessionId}.jsonl`);
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
  // 1h-only: no 5m writes and the 1h count equals the total writes. Any cache read, or a
  // missing read counter, means older segments of unknown TTL are in play, so the session
  // estimate must not be promoted from the new writes' TTL; the SDK's own read field is
  // required (OpenCode may normalize unavailable reads to 0).
  return usage.read === 0 &&
    usage.fiveMinute === 0 &&
    usage.oneHour !== undefined &&
    usage.oneHour > 0 &&
    usage.oneHour === usage.write
    ? "1h"
    : "unchanged";
}
