/**
 * `autoResumeOnQuotaRecovery` (off by default): after a session terminally fails on a genuine
 * provider quota limit, wait until the failed route's exhausted quota window is observed as reset
 * for the same verified identity, then send exactly one `continue` prompt if the session is still
 * failed, idle and on the same model.
 *
 * In-process only. There is no durable queue: a plugin restart drops a pending resume (accepted;
 * the next terminal failure arms a new cycle). Native retry and provider cooldown policies are
 * never replaced by this module, and no tool action is replayed.
 */
import {
  isQuotaLimitError,
  type QuotaRetryEvent,
  type QuotaWindowBinding,
  type QuotaWindowCollection,
  sameQuotaWindowBinding,
} from "./quota-retry-wait.js";

/** Wait after the first confirmed recovery, so a user who is back at the keyboard can take over. */
export const QUOTA_AUTO_RESUME_GRACE_MS = 120_000;
/** The single continuation prompt; no native continue API exists. */
export const QUOTA_AUTO_RESUME_PROMPT = "continue";
/** Marker used to ignore the module's own prompt and to make the continuation visible. */
export const QUOTA_AUTO_RESUME_SOURCE = "opencode-quota-gui-autoresume";

/** `setTimeout` overflows above this; longer waits are re-armed in chunks. */
const MAX_TIMER_MS = 2_147_483_647;

export type QuotaAutoResumeSessionInfo = {
  model?: { id: string; providerID: string };
  parentID?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time?: { idle?: number };
};

