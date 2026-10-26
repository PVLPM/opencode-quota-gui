import { describe, expect, it } from "vitest";

import { type StorageIdScope, scopedIdQueries } from "../src/lib/scoped-query-chunks.js";

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
}

function clauseWidth(clause: StorageIdScope): number {
  return (
    (clause.sessionID === undefined ? 0 : 1) +
    (clause.sessionIDs?.length ?? 0) +
    (clause.messageIDs?.length ?? 0)
  );
}

describe("scopedIdQueries", () => {
  it("splits an id list only when it exceeds the budget", () => {
    const build = (clause: StorageIdScope) => clause.messageIDs ?? [];

    expect(scopedIdQueries({ messageIDs: ids("msg", 5) }, 4, build)).toEqual([
      ["msg_0", "msg_1", "msg_2", "msg_3"],
      ["msg_4"],
    ]);
    expect(scopedIdQueries({ messageIDs: ids("msg", 4) }, 4, build)).toHaveLength(1);
    expect(scopedIdQueries({ messageIDs: ids("msg", 5) }, 4, build)).toHaveLength(2);
  });

  it("charges a single session id against the message chunk", () => {
    const clauses = scopedIdQueries(
      { sessionID: "ses_a", messageIDs: ids("msg", 5) },
      4,
      (clause) => clause,
    );

    expect(clauses.map((clause) => clause.messageIDs?.length)).toEqual([3, 2]);
    expect(clauses.every((clause) => clause.sessionID === "ses_a")).toBe(true);
    for (const clause of clauses) expect(clauseWidth(clause)).toBeLessThanOrEqual(4);
  });

  it("splits combined session and message scopes with AND semantics under the budget", () => {
    const clauses = scopedIdQueries(
      { sessionIDs: ids("ses", 3), messageIDs: ids("msg", 5) },
      4,
      (clause) => clause,
    );

    // Message chunks take `budget - 1` ids; sessions fill the remaining args.
    expect(clauses.map((clause) => clause.messageIDs?.length)).toEqual([3, 3, 3, 2, 2]);
    expect(clauses.map((clause) => clause.sessionIDs?.length)).toEqual([1, 1, 1, 2, 1]);
    for (const clause of clauses) expect(clauseWidth(clause)).toBeLessThanOrEqual(4);
  });
});
