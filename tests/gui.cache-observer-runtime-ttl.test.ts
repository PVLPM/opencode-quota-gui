import { describe, expect, it, vi } from "vitest";

import { projectOpenCodeCacheObserverEvent } from "../src/lib/cache-observer-ingestion.js";
import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";

const steps = (sessionID: string) =>
  [
    {
      type: "session.step.started",
      created: 1_010,
      data: {
        sessionID,
        assistantMessageID: "msg_1",
        model: { providerID: "claude-agent", id: "claude-test" },
        started: 1_000,
      },
    },
    {
      type: "session.step.ended",
      created: 1_100,
      data: {
        sessionID,
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 3, cache: { read: 100, write: 50 } },
      },
    },
  ].map((event) => projectOpenCodeCacheObserverEvent(event) as never);
const ttl = (sessionID: string) =>
  ({
    type: "session.cache.ttl",
    created: 1_200,
    data: { sessionID, assistantMessageID: "msg_1", ttlMs: 3_600_000 },
  }) as never;

describe("native cache observer runtime: observed TTL refinement", () => {
  it("forwards session.cache.ttl only for sessions the runtime is interested in", () => {
    let receive: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receive = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      now: () => 2_000,
    });
    const release = runtime.subscribe("ses_watched", () => {});
    for (const event of [...steps("ses_watched"), ...steps("ses_unwatched")]) receive?.(event);
    receive?.(ttl("ses_watched"));
    receive?.(ttl("ses_unwatched"));

    expect(runtime.query("ses_watched")?.ttlEstimate).toMatchObject({
      kind: "observed",
      ttlMs: 3_600_000,
    });
    const releaseOther = runtime.subscribe("ses_unwatched", () => {});
    expect(runtime.query("ses_unwatched")).toBeUndefined();
    releaseOther();
    release();
    runtime.dispose();
  });

  it("forwards session.cache.ttl for a direct child of a watched session, not for an unrelated session", async () => {
    let receive: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receive = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async (parentID) =>
        parentID === "ses_parent" ? [{ id: "ses_child", parentID, title: "Worker" }] : [],
      now: () => 2_000,
    });
    const snapshots: string[][] = [];
    const releaseChildren = runtime.subscribeChildren("ses_parent", (snapshot) => {
      snapshots.push(snapshot.children.map((child) => child.sessionId));
    });
    await vi.waitFor(() => expect(snapshots.at(-1)).toEqual(["ses_child"]));

    for (const event of [...steps("ses_child"), ...steps("ses_unrelated")]) receive?.(event);
    receive?.(ttl("ses_child"));
    receive?.(ttl("ses_unrelated"));

    expect(runtime.query("ses_child")?.ttlEstimate).toMatchObject({
      kind: "observed",
      ttlMs: 3_600_000,
    });
    expect(runtime.query("ses_unrelated")).toBeUndefined();
    releaseChildren();
    runtime.dispose();
  });
});
