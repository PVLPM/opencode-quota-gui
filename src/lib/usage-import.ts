import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Token counters shared by imported harnesses; `input` is fresh (non-cached) input. */
export interface UsageImportTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

export function asTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Domain-separated sha256; raw identifiers never leave the importer. */
export function hashUsageImport(kind: string, ...parts: readonly string[]): string {
  return createHash("sha256")
    .update([kind, ...parts].join("\0"), "utf8")
    .digest("hex");
}

/** Opaque cursor key for a transcript path; the raw path is never persisted. */
export function usageImportFileKey(path: string): string {
  const normalized = resolve(path);
  return hashUsageImport(
    "file",
    process.platform === "win32" ? normalized.toLowerCase() : normalized,
  );
}

/**
 * Lists `.jsonl` files under a directory. `undefined` means the directory itself
 * is missing or unreadable, which callers surface as an unavailable harness.
 */
export async function listJsonlFiles(
  directory: string,
  accept: (name: string) => boolean = () => true,
): Promise<string[] | undefined> {
  const files: string[] = [];
  return (await collectJsonlFiles(directory, accept, files)) ? files : undefined;
}

async function collectJsonlFiles(
  directory: string,
  accept: (name: string) => boolean,
  files: string[],
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(path, accept, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && accept(entry.name)) {
      files.push(path);
    }
  }
  return true;
}

const READ_CHUNK_BYTES = 64 * 1024;
/** A single JSONL record larger than this is skipped rather than buffered whole. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Reads complete lines in `[startOffset, endOffset)` and returns the offset just
 * after the last newline. A partially written trailing line is left for the next
 * run. Chunked reads keep memory independent of file size.
 */
export async function readAppendedJsonLines(
  path: string,
  startOffset: number,
  endOffset: number,
  onLine: (line: string) => void,
): Promise<number> {
  if (!Number.isFinite(startOffset) || startOffset < 0 || endOffset <= startOffset) {
    return startOffset;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open on POSIX; it is undefined on Windows.
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return startOffset;
    const end = Math.min(endOffset, stats.size);
    if (end <= startOffset) return startOffset;

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = startOffset;
    let lastNewline = startOffset;
    let pending = Buffer.alloc(0);
    let skipping = false;

    while (position < end) {
      const wanted = Math.min(buffer.length, end - position);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0) {
          const rest = chunk.subarray(start);
          if (!skipping) {
            if (pending.length + rest.length > MAX_LINE_BYTES) {
              skipping = true;
              pending = Buffer.alloc(0);
            } else {
              pending = pending.length === 0 ? Buffer.from(rest) : Buffer.concat([pending, rest]);
            }
          }
          break;
        }
        const segment = chunk.subarray(start, newline);
        if (!skipping && pending.length + segment.length <= MAX_LINE_BYTES) {
          const lineBuffer = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
          const line = lineBuffer.toString("utf8");
          onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
        pending = Buffer.alloc(0);
        skipping = false;
        lastNewline = position + newline + 1;
        start = newline + 1;
      }
      position += bytesRead;
    }
    return lastNewline;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface IncrementalJsonlCursor {
  size: number;
  mtimeMs: number;
  byteOffset: number;
}

export interface IncrementalJsonlRead<TCursor extends IncrementalJsonlCursor, TState> {
  path: string;
  prior?: TCursor;
  /** Builds the parse state; `undefined` means a new, truncated, or rewritten file. */
  state: (prior: TCursor | undefined) => TState;
  onLine: (line: string, state: TState) => void;
  toCursor: (
    state: TState,
    stats: { size: number; mtimeMs: number },
    byteOffset: number,
  ) => TCursor;
}

/**
 * Reads one transcript incrementally. Missing/non-file paths yield `undefined`;
 * a read error yields the prior cursor so the next run retries.
 */
export async function readIncrementalJsonlFile<TCursor extends IncrementalJsonlCursor, TState>(
  read: IncrementalJsonlRead<TCursor, TState>,
): Promise<TCursor | undefined> {
  const stats = await stat(read.path).catch(() => undefined);
  if (stats === undefined || !stats.isFile()) return undefined;
  const prior = read.prior;
  const reset =
    prior === undefined ||
    stats.size < prior.size ||
    (stats.size === prior.size && stats.mtimeMs !== prior.mtimeMs);
  const state = read.state(reset ? undefined : prior);
  const start = reset ? 0 : Math.min(prior?.byteOffset ?? 0, stats.size);
  let nextOffset = start;
  if (start < stats.size) {
    try {
      nextOffset = await readAppendedJsonLines(read.path, start, stats.size, (line) =>
        read.onLine(line, state),
      );
    } catch {
      return read.prior;
    }
  }
  return read.toCursor(state, stats, nextOffset);
}
