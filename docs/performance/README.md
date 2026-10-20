# Analytics performance benchmark

`scripts/benchmark-analytics.mjs` is the repeatable pre/post evidence suite for
analytics persistence and liveness. It runs the **real, tsc-built analytics
worker** behind the **real loopback dashboard server**. The analytics worker,
engine, and HTTP server are real; quota/provider data and settings are
in-memory stubs used by the server fixture, not production implementations.

The suite exists to establish BEFORE/AFTER evidence before and after production
optimizations. It is intentionally read-only with respect to any real source.

## Repository artifact policy

Public OSS artifacts are limited to reusable benchmark scripts, this
methodology/profile/metric documentation, and the synthetic output
schema/example.

**Never commit** machine-specific BEFORE/AFTER results, timing tables, or
real-local output. Keep them under `docs/performance/local/` (ignored) or an OS
temp directory. `.gitignore` ignores every file under `docs/performance` by
default and unignores only `README.md` and `output-schema.md`, so generated
JSON/markdown cannot be added accidentally. The committed tree contains no
claim that a single machine's numbers are a universal baseline. Report
anonymized measurements in the PR or chat with environment caveats. See
`output-schema.md` for the committed schema and illustrative synthetic example.

## Profiles

| Profile | Shape | Purpose |
| --- | --- | --- |
| `dense-30d` | 420 sessions, 128,000 assistant rows over 45 days, 10 projects, billions-equivalent cache-read tokens | Cold 7d, 30d extension, lifetime, warm switches, high-cache dense aggregation |
| `long-lifetime` | 180 sessions, 54,000 rows over 18 months, 6 projects | Lifetime buckets, month-scale spans, 30d extension from a long history |
| `deep-session-tree` | 47 sessions / 46 descendants across six depths, 6,990 rows, 2 forks, 6 compactions, growing-context token patterns | Large tree and subsession detail, fork-copy ownership, compaction markers |

Every profile uses a fixed seed. Data time offsets are deterministic relative
to the run anchor; no fixed wall-clock date makes the profiles stale. Session,
message, project, and model values are generated in a disposable SQLite file.

## What is measured

- `coldHome7d` — first analytics read after starting a fresh worker with no
  persisted snapshot. "Cold" means fresh worker/service state, not a fresh OS
  process; the benchmark process and dashboard server stay alive.
- `extensionHome30d` — next read after the 7d extent, forcing an extent
  extension on the same worker.
- `lifetimeHome` — lifetime aggregation after 30d.
- `projectDense30d` / `projectLongLifetime` — project detail on the densest and
  longest-span projects.
- `largeTreeSession` / `subSession` — session detail for the largest root tree
  and its deepest node.
- `warmReopenHome7d` / `warmReopenProject30d` — fresh worker against the
  persisted snapshot/presentation sidecar.
- Warm switches — three rounds of 24h/7d/30d/lifetime home, dense/long project,
  root/deep session calls after the warm start.
- Deltas — no-change refresh, +100 rows, +1,000 rows, and a two-day 400-row
  spread while the **same service stays alive**. The legacy `twoDay` key now
  means **current physical updates with historical completions**: physical
  `time_updated` is the deterministic current write time (the anchor boundary
  qualifies), while completion timestamps span an actual two days. It is not a
  backdated-update case and not a cold resume. The older BEFORE `twoDay`
  fixture used backdated physical updates, so that scenario is not directly
  comparable to the corrected key. Synthetic profiles may mutate only their
  disposable temp database. Real-local runs no-change only and never writes.
- Cold resume (synthetic only) — close the worker after its snapshot is
  persisted, copy that snapshot to an isolated path, **age only the isolated
  copy's `sourceCursorAtMs` and `lastFullRepairAtMs` before inserting**, then
  append 400 rows with historical completion dates spanning two days. Physical
  updates are distributed linearly from just after the aged cursor to a resume
  clock captured before insertion, so the last update cannot exceed the resume
  time. Record and verify inserted update min/max against both bounds. Start a
  fresh worker against the isolated snapshot. Record first home, refresh,
  post-refresh home, and a second refresh that must add zero steps. The age is a
  replay workload, not an authentic two-day-old historical snapshot. A snapshot
  without `sourceCursorAtMs` is labeled `unavailable-scope-fallback` and cannot
  claim cursor-window proof. The actual wall-clock gap is reported and is not
  two days; this is a simulated cold resume. A separate engine test covers an
  aged two-day snapshot with an injectable clock. Real-local reports this
  scenario skipped because it never mutates the source. If any prior synthetic
  delta correctness check fails, cold resume is skipped rather than reported as
  a dependent failure.
