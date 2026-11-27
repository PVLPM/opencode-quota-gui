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
 */
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
import {
  USAGE_IMPORT_HARNESSES,
  type UsageImportedCodexRateLimit,
  type UsageImportHarness,
  type UsageImportState,
  type UsageImportStatusKind,
  type UsageStore,
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
  /** Resolves after queued ownership writes and imports settle. */
  flush(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const OWNERSHIP_SETTINGS_TTL_MS = 30_000;
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
  let lastSettings: UsageImportSettings | undefined;
  let lastSettingsAtMs = Number.NEGATIVE_INFINITY;
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
    lastSettings = value;
    lastSettingsAtMs = now();
    return value;
  }

  async function ownershipSettings(): Promise<UsageImportSettings | undefined> {
    if (lastSettings !== undefined && now() - lastSettingsAtMs <= OWNERSHIP_SETTINGS_TTL_MS) {
      return lastSettings;
    }
    try {
      return await loadSettings();
    } catch {
      return lastSettings;
    }
  }

  function persist(store: UsageStore, harness: UsageImportHarness, state: UsageImportState): void {
    try {
      store.setImportState(harness, state);
    } catch {
      warnOnce(harness, "usage import state failed", "state-failed");
    }
  }

  function persistUnavailable(
    store: UsageStore,
    harness: UsageImportHarness,
    state: UsageImportState,
    nextCursor: string,
  ): void {
    persist(store, harness, {
      enabled: true,
      status: "unavailable",
      cursor: state.cursor ?? nextCursor,
      ...(state.lastImportedAtMs !== undefined ? { lastImportedAtMs: state.lastImportedAtMs } : {}),
    });
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
  ): Promise<void> {
    const root = rootFor("claude-code");
    const batch = await readClaudeCodeHistory(readerOptions(root, cursor));
    const nextCursor = JSON.stringify(batch.cursor);
    if (!batch.available) {
      persistUnavailable(store, "claude-code", state, nextCursor);
      return;
    }
    store.recordImportedInvocations("claude-code", batch.invocations);
    persist(store, "claude-code", {
      enabled: true,
      status: "ok",
      cursor: nextCursor,
      lastImportedAtMs: now(),
    });
    warned.delete("claude-code");
  }

  async function importCodex(
    store: UsageStore,
    state: UsageImportState,
    cursor: CodexImportCursor | undefined,
  ): Promise<void> {
    const root = rootFor("codex");
    const batch = await readCodexHistory(readerOptions(root, cursor));
    const nextCursor = JSON.stringify(batch.cursor);
    if (!batch.available) {
      persistUnavailable(store, "codex", state, nextCursor);
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
          ...(thread.accountHint !== undefined ? { accountHint: thread.accountHint } : {}),
        });
      }
    }
    store.recordImportedInvocations("codex", invocations);
    store.recordCodexRateLimitObservations(observations);
    persist(store, "codex", {
      enabled: true,
      status: "ok",
      cursor: nextCursor,
      lastImportedAtMs: now(),
    });
    warned.delete("codex");
  }

  async function runHarness(harness: UsageImportHarness, store: UsageStore): Promise<void> {
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
    if (!resume) persist(store, harness, state);
    if (harness === "claude-code") {
      await importClaudeCode(
        store,
        state,
        resume ? parseCursor<ClaudeCodeImportCursor>(previous?.cursor) : undefined,
      );
    } else {
      await importCodex(
        store,
        state,
        resume ? parseCursor<CodexImportCursor>(previous?.cursor) : undefined,
      );
    }
  }

  async function runOnce(): Promise<void> {
    let settings: UsageImportSettings;
    try {
      settings = await loadSettings();
    } catch {
      return;
    }

    // The store is already opened by the same live cycle that scheduled this
    // run, so persisting a disable transition adds no file access.
    const store = await options.store();
    for (const harness of USAGE_IMPORT_HARNESSES) {
      const previous = store.getImportState(harness);
      if (!harnessEnabled(settings, harness)) {
        if (previous?.enabled !== false) {
          persist(store, harness, {
            enabled: false,
            ...(previous?.cursor !== undefined ? { cursor: previous.cursor } : {}),
            ...(previous?.lastImportedAtMs !== undefined
              ? { lastImportedAtMs: previous.lastImportedAtMs }
              : {}),
            ...(previous?.status !== undefined ? { status: previous.status } : {}),
          });
        }
        continue;
      }
      try {
        await runHarness(harness, store);
      } catch {
        warnOnce(harness, "usage import failed", "import-failed");
        try {
          const current = store.getImportState(harness);
          store.setImportState(harness, {
            ...(current ?? {}),
            enabled: true,
            status: "error",
          });
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
      if (running) return;
      const at = now();
      const debounce =
        Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_DEBOUNCE_MS;
      if (at - lastAttemptMs < debounce) return;
      lastAttemptMs = at;
      running = true;
      try {
        await runOnce();
      } catch {
        logger.warn("usage import failed", "import-failed");
      } finally {
        running = false;
      }
    },

    status,

    queryActivity(query, harnesses) {
      return chain.then(async () => {
        let settings: UsageImportSettings;
        try {
          settings = await loadSettings();
        } catch {
          settings = lastSettings ?? { claudeCode: false, codex: false };
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
          const settings = await ownershipSettings();
          if (settings?.claudeCode !== true) return;
          const keys = [claudeCodeSessionKey(sessionId), claudeCodeMessageUuidKey(messageId)];
          if (keys.every((key) => ownershipKeys.has(key))) return;
          const store = await options.store();
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
