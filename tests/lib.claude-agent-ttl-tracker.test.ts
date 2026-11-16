import { describe, expect, it, vi } from "vitest";
import { projectOpenCodeCacheObserverEvent } from "../src/lib/cache-observer-ingestion.js";
import type { ClaudeObservedTtlResult } from "../src/lib/claude-agent-transcript-ttl.js";
import { createClaudeAgentTtlTracker } from "../src/lib/claude-agent-ttl-tracker.js";

const SES = "ses_1";
const STEP = "msg_1";
const NSID = "123e4567-e89b-42d3-a456-426614174000";

const started = (provider = "claude-agent", step = STEP, session = SES) => ({
  type: "session.step.started",
  created: 1_050,
  data: {
    sessionID: session,
    assistantMessageID: step,
    agent: "build",
    model: { providerID: provider, id: "m" },
    started: 1_000,
  },
});
const native = (messageID: string, type = "session.text.ended", step = STEP, session = SES) => ({
  type,
  created: 1_060,
  data: {
    sessionID: session,
    assistantMessageID: step,
    text: "SYNTHETIC",
    native: { sessionID: NSID, messageID },
  },
});
const ended = (over: { finish?: string; tokens?: unknown; step?: string } = {}) => ({
  type: "session.step.ended",
  created: 1_100,
  data: {
    sessionID: SES,
    assistantMessageID: over.step ?? STEP,
    finish: over.finish ?? "stop",
    cost: 0,
    tokens: over.tokens ?? { input: 3, cache: { read: 100, write: 50 } },
  },
});
const other = (session = SES) => ({
  type: "session.status",
  created: 1_200,
  data: { sessionID: session, status: { type: "idle" } },
});

function harness(results: ClaudeObservedTtlResult[] = ["1h"]) {
  const queue = [...results];
  const read = vi.fn(async (_q: unknown) => queue.shift() ?? "unchanged");
  const emit = vi.fn();
  const tracker = createClaudeAgentTtlTracker({ directory: "C:\\Synthetic\\repo", read, emit });
  const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { read, emit, feed, flush, tracker };
}