- `GET /` and `GET /api/v1/health` are sampled into **separate** arrays, so
  their p50/p95/max values are never conflated. Both are real loopback HTTP
  probes against the dashboard server.
- Host and worker memory before/after/peak. Host peak values are the maximum of
  **25 ms samples**, not a true process peak. Worker `rss` is process-wide on
  Node worker threads; heap/external/arrayBuffers are per-isolate samples
  after best-effort GC.

## Commands

```sh
pnpm exec tsc

# All synthetic profiles, concise human table
node scripts/benchmark-analytics.mjs

# Stable JSON (table goes to stderr)
node scripts/benchmark-analytics.mjs --json

# Keep actual results local/ignored; never commit them
node scripts/benchmark-analytics.mjs --json-out docs/performance/local/before.json

# One profile
node scripts/benchmark-analytics.mjs --profile dense-30d

# Opt-in real local source: resolved like production OPENCODE_DB, read-only.
# Keep its output local/ignored too.
node scripts/benchmark-analytics.mjs --real-local --json-out docs/performance/local/real-local.json
```

Useful environment overrides:

- `ANALYTICS_BENCH_MEMORY_CAP_MIB` (default `100`) — retained worker heap delta
  target for the `workerRetainedBounded` check.
- `ANALYTICS_BENCH_DENSE_SESSIONS` / `ANALYTICS_BENCH_DENSE_ROWS` — shrink or
  grow the dense profile for a quick smoke.
- `ANALYTICS_BENCH_SESSIONS` / `ANALYTICS_BENCH_STEPS` — legacy dense override
  (`rows = sessions * steps`).
- `OCQ_BENCH_TMP_DIR` — benchmark temp parent (default `<tmp>/opencode`).

## Query-plan diagnostic

`scripts/analytics-query-plan.mjs` opens OpenCode's database read-only and prints
the representative analytics query plans plus aggregate `session_message` page
composition. It never emits identifiers or payloads.

```sh
pnpm exec tsc
pnpm run diagnose:analytics-query-plan
pnpm run diagnose:analytics-query-plan -- --timings
pnpm run diagnose:analytics-query-plan -- --json
```

`--timings` executes each projection once and is opt-in because a cold global
scan can take tens of seconds. The diagnostic mirrors the SQL shapes in
`src/lib/opencode-storage.ts`; update it when those builders change. It is a
diagnostic, not a performance claim: plans are source-schema facts, timings are
machine-local.

## Model-only allocation check

To isolate retained rollup-model allocations from storage and persistence:

```sh
node scripts/benchmark-analytics-model.mjs --sizes 32000,128000 --json
```

This uses lazy synthetic rows and explicit GC. Compare load, unchanged-upsert,
removal, and clear samples separately; retained bytes per row are not a
whole-worker memory estimate. Keep actual results local, like the full suite.

## Real-local safety and privacy

`--real-local`:

1. Resolves the source path with the same `OPENCODE_DB` rules production uses.
2. Opens the source **read-only**, sets `PRAGMA query_only = ON`, and reads the
   pragma back before selection.
3. Never constructs a writer connection and never executes a source write
   statement.
4. Puts the benchmark snapshot/presentation sidecar, dashboard assets, and all
   XDG cache/config/state dirs in a disposable temp root.
5. Selects the densest project, longest project, and largest root tree from
   anonymous assistant-row counts. It does not read titles, directories, message
   contents, or display names for output.
6. Emits only aggregate counts and timings. No ids, names, titles, contents,
   paths, or error messages reach stdout, JSON, the human table, or persisted
   output. Errors are reduced to fixed codes.
7. Runs only the no-change delta; mutation and cold-resume scenarios are
   reported as skipped. External OpenCode activity can still change the source
   during the run, so real no-change is reported as an observation, not a hard
   guarantee.

The focused test `tests/gui.analytics-benchmark.test.ts` opens a **disposable
synthetic** database through the same guarded reader, verifies `query_only` is
`1`, verifies a write attempt fails, and verifies the file hash is unchanged.
That is test evidence for the guarded opener and temp fixture, not proof about
a live source. A live source can be changed by external writers, so the
benchmark never hashes or enforces immutability on the real DB.

