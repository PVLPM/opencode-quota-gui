/**
 * `autoResumeOnQuotaRecovery` (off by default): after a session terminally fails on a genuine
 * provider quota limit, wait until the failed route's exhausted quota window is observed as reset
 * for the same verified identity, then send exactly one `continue` prompt if the session is still
 * failed, idle and on the same model.
 *
 * Recovery evidence follows the same reset-transition rule as the quota reset notifications: a
 * raised percentage on an unchanged or missing reset boundary is not proof. A temporarily
 * unavailable observation (probe failure, provider cooldown, RPC timeout, missing row or identity)
 * keeps the pending resume and polls again; only authoritative events and evidence cancel it.
 * The first observation that shows a used-up window with a future reset boundary becomes the
 * baseline, so an unavailable first probe never loses the continuation but also never authorizes
 * it without the later transition. A disabled setting cancels the pending resume and is not
 * polled again.
 *
 * Claude Agent's five-hour subscription limit is not classified as a quota limit by OpenCode
 * 2.4.1 (it arrives as an untyped provider error with only a message), so it cannot arm this
 * feature until upstream supplies a structured quota error. Native retry and provider cooldown
 * policies are never replaced by this module.
 *
 * In-process only. There is no durable queue: a plugin restart drops a pending resume (accepted;
 * the next terminal failure arms a new cycle). No tool action is replayed.
 */
import { type ResetObservation, updateObservation } from "./quota-reset-notifications.js";
import {
  isQuotaLimitError,
  type QuotaRetryEvent,
  type QuotaWindowBinding,
  type QuotaWindowCollection,
  sameQuotaWindowBinding,
} from "./quota-retry-wait.js";

/** Confirmed recovery must hold this long before the single continuation. */
export const QUOTA_AUTO_RESUME_GRACE_MS = 120_000;
/** The single continuation prompt; no native continue API exists. */
export const QUOTA_AUTO_RESUME_PROMPT = "continue";
/** Marker used to ignore the module's own prompt and to make the continuation visible. */
export const QUOTA_AUTO_RESUME_SOURCE = "opencode-quota-gui-autoresume";

/** `setTimeout` overflows above this; longer waits are re-armed in chunks. */
const MAX_TIMER_MS = 2_147_483_647;
/** Poll interval after an observation gap; a provider cooldown still paces the actual request. */
const QUOTA_AUTO_RESUME_RETRY_MS = 60_000;

export type QuotaAutoResumeSessionInfo = {
  model?: { id: string; providerID: string };
  parentID?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time?: { idle?: number };
};

/** The probe's evidence state; the setting's enablement stays distinct from absent evidence. */
export type QuotaAutoResumeProbe =
  | { readonly kind: "collection"; readonly collection: QuotaWindowCollection }
  | { readonly kind: "absent" }
  | { readonly kind: "disabled" };

export interface QuotaAutoResumeDeps {
  /**
   * Current windows for the failed route. `absent` means the setting is on but the observation is
   * temporarily unavailable (probe failure, cooldown, timeout, missing row or identity); `disabled`
   * means the setting is off, so a pending resume is cancelled instead of polled.
   */
  probe: (model: { id: string; providerID: string }) => Promise<QuotaAutoResumeProbe>;
  session: {
    get(input: { sessionID: string }): Promise<QuotaAutoResumeSessionInfo>;
    prompt(input: {
      sessionID: string;
      text: string;
      metadata?: Record<string, string | number | boolean>;
    }): Promise<unknown>;
  };
  now?: () => number;
  /** Receives uncontrolled failures only; never session ids or prompts. */
  log?: (message: string) => void;
}

export interface QuotaAutoResumeEvent {
  readonly type: string;
  readonly created?: number;
  readonly data?: unknown;
}

/** One exhausted window and its reset-transition evidence. */
type TrackedWindow = {
  /** Latest observation taken before its own reset boundary. */
  observation: ResetObservation;
  /** A reset transition was proven for the current window cycle. */
  recovered: boolean;
};

