import { describe, expect, it } from "vitest";

import {
  forkCopyFingerprint,
  type OpenCodeRawAssistantRow,
  rawAssistantRowFingerprint,
} from "../src/lib/opencode-storage.js";
import {
  type ForkOwnerCandidate,
  selectForkOwnerCandidates,
  selectForkOwners,
} from "../src/lib/usage-ownership.js";

function candidate<T>(
  item: T,
  sessionID: string,
  messageID: string,
  opts: { fingerprint?: string; createdAtMs?: number } = {},
): ForkOwnerCandidate<T> {
  const entry: ForkOwnerCandidate<T> = { item, sessionID, messageID };
  if (opts.fingerprint !== undefined) entry.fingerprint = opts.fingerprint;
  if (opts.createdAtMs !== undefined) entry.createdAtMs = opts.createdAtMs;
  return entry;
}

describe("deterministic fork ownership", () => {
  it("derives the raw-row fingerprint from the upstream message formula", () => {
    const row: OpenCodeRawAssistantRow = {
      sessionID: "ses_a",
      messageID: "msg_a",
      createdAtMs: 100,
      completedAtMs: 150,
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      cost: 6,
      providerID: "openai",
      modelID: "gpt-5",
    };

    const messageFingerprint = forkCopyFingerprint(
      {
        id: row.messageID,
        sessionID: row.sessionID,
        role: "assistant",
        providerID: row.providerID,
        modelID: row.modelID,
        tokens: {
          input: row.tokens.input,
          output: row.tokens.output,
          reasoning: row.tokens.reasoning,
          cache: { read: row.tokens.cacheRead, write: row.tokens.cacheWrite },
        },
        cost: row.cost,
        time: { created: row.createdAtMs, completed: row.completedAtMs },
      },
      row.completedAtMs,
    );

    expect(rawAssistantRowFingerprint(row)).toBe(messageFingerprint);
  });
  it("preserves a fingerprint repeated k times in one session as k owned rows", () => {
    const candidates = [
      candidate("a1", "ses_a", "msg_a1", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("a2", "ses_a", "msg_a2", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("b1", "ses_b", "msg_b1", { fingerprint: "fp", createdAtMs: 10 }),
    ];

    const owned = selectForkOwnerCandidates(candidates);

    expect(owned.map((entry) => entry.item)).toEqual(["a1", "a2"]);
  });

  it("selects the earliest candidate by created time, then message id, then session id", () => {
    const byCreated = selectForkOwners([
      candidate("late", "ses_a", "msg_a", { fingerprint: "fp", createdAtMs: 20 }),
      candidate("early", "ses_b", "msg_b", { fingerprint: "fp", createdAtMs: 10 }),
    ]);
    expect(byCreated).toEqual(["early"]);

    const byMessageId = selectForkOwners([
      candidate("z", "ses_a", "msg_z", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("a", "ses_b", "msg_a", { fingerprint: "fp", createdAtMs: 10 }),
    ]);
    expect(byMessageId).toEqual(["a"]);

    const bySessionId = selectForkOwners([
      candidate("b", "ses_b", "msg_x", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("a", "ses_a", "msg_x", { fingerprint: "fp", createdAtMs: 10 }),
    ]);
    expect(bySessionId).toEqual(["a"]);
  });

  it("never doubles a cross-session fork copy and keeps max multiplicity", () => {
    const candidates = [
      candidate("parent1", "ses_parent", "msg_a1", { fingerprint: "fp1", createdAtMs: 10 }),
      candidate("parent2", "ses_parent", "msg_a2", { fingerprint: "fp1", createdAtMs: 20 }),
      candidate("fork1", "ses_fork", "msg_z1", { fingerprint: "fp1", createdAtMs: 10 }),
      candidate("fork2", "ses_fork", "msg_z2", { fingerprint: "fp1", createdAtMs: 20 }),
      candidate("fork3", "ses_fork", "msg_z3", { fingerprint: "fp1", createdAtMs: 30 }),
    ];

    const owned = selectForkOwners(candidates);

    // ses_fork holds the maximum multiplicity (3), so three rows survive:
    // index 0 -> parent1 (created tie, msg_a1 < msg_z1), index 1 -> parent2,
    // index 2 -> fork3 (only candidate).
    expect(owned).toEqual(["parent1", "parent2", "fork3"]);
  });

  it("always owns candidates without a fingerprint, preserving upstream unfinished behavior", () => {
    const candidates = [
      candidate("unfinished_a", "ses_a", "msg_u_a", { createdAtMs: 10 }),
      candidate("finished", "ses_a", "msg_f", { fingerprint: "fp", createdAtMs: 20 }),
      candidate("unfinished_b", "ses_b", "msg_u_b", { createdAtMs: 10 }),
    ];

    const owned = selectForkOwners(candidates);

    expect(owned).toEqual(["unfinished_a", "finished", "unfinished_b"]);
  });

  it("is independent of input order", () => {
    const forward = [
      candidate("parent1", "ses_parent", "msg_p1", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("parent2", "ses_parent", "msg_p2", { fingerprint: "fp", createdAtMs: 20 }),
      candidate("fork1", "ses_fork", "msg_f1", { fingerprint: "fp", createdAtMs: 10 }),
      candidate("fork2", "ses_fork", "msg_f2", { fingerprint: "fp", createdAtMs: 20 }),
    ];
    const reversed = [...forward].reverse();

    const forwardOwned = selectForkOwners(forward).slice().sort();
    const reversedOwned = selectForkOwners(reversed).slice().sort();

    expect(reversedOwned).toEqual(forwardOwned);
    // Ties on created time go to the smaller message id, regardless of read order.
    expect(reversedOwned).toEqual(["fork1", "fork2"]);
  });

  it("returns selected candidates in input order", () => {
    const candidates = [
      candidate("second", "ses_b", "msg_b", { fingerprint: "fp", createdAtMs: 20 }),
      candidate("first", "ses_a", "msg_a", { fingerprint: "fp", createdAtMs: 10 }),
    ];

    expect(selectForkOwnerCandidates(candidates).map((entry) => entry.item)).toEqual(["first"]);
  });
});
