# Analytics storage

The Analytics worker keeps its whole model in memory. What it persists is a
checkpoint of that model (the compact index) and a bounded cache of ready
DTOs (the warm presentation), so a restart can serve quickly and catch up
incrementally instead of re-reading the OpenCode database.

Both are **derived data**. Losing them costs a rebuild from the OpenCode
database, never history. Usage history (`usage-history.sqlite`) is the only
irreplaceable store here and is never opened, rebuilt or removed by the
Analytics store.

## Layout

`<state>/opencode-quota-gui/analytics.sqlite`, beside the legacy
`analytics-v3.json`. WAL journal, `synchronous=NORMAL`, a 3 s busy timeout and
an 8 MiB journal size limit.

| Table | Contents |
| --- | --- |
| `analytics_meta` | `schema_version`, `store.epoch`, `store.revision`, the index fields (`index.version`, `index.complete`, `index.savedAt`, `index.frontierAt`, `index.sourceCursorAt`, `index.lastFullRepairAt`, `index.sourceSignature`, `index.futureCompletionAt`, `index.sourceIdentity`, `index.extent`) and `presentation.header` |
| `analytics_str` | Append-only dictionary for session, provider, model and variant strings |
| `analytics_occurrence` | One row per occurrence: `ord` (in-memory Map order), unique `message_id`, the fingerprint columns, `updated_at`, variant |
| `analytics_session`, `analytics_project` | Index metadata rows |
| `analytics_presentation` | One row per warm DTO slot (`home:<range>`, `project:<id>\0<range>`, `session:<id>`) with a content hash |

Fingerprints are not stored separately. Loading re-interns each occurrence with
`fingerprintOf`, exactly as the engine's runtime `internFingerprint` does, so
fork-copy ownership and every derived view match the JSON path. (The JSON
decoder keys its index without the cache-missing bits; occurrences still point
at the right tuples, so this only affects which key a later lookup finds.)

## Writes

- The engine records changed, removed and replaced occurrences in a persist
  delta. The store takes the delta inside `BEGIN IMMEDIATE` and restores it if
  the transaction rolls back, so a failed write is retried in full by the next
  checkpoint. Everything from the delta take to `COMMIT` is synchronous: rows
  and cursor/coverage fields always describe one in-memory state.
- An incremental write upserts changed rows in place (keeping `ord`),
  deletes removed rows and re-inserts a removed-then-re-added row at the end,
  matching `Map` order. Sessions and projects are upserted only when changed.
- The write becomes a whole-index rewrite when the delta is a replacement, the
  stored index is incomplete or of another version, or the `(epoch, revision)`
  this process last loaded or wrote no longer matches. The fence means two
  processes never interleave their rows: the last writer wins with a complete
  index.
- Presentation slots are rewritten only when their hash changed. Session DTOs
  are evicted oldest-first to keep the serialized presentation under 4 MiB.
  The JSON sidecar additionally capped itself at the compact snapshot size; the
  SQLite store keeps only the 4 MiB cap.
- `cache_spill` is off on the store connection. Random `message_id` index
  updates overflow SQLite's default page cache in a large write, and every
  spill rewrites pages into the WAL. On a 1M-row synthetic index that turned a
  ~150 MB write into ~2.8 GB. Dirty pages are now held until `COMMIT`, so a
  write's transient memory is bounded by the pages it changes. That is
  comparable to the JSON baseline, which serialized the whole index into one
  string.
- Write scheduling is unchanged: a no-change refresh does not checkpoint the
  index, exactly as before. (The JSON baseline sometimes captured a newer
  frontier because an earlier, slower write was still in flight; that was
  latency, not a contract.)

## Loads

- One read transaction covers the whole load, so a concurrent writer can never
  mix two revisions into one in-memory index.
- The load hands the worker's event loop back after each 50 ms of work. A
  warm cached Home or Project response that arrives meanwhile is served
  instead of waiting for the full scan. (The JSON baseline got a similar
  window from its asynchronous file read before its synchronous parse.) The
  slice is time-based because each event-loop turn has a fixed cost in Bun on
  a large heap. Yielding every 4,096 rows made a 253K-row load about 60%
  slower; 50 ms slices cost about 8%.
