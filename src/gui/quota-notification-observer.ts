/**
 * Host-runtime quota notification observation.
 *
 * The runtime calls `observe` once for every fresh, non-stale quota snapshot the
 * existing shared poller produces. The pure detector owns transition policy;
 * this module owns effective settings, the in-memory baseline, cooldown
 * persistence, safe event wording and the live notification bus.
 *
 * Baseline semantics are deliberately simple: detector rows/providers are never
 * persisted, so the first snapshot after startup or a source handoff silently
 * re-baselines. Only fingerprint cooldowns survive, through the existing
 * private atomic JSON write, which prevents a notification storm across quick
 * app restarts. There is no lock, claim, outbox or acknowledgement protocol:
 * cooldown writes are best effort per owner and may race across processes.
 *
 * Events are live-only. If no window is listening when an event is emitted it
 * is lost; the next transition is the next opportunity to alert.
 */
import { readFile } from "node:fs/promises";

import type { QuotaSnapshot, SettingsSnapshot } from "../contracts/dashboard.js";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import {
  isValidDuplicateCooldownMinutes,
  isValidLowQuotaThresholdRemainingPercent,
  isValidNativeQuotaNotificationPolicy,
} from "../lib/config.js";
import { formatResetCountdown } from "../lib/format-utils.js";
import { getGuiPrivateStatePath } from "../lib/private-state-paths.js";
import {
  DEFAULT_CONFIG,
  type NativeQuotaNotificationPolicy,
  type PercentDisplayMode,
} from "../lib/types.js";
import type { DashboardRpcQuotaNotificationData } from "../rpc.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import {
  detectQuotaNotifications,
  QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION,
  type QuotaNotification,
  type QuotaNotificationDetectorState,
} from "./quota-notification-detector.js";

const PERSISTED_STATE_VERSION = 1 as const;
const DEFAULT_STATE_FILE = "quota-notifications.json";
const MAX_LABEL_LENGTH = 80;
const CONFIG_UNAVAILABLE = "config unavailable";

/** Effective settings for one observation. */
export interface QuotaNotificationSettings {
  readonly policy: NativeQuotaNotificationPolicy;
  readonly hiddenCards: readonly string[];
  readonly hiddenRows: readonly string[];
  readonly percentDisplayMode: PercentDisplayMode;
}

export interface QuotaNotificationObserverOptions {
  /** Effective settings loader (the canonical GUI settings store in production). */
  loadSettings: () => Promise<QuotaNotificationSettings>;
  /** Cooldown/fingerprint state path; defaults to the private state namespace. */
  statePath?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Test seam: replaces the private atomic cooldown write. */
  writeState?: (statePath: string, cooldowns: Record<string, number>) => Promise<void>;
  logger?: GuiLogger;
}

export interface QuotaNotificationObserver {
  /**
   * Queue one observation of a fresh quota snapshot. A caller with an
   * asynchronous source read must capture `epoch()` before that read and pass
   * it here; an observation whose captured epoch no longer matches is dropped.
   * Never rejects.
   */
  observe(snapshot: QuotaSnapshot, epoch?: number): void;
  /** Current source generation, captured before an asynchronous source read. */
  epoch(): number;
  /**
   * The host's active source changed. Observations queued under the previous
   * source identity are discarded and the next fresh snapshot baselines
   * silently; persisted cooldowns stay in force.
   */
  sourceChanged(): void;
  /** Resolves after every queued observation finished. */
  flush(): Promise<void>;
  /** Live event listener; returns an unsubscribe function. */
  subscribe(listener: (event: DashboardRpcQuotaNotificationData) => void): () => void;
  /** Stop accepting observations and wait for already-started work. */
  close(): Promise<void>;
}

interface PersistedState {
  version: typeof PERSISTED_STATE_VERSION;
  cooldowns: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function displayModeSetting(values: Record<string, unknown>): PercentDisplayMode {
  const value = values.percentDisplayMode;
  if (value === undefined || value === null) return DEFAULT_CONFIG.percentDisplayMode;
  if (value !== "used" && value !== "remaining") throw new Error(CONFIG_UNAVAILABLE);
  return value;
}

function hiddenIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(CONFIG_UNAVAILABLE);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(CONFIG_UNAVAILABLE);
    }
    result.push(entry);
  }
  return result;
}

