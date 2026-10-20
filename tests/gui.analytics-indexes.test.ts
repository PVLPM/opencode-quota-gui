import { describe, expect, it } from "vitest";
import { createAnalyticsIndexes } from "../src/gui/analytics-indexes.js";
import type { Occurrence } from "../src/gui/analytics-state.js";
import type { OpenCodeSessionInfo } from "../src/lib/opencode-storage.js";

function occurrence(messageID: string, sessionID: string, fingerprintIndex: number): Occurrence {
  return { messageID, sessionID, fingerprintIndex, updatedAtMs: null };
}

function session(id: string, overrides: Partial<OpenCodeSessionInfo> = {}): OpenCodeSessionInfo {
  return { id, ...overrides };
}

function sessionMap(...values: OpenCodeSessionInfo[]): Record<string, OpenCodeSessionInfo> {
  const map: Record<string, OpenCodeSessionInfo> = {};
  for (const value of values) map[value.id] = value;
  return map;
}

describe("createAnalyticsIndexes", () => {
  it("indexes by session and fingerprint and removes memberships cleanly", () => {
    const indexes = createAnalyticsIndexes();
    indexes.rebuild(
      [occurrence("m2", "s1", 1), occurrence("m1", "s1", 0), occurrence("m3", "s2", 0)],
      sessionMap(session("s1"), session("s2")),
    );

    expect([...indexes.sessionMessages(["s1"])]).toEqual(["m1", "m2"]);
    expect([...indexes.sessionMessages(["s2", "s1"])]).toEqual(["m1", "m2", "m3"]);
    expect([...indexes.fingerprintMessages([0])]).toEqual(["m1", "m3"]);
    expect([...indexes.fingerprintMessages([1, 0])]).toEqual(["m1", "m2", "m3"]);

    indexes.remove("m2");
    expect([...indexes.sessionMessages(["s1"])]).toEqual(["m1"]);
    expect([...indexes.fingerprintMessages([1])]).toEqual([]);

    // Removing an unknown or already-removed id is a no-op.
    indexes.remove("m2");
    indexes.remove("missing");
    expect([...indexes.sessionMessages(["s1"])]).toEqual(["m1"]);

    indexes.upsert(occurrence("m4", "s2", 1));
    expect([...indexes.sessionMessages(["s2"])]).toEqual(["m3", "m4"]);
    expect([...indexes.fingerprintMessages([1])]).toEqual(["m4"]);
  });

  it("moves a message when its session or fingerprint changes", () => {
    const indexes = createAnalyticsIndexes();
    indexes.rebuild([occurrence("m1", "s1", 0)], sessionMap(session("s1"), session("s2")));

    indexes.upsert(occurrence("m1", "s2", 3));
    expect([...indexes.sessionMessages(["s1"])]).toEqual([]);
    expect([...indexes.sessionMessages(["s2"])]).toEqual(["m1"]);
    expect([...indexes.fingerprintMessages([0])]).toEqual([]);
    expect([...indexes.fingerprintMessages([3])]).toEqual(["m1"]);

    // Idempotent re-upsert keeps exactly one membership.
    indexes.upsert(occurrence("m1", "s2", 3));
    expect([...indexes.sessionMessages(["s2"])]).toEqual(["m1"]);
    expect([...indexes.fingerprintMessages([3])]).toEqual(["m1"]);
  });

  it("rebuilds parent and project membership when session metadata changes", () => {
    const indexes = createAnalyticsIndexes();
    indexes.setSessions(
      sessionMap(
        session("root"),
        session("a", { parentID: "root", projectID: "p1" }),
        session("b", { parentID: "root", projectID: "p2" }),
        session("c", { projectID: "  p1  " }),
        session("d"),
      ),
    );

    expect(indexes.projectSessions("p1")).toEqual(["a", "c"]);
    expect(indexes.projectSessions("p2")).toEqual(["b"]);
    expect(indexes.projectSessions("unknown")).toEqual(["d", "root"]);
    expect(indexes.treeIds("root")).toEqual(["root", "a", "b"]);

    indexes.setSessions(
      sessionMap(
        session("root"),
        session("a", { parentID: "other", projectID: "p2" }),
        session("b", { parentID: "root", projectID: "p2" }),
        session("c", { projectID: "p1" }),
        session("d", { projectID: "p1" }),
      ),
    );

    expect(indexes.projectSessions("p1")).toEqual(["c", "d"]);
    expect(indexes.projectSessions("p2")).toEqual(["a", "b"]);
    expect(indexes.projectSessions("unknown")).toEqual(["root"]);
    expect(indexes.treeIds("root")).toEqual(["root", "b"]);
    expect(indexes.treeIds("other")).toEqual(["other", "a"]);

    // Sessions removed from the metadata record disappear from both indexes.
    indexes.setSessions({});
    expect(indexes.projectSessions("p1")).toEqual([]);
    expect(indexes.projectSessions("unknown")).toEqual([]);
    expect(indexes.treeIds("root")).toEqual(["root"]);
  });

  it("returns deterministic, cycle-safe pre-order tree ids", () => {
    const indexes = createAnalyticsIndexes();
    indexes.setSessions(
      sessionMap(
        session("root"),
        session("b", { parentID: "root" }),
        session("c", { parentID: "root" }),
        session("a", { parentID: "root" }),
        session("a2", { parentID: "a" }),
        session("a1", { parentID: "a" }),
        session("a1x", { parentID: "a1" }),
        session("cycle1", { parentID: "cycle2" }),
        session("cycle2", { parentID: "cycle1" }),
      ),
    );

    expect(indexes.treeIds("root")).toEqual(["root", "a", "a1", "a1x", "a2", "b", "c"]);
    expect(indexes.treeIds("cycle1")).toEqual(["cycle1", "cycle2"]);
    expect(indexes.treeIds("missing")).toEqual(["missing"]);

    const deep: OpenCodeSessionInfo[] = [session("n0")];
    for (let index = 1; index < 500; index += 1) {
      deep.push(session(`n${index}`, { parentID: `n${index - 1}` }));
    }
    indexes.setSessions(sessionMap(...deep));
    const ids = indexes.treeIds("n0");
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("n0");
    expect(ids.at(-1)).toBe("n499");
    expect(new Set(ids).size).toBe(500);
  });

  it("rebuild clears stale state and matches incremental updates", () => {
    const indexes = createAnalyticsIndexes();
    indexes.setSessions(
      sessionMap(session("s1", { projectID: "p1" }), session("s2", { projectID: "p2" })),
    );
    indexes.upsert(occurrence("m1", "s1", 0));
    indexes.upsert(occurrence("m2", "s2", 1));
    indexes.remove("m1");
    indexes.upsert(occurrence("m3", "s1", 2));
    indexes.setSessions(sessionMap(session("s1", { projectID: "p2" })));

    indexes.rebuild([occurrence("m3", "s1", 2)], sessionMap(session("s1", { projectID: "p2" })));

    expect([...indexes.sessionMessages(["s1", "s2"])]).toEqual(["m3"]);
    expect([...indexes.fingerprintMessages([0, 1, 2])]).toEqual(["m3"]);
    expect(indexes.projectSessions("p1")).toEqual([]);
    expect(indexes.projectSessions("p2")).toEqual(["s1"]);
    expect(indexes.treeIds("s1")).toEqual(["s1"]);
  });

  it("accepts arbitrary iterables for occurrences and lookups", () => {
    const indexes = createAnalyticsIndexes();

    function* occurrences(): Generator<Occurrence> {
      yield occurrence("m2", "s2", 1);
      yield occurrence("m1", "s1", 0);
    }
    indexes.rebuild(occurrences(), sessionMap(session("s1"), session("s2")));

    function* sessionsToRead(): Generator<string> {
      yield "s2";
      yield "s1";
    }
    function* fingerprintsToRead(): Generator<number> {
      yield 1;
      yield 0;
    }

    expect([...indexes.sessionMessages(sessionsToRead())]).toEqual(["m1", "m2"]);
    expect([...indexes.fingerprintMessages(fingerprintsToRead())]).toEqual(["m1", "m2"]);
  });

  it("keeps answering from its buckets after the sessions input is emptied", () => {
    const sessions = sessionMap(
      session("root"),
      session("child", { parentID: "root", projectID: "p1" }),
    );
    const indexes = createAnalyticsIndexes();
    indexes.rebuild([occurrence("m1", "child", 0)], sessions);

    for (const id of Object.keys(sessions)) delete sessions[id];

    expect([...indexes.sessionMessages(["child"])]).toEqual(["m1"]);
    expect([...indexes.fingerprintMessages([0])]).toEqual(["m1"]);
    expect(indexes.projectSessions("p1")).toEqual(["child"]);
    expect(indexes.treeIds("root")).toEqual(["root", "child"]);
  });

  it("requires an explicit rebuild after fingerprint indices are remapped", () => {
    const indexes = createAnalyticsIndexes();
    indexes.rebuild(
      [occurrence("m1", "s1", 0), occurrence("m2", "s1", 1)],
      sessionMap(session("s1")),
    );

    // A compaction remap (1 -> 0) is positional, so the old bucket is stale.
    expect([...indexes.fingerprintMessages([1])]).toEqual(["m2"]);

    indexes.rebuild(
      [occurrence("m1", "s1", 0), occurrence("m2", "s1", 0)],
      sessionMap(session("s1")),
    );
    expect([...indexes.fingerprintMessages([0])]).toEqual(["m1", "m2"]);
    expect([...indexes.fingerprintMessages([1])]).toEqual([]);
  });
});
