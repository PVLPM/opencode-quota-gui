import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_OAUTH_DEFAULT_POLL_INTERVAL_MS,
  ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS,
  ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
  ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS,
  claimAnthropicOAuthUsageRequest,
  getAnthropicOAuthRateLimitDurationMs,
  resetAnthropicOAuthThrottleMemoryForTests,
} from "../src/lib/anthropic-oauth-throttle.js";

const ONE_HOUR_MS = 60 * 60_000;

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "orient-throttle-test-"));
  resetAnthropicOAuthThrottleMemoryForTests();
});

afterEach(async () => {
  resetAnthropicOAuthThrottleMemoryForTests();
  await rm(stateDir, { recursive: true, force: true });
});

function statePath(): string {
  return join(stateDir, "anthropic-oauth-throttle.json");
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath(), "utf8")) as Record<string, unknown>;
}

describe("Anthropic OAuth backoff duration", () => {
  it("honors a server Retry-After in full beyond five minutes", () => {
    expect(getAnthropicOAuthRateLimitDurationMs(0, 10 * 60_000)).toBe(10 * 60_000);
    expect(getAnthropicOAuthRateLimitDurationMs(0, ONE_HOUR_MS)).toBe(ONE_HOUR_MS);
    expect(getAnthropicOAuthRateLimitDurationMs(0, ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS)).toBe(
      ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS,
    );
  });

  it("caps only our own backoff at five minutes", () => {
    expect(getAnthropicOAuthRateLimitDurationMs(0, undefined)).toBe(
      ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS,
    );
    expect(getAnthropicOAuthRateLimitDurationMs(1, undefined)).toBe(120_000);
    expect(getAnthropicOAuthRateLimitDurationMs(2, undefined)).toBe(240_000);
    expect(getAnthropicOAuthRateLimitDurationMs(3, undefined)).toBe(
      ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
    );
    expect(getAnthropicOAuthRateLimitDurationMs(20, undefined)).toBe(
      ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
    );
  });

  it.each([
    undefined,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("falls back to our own backoff for unusable Retry-After %s", (retryAfterMs) => {
    expect(getAnthropicOAuthRateLimitDurationMs(0, retryAfterMs)).toBe(60_000);
    expect(getAnthropicOAuthRateLimitDurationMs(2, retryAfterMs)).toBe(240_000);
  });

  it("treats a Retry-After above the one-day safety limit as malformed", () => {
    expect(getAnthropicOAuthRateLimitDurationMs(0, ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS + 1)).toBe(
      ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS,
    );
    expect(getAnthropicOAuthRateLimitDurationMs(4, ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS + 1)).toBe(
      ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
    );
  });
});

describe("Anthropic OAuth shared throttle state", () => {
  it("lets only one process claim the request at a time", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    expect(first.state).toBe("claimed");
    if (first.state !== "claimed") throw new Error("expected a claim");

    const second = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 1,
      statePath: statePath(),
    });
    expect(second).toMatchObject({ state: "skip", reason: "busy" });

    await first.complete({ kind: "success" });
    const third = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 1_000,
      statePath: statePath(),
    });
    expect(third).toMatchObject({ state: "skip", reason: "spacing" });
    expect(third.state === "skip" ? third.retryAtMs : undefined).toBe(now + 180_000);
  });

  it("persists a 429 cooldown and failure count across a module restart", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    if (first.state !== "claimed") throw new Error("expected a claim");
    const completion = await first.complete({
      kind: "rate-limited",
      retryAfterMs: 90_000,
      nowMs: now,
    });
    expect(completion).toEqual({ blockedUntilMs: now + 90_000, failureCount: 1 });

    // A fresh module instance has no in-memory timing state; the file is the
    // only source of truth, exactly like a restarted OpenCode process.
    vi.resetModules();
    const fresh = await import("../src/lib/anthropic-oauth-throttle.js");
    const paused = await fresh.claimAnthropicOAuthUsageRequest({
      nowMs: now + 1_000,
      statePath: statePath(),
    });
    expect(paused).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(paused.state === "skip" ? paused.retryAtMs : undefined).toBe(now + 180_000);

    const afterSpacing = await fresh.claimAnthropicOAuthUsageRequest({
      nowMs: now + 180_001,
      statePath: statePath(),
    });
    expect(afterSpacing.state).toBe("claimed");
  });

  it("treats Retry-After zero as our own one-minute backoff", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    if (first.state !== "claimed") throw new Error("expected a claim");
    await first.complete({ kind: "rate-limited", retryAfterMs: 0, nowMs: now });
    const state = await readState();
    expect(state.blockedUntilMs).toBe(now + 60_000);
    expect(state.failureCount).toBe(1);
  });

  it("fails closed for one interval when the shared record is corrupt, then repairs it", async () => {
    const now = Date.now();
    await writeFile(statePath(), "{not-json", "utf8");
    const blocked = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    expect(blocked).toMatchObject({ state: "skip", reason: "unavailable" });
    expect(blocked.state === "skip" ? blocked.retryAtMs : undefined).toBe(now + 180_000);

    // The repaired record still blocks this process until the interval ends.
    const stillBlocked = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 1_000,
      statePath: statePath(),
    });
    expect(stillBlocked).toMatchObject({ state: "skip", reason: "unavailable" });

    const recovered = await claimAnthropicOAuthUsageRequest({
      nowMs: now + ANTHROPIC_OAUTH_DEFAULT_POLL_INTERVAL_MS + 1,
      statePath: statePath(),
    });
    expect(recovered.state).toBe("claimed");
    const state = await readState();
    expect(state.version).toBe(1);
    expect(typeof state.issuedAtMs).toBe("number");
  });

  it("treats a record written by a clock ahead as a bounded cooldown, then repairs it", async () => {
    const now = Date.now();
    await writeFile(
      statePath(),
      JSON.stringify({
        version: 1,
        issuedAtMs: now + 10_000,
        lastAttemptAtMs: now + 10_000,
        blockedUntilMs: now + 20_000,
        failureCount: 2,
      }),
      "utf8",
    );
    const blocked = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    expect(blocked).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(blocked.state === "skip" ? blocked.retryAtMs : undefined).toBe(now + 10_000);

    // The record is repaired with this clock and keeps the recorded deadline
    // length, so a clock step cannot erase the live cooldown.
    const repaired = await readState();
    expect(repaired.issuedAtMs).toBe(now);
    expect(repaired.blockedUntilMs).toBe(now + 10_000);
    expect(repaired.lastAttemptAtMs).toBeUndefined();
    expect(repaired.failureCount).toBe(2);

    const stillBlocked = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 9_999,
      statePath: statePath(),
    });
    expect(stillBlocked.state).toBe("skip");
    expect(stillBlocked.state === "skip" ? stillBlocked.retryAtMs : undefined).toBe(now + 10_000);

    const allowed = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 10_000,
      statePath: statePath(),
    });
    expect(allowed.state).toBe("claimed");
  });

  it("caps a rollback deadline at our own five-minute backoff", async () => {
    const now = Date.now();
    await writeFile(
      statePath(),
      JSON.stringify({
        version: 1,
        issuedAtMs: now + 20 * 60_000,
        blockedUntilMs: now + 30 * 60_000,
      }),
      "utf8",
    );
    const blocked = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    expect(blocked).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(blocked.state === "skip" ? blocked.retryAtMs : undefined).toBe(
      now + ANTHROPIC_OAUTH_RATE_LIMIT_MAX_MS,
    );
  });

  it("keeps a provisional cooldown when the claiming process dies mid-request", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    expect(first.state).toBe("claimed");
    const state = await readState();
    expect(state.blockedUntilMs).toBe(now + ANTHROPIC_OAUTH_RATE_LIMIT_BASE_MS);

    // The claimant never publishes: simulate its death by dropping only the lock.
    await rm(`${statePath()}.lock`, { recursive: true, force: true });
    const blocked = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 1,
      statePath: statePath(),
    });
    expect(blocked).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(blocked.state === "skip" ? blocked.retryAtMs : undefined).toBe(now + 180_000);
  });

  it("writes timing only, never a token or account identity", async () => {
    const now = Date.now();
    const claim = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    if (claim.state !== "claimed") throw new Error("expected a claim");
    await claim.complete({ kind: "success" });
    const raw = await readFile(statePath(), "utf8");
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      "failureCount",
      "issuedAtMs",
      "lastAttemptAtMs",
      "version",
    ]);
    expect(raw).not.toMatch(/token|email|account|identity/iu);
  });

  it("uses the configured spacing, with a one-minute lower bound", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({
      nowMs: now,
      pollIntervalMs: 1_000,
      statePath: statePath(),
    });
    if (first.state !== "claimed") throw new Error("expected a claim");
    await first.complete({ kind: "response" });

    const tooSoon = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 59_999,
      pollIntervalMs: 1_000,
      statePath: statePath(),
    });
    expect(tooSoon).toMatchObject({ state: "skip", reason: "spacing" });
    expect(tooSoon.state === "skip" ? tooSoon.retryAtMs : undefined).toBe(now + 60_000);

    const allowed = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 60_000,
      pollIntervalMs: 1_000,
      statePath: statePath(),
    });
    expect(allowed.state).toBe("claimed");
  });

  it("clears the 429 cooldown and failure count on a successful attempt", async () => {
    const now = Date.now();
    const first = await claimAnthropicOAuthUsageRequest({ nowMs: now, statePath: statePath() });
    if (first.state !== "claimed") throw new Error("expected a claim");
    await first.complete({ kind: "rate-limited", retryAfterMs: 60_000, nowMs: now });

    const retry = await claimAnthropicOAuthUsageRequest({
      nowMs: now + 180_001,
      statePath: statePath(),
    });
    if (retry.state !== "claimed") throw new Error("expected the cooldown to expire");
    await retry.complete({ kind: "success" });
    const state = await readState();
    expect(state.blockedUntilMs).toBeUndefined();
    expect(state.failureCount).toBe(0);
  });
});
