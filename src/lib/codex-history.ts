import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  asNonNegativeNumber,
  asNumber,
  asRecord,
  asString,
  asTimestampMs,
  hashUsageImport,
  listJsonlFiles,
  readIncrementalJsonlFile,
  readJsonlFilesWithBudget,
  sanitizeUsageImportEffort,
  sanitizeUsageImportModelId,
  type UsageImportTokens,
  type UsageResetPrecision,
} from "./usage-import.js";

/**
 * Privacy-minimal reader for local Codex CLI rollout history.
 *
 * The authoritative usage path is the `event_msg` / `token_count` stream: its
 * `total_token_usage` is cumulative per thread, so per-invocation tokens are
 * consecutive deltas. `token_usage_record` lines are deliberately ignored; using
 * both would count the same responses twice. Thresholds are covered by the same
 * stream; older rollouts only have `token_count`.
 *
 * Nothing except numeric counters, model/effort/provider strings and hashed
 * identifiers leaves this module. Prompts, responses, tool payloads, cwd and
 * paths are parsed only far enough to be discarded.
 */

export interface CodexTokenCounters {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CodexImportedInvocation {
  atMs: number;
  model: string;
  effort?: string;
  tokens: UsageImportTokens;
  dedupeKey: string;
}

export interface CodexRateLimitObservation {
  atMs: number;
  window: "primary" | "secondary";
  windowMinutes?: number;
  usedPercent: number;
  resetsAtMs?: number;
  /** `exact` for `resets_at`; `estimated` for a relative `resets_in_seconds`. */
  resetPrecision?: UsageResetPrecision;
  planType?: string;
  limitId?: string;
}

export interface CodexImportedThread {
  /** sha256 of the Codex thread id; the raw id never leaves the parser. */
  threadKey: string;
  /** sha256 of `creator_account_id` when recorded. */
  accountHint?: string;
  invocations: CodexImportedInvocation[];
  rateLimitObservations: CodexRateLimitObservation[];
}

export interface CodexFileCursor {
  size: number;
  mtimeMs: number;
  byteOffset: number;
  threadKey?: string;
  accountHint?: string;
  totals?: CodexTokenCounters;
  model?: string;
  effort?: string;
}

export interface CodexImportCursor {
  version: 1;
  files: Record<string, CodexFileCursor>;
}

export interface CodexImportBatch {
  /** False when the configured CODEX_HOME is missing or is not a directory. */
  available: boolean;
  threads: CodexImportedThread[];
  cursor: CodexImportCursor;
}

export interface CodexHistoryReadInput {
  /** CODEX_HOME. The resolver below derives it from the environment or home directory. */
  root?: string;
  cursor?: CodexImportCursor;
  /** Per-run byte budget; unread files keep their prior cursor. */
  maxBytes?: number;
}

interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAtMs?: number;
  resetsInSeconds?: number;
}

interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  planType?: string;
  limitId?: string;
}

interface CodexTokenUsageInfo {
  total: CodexTokenCounters;
  last?: CodexTokenCounters;
}

export type CodexRolloutLine =
  | {
      kind: "session-meta";
      threadKey: string;
      /** sha256 of `creator_account_id` when recorded. */
      accountHint?: string;
    }
  | { kind: "turn-context"; model?: string; effort?: string }
  | {
      kind: "token-count";
      atMs?: number;
      ordinal?: number;
      info?: CodexTokenUsageInfo;
      rateLimits?: CodexRateLimitSnapshot;
    };

