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
 * it without the later transition. A disabled setting or a route whose provider registration has
 * no `autoResume` contract cancels the pending resume and is not polled again.
 *
 * OpenCode 2.4.1 loses the structured quota error for some Claude Agent subscription limits and
 * exposes only a message. Known Claude subscription-limit messages are recognized for this module
 * only; they still require an independently observed exhausted five-hour or weekly window (plus
 * the Fable weekly row only for a Fable model) for the same verified identity. Native retry
 * classification and provider cooldown policies are never changed by that recognition.
 *
 * In-process only. There is no durable queue: a plugin restart drops a pending resume (accepted;
 * the next terminal failure arms a new cycle). No tool action is replayed.
 */
import { getQuotaProviderIdsForRuntimeId } from "./provider-metadata.js";
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

/**
 * The probe's evidence state; the setting's enablement, permanent route support, and temporary
 * evidence absence stay distinct.
 */
export type QuotaAutoResumeProbe =
  | { readonly kind: "collection"; readonly collection: QuotaWindowCollection }
  | { readonly kind: "absent" }
  | { readonly kind: "disabled" }
  | { readonly kind: "unsupported" };

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
  /** Set when a known Claude subscription-limit message armed this pending resume. */
  subscription?: ClaudeSubscriptionWindow;
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
  message?: string;
  status?: number;
  retryAfterMs?: number;
};

