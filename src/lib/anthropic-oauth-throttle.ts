/**
 * Cross-process request spacing and 429 cooldown for Anthropic's OAuth usage endpoint.
 *
 * Claude Agent is polled by every OpenCode process. Anthropic rate-limits per
 * account, so two processes polling independently keep the limit alive. The
 * shared record keeps timing only - never a token, token hash, account, email
 * or any other identity - so it is safe under the Windows process-local
 * identity contract.
 *
 * Claiming holds `state-file-lock` until the attempt publishes its outcome, so
 * a concurrent process either sees the claimed attempt or skips; it never
 * performs an independent fetch. A busy lock is a skip, not a wait.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getGuiPrivateStatePath } from "./private-state-paths.js";
import { acquireStateFileLock } from "./state-file-lock.js";
import { REQUEST_TIMEOUT_MS } from "./types.js";

/** Default minimum spacing between Anthropic usage requests. */
export const ANTHROPIC_OAUTH_DEFAULT_POLL_INTERVAL_MS = 180_000;
/** The configured spacing may not go below one minute. */
export const ANTHROPIC_OAUTH_MIN_POLL_INTERVAL_MS = 60_000;
/** A 429 without a usable Retry-After starts at one minute. */
export const ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS = 60_000;
/** Our own exponential backoff is capped at five minutes. */
export const ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS = 5 * 60_000;
/** A server Retry-After longer than one day is treated as malformed. */
export const ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

const STATE_VERSION = 1;
const STATE_FILE_NAME = "anthropic-oauth-throttle.json";
const MAX_BACKOFF_EXPONENT = 30;

interface AnthropicOAuthThrottleState {
  version: typeof STATE_VERSION;
  issuedAtMs: number;
  lastAttemptAtMs?: number;
  blockedUntilMs?: number;
  failureCount?: number;
}

type AnthropicOAuthThrottleSkipReason = "spacing" | "cooldown" | "busy" | "unavailable";

type AnthropicOAuthAttemptCompletion =
  | { kind: "success" }
  /** A non-429 response ended any previous 429 backoff. */
  | { kind: "response" }
  /** No response was received; an existing 429 streak is preserved. */
  | { kind: "network-error" }
  | { kind: "rate-limited"; retryAfterMs?: number; nowMs: number };

export interface AnthropicOAuthAttemptCompletionResult {
  blockedUntilMs?: number;
  failureCount: number;
}

export type AnthropicOAuthThrottleClaim =
  | {
      state: "claimed";
      claimedAtMs: number;
      failureCount: number;
      /** Publishes the outcome and releases the claim; safe to call once. */
      complete: (
        outcome: AnthropicOAuthAttemptCompletion,
      ) => Promise<AnthropicOAuthAttemptCompletionResult>;
    }
  | {
      state: "skip";
      reason: AnthropicOAuthThrottleSkipReason;
      /** The next real request time when one is known. */
      retryAtMs?: number;
    };

/** In-process fail-closed deadline for corrupt, unreadable or unpublishable shared state. */
let failClosedUntilMs = 0;
/**
 * A completed rate-limit deadline whose shared write failed. The next claim
 * retries the write before doing anything else; until then this process fails
 * closed rather than letting the known cooldown be lost.
 */
let pendingPublish: { statePath: string; state: AnthropicOAuthThrottleState } | undefined;

function getAnthropicOAuthThrottleStatePath(): string {
  return getGuiPrivateStatePath(STATE_FILE_NAME);
}

export function normalizeAnthropicOAuthPollIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(ANTHROPIC_OAUTH_MIN_POLL_INTERVAL_MS, value)
    : ANTHROPIC_OAUTH_DEFAULT_POLL_INTERVAL_MS;
}

export function getAnthropicOAuthRateLimitDurationMs(
  failureCount: number,
  retryAfterMs: number | undefined,
): number {
  if (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0 &&
    retryAfterMs <= ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS
  ) {
    // A server deadline is honored in full; the five-minute cap only applies to
    // our own backoff when the header is missing, zero, or malformed.
    return retryAfterMs;
  }
  return Math.min(
    ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS * 2 ** Math.min(failureCount, MAX_BACKOFF_EXPONENT),
    ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
  );
}

