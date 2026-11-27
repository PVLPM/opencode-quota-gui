import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveClaudeConfigDirectory } from "./claude-agent-transcript-ttl.js";
import {
  extractTranscriptUsage,
  mergeTranscriptUsage,
  type TranscriptUsage,
} from "./claude-transcript-usage.js";
import {
  asRecord,
  asString,
  asTimestampMs,
  hashUsageImport,
  listJsonlFiles,
  readIncrementalJsonlFile,
  type UsageImportTokens,
  usageImportFileKey,
} from "./usage-import.js";

/**
 * Privacy-minimal reader for local Claude Code transcripts.
 *
 * One API response repeats its `message.id` over several transcript lines, so
 * counters are grouped per `message.id + requestId` and the maximum of each
 * counter wins. A later run that appends another block for the same response
 * emits the same dedupe key with counters that can only grow; consumers upsert.
 *
 * Prompts, responses, tool payloads, cwd, paths and raw ids never leave this
 * module. Session/message identifiers are exposed only as domain-separated
 * hashes for cross-harness exclusion.
 */

export interface ClaudeCodeImportedInvocation {
  atMs: number;
  model: string;
  tokens: UsageImportTokens;
  /** sha256 of `message.id + requestId`; the raw ids never leave the parser. */
  dedupeKey: string;
  /** sha256 of the transcript `sessionId`, when recorded. */
  nativeSessionKey?: string;
  /** sha256 of each transcript record `uuid` in the response group. */
  nativeMessageKeys: string[];
}

export interface ClaudeCodeFileCursor {
  size: number;
  mtimeMs: number;
  byteOffset: number;
}

export interface ClaudeCodeImportCursor {
  version: 1;
  files: Record<string, ClaudeCodeFileCursor>;
  /** Hashes of non-sidechain response identities already seen, for replay rejection. */
  parentReplayKeys: string[];
}

export interface ClaudeCodeImportBatch {
  /** False when the configured Claude config directory is missing or is not a directory. */
  available: boolean;
  invocations: ClaudeCodeImportedInvocation[];
  cursor: ClaudeCodeImportCursor;
}

export interface ClaudeHistoryReadInput {
  /** Claude config directory. The resolver below derives it from CLAUDE_CONFIG_DIR or home. */
  root?: string;
  cursor?: ClaudeCodeImportCursor;
}

export interface ClaudeCodeParsedLine {
  dedupeKey: string;
  /** Hashed response identity scoped to its session, used to drop sidechain replays. */
  replayKey: string;
  atMs: number;
  model: string;
  usage: TranscriptUsage;
  sidechain: boolean;
  nativeSessionKey?: string;
  nativeMessageKeys: string[];
}

/** Hash of a Claude transcript `sessionId`, for cross-harness exclusion. */
export function claudeCodeSessionKey(sessionId: string): string {
  return hashUsageImport("claude-session", sessionId);
}

/** Hash of a Claude transcript `message.id`, for cross-harness exclusion. */
export function claudeCodeMessageKey(messageId: string): string {
  return hashUsageImport("claude-message", messageId);
}

/** Hash of a Claude transcript record `uuid`, for cross-harness exclusion. */
export function claudeCodeMessageUuidKey(uuid: string): string {
  return hashUsageImport("claude-message-uuid", uuid);
}

function hasCounters(usage: TranscriptUsage): boolean {
  return (
    usage.input !== undefined ||
    usage.read !== undefined ||
    usage.write !== undefined ||
    usage.output !== undefined
  );
}

/** Parses one assistant line into already-hashed, privacy-safe metadata. */
export function parseClaudeCodeLine(line: string): ClaudeCodeParsedLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined || record.type !== "assistant") return undefined;
  if (record.isApiErrorMessage === true) return undefined;

  const message = asRecord(record.message);
  if (message === undefined) return undefined;
  const messageId = asString(message.id);
  if (messageId === undefined) return undefined;
  const rawModel = asString(message.model);
  if (rawModel === "<synthetic>") return undefined;
  const usage = extractTranscriptUsage(message.usage);
  if (!hasCounters(usage)) return undefined;
  const atMs = asTimestampMs(record.timestamp);
  if (atMs === undefined) return undefined;

  const requestId = asString(record.requestId) ?? "";
  const sessionId = asString(record.sessionId);
  const uuid = asString(record.uuid);
  const nativeSessionKey = sessionId === undefined ? undefined : claudeCodeSessionKey(sessionId);
  const messageKey = claudeCodeMessageKey(messageId);
  return {
    dedupeKey: hashUsageImport("claude-invocation", messageId, requestId),
    replayKey: hashUsageImport("claude-replay", nativeSessionKey ?? "", messageKey),
    atMs,
    model: rawModel ?? "unknown",
    usage,
    sidechain: record.isSidechain === true,
    ...(nativeSessionKey === undefined ? {} : { nativeSessionKey }),
    nativeMessageKeys: uuid === undefined ? [] : [claudeCodeMessageUuidKey(uuid)],
  };
}