function nativeQuotaNotificationPolicyFromValues(
  values: Record<string, unknown>,
): NativeQuotaNotificationPolicy {
  const rawPolicy = values.nativeQuotaNotifications;
  if (rawPolicy !== undefined && !isRecord(rawPolicy)) throw new Error(CONFIG_UNAVAILABLE);
  const fields = isRecord(rawPolicy) ? rawPolicy : {};
  const defaults = DEFAULT_CONFIG.nativeQuotaNotifications;
  const candidate: unknown = {
    ...defaults,
    ...fields,
    low: Object.hasOwn(fields, "low")
      ? isRecord(fields.low)
        ? { ...defaults.low, ...fields.low }
        : fields.low
      : { ...defaults.low },
    exhausted: Object.hasOwn(fields, "exhausted")
      ? isRecord(fields.exhausted)
        ? { ...defaults.exhausted, ...fields.exhausted }
        : fields.exhausted
      : { ...defaults.exhausted },
    reset: Object.hasOwn(fields, "reset")
      ? isRecord(fields.reset)
        ? { ...defaults.reset, ...fields.reset }
        : fields.reset
      : { ...defaults.reset, windows: [...defaults.reset.windows] },
    providerError: Object.hasOwn(fields, "providerError")
      ? isRecord(fields.providerError)
        ? { ...defaults.providerError, ...fields.providerError }
        : fields.providerError
      : { ...defaults.providerError },
  };
  if (!isValidNativeQuotaNotificationPolicy(candidate)) throw new Error(CONFIG_UNAVAILABLE);

  const policy: NativeQuotaNotificationPolicy = {
    ...candidate,
    low: { ...candidate.low },
    exhausted: { ...candidate.exhausted },
    reset: { ...candidate.reset, windows: [...candidate.reset.windows] },
    providerError: { ...candidate.providerError },
  };

  const hasCanonicalLowThreshold =
    isRecord(fields.low) && Object.hasOwn(fields.low, "thresholdRemainingPercent");
  const legacyLowThreshold = values.lowQuotaThresholdRemainingPercent;
  if (
    !hasCanonicalLowThreshold &&
    legacyLowThreshold !== undefined &&
    legacyLowThreshold !== null
  ) {
    if (!isValidLowQuotaThresholdRemainingPercent(legacyLowThreshold)) {
      throw new Error(CONFIG_UNAVAILABLE);
    }
    policy.low.thresholdRemainingPercent = legacyLowThreshold;
  }

  const hasCanonicalCooldown = Object.hasOwn(fields, "duplicateCooldownMinutes");
  const legacyCooldown = values.duplicateCooldownMinutes;
  if (!hasCanonicalCooldown && legacyCooldown !== undefined && legacyCooldown !== null) {
    if (!isValidDuplicateCooldownMinutes(legacyCooldown)) throw new Error(CONFIG_UNAVAILABLE);
    policy.duplicateCooldownMinutes = legacyCooldown;
  }

  return policy;
}

/**
 * Maps the canonical settings snapshot to the observer's effective values.
 * Missing keys use the product defaults; malformed values and malformed or
 * missing visibility fail closed so the caller can re-baseline instead of
 * alerting with guessed policy (including guessed hidden-card state).
 */
export function quotaNotificationSettingsFromSnapshot(
  snapshot: Pick<SettingsSnapshot, "values" | "visibility">,
): QuotaNotificationSettings {
  if (!isRecord(snapshot.values)) throw new Error(CONFIG_UNAVAILABLE);
  if (!isRecord(snapshot.visibility)) throw new Error(CONFIG_UNAVAILABLE);
  const policy = nativeQuotaNotificationPolicyFromValues(snapshot.values);
  return {
    policy,
    hiddenCards: hiddenIds(snapshot.visibility.hiddenCards),
    hiddenRows: hiddenIds(snapshot.visibility.hiddenRows),
    percentDisplayMode: displayModeSetting(snapshot.values),
  };
}

/**
 * Reads persisted cooldowns best effort. A missing, malformed, unreadable or
 * version-mismatched file means "no suppression state"; a notification is never
 * dropped merely because this read failed.
 */
async function readCooldowns(path: string): Promise<Record<string, number>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== PERSISTED_STATE_VERSION) return {};
  if (!isRecord(parsed.cooldowns)) return {};

  const cooldowns: Record<string, number> = {};
  for (const [fingerprint, value] of Object.entries(parsed.cooldowns)) {
    if (fingerprint.length > 0 && isFiniteNumber(value) && value >= 0) {
      cooldowns[fingerprint] = value;
    }
  }
  return cooldowns;
}