function parseTokenCounters(value: unknown): CodexTokenCounters | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const input = asNonNegativeNumber(usage.input_tokens);
  const cached = asNonNegativeNumber(usage.cached_input_tokens);
  const cacheWrite = asNonNegativeNumber(usage.cache_write_input_tokens);
  const output = asNonNegativeNumber(usage.output_tokens);
  const reasoning = asNonNegativeNumber(usage.reasoning_output_tokens);
  const total = asNonNegativeNumber(usage.total_tokens);
  if (
    input === undefined &&
    cached === undefined &&
    cacheWrite === undefined &&
    output === undefined &&
    reasoning === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  const resolvedInput = input ?? 0;
  const resolvedOutput = output ?? 0;
  return {
    input: resolvedInput,
    cached: cached ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: resolvedOutput,
    reasoning: reasoning ?? 0,
    total: total ?? resolvedInput + resolvedOutput,
  };
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | undefined {
  const window = asRecord(value);
  if (window === undefined) return undefined;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetsAt = asNonNegativeNumber(window.resets_at);
  return {
    usedPercent,
    ...(asNonNegativeNumber(window.window_minutes) === undefined
      ? {}
      : { windowMinutes: asNonNegativeNumber(window.window_minutes) }),
    ...(resetsAt === undefined ? {} : { resetsAtMs: resetsAt * 1000 }),
    ...(asNonNegativeNumber(window.resets_in_seconds) === undefined
      ? {}
      : { resetsInSeconds: asNonNegativeNumber(window.resets_in_seconds) }),
  };
}

function parseRateLimits(value: unknown): CodexRateLimitSnapshot | undefined {
  const limits = asRecord(value);
  if (limits === undefined) return undefined;
  const primary = parseRateLimitWindow(limits.primary);
  const secondary = parseRateLimitWindow(limits.secondary);
  if (primary === undefined && secondary === undefined) return undefined;
  const limitId = asString(limits.limit_id);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(asString(limits.plan_type) === undefined ? {} : { planType: asString(limits.plan_type) }),
    // Opaque and provider-controlled: the raw value never leaves the parser and
    // row keys/labels use only this bounded hash.
    ...(limitId === undefined
      ? {}
      : { limitId: hashUsageImport("codex-limit", limitId).slice(0, 16) }),
  };
}

/** Parses one rollout line into already-hashed, privacy-safe metadata. */
export function parseCodexRolloutLine(line: string): CodexRolloutLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  const payload = asRecord(record?.payload);
  if (record === undefined || payload === undefined) return undefined;

  if (record.type === "session_meta") {
    const threadId = asString(payload.id) ?? asString(payload.session_id);
    if (threadId === undefined) return undefined;
    const accountId = asString(payload.creator_account_id);
    return {
      kind: "session-meta",
      threadKey: hashUsageImport("codex-thread", threadId),
      ...(accountId === undefined
        ? {}
        : { accountHint: hashUsageImport("codex-account", accountId) }),
    };
  }

  if (record.type === "turn_context") {
    const model = sanitizeUsageImportModelId(payload.model);
    const effort = sanitizeUsageImportEffort(payload.effort);
    return {
      kind: "turn-context",
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
  }

  if (record.type !== "event_msg" || payload.type !== "token_count") return undefined;
  const infoRecord = asRecord(payload.info);
  const total =
    infoRecord === undefined ? undefined : parseTokenCounters(infoRecord.total_token_usage);
  const info =
    total === undefined
      ? undefined
      : {
          total,
          ...(parseTokenCounters(infoRecord?.last_token_usage) === undefined
            ? {}
            : { last: parseTokenCounters(infoRecord?.last_token_usage) }),
        };
  return {
    kind: "token-count",
    ...(asTimestampMs(record.timestamp) === undefined
      ? {}
      : { atMs: asTimestampMs(record.timestamp) }),
    ...(asNonNegativeNumber(record.ordinal) === undefined
      ? {}
      : { ordinal: asNonNegativeNumber(record.ordinal) }),
    ...(info === undefined ? {} : { info }),
    ...(parseRateLimits(payload.rate_limits) === undefined
      ? {}
      : { rateLimits: parseRateLimits(payload.rate_limits) }),
  };
}

function parseCodexHomeCandidate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !isAbsolute(value) ||
    /^(?:\\\\|\/\/)/.test(value)
  ) {
    return null;
  }
  return resolve(value);
}

/** CODEX_HOME, or `~/.codex`; a present-but-invalid override is unavailable. */
export function resolveCodexHome(
  deps: { env?: Readonly<Record<string, string | undefined>>; home?: string } = {},
): string | undefined {
  const env = deps.env ?? process.env;
  const configured = parseCodexHomeCandidate(env.CODEX_HOME);
  if (configured === null) return undefined;
  return configured ?? join(deps.home ?? homedir(), ".codex");
}

interface CodexParseState {
  threadKey?: string;
  accountHint?: string;
  totals?: CodexTokenCounters;
  model?: string;
  effort?: string;
}

interface CodexBatchSink {
  invocation(threadKey: string, invocation: CodexImportedInvocation, state: CodexParseState): void;
  observation(
    threadKey: string,
    observation: CodexRateLimitObservation,
    state: CodexParseState,
  ): void;
}

function codexCountersKey(counters: CodexTokenCounters): string {
  return [
    counters.input,
    counters.cached,
    counters.cacheWrite,
    counters.output,
    counters.reasoning,
    counters.total,
  ].join(":");
}