describe("claude-agent TTL tracker", () => {
  it("reads once after a successful claude-agent step and emits only the minimal DTO", async () => {
    const h = harness();
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(ended());
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read.mock.calls[0]?.[0]).toEqual({
      directory: "C:\\Synthetic\\repo",
      nativeSessionId: NSID,
      nativeMessageId: "uuid-1",
      tokens: { input: 3, read: 100, write: 50 },
    });
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(
      {
        type: "session.cache.ttl",
        created: 1_100,
        data: { sessionID: SES, assistantMessageID: STEP, ttlMs: 3_600_000 },
      },
      1_100,
    );
  });

  it("uses the last native message id seen from text or tool events", async () => {
    const h = harness();
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(native("uuid-2", "session.tool.called"));
    h.feed(ended());
    await h.flush();
    expect(h.read.mock.calls[0]?.[0]).toMatchObject({ nativeMessageId: "uuid-2" });
  });

  it.each([
    ["a non-claude route", started("anthropic"), true, ended()],
    ["no native ids", started(), false, ended()],
    ["a failed step", started(), true, ended({ finish: "error" })],
    ["incomplete tokens", started(), true, ended({ tokens: { input: 3 } })],
  ])("does not read for %s", async (_name, start, withNative, end) => {
    const h = harness();
    h.feed(start);
    if (withNative) h.feed(native("uuid-1"));
    h.feed(end);
    await h.flush();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("ignores native ids that belong to another assistant message or session", async () => {
    const h = harness();
    h.feed(started());
    h.feed(native("uuid-x", "session.text.ended", "msg_other"));
    h.feed(ended());
    await h.flush();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("emits nothing when the reader leaves the estimate unchanged", async () => {
    const h = harness(["unchanged"]);
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(ended());
    await h.flush();
    h.feed(other());
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("retries at most once, on the next event of the same session", async () => {
    const h = harness(["retry", "retry", "1h"]);
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(ended());
    await h.flush();
    h.feed(other("ses_unrelated"));
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    h.feed(other());
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.feed(other());
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("emits when the single retry succeeds", async () => {
    const h = harness(["retry", "1h"]);
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(ended());
    await h.flush();
    h.feed(other());
    await h.flush();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("drops a pending retry and a late result when a newer invocation started", async () => {
    const h = harness(["retry", "1h"]);
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed(ended());
    await h.flush();
    h.feed(started("claude-agent", "msg_2"));
    h.feed(other());
    await h.flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("does not emit a result that resolves after a newer invocation started", async () => {
    let release: (value: ClaudeObservedTtlResult) => void = () => undefined;
    const emit = vi.fn();
    const tracker = createClaudeAgentTtlTracker({
      directory: "d",
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      emit,
    });
    const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
    feed(started());
    feed(native("uuid-1"));
    feed(ended());
    feed(started("claude-agent", "msg_2"));
    release("1h");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  describe("retry ordering", () => {
    function deferred() {
      const resolvers: Array<(value: ClaudeObservedTtlResult) => void> = [];
      const read = vi.fn(
        () => new Promise<ClaudeObservedTtlResult>((resolve) => resolvers.push(resolve)),
      );
      const emit = vi.fn();
      const tracker = createClaudeAgentTtlTracker({ directory: "d", read, emit });
      const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      feed(started());
      feed(native("uuid-1"));
      feed(ended());
      return { read, emit, feed, tick, resolvers, tracker };
    }

    it("runs exactly one second read when idle arrives before the first read finishes", async () => {
      const h = deferred();
      h.feed(other());
      h.feed(other());
      await h.tick();
      expect(h.read).toHaveBeenCalledTimes(1);
      h.resolvers[0]?.("retry");
      await h.tick();
      expect(h.read).toHaveBeenCalledTimes(2);
      h.resolvers[1]?.("retry");
      await h.tick();
      h.feed(other());
      await h.tick();
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.emit).not.toHaveBeenCalled();
    });

    it("emits when the second read, requested while the first was in flight, succeeds", async () => {
      const h = deferred();
      h.feed(other());
      h.resolvers[0]?.("retry");
      await h.tick();
      h.resolvers[1]?.("1h");
      await h.tick();
      expect(h.emit).toHaveBeenCalledTimes(1);
    });

    it("does not run a second read when the first finishes with unchanged or 1h", async () => {
      const h = deferred();
      h.feed(other());
      h.resolvers[0]?.("unchanged");
      await h.tick();
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.emit).not.toHaveBeenCalled();
    });

    it("a newer step drops a second read requested during the first", async () => {
      const h = deferred();
      h.feed(other());
      h.feed(started("claude-agent", "msg_2"));
      h.resolvers[0]?.("retry");
      await h.tick();
      expect(h.read).toHaveBeenCalledTimes(1);
      expect(h.emit).not.toHaveBeenCalled();
    });

    it("discards a late second result after a newer step started", async () => {
      const h = deferred();
      h.feed(other());
      h.resolvers[0]?.("retry");
      await h.tick();
      h.feed(started("claude-agent", "msg_2"));
      h.resolvers[1]?.("1h");
      await h.tick();
      expect(h.emit).not.toHaveBeenCalled();
    });
  });

  it("bounds the newest-step map and forgets deleted sessions", async () => {
    const h = harness(["1h"]);
    for (let i = 0; i < 300; i += 1) h.feed(started("claude-agent", `m${i}`, `s${i}`));
    // The oldest session was evicted, so its late end is not recognised as the newest step.
    h.feed({ ...ended({ step: "m0" }), data: { ...ended({ step: "m0" }).data, sessionID: "s0" } });
    await h.flush();
    expect(h.read).not.toHaveBeenCalled();
    h.feed(started());
    h.feed(native("uuid-1"));
    h.feed({ type: "session.deleted", created: 1_300, data: { sessionID: SES } });
    h.feed(ended());
    await h.flush();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("discards a late read of a session evicted from the newest-step cap, and still emits for a retained one", async () => {
    const resolvers: Array<(value: ClaudeObservedTtlResult) => void> = [];
    const read = vi.fn(
      () => new Promise<ClaudeObservedTtlResult>((resolve) => resolvers.push(resolve)),
    );
    const emit = vi.fn();
    const tracker = createClaudeAgentTtlTracker({ directory: "d", read, emit });
    const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const finish = (session: string, step: string) => ({
      ...ended({ step }),
      data: { ...ended({ step }).data, sessionID: session },
    });

    feed(started("claude-agent", "m0", "s0"));
    feed(native("u0", "session.text.ended", "m0", "s0"));
    feed(finish("s0", "m0"));
    // 256 further sessions make 257 tracked sessions: s0 is the evicted oldest.
    for (let i = 1; i <= 256; i += 1) feed(started("claude-agent", `m${i}`, `s${i}`));

    resolvers[0]?.("1h");
    await tick();
    expect(emit).not.toHaveBeenCalled();

    feed(native("u256", "session.text.ended", "m256", "s256"));
    feed(finish("s256", "m256"));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    resolvers[1]?.("1h");
    await tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      {
        type: "session.cache.ttl",
        created: 1_100,
        data: { sessionID: "s256", assistantMessageID: "m256", ttlMs: 3_600_000 },
      },
      1_100,
    );
  });

  it("survives a throwing emit on both read paths and keeps working for later steps", async () => {
    const emit = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("emit boom");
      })
      .mockImplementationOnce(() => {
        throw new Error("emit boom 2");
      });
    const results: ClaudeObservedTtlResult[] = ["1h", "retry", "1h", "1h"];
    const tracker = createClaudeAgentTtlTracker({
      directory: "d",
      read: async () => results.shift() ?? "unchanged",
      emit,
    });
    const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    feed(started());
    feed(native("uuid-1"));
    feed(ended());
    await tick();
    // Second step: first read says retry, the next session event runs the throwing retry path.
    feed(started("claude-agent", "msg_2"));
    feed(native("uuid-2", "session.text.ended", "msg_2"));
    feed(ended({ step: "msg_2" }));
    await tick();
    feed(other());
    await tick();
    // A third step still emits normally.
    feed(started("claude-agent", "msg_3"));
    feed(native("uuid-3", "session.text.ended", "msg_3"));
    feed(ended({ step: "msg_3" }));
    await tick();
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("swallows reader failures", async () => {
    const emit = vi.fn();
    const tracker = createClaudeAgentTtlTracker({
      directory: "d",
      read: async () => {
        throw new Error("boom");
      },
      emit,
    });
    const feed = (raw: unknown) => tracker.observe(raw, projectOpenCodeCacheObserverEvent(raw));
    feed(started());
    feed(native("uuid-1"));
    feed(ended());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emit).not.toHaveBeenCalled();
  });
});