/** Reset per-process memory used only for tests; the shared file is untouched. */
export function resetAnthropicOAuthThrottleMemoryForTests(): void {
  failClosedUntilMs = 0;
  pendingPublish = undefined;
}

/** Remove the shared record and lock used only for tests. */
export function clearAnthropicOAuthThrottleStateForTests(): void {
  failClosedUntilMs = 0;
  pendingPublish = undefined;
  const statePath = getAnthropicOAuthThrottleStatePath();
  try {
    rmSync(statePath, { force: true });
  } catch {
    // A test directory may already be gone.
  }
  try {
    rmSync(`${statePath}.lock`, { recursive: true, force: true });
  } catch {
    // A test directory may already be gone.
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type ParsedState =
  | { kind: "ok"; state: AnthropicOAuthThrottleState }
  /**
   * The record was written by a clock ahead of this one. A recorded deadline
   * still bounds how long we fail closed; the written state is repaired on the
   * next claim so a clock step cannot silently delete a live cooldown.
   */
  | { kind: "rollback"; blockedForMs: number; failureCount: number }
  | { kind: "corrupt" }
  | undefined;

function parseState(raw: string, nowMs: number): ParsedState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(value) || value.version !== STATE_VERSION) return { kind: "corrupt" };

  const issuedAtMs = value.issuedAtMs;
  if (!isPositiveFinite(issuedAtMs)) return { kind: "corrupt" };

  const lastAttemptAtMs = value.lastAttemptAtMs;
  const blockedUntilMs = value.blockedUntilMs;
  const failureCount = value.failureCount;
  if (lastAttemptAtMs !== undefined && !isPositiveFinite(lastAttemptAtMs))
    return { kind: "corrupt" };
  if (blockedUntilMs !== undefined && !isPositiveFinite(blockedUntilMs)) return { kind: "corrupt" };
  if (failureCount !== undefined && !isNonNegativeInteger(failureCount)) return { kind: "corrupt" };

  // Clock rollback: never trust the future timestamps for scheduling, but do
  // honor a recorded deadline for a bounded time. The caller repairs the record.
  if (issuedAtMs > nowMs || (lastAttemptAtMs !== undefined && lastAttemptAtMs > nowMs)) {
    const recordedDeadlineLengthMs =
      blockedUntilMs !== undefined ? Math.max(0, blockedUntilMs - issuedAtMs) : 0;
    return {
      kind: "rollback",
      blockedForMs: Math.min(recordedDeadlineLengthMs, ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS),
      failureCount: failureCount !== undefined ? Math.min(failureCount, MAX_BACKOFF_EXPONENT) : 0,
    };
  }

  return {
    kind: "ok",
    state: {
      version: STATE_VERSION,
      issuedAtMs,
      ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
      ...(blockedUntilMs !== undefined
        ? // A far-future deadline from a corrupt or hostile file must not block
          // forever; a server Retry-After is honored up to the 24-hour safety limit.
          {
            blockedUntilMs: Math.min(blockedUntilMs, nowMs + ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS),
          }
        : {}),
      ...(failureCount !== undefined
        ? { failureCount: Math.min(failureCount, MAX_BACKOFF_EXPONENT) }
        : {}),
    },
  };
}

async function readState(
  statePath: string,
  nowMs: number,
): Promise<{ state: ParsedState; unreadable: boolean }> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { state: undefined, unreadable: false };
    return { state: undefined, unreadable: true };
  }
  return { state: parseState(raw, nowMs), unreadable: false };
}