Real-local results are aggregate-only and intentionally ignored by git. The
tracked tree is limited to `README.md` and `output-schema.md`; every other
`docs/performance` file is ignored by default. Benchmark-generated state lives
only under the OS temp root and is removed on exit.

## Output contract

The committed schema and an illustrative synthetic example live in
`output-schema.md`. Actual JSON output is local-only, never committed. The
JSON object is stable (`schemaVersion: 1`). Per profile:

- `source` — `synthetic` or `real-local`, `access` mode, observed `queryOnly`
  for real-local, mutation mode, and aggregate counts.
- `synthetic` — seed, sessions, rows, projects, span, cache-read tokens, forks,
  compactions, tree shape (synthetic only; `null` for real).
- `selected` — anonymous dense/long/tree aggregate descriptions.
- `durationsMs` — fixed key set; unavailable/skipped scenarios remain `null`.
  Includes cold-resume first-home, first-refresh, post-refresh home, second
  refresh, and second post-refresh home keys.
- `phases` — available flag, fixed labels, interval phase metrics (including
  `coldResume`), and the raw cumulative marks.
- `warmSwitches` — overall and per-operation p50/p95.
- `deltas` — `noChange`, `add100`, `add1000`, `twoDay`, with inserted rows,
  expected/observed step deltas, refresh/home time, status, pass flag, update
  semantics, completion span, and the final aggregate step count used as the
  cold-resume baseline. `twoDay` is a live-service current-update/historical-
  completion delta, not a restart.
- `coldResume` — synthetic-only persisted-snapshot restart: status, simulated
  inactivity days, actual wall-clock gap, aged-snapshot replay metadata,
  cursor-proof/fallback label, inserted update lower/upper bounds and
  min/max, bounded-window flag, inserted rows, expected/observed step delta,
  first-home/refresh/post-refresh times, second-refresh delta/time, and pass
  flags. Real-local is `skipped`; synthetic runs skip it when prior delta
  correctness fails.
- `http` — separate `index` and `health` summaries for `idle`, `active`,
  `delta`.
- `memory` — host and worker before/after/peak. Host peaks are sampled every
  25 ms, not true peaks.
- `persistence` — snapshot and presentation sidecar byte sizes.
- `payload` — JSON sizes for cold/lifetime/tree DTOs.
- `checks` — correctness, cold-resume, and memory-bound checks.

Default output is a concise human table. `--json` writes stable JSON to stdout
and the table to stderr. `--json-out` writes the same JSON to a path with mode
`0600`; use only a local/ignored path. The script exits non-zero when a check
fails. See `output-schema.md` for field semantics.

## Worker phase instrumentation

Production now exposes privacy-safe, cumulative phase timings through the
existing worker `stats` result:

```ts
// src/gui/analytics-protocol.ts
export interface AnalyticsPhaseTiming {
  count: number;
  totalMs: number;
}

/** Fixed-label phase metrics returned with worker stats. */
export type AnalyticsPhaseMetrics = Record<string, AnalyticsPhaseTiming>;

export interface AnalyticsWorkerMemoryStats {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  peakHeapUsed: number;
  peakRss: number;
  /** Cumulative phase timings since worker start; labels/counts/times only. */
  phases?: AnalyticsPhaseMetrics;
}
```

Fixed labels: `presentationLoad`, `indexLoad`, `metadataRead`,
`revisionDiscovery`, `historicalPayloadRead`, `changedPayloadRead`,
`modelUpdate`, `dtoAggregation`, `persistenceWrite`.

The benchmark takes `stats` snapshots outside the timed calls and differences
adjacent marks. Because production reports cumulative totals, asynchronous
persistence/aggregation started by earlier work can land in a later interval.
The suite therefore labels these as **phase intervals**, not exclusive
per-call breakdowns; wall-clock durations remain the primary latency metric.
No duration is inferred or relabeled as a phase.

The cumulative stats labels are sufficient for BEFORE/AFTER comparison. A
future operation-scoped diagnostics ring was considered but is not part of this
suite or the committed schema; interval differencing is the honest attribution
available from the current worker interface.

## Installed-source limitations and scope correctness