/** Newest timestamp wins; a suppression record is never discarded. */
function mergeCooldowns(
  local: Record<string, number>,
  persisted: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...local };
  for (const [fingerprint, observedAtMs] of Object.entries(persisted)) {
    const current = merged[fingerprint];
    if (current === undefined || observedAtMs > current) merged[fingerprint] = observedAtMs;
  }
  return merged;
}

function pruneCooldowns(
  cooldowns: Record<string, number>,
  nowMs: number,
  cooldownMs: number,
): Record<string, number> {
  if (!Number.isFinite(nowMs) || cooldownMs <= 0) return {};
  const pruned: Record<string, number> = {};
  for (const [fingerprint, timestamp] of Object.entries(cooldowns)) {
    const ageMs = nowMs - timestamp;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      pruned[fingerprint] = timestamp;
    }
  }
  return pruned;
}

function sameCooldowns(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([fingerprint, timestamp]) => right[fingerprint] === timestamp)
  );
}

function safeLabel(value: string | undefined, fallback: string): string {
  let withoutControls = "";
  for (const character of value ?? "") {
    const code = character.codePointAt(0) ?? 0;
    withoutControls += code < 0x20 || code === 0x7f ? " " : character;
  }
  const cleaned = withoutControls.replace(/\s+/gu, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

function displayPercent(percentRemaining: number, mode: PercentDisplayMode): string {
  const remaining = Math.min(100, Math.max(0, percentRemaining));
  const value = mode === "used" ? 100 - remaining : remaining;
  return `${Math.round(value)}% ${mode === "used" ? "used" : "remaining"}`;
}

function resetCountdownDescription(resetAtIso: string | undefined, nowMs: number): string {
  const countdown =
    resetAtIso === undefined ? "reset" : formatResetCountdown(resetAtIso, { spaced: true }, nowMs);
  return countdown === "reset" ? " Reset timing unavailable." : ` Resets in ${countdown}.`;
}

function notificationTitle(notification: QuotaNotification): string {
  const provider = safeLabel(notification.providerLabel, "Provider");
  switch (notification.kind) {
    case "low":
      return `${provider} quota low`;
    case "exhausted":
      return `${provider} quota exhausted`;
    case "reset":
      return `${provider} quota reset`;
    case "provider-error":
      return `${provider} quota error`;
  }
}

function notificationDescription(
  notification: QuotaNotification,
  mode: PercentDisplayMode,
  nowMs: number,
): string {
  const account = safeLabel(notification.accountLabel, "Account");
  switch (notification.kind) {
    case "low":
    case "exhausted": {
      return `${account}: ${safeLabel(notification.rowLabel, "Quota")}: ${displayPercent(
        notification.percentRemaining,
        mode,
      )}.${resetCountdownDescription(notification.resetAtIso, nowMs)}`;
    }
    case "reset":
      return `${account}: ${safeLabel(notification.rowLabel, "Quota")}: quota reset; ${displayPercent(
        notification.percentRemaining,
        mode,
      )}.${resetCountdownDescription(notification.resetAtIso, nowMs)}`;
    case "provider-error":
      // Only the safe category is known; labels and raw messages never reach
      // the event, so no provider error detail can leak.
      return `${account}: provider API error.`;
  }
}

/**
 * One event identity for every window. The fingerprint proves which transition
 * it is; the observation timestamp makes a later repetition of the same
 * fingerprint a distinct event for host notification dedupe.
 */
function quotaNotificationEvent(
  notification: QuotaNotification,
  mode: PercentDisplayMode,
): DashboardRpcQuotaNotificationData {
  return {
    id: `${notification.fingerprint}:${notification.observedAtMs}`,
    kind: notification.kind,
    title: notificationTitle(notification),
    description: notificationDescription(notification, mode, notification.observedAtMs),
  };
}

async function defaultWriteState(
  statePath: string,
  cooldowns: Record<string, number>,
): Promise<void> {
  await writeJsonAtomic(
    statePath,
    { version: PERSISTED_STATE_VERSION, cooldowns } satisfies PersistedState,
    { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 },
  );
}

export function createQuotaNotificationObserver(
  options: QuotaNotificationObserverOptions,
): QuotaNotificationObserver {
  const logger = options.logger ?? createGuiLogger();
  const now = options.now ?? Date.now;
  const statePath = options.statePath ?? getGuiPrivateStatePath(DEFAULT_STATE_FILE);
  const listeners = new Set<(event: DashboardRpcQuotaNotificationData) => void>();

  let detectorState: QuotaNotificationDetectorState | undefined;
  let cooldowns: Record<string, number> = {};
  let cooldownsLoaded = false;
  let needsBaseline = true;
  /** Source identity; bumped by a handoff or close. */
  let sourceEpoch = 0;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  function current(epoch: number): boolean {
    return !closed && epoch === sourceEpoch;
  }

  function publish(event: DashboardRpcQuotaNotificationData, epoch: number): void {
    if (!current(epoch)) return;
    // A listener may hand the host off or close the observer synchronously.
    // Re-check before every callback so the copied listener list cannot deliver
    // the old source's event to the remaining windows.
    for (const listener of Array.from(listeners)) {
      if (!current(epoch)) return;
      try {
        listener(event);
      } catch {
        // One window listener never breaks observation or persistence.
      }
    }
  }

  function failObservation(): void {
    // Fail closed: without the effective threshold/visibility, no transition is
    // safe. The next successful read re-baselines silently.
    needsBaseline = true;
    detectorState = undefined;
    logger.warn("quota notification settings unavailable", "config-unavailable");
  }

  async function persist(
    next: Record<string, number>,
    nowMs: number,
    cooldownMs: number,
  ): Promise<Record<string, number> | undefined> {
    // Best-effort read/merge/write. There is no lock; a concurrent process can
    // still lose this entry or overwrite it with its own atomic replace.
    const persisted = await readCooldowns(statePath);
    const merged = pruneCooldowns(mergeCooldowns(next, persisted), nowMs, cooldownMs);
    try {
      await (options.writeState ?? defaultWriteState)(statePath, merged);
      return merged;
    } catch {
      logger.warn("quota notification state write failed", "failed");
      return undefined;
    }
  }

  async function observeNow(snapshot: QuotaSnapshot, epoch: number): Promise<void> {
    if (closed || epoch !== sourceEpoch) return;
    if (snapshot.stale === true) return;

    let settings: QuotaNotificationSettings;
    try {
      settings = await options.loadSettings();
    } catch {
      if (epoch === sourceEpoch) failObservation();
      return;
    }
    if (closed || epoch !== sourceEpoch) return;

    const nowMs = now();
    const cooldownMs = settings.policy.duplicateCooldownMinutes * 60_000;
    if (!cooldownsLoaded) {
      cooldowns = mergeCooldowns(cooldowns, await readCooldowns(statePath));
      cooldownsLoaded = true;
      if (closed || epoch !== sourceEpoch) return;
    }

    const prunedCooldowns = pruneCooldowns(cooldowns, nowMs, cooldownMs);
    const cooldownsWerePruned = !sameCooldowns(cooldowns, prunedCooldowns);
    cooldowns = prunedCooldowns;
    if (cooldownsWerePruned) {
      const persisted = await persist(cooldowns, nowMs, cooldownMs);
      cooldowns = persisted ?? cooldowns;
      if (closed || epoch !== sourceEpoch) return;
    }

    const result = detectQuotaNotifications({
      cards: snapshot.providers.cards,
      hiddenCards: settings.hiddenCards,
      hiddenRows: settings.hiddenRows,
      ...(needsBaseline || detectorState === undefined ? {} : { state: detectorState }),
      cooldowns,
      nowMs,
      policy: settings.policy,
    });
    if (closed || epoch !== sourceEpoch) return;

    detectorState = {
      version: QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION,
      rows: result.state.rows,
      providers: result.state.providers,
    };
    needsBaseline = false;
    cooldowns = pruneCooldowns(result.cooldowns, nowMs, cooldownMs);

    if (result.notifications.length === 0) return;

    const persisted = await persist(cooldowns, nowMs, cooldownMs);
    cooldowns = persisted ?? cooldowns;
    // A handoff can land while the cooldown write is in flight. Fence before
    // publishing so the old source's event never reaches the new generation.
    if (closed || epoch !== sourceEpoch) return;

    for (const notification of result.notifications) {
      if (!current(epoch)) return;
      publish(quotaNotificationEvent(notification, settings.percentDisplayMode), epoch);
    }
  }

  return {
    observe(snapshot, capturedEpoch) {
      if (closed) return;
      const epoch = capturedEpoch ?? sourceEpoch;
      chain = chain
        .then(() => observeNow(snapshot, epoch))
        .catch(() => {
          logger.warn("quota notification observation failed", "failed");
        });
    },

    epoch() {
      return sourceEpoch;
    },

    sourceChanged() {
      sourceEpoch += 1;
      needsBaseline = true;
      detectorState = undefined;
    },

    flush() {
      return chain;
    },

    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      sourceEpoch += 1;
      listeners.clear();
      await chain;
    },
  };
}