async function writeState(statePath: string, state: AnthropicOAuthThrottleState): Promise<void> {
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireClaimLock(
  statePath: string,
  liveOwnerMaxAgeMs: number,
): Promise<(() => Promise<void>) | undefined> {
  try {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    // A busy lock means another process is already attempting or publishing.
    // Skipping (instead of waiting) is the cross-process contract.
    return await acquireStateFileLock(statePath, { timeoutMs: 0, liveOwnerMaxAgeMs });
  } catch {
    return undefined;
  }
}

/**
 * Claim the next Anthropic usage request. The returned claim holds the
 * cross-process lock until `complete` publishes the outcome; every skip path
 * releases it before returning.
 */
export async function claimAnthropicOAuthUsageRequest(params: {
  nowMs: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Test seam: bound for reclaiming a live owner whose PID may have been reused. */
  liveOwnerMaxAgeMs?: number;
  statePath?: string;
}): Promise<AnthropicOAuthThrottleClaim> {
  const { nowMs } = params;
  const pollIntervalMs = normalizeAnthropicOAuthPollIntervalMs(params.pollIntervalMs);
  const statePath = params.statePath ?? getAnthropicOAuthThrottleStatePath();
  const liveOwnerMaxAgeMs =
    params.liveOwnerMaxAgeMs ??
    2 * (params.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) + pollIntervalMs;

  // A pending deadline is retried under the lock rather than skipped here.
  if (nowMs < failClosedUntilMs && pendingPublish?.statePath !== statePath) {
    return { state: "skip", reason: "unavailable", retryAtMs: failClosedUntilMs };
  }

  const release = await acquireClaimLock(statePath, liveOwnerMaxAgeMs);
  if (!release) return { state: "skip", reason: "busy" };

  const skipAndRelease = async (
    skip: Extract<AnthropicOAuthThrottleClaim, { state: "skip" }>,
  ): Promise<AnthropicOAuthThrottleClaim> => {
    await release().catch(() => undefined);
    return skip;
  };

  try {
    if (pendingPublish?.statePath === statePath) {
      const pending = pendingPublish;
      try {
        // A previous completion could not publish its deadline; write it before
        // any new decision so another process cannot act on stale timing.
        await writeState(statePath, pending.state);
        pendingPublish = undefined;
        failClosedUntilMs = 0;
      } catch {
        const retryAtMs = Math.max(pending.state.blockedUntilMs ?? 0, nowMs + pollIntervalMs);
        failClosedUntilMs = Math.max(failClosedUntilMs, retryAtMs);
        return await skipAndRelease({
          state: "skip",
          reason: "unavailable",
          retryAtMs,
        });
      }
    }

    if (nowMs < failClosedUntilMs) {
      return await skipAndRelease({
        state: "skip",
        reason: "unavailable",
        retryAtMs: failClosedUntilMs,
      });
    }

    const read = await readState(statePath, nowMs);
    if (read.unreadable || read.state?.kind === "corrupt") {
      // Fail closed until one interval from now, and repair the record so the
      // next interval can attempt instead of blocking forever.
      failClosedUntilMs = Math.max(failClosedUntilMs, nowMs + pollIntervalMs);
      await writeState(statePath, {
        version: STATE_VERSION,
        issuedAtMs: nowMs,
        lastAttemptAtMs: nowMs,
      }).catch(() => undefined);
      return await skipAndRelease({
        state: "skip",
        reason: "unavailable",
        retryAtMs: nowMs + pollIntervalMs,
      });
    }

    if (read.state?.kind === "rollback") {
      const delayMs = read.state.blockedForMs;
      if (delayMs > 0) {
        // The clock moved backward, but a recorded cooldown length is still
        // honored for at most our own five-minute backoff cap. Then the record
        // is rewritten with a sane clock so the next interval can proceed.
        const repaired: AnthropicOAuthThrottleState = {
          version: STATE_VERSION,
          issuedAtMs: nowMs,
          blockedUntilMs: nowMs + delayMs,
          failureCount: read.state.failureCount,
        };
        try {
          await writeState(statePath, repaired);
        } catch {
          pendingPublish = { statePath, state: repaired };
        }
        failClosedUntilMs = Math.max(failClosedUntilMs, nowMs + delayMs);
        return await skipAndRelease({
          state: "skip",
          reason: "cooldown",
          retryAtMs: nowMs + delayMs,
        });
      }
      // No recorded deadline: the claim below re-establishes the clock.
    }

    const state = read.state?.kind === "ok" ? read.state.state : undefined;

    if (state?.blockedUntilMs !== undefined && state.blockedUntilMs > nowMs) {
      // Spacing still applies after the server deadline, and the caller shows
      // the next real attempt.
      const spacingUntilMs =
        state.lastAttemptAtMs !== undefined ? state.lastAttemptAtMs + pollIntervalMs : 0;
      return await skipAndRelease({
        state: "skip",
        reason: "cooldown",
        retryAtMs: Math.ceil(Math.max(state.blockedUntilMs, spacingUntilMs)),
      });
    }

    if (state?.lastAttemptAtMs !== undefined && state.lastAttemptAtMs + pollIntervalMs > nowMs) {
      return await skipAndRelease({
        state: "skip",
        reason: "spacing",
        retryAtMs: Math.ceil(state.lastAttemptAtMs + pollIntervalMs),
      });
    }

    const claimedAtMs = nowMs;
    const failureCount = state?.failureCount ?? 0;
    // A provisional deadline is published before the HTTP attempt. If this
    // process dies mid-request, another process waits at least our own first
    // backoff step instead of seeing only the request spacing.
    await writeState(statePath, {
      version: STATE_VERSION,
      issuedAtMs: nowMs,
      lastAttemptAtMs: claimedAtMs,
      blockedUntilMs: claimedAtMs + ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS,
      failureCount,
    });

    let completed = false;
    let completionResult: AnthropicOAuthAttemptCompletionResult = { failureCount };
    const complete = async (
      outcome: AnthropicOAuthAttemptCompletion,
    ): Promise<AnthropicOAuthAttemptCompletionResult> => {
      // The 429 deadline is published before the body read; a later completion
      // call returns the same deadline instead of overwriting it.
      if (completed) return completionResult;
      completed = true;
      const outcomeNowMs = outcome.kind === "rate-limited" ? outcome.nowMs : Date.now();
      try {
        const fresh = await readState(statePath, outcomeNowMs);
        const base = fresh.unreadable || fresh.state?.kind !== "ok" ? undefined : fresh.state.state;
        const baseLastAttemptAtMs = Math.max(base?.lastAttemptAtMs ?? 0, claimedAtMs);
        const baseFailureCount = base?.failureCount ?? failureCount;
        const result: AnthropicOAuthAttemptCompletionResult =
          outcome.kind === "rate-limited"
            ? {
                blockedUntilMs: Math.ceil(
                  outcomeNowMs +
                    getAnthropicOAuthRateLimitDurationMs(baseFailureCount, outcome.retryAfterMs),
                ),
                failureCount: Math.min(baseFailureCount + 1, MAX_BACKOFF_EXPONENT),
              }
            : outcome.kind === "success" || outcome.kind === "response"
              ? { failureCount: 0 }
              : { failureCount: baseFailureCount };

        const nextState: AnthropicOAuthThrottleState = {
          version: STATE_VERSION,
          issuedAtMs: outcomeNowMs,
          lastAttemptAtMs: baseLastAttemptAtMs,
          ...(result.blockedUntilMs !== undefined ? { blockedUntilMs: result.blockedUntilMs } : {}),
          failureCount: result.failureCount,
        };
        try {
          await writeState(statePath, nextState);
        } catch {
          // Keep the known deadline in-process and retry the shared write on the
          // next claim; the provisional record already blocks other processes.
          pendingPublish = { statePath, state: nextState };
          failClosedUntilMs = Math.max(
            failClosedUntilMs,
            nextState.blockedUntilMs ?? outcomeNowMs + pollIntervalMs,
          );
        }
        completionResult = result;
      } catch {
        // A read failure must not discard a proven 429 deadline either.
        if (outcome.kind === "rate-limited") {
          const blockedUntilMs = Math.ceil(
            outcomeNowMs + getAnthropicOAuthRateLimitDurationMs(failureCount, outcome.retryAfterMs),
          );
          const nextFailureCount = Math.min(failureCount + 1, MAX_BACKOFF_EXPONENT);
          const nextState: AnthropicOAuthThrottleState = {
            version: STATE_VERSION,
            issuedAtMs: outcomeNowMs,
            lastAttemptAtMs: claimedAtMs,
            blockedUntilMs,
            failureCount: nextFailureCount,
          };
          pendingPublish = { statePath, state: nextState };
          failClosedUntilMs = Math.max(failClosedUntilMs, blockedUntilMs);
          completionResult = {
            blockedUntilMs,
            failureCount: nextFailureCount,
          };
        }
      } finally {
        await release().catch(() => undefined);
      }
      return completionResult;
    };

    return { state: "claimed", claimedAtMs, failureCount, complete };
  } catch {
    return await skipAndRelease({
      state: "skip",
      reason: "unavailable",
      retryAtMs: nowMs + pollIntervalMs,
    });
  }
}