export interface QuotaAutoResumeDeps {
  /** Current windows for the failed route, or undefined when the evidence is unavailable. */
  probe: (model: { id: string; providerID: string }) => Promise<QuotaWindowCollection | undefined>;
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

type PendingResume = {
  phase: "arming" | "waiting" | "grace";
  failureAt: number;
  modelID?: string;
  providerID?: string;
  binding?: QuotaWindowBinding;
  windowKeys?: string[];
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

  function recovered(
    collection: QuotaWindowCollection,
    resume: PendingResume,
  ): { recovered: boolean; nextResetAtMs?: number } {
    const windows = new Map(
      collection.windows.flatMap((window) =>
        window.key !== undefined ? [[window.key, window] as const] : [],
      ),
    );
    let nextResetAtMs: number | undefined;
    for (const key of resume.windowKeys ?? []) {
      const window = windows.get(key);
      // The row disappeared: there is no evidence that this exact window reset.
      if (!window) return { recovered: false };
      if (window.percentRemaining > 0) continue;
      if (window.resetMs === undefined || !(window.resetMs > now())) return { recovered: false };
      if (nextResetAtMs === undefined || window.resetMs > nextResetAtMs) {
        nextResetAtMs = window.resetMs;
      }
    }
    return nextResetAtMs === undefined ? { recovered: true } : { recovered: false, nextResetAtMs };
  }

  async function readSession(sessionID: string): Promise<QuotaAutoResumeSessionInfo | undefined> {
    try {
      return await deps.session.get({ sessionID });
    } catch {
      return undefined;
    }
  }

  type ProbeOutcome =
    | { kind: "probe"; collection: QuotaWindowCollection }
    | { kind: "cancelled" }
    | { kind: "unavailable" };

  async function probeRecovery(
    sessionID: string,
    resume: PendingResume,
    model: { id: string; providerID: string },
  ): Promise<ProbeOutcome> {
    let collection: QuotaWindowCollection | undefined;
    try {
      collection = await deps.probe(model);
    } catch {
      collection = undefined;
    }
    // The controller may have been disposed or superseded while the probe ran.
    if (disposed || pending.get(sessionID) !== resume) return { kind: "cancelled" };
    if (
      !collection ||
      resume.binding === undefined ||
      !sameQuotaWindowBinding(resume.binding, collection.binding)
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "probe", collection };
  }

  async function evaluate(sessionID: string, resume: PendingResume): Promise<void> {
    if (disposed || pending.get(sessionID) !== resume) return;
    let info = await readSession(sessionID);
    if (disposed || pending.get(sessionID) !== resume) return;
    if (info === undefined) {
      cancel(sessionID);
      return;
    }
    if (!sameModel(info, resume)) {
      cancel(sessionID);
      return;
    }
    if (resume.modelID === undefined || resume.providerID === undefined) {
      cancel(sessionID);
      return;
    }
    const model = { id: resume.modelID, providerID: resume.providerID };
    if (resume.phase === "waiting") {
      if (info.outcome !== "failed") {
        cancel(sessionID);
        return;
      }
      const probe = await probeRecovery(sessionID, resume, model);
      if (probe.kind === "cancelled") return;
      if (probe.kind === "unavailable") {
        cancel(sessionID);
        return;
      }
      const state = recovered(probe.collection, resume);
      if (state.nextResetAtMs !== undefined) {
        schedule(sessionID, resume, state.nextResetAtMs + 60_000);
        return;
      }
      if (!state.recovered) {
        cancel(sessionID);
        return;
      }
      resume.phase = "grace";
      schedule(sessionID, resume, now() + QUOTA_AUTO_RESUME_GRACE_MS);
      return;
    }
    if (resume.phase !== "grace") return;
    // A second confirmation after the grace period, so a brief probe reading cannot fire alone.
    if (info.outcome !== "failed") {
      cancel(sessionID);
      return;
    }
    if (resume.idleAtArm !== undefined && info.time?.idle !== resume.idleAtArm) {
      cancel(sessionID);
      return;
    }
    const probe = await probeRecovery(sessionID, resume, model);
    if (probe.kind === "cancelled") return;
    if (probe.kind === "unavailable" || !recovered(probe.collection, resume).recovered) {
      cancel(sessionID);
      return;
    }
    // Re-check after the probe: a user prompt or a resume may have landed while it ran.
    info = await readSession(sessionID);
    if (disposed || pending.get(sessionID) !== resume) return;
    if (
      info === undefined ||
      !sameModel(info, resume) ||
      info.outcome !== "failed" ||
      (resume.idleAtArm !== undefined && info.time?.idle !== resume.idleAtArm)
    ) {
      cancel(sessionID);
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

  async function arm(sessionID: string, error: FailureError): Promise<void> {
    if (disposed || pending.has(sessionID)) return;
    const resume: PendingResume = { phase: "arming", failureAt: now() };
    // Registered before the awaits so a cancellation event during the probe removes it.
    pending.set(sessionID, resume);
    try {
      const info = await deps.session.get({ sessionID });
      if (disposed || pending.get(sessionID) !== resume) return;
      if (info.outcome !== "failed" || !info.model) {
        cancel(sessionID);
        return;
      }
      // A subagent session is not a user conversation; do not inject a continuation there.
      if (info.parentID !== undefined) {
        cancel(sessionID);
        return;
      }
      const model = { id: info.model.id, providerID: info.model.providerID };
      let collection: QuotaWindowCollection | undefined;
      try {
        collection = await deps.probe(model);
      } catch {
        cancel(sessionID);
        return;
      }
      if (disposed || pending.get(sessionID) !== resume) return;
      if (!collection) {
        cancel(sessionID);
        return;
      }
      const binding = collection.binding;
      // Auto-resume needs the failed route bound to a verified identity before it can wait.
      if (binding === undefined) {
        cancel(sessionID);
        return;
      }
      const exhausted = collection.windows.filter((window) => window.percentRemaining <= 0);
      if (exhausted.length === 0) {
        cancel(sessionID);
        return;
      }
      const nowMs = now();
      let latestResetMs = nowMs;
      const windowKeys: string[] = [];
      for (const window of exhausted) {
        if (window.key === undefined || window.resetMs === undefined || !(window.resetMs > nowMs)) {
          cancel(sessionID);
          return;
        }
        windowKeys.push(window.key);
        latestResetMs = Math.max(latestResetMs, window.resetMs);
      }
      resume.phase = "waiting";
      resume.modelID = model.id;
      resume.providerID = model.providerID;
      resume.binding = binding;
      resume.windowKeys = [...new Set(windowKeys)];
      resume.idleAtArm = info.time?.idle;
      // Honor a provider-requested wait for the first observation when it is later than the reset.
      const retryAfterAtMs =
        error.retryAfterMs !== undefined ? nowMs + error.retryAfterMs : latestResetMs;
      schedule(sessionID, resume, Math.max(latestResetMs + 60_000, retryAfterAtMs));
    } catch {
      cancel(sessionID);
    }
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