- **No index can serve completed time.** `$.time.completed` lives inside the
  JSON `data` column. The installed OpenCode schema has indexes on
  `session_id`/`seq`, `session_id`/`time_created`/`id`,
  `session_id`/`type`/`seq`, and `time_created`, but none on the completion
  expression. A global finite-range completed read therefore scans
  `session_message` and evaluates JSON for every row. On a real source the
  `data` payload (including overflow pages) dominates the scan; cold cost is
  I/O-bound, not fixable by a projection or sort change alone. A physical
  `time_created <= completedUntil` prefilter is deliberately **not** used: it
  is only safe if `completed >= created` is a guaranteed source invariant, and
  it cannot reduce a window ending at the current wall clock anyway. Adding an
  index, a sidecar database, or a migration is post-v1.0 work.
- **Session-scoped reads still seek.** A tree payload read uses
  `session_id`/`type` and is cheap. Session detail's dominant cost is the
  separate **exact-completion fork-owner discovery** scan, not the tree read.
  The engine also reconciles known external owners by message id. A shortcut
  based on `MAX(time_updated) <= cursor` was evaluated and rejected: an unseen
  fork copy can commit with `time_updated` equal to (or just below) the cursor,
  and NULL timestamps are replayed by the normal delta, so the shortcut would
  drop valid owners. Exact cross-scope ownership still requires the source
  scan in an uncached case.
- **Redundant sorts were removed.** The raw completed reader and revision reader
  sort their projected rows deterministically in memory, so their SQL builders
  no longer add `ORDER BY`/temp B-trees. Filtering semantics and final row order
  are unchanged; the diagnostic shows the plans without `USE TEMP B-TREE`.
- **The 7d -> 30d extension is idle-graced.** See `synchronization.md`; it is
  still not preemption, and foreground work that arrives after a synchronous
  read has started cannot cancel it.
- **Worker request budget.** A cold 7d read on a measured slow source approached
  the old 90 s bridge budget, and a foreground request queued behind it could
  exceed it; the bridge then retired a healthy worker and the next request
  surfaced `unavailable`. The default budget is now 180 s, enough for two cold
  reads while still retiring a genuinely stuck worker. Queueing remains
  non-preemptive: a request that arrives during a started scan waits. A
  browser/proxy-level 502 has not been reproduced and is not claimed fixed.
- **No assumed `time_updated` index.** The installed OpenCode schema used for
  the BEFORE baseline has no index on `session_message.time_updated`.
  Timestamp/revision filtering therefore scans SQLite rather than using an
  index. Synthetic databases are built without adding such an index, matching
  installed-source behavior. The suite reports what the installed schema does,
  not an indexed best case.
- **Global revision pass is preserved.** Production's global revision scan
  finds cross-scope fork owners so fork copies are owned exactly once across
  projects/sessions. Project and session measurements call the real engine and
  do not filter that pass, narrow its owner discovery, or synthesize a scoped
  shortcut. The deep-tree profile includes fork copies and compaction markers
  specifically so this path is exercised.
- **Interval phase totals are not operation-exclusive.** Asynchronous
  persistence or aggregation started by earlier work can cross a stats mark.
  The suite labels those totals as intervals and keeps wall-clock durations as
  the primary latency metric.

## Reproducibility and interpretation

- Synthetic data shapes are deterministic; measured durations are single-run
  wall-clock samples and depend on machine, runtime, filesystem cache, and
  antivirus/indexing activity.
- Compare BEFORE and AFTER with the same runtime, machine, and command.
- These are machine-specific observations, not a universal baseline or a
  cross-machine guarantee. Do not cite one run as a general performance claim.
- Report baseline failures separately from regressions. A failing worker memory
  cap on a BEFORE run is evidence, not a suite error.
- Do not treat `GET /` or health p95 as an analytics-read latency. They are
  liveness/event-loop probes only.
- Actual BEFORE/AFTER outputs are local/ignored by design; final comparisons
  are reported in chat/PR with their environment caveats.
- The synthetic cold-resume scenario was added after the initial BEFORE run.
  Unchanged scenarios remain comparable; cold resume needs a fresh BEFORE/AFTER
  pair on the same machine and runtime before comparison. Do not present the
  older live-service `twoDay` delta as a cold-resume result.
- The corrected `twoDay` fixture uses current physical updates with historical
  completions. The archived BEFORE `twoDay` used backdated physical updates, so
  that one scenario is not apples-to-apples and must be labeled as an exception
  in comparisons. Common-timing scenarios remain valid.
