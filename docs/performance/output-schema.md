# Benchmark output schema

This is the stable, machine-readable contract emitted by
`scripts/benchmark-analytics.mjs --json` / `--json-out`. The JSON is sanitized:
it contains aggregate counts, durations, and fixed labels only. It never
contains project/session/message identifiers, titles, names, contents, real
paths, or error text.

The example below is **illustrative and non-machine-specific**. `null` marks a
placeholder or an unavailable/skipped value; the numbers that are shown are
fixed synthetic profile counts, not measurements from any machine.

```json
{
  "schemaVersion": 1,
  "suite": "analytics-benchmark",
  "mode": "synthetic",
  "environment": {
    "runtime": "node",
    "node": "vX.Y.Z",
    "platform": "<platform>",
    "arch": "<arch>"
  },
  "instrumentation": {
    "available": true,
    "status": "available",
    "source": "AnalyticsWorkerMemoryStats.phases (stats command)",
    "reason": null,
    "semantics": "Cumulative fixed-label worker timings; intervals are differences between stats marks.",
    "labels": [
      "presentationLoad",
      "indexLoad",
      "metadataRead",
      "revisionDiscovery",
      "historicalPayloadRead",
      "changedPayloadRead",
      "modelUpdate",
      "dtoAggregation",
      "persistenceWrite"
    ]
  },
  "profiles": [
    {
      "name": "dense-30d",
      "mode": "synthetic",
      "source": {
        "kind": "synthetic",
        "access": "disposable-temp-write",
        "queryOnly": null,
        "mutations": "generated-temp-db",
        "counts": {
          "sessions": 420,
          "assistantRows": 128000,
          "projects": 10,
          "spanDays": 45
        }
      },
      "synthetic": {
        "profile": "dense-30d",
        "seed": 0,
        "sessions": 420,
        "rows": 128000,
        "projects": 10,
        "spanDays": 45,
        "tokenProfile": "dense-high-cache",
        "cacheReadTokens": null,
        "forks": 0,
        "compactions": 0,
        "treeRows": null,
        "treeDescendants": null,
        "treeMaxDepth": null
      },
      "selected": {
        "densestProject": null,
        "longestProject": null,
        "largestTree": null
      },
      "durationsMs": {
        "coldHome7d": null,
        "extensionHome30d": null,
        "lifetimeHome": null,
        "projectDense30d": null,
        "projectLongLifetime": null,
        "largeTreeSession": null,
        "subSession": null,
        "warmReopenHome7d": null,
        "warmReopenProject30d": null,
        "deltaNoChangeRefresh": null,
        "deltaNoChangeHome7d": null,
        "deltaAdd100Refresh": null,
        "deltaAdd100Home7d": null,
        "deltaAdd1000Refresh": null,
        "deltaAdd1000Home7d": null,
        "deltaTwoDayRefresh": null,
        "deltaTwoDayHome7d": null,
        "coldResumeHomeAfterRestart": null,
        "coldResumeRefresh": null,
        "coldResumeHomeAfterRefresh": null,
        "coldResumeRefreshAgain": null,
        "coldResumeHomeAfterRefreshAgain": null
      },
      "phases": {
        "available": true,
        "attribution": "interval-between-cumulative-stats-marks",
        "semantics": "Intervals are not exclusive per-call breakdowns.",
        "labels": ["presentationLoad", "indexLoad"],
        "intervals": {
          "cold7d": null,
          "extension30d": null,
          "lifetimeHome": null,
          "projectDense30d": null,
          "projectLongLifetime": null,
          "largeTreeSession": null,
          "subSession": null,
          "warmReopenHome7d": null,
          "warmReopenProject30d": null,
          "warmSwitches": null,
          "deltas": null,
          "coldResume": null
        },
        "marks": {}
      },
      "warmSwitches": {
        "rounds": 3,
        "calls": 24,
        "totalMs": null,
        "p50Ms": null,
        "p95Ms": null,
        "operations": {}
      },
      "deltas": {
        "mutationMode": "synthetic-temp-source",
        "externalWriterPossible": false,
        "finalStepCount": null,
        "scenarios": {
          "noChange": {
            "status": "not-mutated",
            "semantics": "no-mutation",
            "updateClock": null,
            "completionSpanDays": 0,
            "insertedRows": 0,
            "days": 0,
            "expectedStepDelta": 0,
            "observedStepDelta": null,
            "refreshMs": null,
            "homeMs": null,
            "passed": null
          },
          "add100": {
            "status": "skipped",
            "semantics": "current-completion-updates",
            "updateClock": "completion",
            "completionSpanDays": 0,
            "insertedRows": 0,
            "days": 0,
            "expectedStepDelta": 0,
            "observedStepDelta": null,
            "refreshMs": null,
            "homeMs": null,
            "passed": null
          },
          "add1000": {
            "status": "skipped",
            "semantics": "current-completion-updates",
            "updateClock": "completion",
            "completionSpanDays": 0,
            "insertedRows": 0,
            "days": 0,
            "expectedStepDelta": 0,
            "observedStepDelta": null,
            "refreshMs": null,
            "homeMs": null,
            "passed": null
          },
          "twoDay": {
            "status": "skipped",
            "semantics": "current-write-with-historical-completions",
            "updateClock": "current-write",
            "completionSpanDays": 2,
            "insertedRows": 0,
            "days": 0,
            "expectedStepDelta": 0,
            "observedStepDelta": null,
            "refreshMs": null,
            "homeMs": null,
            "passed": null
          }
        }
      },
      "coldResume": {
        "status": "applied",
        "reason": null,
        "simulatedInactivityDays": 2,
        "actualInactivityMs": null,
        "clockSimulation": {
          "mode": "aged-isolated-snapshot-replay",
          "days": 2,
          "snapshotAgedBeforeInsert": true,
          "sourceCursorShifted": true,
          "cursorProof": "aged-source-cursor",
          "repairClockShifted": true,
          "updatesInsideAgedCursorInterval": true,
          "authenticHistoricalSnapshot": false
        },
        "snapshotReused": true,
        "snapshotSource": "persisted-worker-snapshot",
        "scopeFallback": false,
        "updateWindowBounded": null,
        "updateLowerBoundMs": null,
        "updateUpperBoundMs": null,
        "updateMinMs": null,
        "updateMaxMs": null,
        "insertedRows": 400,
        "expectedStepDelta": 400,
        "observedStepDelta": null,
        "homeAfterRestartMs": null,
        "refreshMs": null,
        "homeAfterRefreshMs": null,
        "secondRefreshMs": null,
        "secondRefreshStepDelta": null,
        "secondRefreshPassed": null,
        "passed": null
      },
      "http": {
        "loopback": true,
        "index": {
          "idle": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null },
          "active": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null },
          "delta": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null }
        },
        "health": {
          "idle": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null },
          "active": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null },
          "delta": { "samples": 0, "failures": 0, "p50Ms": null, "p95Ms": null, "maxMs": null }
        }
      },
      "memory": {
        "host": {},
        "worker": {},
        "phases": {}
      },
      "persistence": {
        "snapshotBytes": null,
        "presentationBytes": null,
        "snapshotWritten": null
      },
      "payload": {
        "coldHomeJsonBytes": null,
        "lifetimeHomeJsonBytes": null,
        "largeTreeJsonBytes": null
      },
      "checks": {},
      "limitations": []
    }
  ],
  "limitations": []
}
```