function failureError(value: unknown): FailureError | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = value as Record<string, unknown>;
  if (typeof error.type !== "string") return undefined;
  return {
    type: error.type,
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/** The Claude subscription window named by a known terminal message. */
type ClaudeSubscriptionWindow = "five_hour" | "week" | "any";

/**
 * Known Claude Agent subscription-limit messages. Auto-resume-only: `isQuotaLimitError` and the
 * native retry hook never see this recognition.
 *
 * OpenCode 2.4.1's claude-agent error converter turns a rejected `rate_limit_event` plus an empty
 * result into `Claude Code subscription limit reached (<window>). Resets at <ISO>.`, and it
 * preserves Claude Code's own text when the result is non-empty. The converter and message shape:
 * https://github.com/anomalyco/opencode/blob/v2.4.1/packages/core/src/plugin/provider/claude-agent/language-model/claude-agent-error.ts
 * Observed payloads and the lossy UnknownProvider classification:
 * https://github.com/anomalyco/opencode/issues/63189 (session text and the empty-result form).
 * Claude Code uses the same `You've hit your <window> limit · resets ...` shape for its weekly
 * limit. `five_hour`/`seven_day` and the other rate-limit types are in the Claude Agent SDK
 * `SDKRateLimitInfo` type: https://unpkg.com/@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
const CLAUDE_SUBSCRIPTION_LIMIT_MESSAGES: readonly {
  readonly pattern: RegExp;
  readonly window: ClaudeSubscriptionWindow;
}[] = [
  { pattern: /^Claude Code subscription limit reached \(five hour\)/, window: "five_hour" },
  { pattern: /^Claude Code subscription limit reached \(seven day\)/, window: "week" },
  { pattern: /^Claude Code subscription limit reached\b/, window: "any" },
  {
    pattern: /^You've hit your (?:session|five-hour|5-hour) limit\b/i,
    window: "five_hour",
  },
  { pattern: /^You've hit your weekly limit\b/i, window: "week" },
];

function claudeSubscriptionWindow(
  message: string | undefined,
): ClaudeSubscriptionWindow | undefined {
  if (message === undefined) return undefined;
  const normalized = message.trim();
  return CLAUDE_SUBSCRIPTION_LIMIT_MESSAGES.find(({ pattern }) => pattern.test(normalized))?.window;
}

/** Claude Agent's runtime ids normalize to this canonical provider in the registration catalog. */
function isClaudeAgentRoute(providerID: string): boolean {
  return getQuotaProviderIdsForRuntimeId(providerID).includes("claude-agent");
}

/** The `named:Fable weekly` row belongs to the Fable model only (anthropicQuotaEntries). */
function isFableModel(modelID: string | undefined): boolean {
  return modelID !== undefined && /fable/i.test(modelID);
}

/** The window keys that can confirm a recognized Claude subscription-limit message. */
function subscriptionWindowKeys(resume: PendingResume): readonly string[] {
  if (resume.subscription === "five_hour") return ["window:five_hour"];
  const keys = ["window:week"];
  if (isFableModel(resume.modelID)) keys.push("named:Fable weekly");
  if (resume.subscription === "any") keys.unshift("window:five_hour");
  return keys;
}

type SubscriptionConfirmation = "confirmed" | "contradicted" | "unavailable";

/**
 * A message alone never arms recovery. At least one applicable window must be independently
 * observed as exhausted with a future reset for the same verified binding. A missing row or reset
 * is temporary evidence; a present row that still has quota contradicts the message.
 */
function subscriptionConfirmation(
  collection: QuotaWindowCollection,
  resume: PendingResume,
  nowMs: number,
): SubscriptionConfirmation {
  const expected = subscriptionWindowKeys(resume);
  const present = collection.windows.filter(
    (window) => window.key !== undefined && expected.includes(window.key),
  );
  if (
    present.some(
      (window) =>
        window.percentRemaining <= 0 && window.resetMs !== undefined && window.resetMs > nowMs,
    )
  ) {
    return "confirmed";
  }
  // A possible window row is missing: absence of evidence, not proof against the message.
  if (present.length < expected.length) return "unavailable";
  if (present.every((window) => window.percentRemaining > 0)) return "contradicted";
  // Exhausted but no future reset yet: keep polling for usable evidence.
  return "unavailable";
}

/** Applies model-scoped row semantics before a window can become recovery evidence. */
function isApplicableWindow(
  window: QuotaWindowCollection["windows"][number],
  resume: PendingResume,
): boolean {
  return window.key !== "named:Fable weekly" || isFableModel(resume.modelID);
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

  /** Reads the session; cancels or re-polls itself and returns `undefined` unless it is usable. */
  async function readLiveSession(
    sessionID: string,
    resume: PendingResume,
  ): Promise<QuotaAutoResumeSessionInfo | undefined> {
    const state = sessionState(await readSession(sessionID), resume);
    if (disposed || pending.get(sessionID) !== resume) return undefined;
    if (state.kind === "cancel") {
      cancel(sessionID);
      return undefined;
    }
    if (state.kind === "unavailable") {
      retryLater(sessionID, resume);
      return undefined;
    }
    return state.info;
  }

  type ProbeState =
    | { kind: "collection"; collection: QuotaWindowCollection }
    | { kind: "cancelled" }
    | { kind: "disabled" }
    | { kind: "identity" }
    | { kind: "unavailable" }
    | { kind: "unsupported" };

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
    // A disabled feature or a permanently unsupported route stops the pending resume.
    if (result === undefined || result.kind === "absent") return { kind: "unavailable" };
    if (result.kind === "disabled") return { kind: "disabled" };
    if (result.kind === "unsupported") return { kind: "unsupported" };
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
    | { kind: "cancel" }
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
    if (resume.subscription !== undefined) {
      const confirmation = subscriptionConfirmation(collection, resume, nowMs);
      if (confirmation === "contradicted") return { kind: "cancel" };
      if (confirmation === "unavailable") return { kind: "unknown" };
    }
    const applicable = collection.windows.filter((window) => isApplicableWindow(window, resume));
    const exhausted = applicable.filter((window) => window.percentRemaining <= 0);
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
    if ((await readLiveSession(sessionID, resume)) === undefined) return;
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
    const info = await readLiveSession(sessionID, resume);
    if (info === undefined) return;
    const model = info.model;
    if (model === undefined) {
      retryLater(sessionID, resume);
      return;
    }
    // Capture the failed route and inactivity once, at the first successful read.
    resume.modelID ??= model.id;
    resume.providerID ??= model.providerID;
    resume.idleAtArm ??= info.time?.idle;
    // A recognized Claude subscription-limit message is only valid on the Claude Agent route.
    if (resume.subscription !== undefined && !isClaudeAgentRoute(model.providerID)) {
      cancel(sessionID);
      return;
    }
    const route = { id: model.id, providerID: model.providerID };
    const probe = await probeQuota(sessionID, resume, route);
    if (probe.kind === "cancelled") return;
    if (probe.kind === "identity") {
      cancel(sessionID);
      return;
    }
    // Turning the setting off, or a route with no auto-resume contract, cancels immediately.
    if (probe.kind === "disabled" || probe.kind === "unsupported") {
      cancel(sessionID);
      return;
    }
    if (probe.kind === "unavailable") {
      // Absent evidence keeps the pending resume: it may arm once a baseline is observable.
      retryLater(sessionID, resume);
      return;
    }
    const windows = observeWindows(probe.collection, resume, now());
    if (windows.kind === "cancel") {
      cancel(sessionID);
      return;
    }
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

  async function arm(
    sessionID: string,
    error: FailureError,
    subscription: ClaudeSubscriptionWindow | undefined,
  ): Promise<void> {
    if (disposed || pending.has(sessionID)) return;
    const failureAt = now();
    const resume: PendingResume = {
      failureAt,
      ...(subscription !== undefined ? { subscription } : {}),
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
          if (!error) return;
          const typed = isQuotaLimitError(error as QuotaRetryEvent["error"]);
          // OpenCode 2.4.1 exposes some Claude subscription limits as provider.unknown with only
          // a message. Recognize only the known shapes; a message alone still cannot arm without
          // the independent exhausted-window confirmation in `establishBaseline`.
          const subscription =
            !typed && error.type === "provider.unknown"
              ? claudeSubscriptionWindow(error.message)
              : undefined;
          if (!typed && subscription === undefined) return;
          void arm(sessionID, error, subscription);
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
