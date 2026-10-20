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