function subtractCodexCounters(
  current: CodexTokenCounters,
  previous: CodexTokenCounters,
): CodexTokenCounters {
  const subtract = (a: number, b: number): number => Math.max(0, a - b);
  return {
    input: subtract(current.input, previous.input),
    cached: subtract(current.cached, previous.cached),
    cacheWrite: subtract(current.cacheWrite, previous.cacheWrite),
    output: subtract(current.output, previous.output),
    reasoning: subtract(current.reasoning, previous.reasoning),
    total: subtract(current.total, previous.total),
  };
}

function tokenCountInvocation(
  parsed: Extract<CodexRolloutLine, { kind: "token-count" }>,
  state: CodexParseState,
): CodexImportedInvocation | undefined {
  if (parsed.info === undefined || parsed.atMs === undefined || state.threadKey === undefined) {
    return undefined;
  }
  const { total, last } = parsed.info;
  const previous = state.totals;
  let delta: CodexTokenCounters | undefined;
  if (previous === undefined) {
    delta = total;
  } else if (total.total === previous.total) {
    return undefined;
  } else if (total.total < previous.total) {
    delta = last;
  } else {
    delta = subtractCodexCounters(total, previous);
  }
  state.totals = { ...total };
  if (delta === undefined) return undefined;

  const tokens: UsageImportTokens = {
    // Codex reports cached input inside input_tokens; reasoning is inside output_tokens.
    input: Math.max(0, delta.input - delta.cached),
    cacheRead: delta.cached,
    cacheWrite: delta.cacheWrite,
    output: delta.output,
    reasoning: delta.reasoning,
  };
  if (
    tokens.input === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheWrite === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0
  ) {
    return undefined;
  }

  const identity =
    parsed.ordinal === undefined
      ? `timestamp:${parsed.atMs}:${codexCountersKey(total)}:${
          last === undefined ? "" : codexCountersKey(last)
        }`
      : `ordinal:${parsed.ordinal}`;
  const effort = sanitizeUsageImportEffort(state.effort);
  return {
    atMs: parsed.atMs,
    model: sanitizeUsageImportModelId(state.model) ?? "unknown",
    ...(effort === undefined ? {} : { effort }),
    tokens,
    dedupeKey: hashUsageImport("codex-invocation", state.threadKey, identity),
  };
}

function rateLimitObservations(
  rateLimits: CodexRateLimitSnapshot | undefined,
  atMs: number,
): CodexRateLimitObservation[] {
  if (rateLimits === undefined) return [];
  const observations: CodexRateLimitObservation[] = [];
  for (const window of ["primary", "secondary"] as const) {
    const value = rateLimits[window];
    if (value === undefined) continue;
    // `resets_at` is a provider-supplied absolute timestamp; `resets_in_seconds`
    // is only an offset from local observation time, so its point is estimated.
    const absolute =
      value.resetsAtMs !== undefined && Number.isFinite(value.resetsAtMs)
        ? value.resetsAtMs
        : undefined;
    const resetsAtMs =
      absolute ??
      (value.resetsInSeconds === undefined ? undefined : atMs + value.resetsInSeconds * 1000);
    const resetPrecision: UsageResetPrecision | undefined =
      absolute !== undefined ? "exact" : resetsAtMs === undefined ? undefined : "estimated";
    observations.push({
      atMs,
      window,
      ...(value.windowMinutes === undefined ? {} : { windowMinutes: value.windowMinutes }),
      usedPercent: value.usedPercent,
      ...(resetsAtMs === undefined || !Number.isFinite(resetsAtMs) ? {} : { resetsAtMs }),
      ...(resetPrecision === undefined ? {} : { resetPrecision }),
      ...(rateLimits.planType === undefined ? {} : { planType: rateLimits.planType }),
      ...(rateLimits.limitId === undefined ? {} : { limitId: rateLimits.limitId }),
    });
  }
  return observations;
}

function applyCodexLine(line: string, state: CodexParseState, sink: CodexBatchSink): void {
  const parsed = parseCodexRolloutLine(line);
  if (parsed === undefined) return;
  if (parsed.kind === "session-meta") {
    state.threadKey = parsed.threadKey;
    if (parsed.accountHint !== undefined) state.accountHint = parsed.accountHint;
    return;
  }
  if (parsed.kind === "turn-context") {
    if (parsed.model !== undefined) state.model = parsed.model;
    if (parsed.effort !== undefined) state.effort = parsed.effort;
    return;
  }
  if (parsed.atMs === undefined || state.threadKey === undefined) return;
  for (const observation of rateLimitObservations(parsed.rateLimits, parsed.atMs)) {
    sink.observation(state.threadKey, observation, state);
  }
  const invocation = tokenCountInvocation(parsed, state);
  if (invocation !== undefined) sink.invocation(state.threadKey, invocation, state);
}

