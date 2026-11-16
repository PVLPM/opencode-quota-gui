import type { DashboardRpcCacheObserverEvent } from "../rpc.js";
import type {
  ClaudeObservedTtlResult,
  ClaudeTranscriptQuery,
} from "./claude-agent-transcript-ttl.js";

type TtlEvent = Extract<DashboardRpcCacheObserverEvent, { type: "session.cache.ttl" }>;

interface Step {
  claude: boolean;
  /** The last native ids seen before step.ended; step.ended itself carries none. */
  native?: { sessionId: string; messageId: string };
}

interface PendingRetry {
  /**
   * first-inflight: first read running; first-requested: a later event arrived meanwhile;
   * retry-ready: first read said "retry", waiting for that event; second: final read started.
   */
  phase: "first-inflight" | "first-requested" | "retry-ready" | "second";
  query: ClaudeTranscriptQuery;
  sessionId: string;
  stepId: string;
  created: number;
}

const MAX_TRACKED_STEPS = 256;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * Plugin-side correlation of one completed Claude Agent step with its session transcript.
 * It remembers native ids per assistant message, does one bounded read after a successful
 * step.ended, at most one retry on the session's next event, and emits only the minimal
 * session.cache.ttl DTO for the newest invocation. No polling, watching or logging.
 */
export function createClaudeAgentTtlTracker(options: {
  directory: string;
  read: (query: ClaudeTranscriptQuery) => Promise<ClaudeObservedTtlResult>;
  emit: (event: TtlEvent, at: number) => void;
}) {
  const steps = new Map<string, Step>();
  const newest = new Map<string, string>();
  const retries = new Map<string, PendingRetry>();

  const keyOf = (sessionId: string, stepId: string) => JSON.stringify([sessionId, stepId]);

  /** One read for the slot's step; undefined when it failed, the slot was dropped, or a newer step exists. */
  async function readOnce(slot: PendingRetry): Promise<ClaudeObservedTtlResult | undefined> {
    let result: ClaudeObservedTtlResult;
    try {
      result = await options.read(slot.query);
    } catch {
      return undefined;
    }
    if (retries.get(slot.sessionId) !== slot || newest.get(slot.sessionId) !== slot.stepId) {
      return undefined;
    }
    if (result === "1h") {
      try {
        options.emit(
          {
            type: "session.cache.ttl",
            created: slot.created,
            data: { sessionID: slot.sessionId, assistantMessageID: slot.stepId, ttlMs: 3_600_000 },
          },
          slot.created,
        );
      } catch {
        // A failing relay must not break event handling.
      }
    }
    return result;
  }

  /** At most two reads: the second only after a "retry" result and a later event of the session. */
  async function run(slot: PendingRetry): Promise<void> {
    const first = await readOnce(slot);
    if (first === "retry") {
      if (slot.phase === "first-requested") {
        slot.phase = "second";
        await readOnce(slot);
      } else {
        slot.phase = "retry-ready";
        return;
      }
    }
    if (retries.get(slot.sessionId) === slot) retries.delete(slot.sessionId);
  }

  function observe(raw: unknown, projected: DashboardRpcCacheObserverEvent | undefined): void {
    const event = record(raw);
    const data = record(event?.data);
    const sessionId = text(data?.sessionID);
    if (event === undefined || data === undefined || sessionId === undefined) return;

    if (projected?.type === "session.step.started") {
      const stepId = projected.data.assistantMessageID;
      newest.delete(sessionId);
      newest.set(sessionId, stepId);
      while (newest.size > MAX_TRACKED_STEPS) {
        const oldestSession = newest.keys().next().value;
        if (oldestSession === undefined) break;
        newest.delete(oldestSession);
        retries.delete(oldestSession);
      }
      retries.delete(sessionId);
      steps.delete(keyOf(sessionId, stepId));
      steps.set(keyOf(sessionId, stepId), {
        claude: projected.data.model.providerID === "claude-agent",
      });
      while (steps.size > MAX_TRACKED_STEPS) {
        const oldest = steps.keys().next().value;
        if (oldest === undefined) break;
        steps.delete(oldest);
      }
      return;
    }

    if (event.type === "session.text.ended" || event.type === "session.tool.called") {
      const step = steps.get(keyOf(sessionId, text(data.assistantMessageID) ?? ""));
      const nativeIds = record(data.native);
      const nativeSession = text(nativeIds?.sessionID);
      const nativeMessage = text(nativeIds?.messageID);
      if (step?.claude && nativeSession !== undefined && nativeMessage !== undefined) {
        step.native = { sessionId: nativeSession, messageId: nativeMessage };
      }
      return;
    }

    if (projected?.type === "session.step.ended") {
      const stepId = projected.data.assistantMessageID;
      const step = steps.get(keyOf(sessionId, stepId));
      const { input, cache } = projected.data.tokens;
      if (
        step?.claude !== true ||
        step.native === undefined ||
        newest.get(sessionId) !== stepId ||
        input === undefined ||
        cache?.read === undefined ||
        cache.write === undefined
      ) {
        return;
      }
      const slot: PendingRetry = {
        phase: "first-inflight",
        sessionId,
        stepId,
        created: projected.created,
        query: {
          directory: options.directory,
          nativeSessionId: step.native.sessionId,
          nativeMessageId: step.native.messageId,
          tokens: { input, read: cache.read, write: cache.write },
        },
      };
      retries.set(sessionId, slot);
      run(slot).catch(() => undefined);
      return;
    }

    if (event.type === "session.deleted") {
      newest.delete(sessionId);
      retries.delete(sessionId);
      return;
    }

    const slot = retries.get(sessionId);
    if (slot?.phase === "first-inflight") slot.phase = "first-requested";
    else if (slot?.phase === "retry-ready") {
      slot.phase = "second";
      readOnce(slot)
        .catch(() => undefined)
        .then(() => {
          if (retries.get(sessionId) === slot) retries.delete(sessionId);
        });
    }
  }

  return {
    observe,
    dispose(): void {
      steps.clear();
      newest.clear();
      retries.clear();
    },
  };
}
