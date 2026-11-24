import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ failWrites: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const shouldFail = (path: unknown) =>
    storage.failWrites && String(path).includes("anthropic-oauth-throttle");
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (shouldFail(args[0])) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return await actual.writeFile(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (shouldFail(args[1])) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return await actual.rename(...args);
    }),
  };
});

const throttle = await import("../src/lib/anthropic-oauth-throttle.js");

let stateDir = "";

beforeEach(async () => {
  storage.failWrites = false;
  stateDir = await mkdtemp(join(tmpdir(), "ocq-throttle-storage-"));
});

afterEach(async () => {
  storage.failWrites = false;
  await rm(stateDir, { recursive: true, force: true });
});

function statePath(): string {
  return join(stateDir, "anthropic-oauth-throttle.json");
}

describe("Anthropic OAuth throttle storage failure", () => {
  it("fails closed, keeps the deadline in-process, and retries the write on the next claim", async () => {
    const now = Date.now();
    const first = await throttle.claimAnthropicOAuthUsageRequest({
      nowMs: now,
      statePath: statePath(),
    });
    if (first.state !== "claimed") throw new Error("expected a claim");

    // The attempted deadline cannot be published.
    storage.failWrites = true;
    const completion = await first.complete({
      kind: "rate-limited",
      retryAfterMs: 300_000,
      nowMs: now,
    });
    expect(completion).toEqual({ blockedUntilMs: now + 300_000, failureCount: 1 });

    // Only the provisional deadline reached the shared record. That still
    // blocks another process for at least our own first backoff step.
    const onDisk = JSON.parse(await readFile(statePath(), "utf8")) as Record<string, unknown>;
    expect(onDisk.blockedUntilMs).toBe(now + 60_000);

    vi.resetModules();
    const secondProcess = await import("../src/lib/anthropic-oauth-throttle.js");
    const second = await secondProcess.claimAnthropicOAuthUsageRequest({
      nowMs: now + 30_000,
      statePath: statePath(),
    });
    expect(second).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(second.state === "skip" ? second.retryAtMs : undefined).toBe(now + 180_000);

    // This process still fails closed while the shared write keeps failing.
    const stillFailing = await throttle.claimAnthropicOAuthUsageRequest({
      nowMs: now + 30_001,
      statePath: statePath(),
    });
    expect(stillFailing).toMatchObject({ state: "skip", reason: "unavailable" });
    expect(stillFailing.state === "skip" ? stillFailing.retryAtMs : undefined).toBe(now + 300_000);

    // With storage healthy again, the next claim publishes the true server
    // deadline before deciding anything else.
    storage.failWrites = false;
    const retried = await throttle.claimAnthropicOAuthUsageRequest({
      nowMs: now + 30_002,
      statePath: statePath(),
    });
    expect(retried).toMatchObject({ state: "skip", reason: "cooldown" });
    expect(retried.state === "skip" ? retried.retryAtMs : undefined).toBe(now + 300_000);

    const shared = JSON.parse(await readFile(statePath(), "utf8")) as Record<string, unknown>;
    expect(shared.blockedUntilMs).toBe(now + 300_000);

    const afterFlush = await secondProcess.claimAnthropicOAuthUsageRequest({
      nowMs: now + 30_003,
      statePath: statePath(),
    });
    expect(afterFlush.state).toBe("skip");
    expect(afterFlush.state === "skip" ? afterFlush.retryAtMs : undefined).toBe(now + 300_000);
  });
});
