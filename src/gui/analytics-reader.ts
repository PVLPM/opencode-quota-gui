/**
 * Storage adapter for the analytics worker.
 *
 * Every read composes the shared core `withOpenCodeStorageSnapshot` seam: one
 * read-only connection, one read transaction, and one identity captured for all
 * metadata/membership/payload reads. The engine stages its entire candidate
 * generation inside that callback, so no before/after stat heuristic is needed.
 */
import {
  type OpenCodeStorageSnapshot,
  type OpenCodeStorageSnapshotResult,
  withOpenCodeStorageSnapshot,
} from "../lib/opencode-storage.js";

export interface AnalyticsReader {
  withSnapshot<T>(
    read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
  ): Promise<OpenCodeStorageSnapshotResult<T>>;
}

export function createAnalyticsReader(): AnalyticsReader {
  return {
    withSnapshot: (read) => withOpenCodeStorageSnapshot(read),
  };
}
