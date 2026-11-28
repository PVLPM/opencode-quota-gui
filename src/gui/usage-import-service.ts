/**
 * Opt-in Claude Code / Codex history import (v1.4.0 D10).
 *
 * Import runs only after a live quota cycle the host already performs:
 * `maybeRun` is debounced by that poll cadence, single-flight, and hands the
 * readers a per-run byte budget. It never performs a provider request and never
 * blocks the quota read. Transcript contents are parsed only far enough to
 * discard them; only counters, model/effort names and domain-separated hashes
 * reach the store.
 *
 * Cross-harness ownership: OpenCode's Claude Agent integration writes Claude
 * Code transcripts, so host `data.native.sessionID/messageID` values are
 * recorded as hashes (`recordClaudeOwnership`) and imported Claude Code
 * invocations carrying those keys are excluded at query time. Codex rollouts
 * are not written by any OpenCode integration, so Codex needs no exclusion.
 *
 * Opt-out stop semantics: the enabled flag is re-read before each harness scan
 * and before every ownership write, so a disable takes effect on the next
 * harness. A file chunk already being read may finish and persist its records;
 * no new harness scan starts after the flag is off.
 *
 * Deletion semantics: turning a switch off keeps what was already imported.
 * `deleteImportedHistory` is the separate, explicit removal; it drops the cursor
 * so a later run re-reads from offset 0 (idempotent through the dedupe keys).
 *
 * Cross-process deletion: several hosts share one `usage-history.sqlite`, so
 * this module's single-flight only serialises this process. A scan reads its
 * harness's import generation when it starts and passes it to every write it
 * commits; a deletion in another host increments that counter in its own
 * transaction, so a scan that awaited transcript I/O across it writes nothing
 * and abandons the harness for that opportunity instead of restoring the
 * deleted rows and cursor.
 */
import type { DeleteImportedHistoryResult } from "../contracts/dashboard.js";
import { USAGE_IMPORT_HARNESSES, type UsageImportHarness } from "../contracts/usage.js";
import type { UsageActivityQuery, UsageActivityResult } from "../contracts/usage-activity.js";
import {
  type ClaudeCodeImportCursor,
  claudeCodeMessageUuidKey,
  claudeCodeSessionKey,
  readClaudeCodeHistory,
  resolveClaudeCodeConfigDir,
} from "../lib/claude-code-history.js";
import {
  type CodexImportCursor,
  readCodexHistory,
  resolveCodexHome,
} from "../lib/codex-history.js";
import { USAGE_IMPORT_READ_BUDGET_BYTES, type UsageImportTokens } from "../lib/usage-import.js";
import type {
  UsageImportedCodexRateLimit,
  UsageImportState,
  UsageImportStatusKind,
  UsageStore,
} from "../lib/usage-store.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

/** Narrow settings view; avoids loading GUI settings types into the reader. */
export interface UsageImportSettings {
  claudeCode: boolean;
  codex: boolean;
}

/** Empty imported-activity result aligned with the requested intervals. */
export function emptyImportedActivity(query: UsageActivityQuery): UsageActivityResult {
  return {
    intervals: query.intervals.map((interval) => ({
      startMs: interval.startMs,
      endMs: interval.endMs,
      entries: [],
      incomplete: false,
      unpricedTokens: 0,
      unknownTokens: 0,
    })),
  };
}

export interface UsageImportStatus {
  harness: UsageImportHarness;
  enabled: boolean;
  lastImportedAtMs?: number;
  status: "disabled" | UsageImportStatusKind;
}

export interface UsageImporterOptions {
  /** Lazily opens the one plugin-owned store. */
  store: () => Promise<UsageStore>;
  loadSettings: () => Promise<UsageImportSettings>;
  /** Test seam: config root per harness; production resolves env/home. */
  rootFor?: (harness: UsageImportHarness) => string | undefined;
  now?: () => number;
  logger?: GuiLogger;
  maxBytesPerRun?: number;
}

