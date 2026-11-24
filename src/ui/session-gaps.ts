import type { SessionSnapshot, StepPoint } from "../contracts/dashboard";
import { formatPercentExact } from "./format";

/** Labels the Session page uses for per-step timing and idle-gap observations. */
export const SESSION_GAP_LABELS = {
  longestIdleGap: "Longest idle gap",
  longestHighReuseGap: "Longest high-reuse gap",
  unavailable: "Unavailable",
  /** Exact wording for the gap basis: stored message times, not HTTP request times. */
  gapBasis: "Previous message completed → next message created",
  messageCreated: "Created",
  messageCompleted: "Completed",
  messageDuration: "Duration",
  idleSincePrevious: "Idle before",
  overlapsPrevious: "Overlaps previous message",
  cacheReadTokens: "Cache read",
  cacheReuse: "Cache reuse",
  providerModelEffort: "Provider / model / effort",
} as const;

/** A gap is "high-reuse" at or above this cache reuse percentage (observation, not a TTL). */
export const HIGH_REUSE_THRESHOLD_PCT = 90;

/**
 * Token-weighted cache reuse of one message: `cacheRead / (input + cacheRead +
 * cacheWrite)` in percent. `null` when either cache counter was not stored
 * (the 0 is unknown) or there was no prompt traffic; never a manufactured 0%.
 */
export function stepCacheReuse(step: StepPoint): number | null {
  if (step.cacheReadUnknown || step.cacheWriteUnknown) return null;
  const { input, cacheRead, cacheWrite } = step.stack;
  const denominator = input + cacheRead + cacheWrite;
  if (!(denominator > 0)) return null;
  return (cacheRead / denominator) * 100;
}

/** `Cache reuse: 16.60%`; unknown reuse reads `Cache reuse: Unavailable`. */
export function formatCacheReuse(pct: number | null): string {
  const value =
    pct === null || !Number.isFinite(pct)
      ? SESSION_GAP_LABELS.unavailable
      : formatPercentExact(pct);
  return `${SESSION_GAP_LABELS.cacheReuse}: ${value}`;
}

/**
 * Timing of one message relative to its own session. Concepts stay separate:
 * `createdAtMs` is OpenCode's stored message creation time (not an HTTP request
 * start); `completedAtMs` its stored completion; `durationMs` spans exactly
 * those two; `idleMs` is previous-completed → this-created. No intra-message
 * step timing exists in the source, so none is reported.
 */
export interface StepTiming {
  stepIndex: number;
  /** Index of the earlier message that finished last, when one exists. */
  previousStepIndex?: number;
  createdAtMs?: number;
  completedAtMs: number;
  /** Absent when creation time is missing or later than completion. */
  durationMs?: number;
  /** Absent when it cannot be measured or when the message overlaps earlier work. */
  idleMs?: number;
  /** This message was created before an earlier message of the session finished. */
  overlap: boolean;
  /** How long it ran concurrently with that earlier message; only with `overlap`. */
  overlapMs?: number;
}

function validCreated(step: StepPoint): number | undefined {
  const created = step.createdAtMs;
  return created !== undefined && Number.isFinite(created) && created > 0 ? created : undefined;
}

/** A session's steps in creation order (completion order where creation is unknown). */
function sessionSequence(steps: readonly StepPoint[], sessionId: string): number[] {
  return steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.sessionId === sessionId)
    .sort(
      (a, b) =>
        (validCreated(a.step) ?? a.step.atMs) - (validCreated(b.step) ?? b.step.atMs) ||
        a.step.atMs - b.step.atMs ||
        (a.step.messageId < b.step.messageId ? -1 : a.step.messageId > b.step.messageId ? 1 : 0),
    )
    .map(({ index }) => index);
}

interface SequencedStep {
  timing: StepTiming;
  /** The previous finisher is also the immediately preceding message in sequence. */
  adjacent: boolean;
}

function sequenceTimings(
  steps: readonly StepPoint[],
  sequence: readonly number[],
): SequencedStep[] {
  const out: SequencedStep[] = [];
  let finisher: number | undefined;
  sequence.forEach((stepIndex, position) => {
    const step = steps[stepIndex]!;
    const created = validCreated(step);
    const timing: StepTiming = { stepIndex, completedAtMs: step.atMs, overlap: false };
    if (created !== undefined) {
      timing.createdAtMs = created;
      if (created <= step.atMs) timing.durationMs = step.atMs - created;
    }
    if (finisher !== undefined) {
      const previous = steps[finisher]!;
      timing.previousStepIndex = finisher;
      if (created !== undefined) {
        // Idle is measured from the latest completion so far, so concurrent
        // earlier work is never counted as idle time.
        if (created < previous.atMs) {
          timing.overlap = true;
          timing.overlapMs = previous.atMs - created;
        } else {
          timing.idleMs = created - previous.atMs;
        }
      }
    }
    out.push({ timing, adjacent: finisher !== undefined && finisher === sequence[position - 1] });
    if (finisher === undefined || step.atMs >= steps[finisher]!.atMs) finisher = stepIndex;
  });
  return out;
}

