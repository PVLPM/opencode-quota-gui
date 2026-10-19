/**
 * Deterministic fork-copy ownership (R50).
 *
 * OpenCode copies a parent's finished messages into each fork with new ids but
 * identical times, model, tokens, and cost. The upstream fingerprint groups
 * those copies. This primitive chooses, deterministically and independent of
 * read order, which physical rows still count:
 *
 * - group candidates by fingerprint;
 * - per session sort occurrences by `createdAtMs`, then `messageID`, then
 *   `sessionID`;
 * - for occurrence index `0..maxCount-1` select the earliest candidate across
 *   sessions, so a fingerprint repeated `k` times in one session contributes
 *   `k` owned rows;
 * - candidates without a fingerprint (upstream unfinished rows) are always
 *   owned.
 *
 * The selected entries preserve the caller's input order: upstream dedup keeps
 * its SQL order, and GUI callers sort with their own step comparator.
 *
 * Scoping rule: ownership is only correct over the coverage-complete candidate
 * set. A reader that returns a window/session subset must either use the same
 * global owner set as the other surfaces or keep the full set's owned ids;
 * running this primitive on a partial subset can pick a different winner.
 */

export interface ForkOwnerCandidate<T> {
  item: T;
  sessionID: string;
  /**
   * Fingerprint shared by fork copies. Absent/`undefined` means the entry is
   * always owned (upstream unfinished-row legacy behavior).
   */
  fingerprint?: string;
  /** Session message creation time used for ownership; absent sorts last. */
  createdAtMs?: number;
  /** Stable message id; tie-break after creation time. */
  messageID: string;
}

interface Occurrence<T> {
  candidate: ForkOwnerCandidate<T>;
  index: number;
}

function finiteOrMax(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareOccurrence<T>(a: Occurrence<T>, b: Occurrence<T>): number {
  const byCreated = finiteOrMax(a.candidate.createdAtMs) - finiteOrMax(b.candidate.createdAtMs);
  if (byCreated !== 0) return byCreated;
  const byMessage = compareStrings(a.candidate.messageID, b.candidate.messageID);
  if (byMessage !== 0) return byMessage;
  return compareStrings(a.candidate.sessionID, b.candidate.sessionID);
}

/**
 * Select the owned candidates, preserving input order. The result is
 * independent of input order as a set; output order is the caller's order
 * filtered to the owners.
 */
export function selectForkOwnerCandidates<T>(
  candidates: readonly ForkOwnerCandidate<T>[],
): ForkOwnerCandidate<T>[] {
  const selected = new Set<number>();
  const byFingerprint = new Map<string, Map<string, Occurrence<T>[]>>();

  candidates.forEach((candidate, index) => {
    if (candidate.fingerprint === undefined) {
      selected.add(index);
      return;
    }
    let bySession = byFingerprint.get(candidate.fingerprint);
    if (!bySession) {
      bySession = new Map();
      byFingerprint.set(candidate.fingerprint, bySession);
    }
    let occurrences = bySession.get(candidate.sessionID);
    if (!occurrences) {
      occurrences = [];
      bySession.set(candidate.sessionID, occurrences);
    }
    occurrences.push({ candidate, index });
  });

  for (const bySession of byFingerprint.values()) {
    const occurrenceLists = [...bySession.values()];
    for (const occurrences of occurrenceLists) occurrences.sort(compareOccurrence);
    let maxCount = 0;
    for (const occurrences of occurrenceLists) {
      if (occurrences.length > maxCount) maxCount = occurrences.length;
    }
    for (let index = 0; index < maxCount; index += 1) {
      let winner: Occurrence<T> | undefined;
      for (const occurrences of occurrenceLists) {
        const candidate = occurrences[index];
        if (!candidate) continue;
        if (!winner || compareOccurrence(candidate, winner) < 0) winner = candidate;
      }
      if (winner) selected.add(winner.index);
    }
  }

  return candidates.filter((_, index) => selected.has(index));
}

/** The owned items, in input order. */
export function selectForkOwners<T>(candidates: readonly ForkOwnerCandidate<T>[]): T[] {
  return selectForkOwnerCandidates(candidates).map((candidate) => candidate.item);
}