interface ClaudeCandidate {
  dedupeKey: string;
  replayKey: string;
  atMs: number;
  model: string;
  usage: TranscriptUsage;
  sidechain: boolean;
  nativeSessionKey?: string;
  nativeMessageKeys: Set<string>;
}

function mergeCandidate(
  candidates: Map<string, ClaudeCandidate>,
  parsed: ClaudeCodeParsedLine,
): void {
  const existing = candidates.get(parsed.dedupeKey);
  if (existing === undefined) {
    candidates.set(parsed.dedupeKey, {
      dedupeKey: parsed.dedupeKey,
      replayKey: parsed.replayKey,
      atMs: parsed.atMs,
      model: parsed.model,
      usage: parsed.usage,
      sidechain: parsed.sidechain,
      ...(parsed.nativeSessionKey === undefined
        ? {}
        : { nativeSessionKey: parsed.nativeSessionKey }),
      nativeMessageKeys: new Set(parsed.nativeMessageKeys),
    });
    return;
  }
  existing.atMs = Math.min(existing.atMs, parsed.atMs);
  existing.model = existing.model === "unknown" ? parsed.model : existing.model;
  existing.usage = mergeTranscriptUsage(existing.usage, parsed.usage);
  // A parent line and a sidechain line for the same key describe one response.
  if (existing.sidechain && !parsed.sidechain) {
    existing.replayKey = parsed.replayKey;
    existing.nativeSessionKey = parsed.nativeSessionKey ?? existing.nativeSessionKey;
  }
  existing.sidechain = existing.sidechain && parsed.sidechain;
  for (const key of parsed.nativeMessageKeys) existing.nativeMessageKeys.add(key);
}

function tokensFromUsage(usage: TranscriptUsage): UsageImportTokens {
  return {
    // Claude reports cache reads/writes beside input_tokens, not inside it.
    input: usage.input ?? 0,
    cacheRead: usage.read ?? 0,
    cacheWrite: usage.write ?? 0,
    output: usage.output ?? 0,
    reasoning: 0,
  };
}

/** Config directory from CLAUDE_CONFIG_DIR, or `~/.claude`; invalid overrides fail closed. */
export function resolveClaudeCodeConfigDir(
  deps: { env?: Readonly<Record<string, string | undefined>>; home?: string } = {},
): string | undefined {
  return resolveClaudeConfigDirectory(deps);
}

/**
 * Reads only bytes appended since the previous cursor. A truncated or rewritten
 * file is read again from the start; stable dedupe keys make repeated records
 * idempotent.
 */
export async function readClaudeCodeHistory(
  input: ClaudeHistoryReadInput = {},
): Promise<ClaudeCodeImportBatch> {
  const previous =
    input.cursor?.version === 1
      ? input.cursor
      : { version: 1 as const, files: {}, parentReplayKeys: [] };
  if (input.root === undefined) {
    return { available: false, invocations: [], cursor: previous };
  }
  const rootStats = await stat(input.root).catch(() => undefined);
  if (rootStats === undefined || !rootStats.isDirectory()) {
    return { available: false, invocations: [], cursor: previous };
  }

  const paths = (await listJsonlFiles(join(input.root, "projects"))) ?? [];
  const candidates = new Map<string, ClaudeCandidate>();
  const nextFiles: Record<string, ClaudeCodeFileCursor> = {};

  for (const path of paths.sort()) {
    const key = usageImportFileKey(path);
    const cursor = await readIncrementalJsonlFile<ClaudeCodeFileCursor, undefined>({
      path,
      prior: previous.files[key],
      state: () => undefined,
      onLine: (line) => {
        const parsed = parseClaudeCodeLine(line);
        if (parsed !== undefined) mergeCandidate(candidates, parsed);
      },
      toCursor: (_state, stats, byteOffset) => ({
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        byteOffset,
      }),
    });
    if (cursor !== undefined) nextFiles[key] = cursor;
  }

  const parentReplayKeys = new Set(previous.parentReplayKeys);
  for (const candidate of candidates.values()) {
    if (!candidate.sidechain) parentReplayKeys.add(candidate.replayKey);
  }

  const invocations: ClaudeCodeImportedInvocation[] = [];
  for (const candidate of candidates.values()) {
    if (candidate.sidechain && parentReplayKeys.has(candidate.replayKey)) continue;
    invocations.push({
      atMs: candidate.atMs,
      model: candidate.model,
      tokens: tokensFromUsage(candidate.usage),
      dedupeKey: candidate.dedupeKey,
      ...(candidate.nativeSessionKey === undefined
        ? {}
        : { nativeSessionKey: candidate.nativeSessionKey }),
      nativeMessageKeys: [...candidate.nativeMessageKeys].sort(),
    });
  }
  invocations.sort(
    (left, right) => left.atMs - right.atMs || left.dedupeKey.localeCompare(right.dedupeKey),
  );

  return {
    available: true,
    invocations,
    cursor: {
      version: 1,
      files: nextFiles,
      parentReplayKeys: [...parentReplayKeys].sort(),
    },
  };
}