export interface UsageImporter {
  /** One bounded attempt on the caller's existing poll opportunity. */
  maybeRun(intervalMs: number): Promise<void>;
  status(): Promise<UsageImportStatus[]>;
  queryActivity(
    query: UsageActivityQuery,
    harnesses: readonly UsageImportHarness[],
  ): Promise<UsageActivityResult>;
  /** Hash and persist one host-native Claude Agent identity, when import is on. */
  recordClaudeOwnership(sessionId: string, messageId: string): void;
  /**
   * Delete one harness's imported history. The deletion shares the import
   * single-flight: a run already scanning completes first (and its rows are
   * then removed), and no run starts until the deletion has committed, so an
   * in-flight import can never re-insert rows behind it. The cursor row goes
   * with the data, so the harness re-reads from offset 0 when it runs again.
   * A scan in another host is superseded by the store's generation fence
   * rather than by this gate.
   */
  deleteImportedHistory(harness: UsageImportHarness): Promise<DeleteImportedHistoryResult>;
  /** Resolves after queued ownership writes and imports settle. */
  flush(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const MAX_REMEMBERED_OWNERSHIP_KEYS = 4_096;

function isImportSettings(value: unknown): value is UsageImportSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.claudeCode === "boolean" && typeof record.codex === "boolean";
}

function parseCursor<T>(value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function harnessEnabled(settings: UsageImportSettings, harness: UsageImportHarness): boolean {
  return harness === "claude-code" ? settings.claudeCode : settings.codex;
}

export function createUsageImporter(options: UsageImporterOptions): UsageImporter {
  const logger = options.logger ?? createGuiLogger();
  const now = options.now ?? Date.now;
  const rootFor =
    options.rootFor ??
    ((harness: UsageImportHarness) =>
      harness === "claude-code" ? resolveClaudeCodeConfigDir() : resolveCodexHome());
  const maxBytesPerRun = options.maxBytesPerRun ?? USAGE_IMPORT_READ_BUDGET_BYTES;
  let running = false;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();
  /** The run currently scanning, so a deletion can wait for its rows to land. */
  let currentRun: Promise<void> | undefined;
  /**
   * Counted, not boolean: two overlapping deletions both keep new runs out, and
   * the last one to finish releases the gate. Every entry point reads and
   * writes it synchronously, before its first `await`, which is what makes the
   * gate immune to an interleaving run.
   */
  let deleting = 0;
  const warned = new Set<UsageImportHarness>();
  const ownershipKeys = new Set<string>();

  function warnOnce(harness: UsageImportHarness, event: string, reason: string): void {
    if (warned.has(harness)) return;
    warned.add(harness);
    logger.warn(event, reason);
  }

  async function loadSettings(): Promise<UsageImportSettings> {
    const value: unknown = await options.loadSettings();
    if (!isImportSettings(value)) throw new Error("usage-import-settings-invalid");
    return value;
  }

  /**
   * Persist one harness's import state. False means a deletion committed after
   * this opportunity read the generation, so the scan is abandoned: writing the
   * state back would restore a cursor for history that no longer exists.
   */
  function persist(
    store: UsageStore,
    harness: UsageImportHarness,
    state: UsageImportState,
    generation: number,
  ): boolean {
    try {
      return store.setImportState(harness, state, generation) === "recorded";
    } catch {
      warnOnce(harness, "usage import state failed", "state-failed");
      // A write error is not a supersession; the scan policy is unchanged.
      return true;
    }
  }

  function persistUnavailable(
    store: UsageStore,
    harness: UsageImportHarness,
    state: UsageImportState,
    nextCursor: string,
    generation: number,
  ): void {
    persist(
      store,
      harness,
      {
        enabled: true,
        status: "unavailable",
        cursor: state.cursor ?? nextCursor,
        ...(state.lastImportedAtMs !== undefined
          ? { lastImportedAtMs: state.lastImportedAtMs }
          : {}),
      },
      generation,
    );
  }

  function readerOptions<TCursor extends object>(
    root: string | undefined,
    cursor: TCursor | undefined,
  ): { root?: string; cursor?: TCursor; maxBytes: number } {
    return {
      ...(root !== undefined ? { root } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      maxBytes: maxBytesPerRun,
    };
  }

  async function importClaudeCode(
    store: UsageStore,
    state: UsageImportState,
    cursor: ClaudeCodeImportCursor | undefined,
    generation: number,
  ): Promise<void> {
    const root = rootFor("claude-code");
    const batch = await readClaudeCodeHistory(readerOptions(root, cursor));
    const nextCursor = JSON.stringify(batch.cursor);
    if (!batch.available) {
      persistUnavailable(store, "claude-code", state, nextCursor, generation);
      return;
    }
    // Rows and cursor land in one fenced transaction: a deletion committed
    // while this scan awaited transcript I/O supersedes both.
    const outcome = store.commitImportChunk({
      harness: "claude-code",
      invocations: batch.invocations,
      state: {
        enabled: true,
        status: "ok",
        cursor: nextCursor,
        lastImportedAtMs: now(),
      },
      expectedGeneration: generation,
    });
    if (outcome === "superseded") return;
    warned.delete("claude-code");
  }

  async function importCodex(
    store: UsageStore,
    state: UsageImportState,
    cursor: CodexImportCursor | undefined,
    generation: number,
  ): Promise<void> {
    const root = rootFor("codex");
    const batch = await readCodexHistory(readerOptions(root, cursor));
    const nextCursor = JSON.stringify(batch.cursor);
    if (!batch.available) {
      persistUnavailable(store, "codex", state, nextCursor, generation);
      return;
    }
    const invocations: {
      atMs: number;
      model: string;
      effort?: string;
      tokens: UsageImportTokens;
      dedupeKey: string;
      threadKey: string;
      accountHint?: string;
    }[] = [];
    const observations: UsageImportedCodexRateLimit[] = [];
    for (const thread of batch.threads) {
      for (const invocation of thread.invocations) {
        invocations.push({
          ...invocation,
          threadKey: thread.threadKey,
          ...(thread.accountHint !== undefined ? { accountHint: thread.accountHint } : {}),
        });
      }
      for (const observation of thread.rateLimitObservations) {
        observations.push({
          ...observation,
          // The imported session is the only provable scope when a rollout
          // carries no account identity; it keeps those readings from merging.
          threadKey: thread.threadKey,
          ...(thread.accountHint !== undefined ? { accountHint: thread.accountHint } : {}),
        });
      }
    }
    // One transaction for the invocations, the imported rate-limit series and
    // the cursor, fenced on the generation this scan started from.
    const outcome = store.commitImportChunk({
      harness: "codex",
      invocations,
      codexRateLimits: observations,
      state: {
        enabled: true,
        status: "ok",
        cursor: nextCursor,
        lastImportedAtMs: now(),
      },
      expectedGeneration: generation,
    });
    if (outcome === "superseded") return;
    warned.delete("codex");
  }

  async function runHarness(
    harness: UsageImportHarness,
    store: UsageStore,
    generation: number,
  ): Promise<void> {
    const previous = store.getImportState(harness);
    const resume = previous?.enabled === true;
    // A transition to on restarts from offset 0; subsequent runs resume the
    // persisted cursor. Re-reading is idempotent through the dedupe keys.
    const state: UsageImportState = resume
      ? (previous ?? { enabled: true })
      : {
          enabled: true,
          ...(previous?.lastImportedAtMs !== undefined
            ? { lastImportedAtMs: previous.lastImportedAtMs }
            : {}),
          ...(previous?.status !== undefined ? { status: previous.status } : {}),
        };
    if (!resume && !persist(store, harness, state, generation)) return;
    if (harness === "claude-code") {
      await importClaudeCode(
        store,
        state,
        resume ? parseCursor<ClaudeCodeImportCursor>(previous?.cursor) : undefined,
        generation,
      );
    } else {
      await importCodex(
        store,
        state,
        resume ? parseCursor<CodexImportCursor>(previous?.cursor) : undefined,
        generation,
      );
    }
  }

  async function runOnce(): Promise<void> {
    const store = await options.store();
    for (const harness of USAGE_IMPORT_HARNESSES) {
      // Never use a settings snapshot from an earlier harness: a disable that
      // lands while another harness scans must stop this one from starting.
      let enabled: boolean;
      try {
        enabled = harnessEnabled(await loadSettings(), harness);
      } catch {
        continue;
      }
      // The fence baseline for this opportunity, read before any write it
      // commits: a deletion that lands from here on supersedes the whole scan.
      const generation = store.getImportGeneration(harness);
      const previous = store.getImportState(harness);
      if (!enabled) {
        if (previous?.enabled !== false) {
          persist(
            store,
            harness,
            {
              enabled: false,
              ...(previous?.cursor !== undefined ? { cursor: previous.cursor } : {}),
              ...(previous?.lastImportedAtMs !== undefined
                ? { lastImportedAtMs: previous.lastImportedAtMs }
                : {}),
              ...(previous?.status !== undefined ? { status: previous.status } : {}),
            },
            generation,
          );
        }
        continue;
      }
      try {
        await runHarness(harness, store, generation);
      } catch {
        warnOnce(harness, "usage import failed", "import-failed");
        try {
          const current = store.getImportState(harness);
          store.setImportState(
            harness,
            {
              ...(current ?? {}),
              enabled: true,
              status: "error",
            },
            generation,
          );
        } catch {
          // the failed import already logged one controlled line
        }
      }
    }
  }

  async function status(): Promise<UsageImportStatus[]> {
    let settings: UsageImportSettings;
    try {
      settings = await loadSettings();
    } catch {
      return USAGE_IMPORT_HARNESSES.map((harness) => ({
        harness,
        enabled: false,
        status: "error" as const,
      }));
    }
    if (!settings.claudeCode && !settings.codex) {
      return USAGE_IMPORT_HARNESSES.map((harness) => ({
        harness,
        enabled: false,
        status: "disabled" as const,
      }));
    }
    let store: UsageStore;
    try {
      store = await options.store();
    } catch {
      return USAGE_IMPORT_HARNESSES.map((harness) => ({
        harness,
        enabled: harnessEnabled(settings, harness),
        status: harnessEnabled(settings, harness) ? ("error" as const) : ("disabled" as const),
      }));
    }
    return USAGE_IMPORT_HARNESSES.map((harness) => {
      const enabled = harnessEnabled(settings, harness);
      const state = store.getImportState(harness);
      if (!enabled) return { harness, enabled: false, status: "disabled" as const };
      return {
        harness,
        enabled: true,
        ...(state?.lastImportedAtMs !== undefined
          ? { lastImportedAtMs: state.lastImportedAtMs }
          : {}),
        status: state?.status ?? ("unavailable" as const),
      };
    });
  }

  return {
    async maybeRun(intervalMs) {
      // `running` and `deleting` are read before either is set, so a deletion
      // that starts now keeps this opportunity out and vice versa.
      if (running || deleting > 0) return;
      const at = now();
      const debounce =
        Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_DEBOUNCE_MS;
      if (at - lastAttemptMs < debounce) return;
      lastAttemptMs = at;
      running = true;
      const run = (async () => {
        try {
          await runOnce();
        } catch {
          logger.warn("usage import failed", "import-failed");
        } finally {
          running = false;
          currentRun = undefined;
        }
      })();
      currentRun = run;
      await run;
    },

    async deleteImportedHistory(harness) {
      // Entered synchronously, before any await: nothing that checks this gate
      // can start a run between here and the commit.
      deleting += 1;
      try {
        // A run that already started wrote its rows first; they are part of
        // what this deletion removes. A run cannot start while `deleting > 0`.
        await currentRun;
        const store = await options.store();
        return store.deleteImportedHistory(harness);
      } finally {
        deleting -= 1;
      }
    },

    status,

    queryActivity(query, harnesses) {
      return chain.then(async () => {
        let settings: UsageImportSettings;
        try {
          settings = await loadSettings();
        } catch {
          // Fail closed: a stale cache could show activity after an opt-out.
          return emptyImportedActivity(query);
        }
        const active = harnesses.filter((harness) => harnessEnabled(settings, harness));
        if (active.length === 0) {
          return emptyImportedActivity(query);
        }
        const store = await options.store();
        return store.queryImportedActivity(query, active);
      });
    },

    recordClaudeOwnership(sessionId, messageId) {
      chain = chain
        .then(async () => {
          const keys = [claudeCodeSessionKey(sessionId), claudeCodeMessageUuidKey(messageId)];
          if (keys.every((key) => ownershipKeys.has(key))) return;
          const store = await options.store();
          // Re-read after the only await so a disable is never served from a
          // cache and lands before this write.
          let settings: UsageImportSettings;
          try {
            settings = await loadSettings();
          } catch {
            return;
          }
          if (!settings.claudeCode) return;
          store.addImportExclusionKeys(keys);
          if (ownershipKeys.size >= MAX_REMEMBERED_OWNERSHIP_KEYS) ownershipKeys.clear();
          for (const key of keys) ownershipKeys.add(key);
        })
        .catch(() => {
          logger.warn("usage import ownership failed", "ownership-failed");
        });
    },

    flush() {
      return chain;
    },
  };
}