type PendingResume = {
  failureAt: number;
  /** The provider's requested cooldown deadline from the terminal failure, if any. */
  retryAfterAtMs?: number;
  /** The failed route, captured from the first successful session read. */
  modelID?: string;
  providerID?: string;
  binding?: QuotaWindowBinding;
  /**
   * The exhausted windows this resume tracks. Undefined while the first observation is still
   * unavailable: the resume is pending, but no continuation is authorized without a baseline.
   */
  windows?: Map<string, TrackedWindow>;
  /** When every exhausted window was last observed as recovered. */
  recoveredAtMs?: number;
  idleAtArm?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type FailureError = {
  type: string;
  status?: number;
  retryAfterMs?: number;
};

function failureError(value: unknown): FailureError | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = value as Record<string, unknown>;
  if (typeof error.type !== "string") return undefined;
  return {
    type: error.type,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

function sessionIDOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const sessionID = (data as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" && sessionID !== "" ? sessionID : undefined;
}

function sameModel(info: QuotaAutoResumeSessionInfo, pending: PendingResume): boolean {
  return (
    pending.modelID !== undefined &&
    pending.providerID !== undefined &&
    info.model?.id === pending.modelID &&
    info.model.providerID === pending.providerID
  );
}

/**
 * Creates the in-process auto-resume controller. Feed every host event through `handleEvent`,
 * user prompt submissions through `onPrompt`, and call `dispose` from the plugin cleanup.
 */
export function createQuotaAutoResumption(deps: QuotaAutoResumeDeps): {
  handleEvent: (event: QuotaAutoResumeEvent) => void;
  onPrompt: (event: {
    readonly sessionID?: string;
    readonly metadata?: Record<string, unknown> | null;
  }) => void;
  dispose: () => void;
} {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingResume>();
  /** Sessions where an auto-resume already ran for the current user-initiated execution. */
  const consumed = new Set<string>();
  let disposed = false;

  function clearTimer(resume: PendingResume): void {
    if (resume.timer !== undefined) {
      clearTimeout(resume.timer);
      resume.timer = undefined;
    }
  }

  function cancel(sessionID: string): void {
    const resume = pending.get(sessionID);
    if (!resume) return;
    clearTimer(resume);
    pending.delete(sessionID);
  }

  function cancelAll(): void {
    for (const sessionID of [...pending.keys()]) cancel(sessionID);
  }

  function schedule(sessionID: string, resume: PendingResume, atMs: number): void {
    clearTimer(resume);
    const delay = Math.min(Math.max(1, atMs - now()), MAX_TIMER_MS);
    resume.timer = setTimeout(() => {
      resume.timer = undefined;
      void evaluate(sessionID, resume);
    }, delay);
    resume.timer.unref?.();
  }

  function retryLater(sessionID: string, resume: PendingResume): void {
    schedule(sessionID, resume, now() + QUOTA_AUTO_RESUME_RETRY_MS);
  }

  async function readSession(sessionID: string): Promise<QuotaAutoResumeSessionInfo | undefined> {
    try {
      return await deps.session.get({ sessionID });
    } catch {
      return undefined;
    }
  }

  /**
   * A failed read is absence of evidence, not proof the session is gone; `session.deleted`
   * cancels authoritatively. A missing outcome, model or idle time is also retried.
   */
  type SessionState =
    | { kind: "ok"; info: QuotaAutoResumeSessionInfo }
    | { kind: "cancel" }
    | { kind: "unavailable" };

  function sessionState(
    info: QuotaAutoResumeSessionInfo | undefined,
    resume: PendingResume,
  ): SessionState {
    if (info === undefined) return { kind: "unavailable" };
    if (info.parentID !== undefined) return { kind: "cancel" };
    if (info.outcome !== undefined && info.outcome !== "failed") return { kind: "cancel" };
    if (info.outcome === undefined || info.model === undefined) return { kind: "unavailable" };
    // The first successful read defines the route; a later change invalidates the continuation.
    if (resume.modelID !== undefined && !sameModel(info, resume)) return { kind: "cancel" };
    if (resume.idleAtArm !== undefined) {
      const idle = info.time?.idle;
      if (idle === undefined) return { kind: "unavailable" };
      if (idle !== resume.idleAtArm) return { kind: "cancel" };
    }
    return { kind: "ok", info };
  }

  type ProbeState =
    | { kind: "collection"; collection: QuotaWindowCollection }
    | { kind: "cancelled" }
    | { kind: "disabled" }
    | { kind: "identity" }
    | { kind: "unavailable" };

  async function probeQuota(
    sessionID: string,
    resume: PendingResume,
    model: { id: string; providerID: string },
  ): Promise<ProbeState> {
    let result: QuotaAutoResumeProbe | undefined;
    try {
      result = await deps.probe(model);
    } catch {
      result = undefined;
    }
    // The controller may have been disposed or superseded while the probe ran.
    if (disposed || pending.get(sessionID) !== resume) return { kind: "cancelled" };
    // A disabled feature stops the pending resume; absent evidence keeps polling instead.
    if (result === undefined || result.kind === "absent") return { kind: "unavailable" };
    if (result.kind === "disabled") return { kind: "disabled" };
    const collection = result.collection;
    if (resume.binding !== undefined) {
      // A different verified identity means this continuation is no longer valid.
      if (collection.binding === undefined) return { kind: "unavailable" };
      if (!sameQuotaWindowBinding(resume.binding, collection.binding)) return { kind: "identity" };
    }
    // Keep the first verified identity for every later observation.
    resume.binding ??= collection.binding;
    return { kind: "collection", collection };
  }

  type WindowState =
    | { kind: "recovered" }
    | { kind: "waiting"; nextCheckAtMs?: number }
    | { kind: "unknown" };

  /**
   * Applies one observation to every tracked window. Recovery needs the shared reset-transition
   * proof (`updateObservation`), so a raised percentage alone cannot fire a continuation.
   */
  function observeWindows(
    collection: QuotaWindowCollection,
    resume: PendingResume,
    nowMs: number,
  ): WindowState {
    const windows = resume.windows;
    // The first observation was unavailable: an exhausted window with a future reset boundary is
    // the baseline, and recovery still needs the later transition. An already-available window
    // cannot prove one, so keep the pending resume and poll.
    if (windows === undefined || windows.size === 0) {
      return establishBaseline(collection, resume, nowMs);
    }
    const observed = new Map(
      collection.windows.flatMap((window) =>
        window.key !== undefined ? [[window.key, window] as const] : [],
      ),
    );
    let incomplete = false;
    let unknown = false;
    let nextCheckAtMs: number | undefined;
    for (const [key, tracked] of windows) {
      const window = observed.get(key);
      // A row that disappears is an absent observation, not proof that the window reset.
      if (!window) {
        incomplete = true;
        unknown = true;
        continue;
      }
      if (tracked.recovered && window.percentRemaining > 0) continue;
      if (tracked.recovered) tracked.recovered = false;
      if (window.resetMs === undefined) {
        incomplete = true;
        unknown = true;
        continue;
      }
      const current: ResetObservation = {
        resetAtMs: window.resetMs,
        percentRemaining: window.percentRemaining,
        observedAtMs: nowMs,
      };
      // Keep the latest pre-reset exhaustion as the baseline: a window that recovered once and is
      // used up again must be able to prove its next reset too. `updateObservation` keeps the
      // earlier observation until the boundary passes.
      if (current.percentRemaining <= 0 && current.resetAtMs > nowMs) {
        tracked.observation = current;
        incomplete = true;
        nextCheckAtMs =
          nextCheckAtMs === undefined
            ? current.resetAtMs
            : Math.max(nextCheckAtMs, current.resetAtMs);
        continue;
      }
      const update = updateObservation(tracked.observation, current, nowMs);
      // The proof needs a baseline observed before its own reset boundary.
      if (update.observation.observedAtMs <= update.observation.resetAtMs) {
        tracked.observation = update.observation;
      }
      if (update.notify) {
        tracked.recovered = true;
        continue;
      }
      incomplete = true;
      if (tracked.observation.resetAtMs > nowMs) {
        nextCheckAtMs =
          nextCheckAtMs === undefined
            ? tracked.observation.resetAtMs
            : Math.max(nextCheckAtMs, tracked.observation.resetAtMs);
      } else {
        // The boundary passed without a fresh one: poll again rather than give up.
        unknown = true;
      }
    }
    if (!incomplete) return { kind: "recovered" };
    if (unknown) return { kind: "unknown" };
    return {
      kind: "waiting",
      ...(nextCheckAtMs !== undefined ? { nextCheckAtMs } : {}),
    };
  }

  /**
   * Arms the window baseline from the first usable observation. A window that is already
   * available cannot prove a reset, so the resume stays pending with no baseline and polls.
   */
  function establishBaseline(
    collection: QuotaWindowCollection,
    resume: PendingResume,
    nowMs: number,
  ): WindowState {
    const binding = collection.binding;
    if (binding === undefined) return { kind: "unknown" };
    const exhausted = collection.windows.filter((window) => window.percentRemaining <= 0);
    if (exhausted.length === 0) return { kind: "unknown" };
    const windows = new Map<string, TrackedWindow>();
    let latestResetMs = nowMs;
    for (const window of exhausted) {
      if (window.key === undefined || window.resetMs === undefined || !(window.resetMs > nowMs)) {
        // A used-up window without a usable future boundary cannot prove its reset.
        return { kind: "unknown" };
      }
      windows.set(window.key, {
        observation: {
          resetAtMs: window.resetMs,
          percentRemaining: window.percentRemaining,
          observedAtMs: nowMs,
        },
        recovered: false,
      });
      latestResetMs = Math.max(latestResetMs, window.resetMs);
    }
    resume.windows = windows;
    // Honor a provider cooldown from the original failure, counted from that failure.
    return {
      kind: "waiting",
      nextCheckAtMs: Math.max(latestResetMs, resume.retryAfterAtMs ?? latestResetMs),
    };
  }

  async function fire(sessionID: string, resume: PendingResume): Promise<void> {
    // Re-check after the probe: a user prompt or a resume may have landed while it ran.
    const state = sessionState(await readSession(sessionID), resume);
    if (disposed || pending.get(sessionID) !== resume) return;
    if (state.kind === "cancel") {
      cancel(sessionID);
      return;
    }
    if (state.kind === "unavailable") {
      retryLater(sessionID, resume);
      return;
    }
    // Single-flight: removing the entry before the prompt makes a second fire impossible.
    pending.delete(sessionID);
    // A failure from the execution this prompt starts must not schedule another continue.
    consumed.add(sessionID);
    try {
      await deps.session.prompt({
        sessionID,
        text: QUOTA_AUTO_RESUME_PROMPT,
        metadata: {
          source: QUOTA_AUTO_RESUME_SOURCE,
          failureAt: resume.failureAt,
        },
      });
    } catch {
      deps.log?.("auto-resume prompt failed");
    }
  }

  async function evaluate(sessionID: string, resume: PendingResume): Promise<void> {
    if (disposed || pending.get(sessionID) !== resume) return;
    const state = sessionState(await readSession(sessionID), resume);
    if (disposed || pending.get(sessionID) !== resume) return;
    if (state.kind === "cancel") {
      cancel(sessionID);
      return;
    }
    if (state.kind === "unavailable") {
      retryLater(sessionID, resume);
      return;
    }
    const info = state.info;
    const model = info.model;
    if (model === undefined) {
      retryLater(sessionID, resume);
      return;
    }
    // Capture the failed route and inactivity once, at the first successful read.
    resume.modelID ??= model.id;
    resume.providerID ??= model.providerID;
    resume.idleAtArm ??= info.time?.idle;
    const route = { id: model.id, providerID: model.providerID };
    const probe = await probeQuota(sessionID, resume, route);
    if (probe.kind === "cancelled") return;
    if (probe.kind === "identity") {
      cancel(sessionID);
      return;
    }
    // Turning the setting off cancels the pending resume instead of polling a disabled feature.
    if (probe.kind === "disabled") {
      cancel(sessionID);
      return;
    }
    if (probe.kind === "unavailable") {
      // Absent evidence keeps the pending resume: it may arm once a baseline is observable.
      retryLater(sessionID, resume);
      return;
    }
    const windows = observeWindows(probe.collection, resume, now());
    if (windows.kind !== "recovered") {
      if (windows.kind === "waiting") {
        // The window is confirmed used up again; the next reset starts a new grace period.
        resume.recoveredAtMs = undefined;
        schedule(sessionID, resume, windows.nextCheckAtMs ?? now() + QUOTA_AUTO_RESUME_RETRY_MS);
        return;
      }
      // An incomplete observation keeps an already-confirmed recovery; it just cannot fire.
      retryLater(sessionID, resume);
      return;
    }
    resume.recoveredAtMs ??= now();
    const fireAtMs = resume.recoveredAtMs + QUOTA_AUTO_RESUME_GRACE_MS;
    if (now() < fireAtMs) {
      schedule(sessionID, resume, fireAtMs);
      return;
    }
    await fire(sessionID, resume);
  }

  async function arm(sessionID: string, error: FailureError): Promise<void> {
    if (disposed || pending.has(sessionID)) return;
    const failureAt = now();
    const resume: PendingResume = {
      failureAt,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterAtMs: failureAt + error.retryAfterMs }
        : {}),
    };
    // Registered before the awaits so a cancellation event during the probe removes it.
    pending.set(sessionID, resume);
    await evaluate(sessionID, resume);
  }

  return {
    handleEvent(event) {
      if (disposed) return;
      const sessionID = sessionIDOf(event.data);
      switch (event.type) {
        case "session.execution.failed": {
          if (sessionID === undefined) return;
          // A newer terminal failure supersedes a pending resume for this session.
          cancel(sessionID);
          // The current execution was already resumed once; wait for a fresh user prompt.
          if (consumed.has(sessionID)) return;
          const data = event.data as Record<string, unknown>;
          const error = failureError(data.error);
          if (!error || !isQuotaLimitError(error as QuotaRetryEvent["error"])) return;
          void arm(sessionID, error);
          return;
        }
        case "session.execution.interrupted":
        case "session.execution.started":
        case "session.execution.succeeded":
        case "session.model.selected":
          if (sessionID !== undefined) cancel(sessionID);
          return;
        case "session.deleted":
          if (sessionID !== undefined) {
            consumed.delete(sessionID);
            cancel(sessionID);
          }
          return;
        case "credential.updated":
        case "credential.switched":
          cancelAll();
          return;
        default:
          return;
      }
    },
    onPrompt(event) {
      if (disposed || event.sessionID === undefined) return;
      if (event.metadata?.source === QUOTA_AUTO_RESUME_SOURCE) return;
      // A user prompt starts a new execution; it may earn one fresh auto-resume later.
      consumed.delete(event.sessionID);
      cancel(event.sessionID);
    },
    dispose() {
      disposed = true;
      consumed.clear();
      cancelAll();
    },
  };
}