## Field notes

- `schemaVersion` is `1`; additive fields may appear without a version bump.
- `mode` is `synthetic` or `real-local`.
- `source.access` is `disposable-temp-write` for synthetic and `read-only` for
  real-local. `source.queryOnly` is `null` for synthetic and the observed
  `PRAGMA query_only` result for real-local; it is not a claim that external
  writers cannot change a live source.
- `source.counts` and `selected` are aggregate-only. `real-local` never emits
  source identifiers or paths.
- `durationsMs` always contains the fixed key set. A `null` means skipped or
  unavailable; it is never zero-filled. The `coldResume*` keys are `null` for
  real-local, including `coldResumeRefreshAgain` and
  `coldResumeHomeAfterRefreshAgain`.
- `warmSwitches.operations` contains per-operation `samples`, `failures`,
  `p50Ms`, `p95Ms`, and `maxMs`.
- `deltas.finalStepCount` is the aggregate 7d step count after the last delta;
  the cold-resume comparison uses it as the pre-restart baseline.
- `deltas.scenarios` always contains `noChange`, `add100`, `add1000`, and
  `twoDay`. The legacy `twoDay` key now means
  `current-write-with-historical-completions`: physical `time_updated` is the
  current write time (anchor boundary inclusive), while completion timestamps
  span two days. It is a live-service delta, not a cold restart. Archived BEFORE
  output used backdated physical updates, so that scenario is not directly
  comparable. Real-local marks mutation scenarios `skipped`.
- `coldResume` applies only to synthetic runs. The isolated snapshot is aged
  **before** inserts; physical row update times are distributed linearly from
  just after the aged cursor to a resume clock captured before insertion. The
  last update cannot exceed that clock. `updateLowerBoundMs`, `updateUpperBoundMs`,
  `updateMinMs`, and `updateMaxMs` are recorded; `updateWindowBounded` verifies
  both bounds and requires distinct min/max. Completion timestamps remain
  historical. `clockSimulation` records `snapshotAgedBeforeInsert`,
  `cursorProof` (`aged-source-cursor` or `unavailable-scope-fallback`),
  `updatesInsideAgedCursorInterval`, and `authenticHistoricalSnapshot: false`:
  this is a replay workload, not an authentic two-day-old snapshot. A snapshot
  without `sourceCursorAtMs` is a scope fallback (`scopeFallback: true`,
  `passed: null`) and cannot claim cursor proof. `actualInactivityMs` is the real gap between snapshot close and fresh-worker
  start, much shorter than two days. `secondRefreshStepDelta` must be `0`;
  `secondRefreshPassed` records it. A separate engine test covers an aged
  two-day snapshot with an injectable clock. Real-local reports `skipped` with
  reason `real-source-is-never-mutated`; synthetic runs report
  `prior-delta-correctness-failed` instead of running a dependent cold check.
- `http.index` and `http.health` are separate sample sets. Their percentiles
  are never combined.
- `phases.intervals` contains phase-timing differences between cumulative
  `stats` marks, including `coldResume` for synthetic runs. Async persistence
  can cross an interval boundary, so these are interval observations, not
  exclusive per-call measurements.
- `memory.host` peaks are the maximum of 25 ms samples, not true process peaks.
  `memory.worker` reports before/after/peak values in MiB; Node worker RSS is
  process-wide.
- `checks` values are `true`, `false`, or `null` (not applicable/skipped).
- `limitations` explains installed-schema and scope caveats, including the
  missing `session_message.time_updated` index and the preserved global
  revision/cross-scope fork-owner pass.

## Local results are not part of this schema artifact

Actual BEFORE/AFTER JSON and markdown reports are machine-specific. They belong
under `docs/performance/local/` (ignored) or an OS temp directory, never in the
committed tree. Real-local output is aggregate-only and always local/temp.
