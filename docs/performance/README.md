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
  spread while the **same service stays alive**. The two-day delta adds rows
  with two-day-spread timestamps; it is not a cold resume. Synthetic profiles
  may mutate only their disposable temp database. Real-local runs no-change
  only and never writes.
- Cold resume (synthetic only) — close the worker after its snapshot is
  persisted, copy that snapshot to an isolated path, append 400 rows with
  two-day-spread timestamps while no worker is running, shift only the isolated
  snapshot's `sourceCursorAtMs` and `lastFullRepairAtMs` back two days, then
  start a fresh worker against the isolated snapshot. Record first home,
  refresh, and post-refresh home. Source row timestamps are unchanged. The
  actual wall-clock gap is reported and is not two days; this is a simulated
  cold resume, not a two-day wall-clock pause. A separate engine test covers an
  aged two-day snapshot with an injectable clock. Real-local reports this
  scenario skipped because it never mutates the source.
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
  Includes the cold-resume first-home, refresh, and post-refresh keys.
- `phases` — available flag, fixed labels, interval phase metrics (including
  `coldResume`), and the raw cumulative marks.
- `warmSwitches` — overall and per-operation p50/p95.
- `deltas` — `noChange`, `add100`, `add1000`, `twoDay`, with inserted rows,
  expected/observed step deltas, refresh/home time, status, pass flag, and the
  final aggregate step count used as the cold-resume baseline. `twoDay` is a
  live-service delta, not a restart.
- `coldResume` — synthetic-only persisted-snapshot restart: status, simulated
  inactivity days, actual wall-clock gap, clock-simulation note, inserted rows,
  expected/observed step delta, first-home/refresh/post-refresh times, and pass
  flag. Real-local is `skipped`.
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
