import { asNonNegativeNumber, asRecord } from "./usage-import.js";

/** Numeric counters of one grouped API message; nothing else leaves the parser. */
export interface TranscriptUsage {
  input?: number;
  read?: number;
  write?: number;
  output?: number;
  oneHour?: number;
  fiveMinute?: number;
}

const USAGE_KEYS = ["input", "read", "write", "output", "oneHour", "fiveMinute"] as const;

const counter = asNonNegativeNumber;

/** Extracts only the counters this importer understands from a transcript usage object. */
export function extractTranscriptUsage(usage: unknown): TranscriptUsage {
  const record = asRecord(usage);
  if (record === undefined) return {};
  const split = asRecord(record.cache_creation) ?? {};
  const values: Record<(typeof USAGE_KEYS)[number], number | undefined> = {
    input: counter(record.input_tokens),
    read: counter(record.cache_read_input_tokens),
    write: counter(record.cache_creation_input_tokens),
    output: counter(record.output_tokens),
    oneHour: counter(split.ephemeral_1h_input_tokens),
    fiveMinute: counter(split.ephemeral_5m_input_tokens),
  };
  const result: TranscriptUsage = {};
  for (const key of USAGE_KEYS) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Per-counter maximum, matching how one API response repeats its usage over content blocks. */
export function mergeTranscriptUsage(
  left: TranscriptUsage,
  right: TranscriptUsage,
): TranscriptUsage {
  const result: TranscriptUsage = {};
  for (const key of USAGE_KEYS) {
    const a = left[key];
    const b = right[key];
    const value = a === undefined ? b : b === undefined ? a : Math.max(a, b);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Groups assistant records by `message.id` (records repeat it per content block; the max of
 * each counter wins) and returns the group of the record whose `uuid` matches. Only text up
 * to the last newline is parsed, so a partially flushed trailing line is ignored.
 */
export function parseTranscriptTail(text: string, uuid: string): TranscriptUsage | undefined {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const groups = new Map<string, TranscriptUsage>();
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
    groups.set(
      message.id,
      mergeTranscriptUsage(groups.get(message.id) ?? {}, extractTranscriptUsage(message.usage)),
    );
  }
  const group = target === undefined ? undefined : groups.get(target);
  return group;
}