/**
 * Per-step timing, aligned with `steps` by index. Each session is sequenced on
 * its own, so concurrent child agents are never treated as one sequential run.
 */
export function stepTimings(steps: readonly StepPoint[]): StepTiming[] {
  const byIndex: StepTiming[] = new Array<StepTiming>(steps.length);
  for (const sessionId of new Set(steps.map((step) => step.sessionId))) {
    for (const { timing } of sequenceTimings(steps, sessionSequence(steps, sessionId))) {
      byIndex[timing.stepIndex] = timing;
    }
  }
  return byIndex;
}

/** One observed idle interval between two consecutive messages of one session. */
export interface SessionGap {
  fromStepIndex: number;
  toStepIndex: number;
  /** Previous message completed → next message created, in ms. A message-boundary interval, not a request interval. */
  idleMs: number;
  /** Cache reuse of the next message; null when its cache counters are unknown. */
  cacheReusePct: number | null;
}

export interface SessionGapMetrics {
  /** The session whose own sequence was used (the focused session, also in Session tree scope). */
  sessionId: string;
  longestIdle: SessionGap | null;
  longestHighReuse: SessionGap | null;
  /** Steps created before an earlier message finished; those pairs are excluded, never given an idle time. */
  overlappingSteps: number;
}

function sameIdentity(a: StepPoint, b: StepPoint): boolean {
  return (
    a.model !== undefined &&
    b.model !== undefined &&
    a.model.providerId === b.model.providerId &&
    a.model.modelId === b.model.modelId &&
    a.model.effort === b.model.effort
  );
}

function anyWithin(times: readonly number[], from: number, to: number): boolean {
  return times.some((time) => time >= from && time <= to);
}

/**
 * Observed idle gaps of the focused session's own sequence (children are never
 * mixed in). A gap needs: the previous finisher is the immediately preceding
 * message, no overlap, valid timestamps, the same provider/model/effort on both
 * sides, no compaction between them, and no excluded or fork-copy message
 * between them (`unobservedAtMs`), so history gaps are never bridged. The gap's
 * cache reuse is the next MESSAGE's token-weighted reuse (a message is one
 * chart point; step-level parts carry no timestamps or counters). These are
 * observations, not provider cache TTLs. Incomplete (unfinished) messages are
 * never read, so they cannot be detected between two messages.
 */
export function sessionGapMetrics(snapshot: SessionSnapshot): SessionGapMetrics {
  const sessionId = snapshot.focusSessionId;
  const steps = snapshot.steps;
  const compactions = snapshot.compactionMarkers
    .filter((marker) => marker.sessionId === sessionId)
    .map((marker) => marker.atMs);
  const unobserved = snapshot.unobservedAtMs ?? [];
  const sequenced = sequenceTimings(steps, sessionSequence(steps, sessionId));

  let longestIdle: SessionGap | null = null;
  let longestHighReuse: SessionGap | null = null;
  for (const { timing, adjacent } of sequenced) {
    if (!adjacent || timing.idleMs === undefined || timing.previousStepIndex === undefined)
      continue;
    const previous = steps[timing.previousStepIndex]!;
    const next = steps[timing.stepIndex]!;
    if (!sameIdentity(previous, next)) continue;
    const lower = validCreated(previous) ?? previous.atMs;
    const upper = timing.createdAtMs!;
    if (anyWithin(compactions, lower, upper) || anyWithin(unobserved, lower, upper)) continue;
    const gap: SessionGap = {
      fromStepIndex: timing.previousStepIndex,
      toStepIndex: timing.stepIndex,
      idleMs: timing.idleMs,
      cacheReusePct: stepCacheReuse(next),
    };
    if (longestIdle === null || gap.idleMs > longestIdle.idleMs) longestIdle = gap;
    if (
      gap.cacheReusePct !== null &&
      gap.cacheReusePct >= HIGH_REUSE_THRESHOLD_PCT &&
      (longestHighReuse === null || gap.idleMs > longestHighReuse.idleMs)
    ) {
      longestHighReuse = gap;
    }
  }
  return {
    sessionId,
    longestIdle,
    longestHighReuse,
    overlappingSteps: sequenced.filter(({ timing }) => timing.overlap).length,
  };
}