interface CodexThreadAccumulator {
  record: CodexImportedThread;
  invocations: Map<string, CodexImportedInvocation>;
  observations: Map<string, CodexRateLimitObservation>;
}

function createCodexAccumulator(): CodexBatchSink & { result: () => CodexImportedThread[] } {
  const threads = new Map<string, CodexThreadAccumulator>();
  const threadFor = (threadKey: string, state: CodexParseState): CodexThreadAccumulator => {
    let entry = threads.get(threadKey);
    if (entry === undefined) {
      entry = {
        record: { threadKey, invocations: [], rateLimitObservations: [] },
        invocations: new Map(),
        observations: new Map(),
      };
      threads.set(threadKey, entry);
    }
    entry.record.accountHint ??= state.accountHint;
    return entry;
  };

  return {
    invocation(threadKey, invocation, state) {
      threadFor(threadKey, state).invocations.set(invocation.dedupeKey, invocation);
    },
    observation(threadKey, observation, state) {
      const key = [
        observation.atMs,
        observation.window,
        observation.limitId ?? "",
        observation.planType ?? "",
        observation.windowMinutes ?? "",
        observation.usedPercent,
        observation.resetsAtMs ?? "",
        observation.resetPrecision ?? "",
      ].join("\0");
      threadFor(threadKey, state).observations.set(key, observation);
    },
    result() {
      const result: CodexImportedThread[] = [];
      for (const entry of threads.values()) {
        if (entry.invocations.size === 0 && entry.observations.size === 0) continue;
        entry.record.invocations = [...entry.invocations.values()].sort(
          (left, right) => left.atMs - right.atMs || left.dedupeKey.localeCompare(right.dedupeKey),
        );
        entry.record.rateLimitObservations = [...entry.observations.values()].sort(
          (left, right) =>
            left.atMs - right.atMs ||
            left.window.localeCompare(right.window) ||
            (left.limitId ?? "").localeCompare(right.limitId ?? ""),
        );
        result.push(entry.record);
      }
      return result.sort((left, right) => left.threadKey.localeCompare(right.threadKey));
    },
  };
}

function parseStateFromCursor(cursor: CodexFileCursor | undefined): CodexParseState {
  if (cursor === undefined) return {};
  const model = sanitizeUsageImportModelId(cursor.model);
  const effort = sanitizeUsageImportEffort(cursor.effort);
  return {
    threadKey: cursor.threadKey,
    accountHint: cursor.accountHint,
    totals: cursor.totals === undefined ? undefined : { ...cursor.totals },
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

const isRolloutFile = (name: string): boolean =>
  name.startsWith("rollout-") && name.endsWith(".jsonl");

/**
 * Reads only bytes appended since the previous cursor. A truncated or rewritten
 * file (size shrink, or same size with a new mtime) is read again from the start;
 * stable dedupe keys make the repeated records idempotent.
 */
export async function readCodexHistory(
  input: CodexHistoryReadInput = {},
): Promise<CodexImportBatch> {
  const previous = input.cursor?.version === 1 ? input.cursor : { version: 1 as const, files: {} };
  if (input.root === undefined) {
    return { available: false, threads: [], cursor: previous };
  }
  const rootStats = await stat(input.root).catch(() => undefined);
  if (rootStats === undefined || !rootStats.isDirectory()) {
    return { available: false, threads: [], cursor: previous };
  }

  const [sessions, archived] = await Promise.all([
    listJsonlFiles(join(input.root, "sessions"), isRolloutFile),
    listJsonlFiles(join(input.root, "archived_sessions"), isRolloutFile),
  ]);
  const paths = [...(sessions ?? []), ...(archived ?? [])].sort();
  const accumulator = createCodexAccumulator();
  const nextFiles = await readJsonlFilesWithBudget<CodexFileCursor>({
    paths,
    previous: previous.files,
    ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    read: (path, prior, budget) =>
      readIncrementalJsonlFile<CodexFileCursor, CodexParseState>({
        path,
        prior,
        state: (statePrior) => parseStateFromCursor(statePrior),
        onLine: (line, state) => applyCodexLine(line, state, accumulator),
        toCursor: (state, stats, byteOffset) => ({
          ...state,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          byteOffset,
        }),
        ...(budget !== undefined ? { budget } : {}),
      }),
  });

  return {
    available: true,
    threads: accumulator.result(),
    cursor: { version: 1, files: nextFiles },
  };
}
