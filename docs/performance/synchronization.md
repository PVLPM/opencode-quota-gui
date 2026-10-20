# Analytics source synchronization

This note records the delta-phase synchronization policy for the GUI analytics
worker. It is deliberately narrower than a content-addressed source-generation
claim.

## Cursor and overlap

- The trusted source cursor is the maximum observed `session_message.time_updated`
  value, capped at the wall clock (`atMs`) so future timestamps cannot push it
  ahead. It is persisted separately from `frontierAtMs` (wall freshness).
- A missing cursor always triggers a full source baseline. It is never inferred
  from the wall frontier or from cached occurrence timestamps.
- A normal global refresh reads revisions with an **inclusive**
  `time_updated >= cursor - 5 minutes` bound. Rows are replayed in deterministic
  `(updated_at, message_id)` order, so equal timestamps and lexically earlier
  late commits are not skipped.
- Only a successful global refresh consumes or advances the cursor. Scoped
  project/session refreshes never advance it and never certify global freshness.
- Rows with NULL/non-numeric timestamps are always included in the delta and
  their payload is fetched conservatively on each refresh, because the source
  cannot prove they are unchanged.
- The five-minute overlap bounds ordinary clock skew and late/equal timestamp
  commits. Changes older than that (including backdated timestamps) are bounded
  by the repair policy below, not guaranteed immediately.

## First baseline

- A truly empty in-memory index establishes the cursor with `MAX(time_updated)`
  and reads exactly the requested extent payload in the same read transaction.
  This is safe because there is no stored contribution whose membership,
  deletion, or ownership must be reconciled.
- A legacy/non-empty snapshot without a cursor instead performs one full
  revision projection plus an indexed-extent payload repair. Existing
  contributions must be reconciled against full membership, and the cursor must
  be established from source rows rather than guessed from cached state.

## Deletions, backdated edits, and repair

The installed source has no deletion tombstones and no index on
`time_updated`. Deletions, same-completion edits, and edits that keep the same
timestamp cannot always be detected by a timestamp delta.

- Full reconciliation uses a persisted seven-day cadence
  (`lastFullRepairAtMs` in the snapshot), not a per-restart scan. A two-day
  restart resumes with the delta unless repair is already due or a fallback
  below applies.
- The repair re-reads the indexed completion extent plus cached scoped data,
  then applies full revision membership. This catches unchanged/backdated
  payload edits and deletions.
- A wall-clock rollback behind the cursor, or a schema that cannot filter
  revisions by `time_updated`, falls back to a conservative full projection.
- A scoped project/session read remains authoritative for its own scope and
  performs its own removal/replacement reads.

## Presentation DTO sidecar

- The small presentation sidecar may hold Home, Project, and session DTOs.
  Session entries are an LRU-ordered `[sessionId, SessionSnapshot]` list capped
  to the newest eight in memory; absent legacy data means an empty list. The
  serialized sidecar may retain fewer because of the disk byte budget below.
  That budget is a disk-side cap, not a heap bound on cached DTO objects, and
  the compact index never duplicates these DTOs.
- A session entry is trusted only when its id matches the snapshot's
  `focusSessionId` and the snapshot collections are arrays. Present but
  malformed or duplicate session data rejects the sidecar; absent legacy
  session data means an empty list.
- Saving captures the sidecar candidate before its first await. For the standard
  `<snapshot>.presentation.json` path it stats the compact snapshot and budgets
  the whole sidecar at `min(4 MiB, compact snapshot bytes)`, evicting
  LRU-oldest sessions until it fits. Home/Project are preserved even if they
  alone exceed the budget, so session DTOs cannot add growth beyond the compact
  snapshot size.
- If the matching compact snapshot is absent/unreadable, or the sidecar path is
  nonstandard, sessions are omitted rather than serializing the compact state
  again.
- The sidecar records its save time, last-refresh frontier, and coverage. A
  same-source sidecar older than the compact index is not reattached; a newer
  index wins. A newer sidecar may still serve its DTOs, but wall-time alone is
  not checkpoint proof: the loaded compact index remains authoritative for
  occurrences, cursor, extent, and freshness, and missing ranges or details
  catch up/backfill rather than deriving from a possibly failed snapshot. A
  cached serve is cleared when an identity-only transaction sees a definite
  source replacement. If that lightweight check is unavailable, the last good
  DTO is served marked stale. A sidecar written while the compact checkpoint is
  dirty omits coverage/frontier, so restart treats it as uncertified while still
  serving its cached DTOs.
- A cached session DTO may be served before the compact index loads. The hit
  moves to the newest LRU position and schedules a scoped catch-up; data changes
  still invalidate the cache and notify the host, so a warm response cannot stay
  wrong indefinitely. A compaction-only scoped refresh also invalidates the
  affected cached session DTOs and emits a generation notification, because
  markers do not change usage rows and must not be mistaken for a no-op.
- Finite Home/Project cache entries are tied to their rolling calculation
  window. When the loaded model can re-derive them, a window advance re-derives
  the DTO instead of refreshing only `generatedAt`/`stale` over aged-out rows.
- Saving a cached DTO does not rewrite the compact index. The compact index is
  written only when its data, cursor, repair time, source identity, or older
  coverage bound changes; wall-freshness and until-bound-only changes stay in
  the small sidecar. A failed or blocked compact write stays dirty for its
  revision and is retried on a later no-change refresh or close. Close drains
  the serialized writer and flushes the latest useful DTOs within the existing
  bound.
- The default 7d response may schedule one deferred, unref'd 30d extension
  after that response is ready. The zero-delay timer yields one event-loop turn;
  it is not an OS scheduling priority and cannot preempt a synchronous SQLite
  read. It is canceled on close, never scheduled at construction, and never
  extends to lifetime automatically. Once 30d is covered, bounded Home caches
  may be derived together without duplicate model hydration.

## Source limitations

- The source is opened read-only. This phase adds no journal, SQLite index,
  schema migration, or source write.
- Because `time_updated` is not indexed in installed OpenCode, the delta query
  still scans SQLite pages. It avoids projecting JSON completion results for
  rows outside the returned delta, but it does not turn the scan into an index
  seek.
- Fork ownership discovery for scoped history uses a targeted completed-time
  candidate read. It is not proven complete by one existing occurrence; unseen
  same-fingerprint multiplicity and lexically earlier owners are intentionally
  queried.
- A stable file identity/schema token identifies a replacement source. The
  transaction is rejected as `unreadable` if the path's stable identity changes
  between the pre-open stat, transaction open, or commit. Content generation is
  not otherwise cryptographically verified, and platforms without a stable file
  key degrade to the existing unknown-comparison policy.
- Warm presentation sidecars are not a measured baseline in this phase. Sidecar
  performance belongs to the later persistence work and is not claimed here.
