/**
 * Reverse indexes over analytics occurrences and session metadata.
 *
 * `AnalyticsState.occurrences` stays the single source of occurrence rows; this
 * helper keeps only minimal membership refs (message -> session/fingerprint),
 * never copies of the rows. `messageID` is treated as globally unique, matching
 * OpenCode message ids.
 *
 * Fingerprint buckets are keyed by the positional `Occurrence.fingerprintIndex`.
 * After a fingerprint compaction remaps those positions, call
 * `rebuild(occurrences, sessions)` before relying on `fingerprintMessages`.
 */
import type { OpenCodeSessionInfo } from "../lib/opencode-storage.js";
import { UNKNOWN_PROJECT_ID } from "./aggregation.js";
import type { Occurrence } from "./analytics-state.js";

export interface AnalyticsIndexes {
  /** Clears every index and rebuilds from a full occurrence/session snapshot. */
  rebuild(occurrences: Iterable<Occurrence>, sessions: Record<string, OpenCodeSessionInfo>): void;
  /** Adds an occurrence or moves it from its previous session/fingerprint. */
  upsert(occurrence: Occurrence): void;
  /** Removes the occurrence's session/fingerprint memberships. */
  remove(messageID: string): void;
  /** Replaces parent/project membership from new session metadata. */
  setSessions(sessions: Record<string, OpenCodeSessionInfo>): void;
  /** Sorted message ids across the requested sessions. */
  sessionMessages(sessionIDs: Iterable<string>): Iterable<string>;
  /** Sorted message ids across the requested fingerprint indices. */
  fingerprintMessages(fingerprintIndexes: Iterable<number>): Iterable<string>;
  /** Deterministic pre-order subtree, matching the engine's tree walk. */
  treeIds(focusId: string): string[];
  /** Sorted session ids whose `projectID` resolves to `projectId`. */
  projectSessions(projectId: string): string[];
}

interface MessageMembership {
  sessionID: string;
  fingerprintIndex: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function projectIdOf(session: OpenCodeSessionInfo): string {
  const value = session.projectID?.trim();
  return value ? value : UNKNOWN_PROJECT_ID;
}

function addToBucket<K>(buckets: Map<K, Set<string>>, key: K, id: string): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = new Set<string>();
    buckets.set(key, bucket);
  }
  bucket.add(id);
}

function removeFromBucket<K>(buckets: Map<K, Set<string>>, key: K, id: string): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  bucket.delete(id);
  if (bucket.size === 0) buckets.delete(key);
}

export function createAnalyticsIndexes(): AnalyticsIndexes {
  const messagesBySession = new Map<string, Set<string>>();
  const messagesByFingerprint = new Map<number, Set<string>>();
  /** Memberships only; occurrence rows remain authoritative in analytics state. */
  const memberships = new Map<string, MessageMembership>();
  const sessionsByParent = new Map<string, Set<string>>();
  const sessionsByProject = new Map<string, Set<string>>();

  function setSessions(sessions: Record<string, OpenCodeSessionInfo>): void {
    sessionsByParent.clear();
    sessionsByProject.clear();
    for (const session of Object.values(sessions)) {
      if (session.parentID) addToBucket(sessionsByParent, session.parentID, session.id);
      addToBucket(sessionsByProject, projectIdOf(session), session.id);
    }
  }

  function upsert(occurrence: Occurrence): void {
    const previous = memberships.get(occurrence.messageID);
    if (previous) {
      if (previous.sessionID !== occurrence.sessionID) {
        removeFromBucket(messagesBySession, previous.sessionID, occurrence.messageID);
      }
      if (previous.fingerprintIndex !== occurrence.fingerprintIndex) {
        removeFromBucket(messagesByFingerprint, previous.fingerprintIndex, occurrence.messageID);
      }
    }
    memberships.set(occurrence.messageID, {
      sessionID: occurrence.sessionID,
      fingerprintIndex: occurrence.fingerprintIndex,
    });
    addToBucket(messagesBySession, occurrence.sessionID, occurrence.messageID);
    addToBucket(messagesByFingerprint, occurrence.fingerprintIndex, occurrence.messageID);
  }

  function remove(messageID: string): void {
    const previous = memberships.get(messageID);
    if (!previous) return;
    removeFromBucket(messagesBySession, previous.sessionID, messageID);
    removeFromBucket(messagesByFingerprint, previous.fingerprintIndex, messageID);
    memberships.delete(messageID);
  }

  function sessionMessages(sessionIDs: Iterable<string>): Iterable<string> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const sessionID of sessionIDs) {
      const bucket = messagesBySession.get(sessionID);
      if (!bucket) continue;
      for (const messageID of bucket) {
        if (seen.has(messageID)) continue;
        seen.add(messageID);
        ids.push(messageID);
      }
    }
    return ids.sort(compareIds);
  }

  function fingerprintMessages(fingerprintIndexes: Iterable<number>): Iterable<string> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const fingerprintIndex of fingerprintIndexes) {
      const bucket = messagesByFingerprint.get(fingerprintIndex);
      if (!bucket) continue;
      for (const messageID of bucket) {
        if (seen.has(messageID)) continue;
        seen.add(messageID);
        ids.push(messageID);
      }
    }
    return ids.sort(compareIds);
  }

  function treeIds(focusId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const pending = [focusId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      const children = sessionsByParent.get(id);
      if (!children) continue;
      const ordered = [...children].sort(compareIds);
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const child = ordered[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return ids;
  }

  function projectSessions(projectId: string): string[] {
    const bucket = sessionsByProject.get(projectId);
    return bucket ? [...bucket].sort(compareIds) : [];
  }

  return {
    rebuild(occurrences, sessions) {
      memberships.clear();
      messagesBySession.clear();
      messagesByFingerprint.clear();
      setSessions(sessions);
      for (const occurrence of occurrences) upsert(occurrence);
    },
    upsert,
    remove,
    setSessions,
    sessionMessages,
    fingerprintMessages,
    treeIds,
    projectSessions,
  };
}