- Store operations run one at a time on one connection, in call order. A
  write queued during a load waits for the load's read transaction to end. A
  `close()` during an operation takes effect when that operation returns.

## Migration from analytics-v3.json

- On the first load without a SQLite index, a valid `analytics-v3.json` is
  decoded with the existing JSON decoder and written as a whole index with its
  original `savedAt`; a valid sidecar is imported into the presentation slots.
- The row count is verified. Only after a committed, verified SQLite index do
  the legacy file, its sidecar and their orphaned temp files get removed. An
  unreadable or older-version legacy file stays until a SQLite index commits
  from a source rebuild.
- Migration is idempotent and resumable: an interrupted migration leaves the
  legacy files in place and repeats on the next start.

## Recovery, concurrency and versions

- A corrupt database (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) is replaced, never
  repaired: the store removes only `analytics.sqlite` and its `-wal`, `-shm`
  and `-journal` files, then rebuilds from source.
- A database whose `schema_version` is newer than this build is never written,
  migrated or rebuilt; the engine runs from source in memory instead, so two
  installed versions cannot destroy each other's cache.
- An older or missing schema is dropped and recreated (derived data only).
- WAL lets readers proceed during a write. Writers serialize on
  `BEGIN IMMEDIATE` with the busy timeout; a write that cannot get the lock
  fails, keeps its delta and is retried by the next checkpoint.
- Under Bun (OpenCode's runtime) every statement is finalized before close.
  Otherwise `bun:sqlite` keeps the connection, and on Windows the file lock,
  alive after `close()`.

## Returning to the baseline

The baseline build reads only `analytics-v3.json`. After migration that file is
gone, so the baseline rebuilds its index from the OpenCode database on first
start (a full read: minutes on a multi-GB history) and writes a new JSON file.
Nothing else is lost; `analytics.sqlite` is ignored by the baseline and may be
deleted. There is no dual-write.

## Provider quota disk cache (not migrated)

Per-provider JSON files under `<cache>/opencode-quota-gui/quota-provider-state/`
hold the last normalized provider result per cache key (a SHA-256 of the
logical key, never credentials), replayed within the TTL and kept as
last-good. They stay as files:

- They are small and few (one file of 731 B on the measured machine). At that
  size, an atomic write measured p50 1.2 ms (Bun) / 1.4 ms (Node) and a read
  plus parse 0.4 / 0.7 ms (200 iterations, Windows). That is at most one of
  each per provider poll, so a shared database has nothing material to save.
  (An 8 KB entry read measured ~14 ms p50 under Bun's async `readFile` and
  0.8 ms under Node; it is a runtime cost, not one a database would remove.)
- They live in the disposable cache directory on purpose. Moving them into
  `usage-history.sqlite` would couple a disposable cache to the one
  irreplaceable store: a cache-schema change or cache corruption recovery
  would then touch Usage history. Moving them into `analytics.sqlite` would put
  them in the state directory and under its drop-and-rebuild schema policy.
- A cached read never creates a measured quota observation, and no provider
  request, credential or token is added by this change.

## Cache Observer compatibility (v1.5.0)

The Cache Observer is in memory today (at most 128 invocations per scope) and
reconstructs history from OpenCode `message.list`. Every field it needs is
derivable from the OpenCode database: dispatch (`time.created`), completion,
route (provider, model, variant) and cache counts. That makes observer history
derived data, which fits `analytics.sqlite` and its rebuild policy. Two gaps
must be closed first:

- The occurrence table has no finish reason, and the observer only counts
  successful primary calls (`stop`, `tool-calls`). Add a column; it is a schema
  version bump, which rebuilds the index from source once.
- Per-session replay needs an index on `(session_ref, completed_at)`. It can
  be created additively (`CREATE INDEX IF NOT EXISTS`) without a rebuild.

Observer state that cannot be derived (for example live-only timing that
OpenCode does not persist) must not go into `analytics.sqlite`, because a
schema change there drops every table. It would need an additive-migration
store like Usage history.
