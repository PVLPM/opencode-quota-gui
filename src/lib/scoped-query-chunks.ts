/** One session/message id scope shared by all scoped readers. */
export interface StorageIdScope {
  sessionID?: string;
  sessionIDs?: string[];
  messageIDs?: string[];
}

// Stay comfortably below SQLite's default host-parameter cap once optional
// time filters are included in the query.
export const SCOPED_QUERY_ARG_BUDGET = 900;

export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Chunk one scope into queries under a bind-argument budget. `messageIDs` and
 * session ids combine with AND semantics; when both lists are present they are
 * chunked together so every emitted query stays within the budget.
 */
export function scopedIdQueries<T>(
  ids: StorageIdScope,
  budget: number,
  build: (clause: StorageIdScope) => T,
): T[] {
  const queries: T[] = [];
  const { sessionID, sessionIDs, messageIDs } = ids;

  if (messageIDs === undefined) {
    if (sessionID !== undefined) return [build({ sessionID })];
    if (sessionIDs !== undefined) {
      for (const chunk of chunkArray(sessionIDs, budget)) {
        queries.push(build({ sessionIDs: chunk }));
      }
    }
    return queries;
  }

  if (sessionID !== undefined) {
    for (const chunk of chunkArray(messageIDs, Math.max(1, budget - 1))) {
      queries.push(build({ sessionID, messageIDs: chunk }));
    }
    return queries;
  }

  if (sessionIDs === undefined) {
    for (const chunk of chunkArray(messageIDs, budget)) queries.push(build({ messageIDs: chunk }));
    return queries;
  }

  for (const messageChunk of chunkArray(messageIDs, Math.max(1, budget - 1))) {
    const remaining = Math.max(1, budget - messageChunk.length);
    for (const sessionChunk of chunkArray(sessionIDs, remaining)) {
      queries.push(build({ sessionIDs: sessionChunk, messageIDs: messageChunk }));
    }
  }
  return queries;
}
