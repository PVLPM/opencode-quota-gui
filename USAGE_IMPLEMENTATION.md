# v1.4.0 — Quota Usage, local observation history and model attribution

Living implementation record. Another agent must be able to resume from this
file plus `git log`. Product scope is fixed by the owner brief (Usage view,
local history, attribution, optional Claude Code / Codex import); this file
records technical decisions and progress only. Open product questions are
listed separately and are never silently resolved.

Branch `feat/v1.4.0`, base `main@8c0aad2e` (v1.3.3).

## Status

| Workstream | Scope | State |
|---|---|---|
| A | Investigation, contracts, plan | done (this file) |
| B | Observation store + polling capture | done: SQLite store, recorder, budget rows with a scheduled reset (D11) |
| C | Effort on owned steps + interval activity query + attribution | done: certified activity coverage, presence-span account eligibility (D8.1), uncertain reset boundaries (D4) |
| D | Claude Code / Codex opt-in import + dedupe | done: parsers/readers, settings, schema v3, scheduling, exclusions, activity query, per-session unknown Codex accounts, per-harness delete (D10.3) |
| E | Usage navigation, charts, inspection, breakdown (browser + native) | done: redesign against owner feedback (shared frame tabs, compact plot, account meta) |
| F | Integration, benchmarks, review, screenshots, draft PR | in progress: integrated, verified, reviews running; draft PR #41 |
| G | New providers: Mistral Vibe, Antigravity CLI | done (see capability matrix) |

## Investigation findings (summary)

- Polling: one host per OpenCode process (`src/gui/lifecycle.ts`), one quota
  cycle per `minIntervalMs` (default 60 s, `src/gui/snapshot-service.ts`).
  Claude Agent has its own cross-process OAuth throttle (default 3 min).
  No cross-process poll owner: two OpenCode processes poll independently.
- Provider results go through `fetchQuotaProviderResult`
  (`src/lib/quota-state.ts`): within TTL (= `minIntervalMs`) a result is
  replayed from memory or from the shared on-disk cache **without an HTTP
  request**. The cache entry `timestamp` is the fetch time of the genuine
  measurement and survives replay — the basis of observation identity.
- Last-good retention marks a card `stale: true`; cooldown skips appear as
  `errors[].attemptOutcome = "cooldown" | "reuse"`.
- `accounting.observedAtIso` is provider observation time, present only for
  claude-agent, anthropic, xai, cursor (local now) and some custom providers.
- Identity: `cardId = providerId:sha256(domain‖identityKey)`; `rowId =
  cardId#rowKey` from semantic metrics. Privacy-safe opaque hashes; stable.
- OpenCode records **no account identity per message** — only providerID,
  modelID, `model.variant` (effort), tokens, cost, times.
- Analytics worker keeps deduplicated owned steps in hour buckets with
  precomputed API-equivalent cost; effort (`variant`) is staged but dropped
  in `toOwnedStep` (`src/gui/analytics-model.ts`).
- The plugin writes JSON only today; read-only SQLite wrapper exists for
  `bun:sqlite` (OpenCode host) and `node:sqlite` (Node CLI).

Full capability matrix: see [Provider capability matrix](#provider-capability-matrix).

## Architecture decisions

### D1 Storage: plugin-owned SQLite (WAL)
`<private state dir>/usage-history.sqlite` via the same runtime selection as
`src/lib/opencode-sqlite.ts` (bun:sqlite inside OpenCode, node:sqlite on Node).
No new dependency. WAL + `busy_timeout`, every write in one `BEGIN IMMEDIATE`
transaction; unique constraints make concurrent identical writes idempotent.
JSON + lock files (existing convention) are unsuitable for indefinitely
growing, range-queried history. No retention cutoff, no deletion.

Durability: `synchronous = NORMAL` in WAL means a process crash loses nothing
already committed, but a sudden power loss may lose recent committed
transactions. The exact number is not bounded to one poll cycle: losses depend
on the OS, the filesystem and when WAL checkpoints complete, so several
collected cycles can be lost. That is an accepted trade-off for local quota
history: it avoids one fsync per cycle. `busy_timeout` is applied before the
`journal_mode = WAL` switch so opening a database another process is writing
does not wait on the default multi-second timeout. The recorder uses a 250 ms
timeout and carries a small bounded number of cycles over to a later
observation. This is a bounded synchronous wait, not nonblocking: a contended
open or write can still stall the host event loop for up to that timeout, which
is why it is kept short. A failed open is retried on a later observation, and a
failed setup closes the handle. Dashboard reads use the same 250 ms read-only
timeout and never trigger a provider request.

Windows file permissions: the directory is created with mode 0700, but Windows
ignores POSIX modes. The database file therefore inherits the ACL of the
private state directory (`%LOCALAPPDATA%`/OpenCode state) just like the other
plugin state files; no explicit per-file ACL is set. Unix additionally applies
`chmod 0600` best effort.

### D2 Observation identity
A sample is `(seriesId, measuredAtMs)`. `measuredAtMs` = provider
`accounting.observedAtIso` when supplied, else the cache-entry timestamp of the
genuine fetch (propagated from `fetchQuotaProviderResult`, unchanged on
replay). A replay from memory or another process's disk cache therefore maps to
the same sample and is ignored. Retained (`card.stale`) cards and cooldown /
reuse outcomes never produce samples; they produce interruption evidence.
Cursor's `observedAtIso` is local compute time, so Cursor is marked
`locally-estimated` and not treated as a provider measurement.

### D3 Series and run-length storage
`series` = one (cardId, rowKey) percent or quantity row, with last-seen
provider label and row label only. Account and plan labels are identity-bearing
(possibly an email or workspace name) and are never persisted; Usage resolves
those from the current live cards or a neutral opaque-hash fallback. A late or
duplicate sample never overwrites newer series metadata. Unchanged consecutive
samples of a series in the same epoch extend one `run` row (`first_at`,
`last_at`, `sample_count`) instead of inserting a row per poll — lossless for
every derived quantity (flat interval, endpoints, sample count) and bounded by
change frequency, not poll frequency. A run is only extended across a
continuous link (D5).

### D4 Epoch / reset semantics (pure, `src/gui/usage-intervals.ts`)
Reuses the proven-reset rule of `src/lib/quota-reset-notifications.ts`
(`updateObservation`): a scheduled reset is proven when the later observation
is at/after the earlier observation's `resetAt` and the new `resetAt` is later.
- remaining non-increasing, reset not passed → same epoch (reset-time jitter of
  offset-derived providers does not split an epoch).
- remaining increased without a proven reset → `replenished` boundary
  (refill, banked/manual reset, correction) — never negative burn.
- unit / capacity / limit / plan identity change → `identity-change` boundary.
  Capacity and plan identity are carried per sample through an internal side
  channel (never new card-DTO fields); standalone quantity rows are out of
  scope because they carry no capacity.
- no reset information and value increased → `uncertain` boundary.
- the earlier sample's known `resetAt` is already in the past at the later
  sample, and the later sample carries no reset of its own → `uncertain`
  boundary: whether the window rolled over cannot be established, so neither a
  decrease nor an increase is measured across it. An estimated earlier boundary
  follows the same rule, because the rollover may have happened anywhere inside
  the gap. Two samples that both report a reset keep the exact/estimated
  rollover rules above.
- `current` axis start: the latest epoch's proven **exact** provider reset when
  the derivation sees it, otherwise the first observed point of that epoch. A
  latest-epoch read returns the run that opened the epoch in `preceding`, so the
  derivation never has to guess. The unobserved prefix is axis space only: no
  point, link or interval is fabricated for it, and an estimated reset or an
  unknown duration keeps the first observed point as the start.
- duplicates (same sample) ignored; out-of-order samples ordered by
  `measuredAtMs`. A sample inside an existing run with the same value only
  increments `sample_count`. A different value never splits or fabricates an
  endpoint: it is stored as conflict evidence and the derivation renders an
  `uncertain` boundary at that time instead of a step. A sample in a gap between
  runs becomes its own unlinked run and unlinks the following run.
- reset precision is stored per run: an absolute provider reset is `exact`; a
  provider-derived `now + offset` reset (MiniMax, OpenAI
  `reset_after_seconds`, Cursor's local cycle) is `estimated`. Run extension
  compares estimated reset epochs with poll-scale jitter tolerance, not exact
  timestamps.
Reset marker time: the earlier observation's `resetAt` when the provider
supplied it as an absolute timestamp; otherwise "reset between observations".

### D5 Continuity (solid vs dashed)
Consecutive samples are a continuously observed interval when the same
collector run recorded them as consecutive attempts for that card with no
intervening failure/cooldown/retained cycle **and** the elapsed time is at most
twice the collector's configured poll interval at that time (timer/sleep
tolerance). Otherwise the interval is unobserved: dashed connector when both
endpoints are in the same epoch, disconnected when a boundary intervenes.
Explicit interruption evidence always wins over the elapsed-time tolerance: a
recorded failed/cooldown/retained/missing attempt between the two samples, or a
different collector session, breaks the link even when the elapsed time is
inside 2×. The tolerance absorbs scheduling jitter only, never a known gap.
*Technical tolerance (2×) recorded for owner review — see Q3.*

### D6 Burn
`observedBurn = prevRemaining − curRemaining` in percentage points per series
and epoch, only for intervals without a boundary, clamped never negative
(increase ⇒ boundary, D4). Never summed across series/windows.

### D7 Attribution (estimate)
For a series interval with burn ΔQ > 0: eligible activity = owned steps whose
`completedAtMs ∈ (t0, t1]`, provider matches the card provider, and, for
model-specific windows, the model belongs to that window. Weight = precomputed
API-equivalent cost. `est_i = ΔQ × w_i / Σw` **only when attribution is
complete**: account resolvable (D8), every eligible step priced, Σw > 0.
Otherwise the interval's ΔQ stays `unattributed` with a reason
(`no-activity`, `ambiguous-account`, `unpriced`, `zero-weight`) while recorded
tokens and costs are still shown. No effort multipliers, no delay buffer.

D7.1 implementation note: attribution is only certified from an activity read
that reports analytics coverage of the queried intervals. `activity()`
(`src/gui/analytics-engine.ts`) reports `coverage.complete` from the persisted
index extent (`coversSince` plus `extent.untilMs`) and only while the coverage is
trusted (loaded index, trusted coverage, no newer sidecar, readable source); an
uncovered or stale read schedules the same bounded background refresh a group
snapshot schedules, never a foreground scan. Until a read certifies coverage the
snapshot reports `activityUnavailable`: burn, links and stored points stay
displayed and no interval is reported as completely attributed.

### D8 Account eligibility
OpenCode serves a provider through one credential at a time and records no
per-message account. Activity through provider P is attributable to account A
only when A is the **only** account of P with observations overlapping the
interval. Multiple concurrent accounts → `ambiguous-account`. External use of
the same subscription can never be excluded; the UI always discloses this.

D8.1 implementation note: "sole" is decided from positive evidence only, and
that evidence is a **presence span** per rival card. A rival's span runs from
its earliest recorded evidence — a successful run or a recorded `error` /
`cooldown` / `retained` cycle, which proves the card was in the collector
snapshot while producing no sample — through its latest. `missing-row` is not
presence evidence: the store also emits it for a card that left the snapshot.
An interval of A is ambiguous iff it overlaps any rival span; history strictly
before a rival's first evidence predates its configuration, because the
collector records every configured account each cycle as either a success or an
interruption, so A may still be sole there. A rival in the live card list is
configured right now, so its span keeps an open end and covers every later
interval. A live rival with no recorded evidence at all (first cycle pending)
has no known start; it is treated as present only for the newest interval, never
for the whole history, because the store keeps no configuration timestamps.

Recorded for owner review: gaps inside a span stay conservative — a
card removed and re-added is treated as present in between, never as two spans.
The store read is one aggregate over `usage_series` bounds and
`usage_interruptions` (both run-length compressed), so it is proportional to
cards × windows, not to polls; `queryLatestEpochs` returns it too, which is how
a rival that only ever failed becomes visible in the `current` range. Residual
risk: a card observed in a cycle with no measurement mark and no error records
nothing, so its first evidence can lag its configuration by those cycles.

### D9 Effort
Promote `variant` onto `OwnedStep`: absent ⇒ unknown; `"default"` kept
distinct as explicit default where OpenCode recorded it. Never reconstructed
from the current selector.

### D10 External harness import (opt-in, per harness)
Settings flags `usageImport.claudeCode` / `usageImport.codex` (default off).
Importers read structured metadata only (timestamps, model, effort when
recorded, token counters, Codex `rate_limits` observations) into the same
store with `source` provenance; prompts, responses, tool payloads and paths
are never persisted. Dedup: Codex cumulative counters → per-turn deltas with
reset handling; Claude Code `message.id + requestId`. Cross-harness: OpenCode
Claude Agent invocations that also write Claude Code transcripts are excluded
from import when the shared identifier links them; otherwise kept as a
separate source and never merged into a "complete" attribution.

D10.1 implementation notes: Codex uses only `token_count` totals (per-delta;
`token_usage_record` is ignored to avoid double counting; a total decrease uses
`last_token_usage`). Claude Code groups identical `message.id + requestId`
lines by per-counter maximum. Only hashed thread/session/message identifiers
and file-cursor keys are persisted. Discovery reads plain `.jsonl` rollouts
(`sessions/`, `archived_sessions/`) and Claude `projects/` recursively; Codex
`.jsonl.zst` archives are not decompressed.

D10.2 integration (part 2):
- Settings `usageImport.claudeCode` / `usageImport.codex` default false, are
  validated and GUI-writable, and appear in normal settings provenance. No UI
  controls were added by this lane.
- Store schema v2 adds `usage_import_invocations`, hashed per-message keys,
  and the hash-only exclusion set. Schema v3 adds `usage_runs.reset_precision`,
  which imported Codex readings fill from the provider: `resets_at` is an
  absolute provider timestamp (`exact`), while `resets_in_seconds` is a local
  offset (`estimated`). Import cursors and last outcome live in
  `usage_meta` (`import_state:<harness>`), so restarts resume, and a
  disabled-to-enabled transition re-reads from offset 0 (idempotent through
  dedupe keys).
- Import runs only after a live quota cycle the host already performs. It is
  single-flight and debounced by that poll interval, reads at most 16 MiB of
  newly appended data per harness per opportunity, and never performs a
  provider request.
- Cross-harness exclusion: OpenCode's Claude Agent integration writes
  Claude Code transcripts. Host `data.native.sessionID/messageID` values are
  hashed with the reader's session/uuid key functions and stored at observe
  time; imported records carrying those keys (whole session or one message)
  are excluded at query time. No OpenCode integration writes Codex rollouts,
  so Codex has no exclusion and remains a separate source, never merged into
  OpenCode attribution.
- Imported Codex rate limits become `codex-import` series whose `cardId` is
  `codex-import:<accountHash>` with row keys `window:five_hour` /
  `window:week` for exact 300 / 10080 minute windows, otherwise
  `named:<limitId>|<window>|<minutes>`. They are not merged into OpenAI cards.
- A rollout without `creator_account_id` carries no account identity, so those
  readings are scoped to the session (rollout thread) they came from:
  `codex-import:unknown:<threadHash>`. An unknown account is never merged with
  another session's readings, so the interval derivation cannot measure
  consumption between two possibly different subscriptions. The thread hash is
  persisted in the reading, so re-imports stay idempotent; account-hinted rows
  keep the unchanged `codex-import:<accountHash>` id.
- Imported activity is grouped by provider/model/effort and priced through
  `priceTokenBuckets`; provider ids are `anthropic` for Claude Code and
  `openai` for Codex. It is returned only as `UsageSnapshot.importedActivity`
  sections labelled per harness, read over the requested range and never
  attached to a quota-window interval.
- Imported fields are whitelisted before persistence: effort must be a known
  Codex/OpenCode value, model ids must match a conservative model-id shape
  (otherwise `unknown`), and an opaque Codex `limit_id` is hashed for row keys,
  metrics and neutral "Codex limit <hash>" labels. Cursor state carries only
  consumed metadata (hashed thread/account keys, counters, sanitized
  model/effort).

### D10.3 Privacy and retention

- Harness files are opened read-only. No transcript, directory or harness
  database is ever written, renamed or deleted; the only deletion this feature
  performs is on rows in the plugin's own `usage-history.sqlite`.
- Only whitelisted metadata is stored: timestamps, model, effort, token
  counters, and Codex `rate_limits` observations (used percent, window minutes,
  reset instant or offset, reset precision, hashed limit id). Prompts,
  responses, tool payloads, file contents, paths and account/plan display
  labels are never persisted.
- Identifiers are domain-separated unsalted SHA-256 hashes over the raw id
  (`hashUsageImport(<domain>, id)`). They are linkable by anyone who already
  knows the raw id and are not reversible; session, message and thread keys
  exist only for deduplication and for excluding OpenCode-owned Claude Agent
  records.
- Whole transcript lines are parsed in memory only, far enough to extract the
  fields above, and then dropped; between runs nothing survives except the
  cursor and the hash-only exclusion set.
- There is no time-based retention. Imported rows stay until they are deleted,
  and turning an import switch off keeps everything already imported.
- The per-harness **Delete imported history** action in Settings removes that
  harness's `usage_import_invocations` and `usage_import_invocation_keys` rows,
  its Codex `codex-import` series with their runs, interruptions and conflicts,
  and its `import_state:<harness>` cursor, in one SQLite transaction that rolls
  back on failure. Live polled history and the other harness are untouched. The
  hash-only exclusion set is kept: it holds OpenCode's own Claude Agent
  identities and must still apply to a future re-import, so it is not
  harness-scoped import data.
- The deletion shares the importer's single-flight: a scan that already started
  finishes first and its rows are part of what is removed, and no scan starts
  until the transaction has committed, so an in-flight import can never
  re-insert rows behind the delete. Removing the cursor makes a later run
  re-read from offset 0, which stays idempotent through the dedupe keys. The
  action never changes the switch, so a harness that is still enabled re-imports
  on its next opportunity.
- Responses and logs carry counts only (deleted invocations, deleted imported
  rate-limit series); no path, hash, identifier or row content is returned.
- The single-flight above is per process, and several OpenCode hosts share one
  `usage-history.sqlite`, so the store fences deletions across processes too. The
  importer reads the harness's generation counter (`usage_meta` key
  `import_generation:<harness>`, absent = 0) when a scan starts and passes it to
  the one transaction that commits that chunk's rows and cursor; a deletion
  increments the counter inside its own transaction. A scan that awaited
  transcript I/O across a deletion therefore commits nothing — it neither
  restores the deleted rows nor re-creates the cursor — and abandons that
  harness for the opportunity, so the next one re-reads from offset 0. The
  counter reuses `usage_meta`, so no schema migration is involved.

### D11 No new traffic
Capture hooks into the existing `createDelegatingSource.quota` observation
path next to the notification observer. No provider request is added, and
Usage reads never trigger provider polling. Budget rows with a scheduled
reset are recorded.

## Provider capability matrix

### Polled providers

Per-provider facts for the two subscription-quota providers added in v1.4.0.
Both are ordinary `QuotaProvider` entries: they are polled by the existing
quota collector on its configured cadence and TTL cache, and add no timer,
loop or scheduler of their own.

| Provider | Polled | Quota windows | Reset precision | Identity source | Attribution eligibility |
|---|---|---|---|---|---|
| Mistral Vibe (`mistral`) | Yes — one `/v1/billing/budget` read plus one `/v1/billing/subscription` read per fetch, 3 s short timeout | No typed window: the Vibe budget is a `named:Vibe budget` `budget` row (the subscription allowance), plus an optional `named:API budget` budget row that is emitted only while pay-as-you-go is enabled | `exact` — the platform's `reset_at` RFC3339 instant; no reset when it is absent or unparsable | sha256 fingerprint of the credential (never the plan, label or source): one account for one key, and the same key found in `MISTRAL_API_KEY`, `<VIBE_HOME>/.env` or an OpenCode `mistral` login stays one card | The Vibe budget row is `unattributable` (a subscription meter, not model activity); OpenCode's `mistral` activity bills the API budget row |
| Antigravity CLI (`antigravity-cli`) | Yes — one `agy --version` probe (gate: >= 1.1.11) then one `agy --output-format json -p "/usage"` read per fetch, 30 s timeout that kills the child | The buckets the CLI reports (`weekly`, `5h`), each keyed by the CLI's own bucket id (`gemini-weekly`, `3p-weekly`, `3p-5h`); no typed window semantic, so two weekly buckets never collide | `exact` for reported timestamps; absent when the CLI reports `1970-01-01T00:00:00Z` (no reset scheduled) or no timestamp | None is proven: the CLI output carries no account identity, and the local `google_accounts.json` "active" field is not proof, so this source is its own card and is never linked to `google-agy` | None — the CLI has no OpenCode runtime id, so no recorded activity is attributed |

Notification eligibility follows from those row shapes:

- Mistral Vibe's budget rows are `budget` rows, so they are outside the
  `quota`/`rate_limit` low and exhausted policy (the same outcome as OpenCode
  Zen's monthly budget row), and they carry no typed window, so no reset
  notification is derived from them.
- Antigravity CLI rows are `quota` percent rows, so low and exhausted
  notifications apply; they carry a provider row key rather than a typed window,
  so no reset notification is derived from them.
- Neither provider gates auto-resume: both registrations declare no auto-resume
  binding, so their routes are rejected before the live probe.

### Opt-in history import

| Harness | Structured data imported | Priced activity | Quota observations | Ownership exclusion |
|---|---|---|---|---|
| Claude Code | assistant token counters, model, timestamp; `message.id + requestId` dedupe | yes, provider `anthropic` | none (transcripts carry no rate limits) | session + message UUID hashes from OpenCode Claude Agent native ids |
| Codex | `token_count` totals/deltas, model, effort, rate limits | yes, provider `openai` | `codex-import` series from `rate_limits`, 5h/7d semantic or named windows, exact/estimated reset precision | not needed: OpenCode writes no Codex rollouts |

Import limitations:

- Settings-only: the import switches and the per-harness "Delete imported
  history" action live on the Settings page; the Usage view has no import
  controls.
- Codex `.jsonl.zst` archived rollouts are skipped; only plain `.jsonl` is read.
- Imported Codex rate-limit runs are written by a synthetic `codex-import`
  cycle with no linked live polling, so intervals between them render as
  unobserved rather than continuous monitoring.
- Toggling an import off and on re-reads from offset 0 to pick up the disabled
  period. Imported invocations dedupe by key, and repeated Codex rate-limit
  points are idempotent under the stored-sample policy: an exact
  `(series, measuredAtMs, value)` replay is a no-op, never a second point.
- Imported activity is shown only as separate recorded activity in
  `UsageSnapshot.importedActivity`; it is never merged into OpenCode
  attribution weights or estimated burn, and Codex activity is included.

Usage history for the new providers: Mistral Vibe budget rows are recorded
when the platform reports `reset_at` (D11 budget rule); Antigravity CLI quota
rows are recorded like any quota row. Neither harness's local sessions are
imported in v1.4.0 (deferred, below).

## Owner decisions (v1.4.0)

- Native Usage tab keeps imported/derived state in memory only; no extra
  native persistence.
- Per-harness "Delete imported history" action in Settings (D10.3).
- Multi-account history uses presence spans (D8.1) rather than a provider-wide
  ambiguity switch.
- Stale-but-covered intervals stay attributed; only uncertified activity
  coverage makes an interval `activityUnavailable`.
- Budget rows are recorded in Usage history only when they carry a scheduled
  reset (D11); prepaid balances without a reset are not.
- Orphaned analytics snapshot `*.tmp` files are reclaimed on load in v1.4.0.
- Performance fix `a3762d56` (analytics warm reopen) is **not** merged: the fair
  3-way benchmark measured warm reopen medians of 166.55 ms (v1.3.3), 176.29 ms
  (v1.4.0) and 197.30 ms (v1.4.0 + fix), so the fix did not justify itself.

## Deferred (not in v1.4.0)

- Mistral Vibe and Antigravity CLI local session import.
- Analytics model persistence in SQLite instead of `analytics-v3.json`:
  v1.5, gated on a benchmark against the current JSON snapshot.
- Deriving a window start from a known window duration when no reset was
  observed (the current axis starts at the first observation or at an exact
  proven reset).

## Accepted risks

- An account switch inside a single Codex session that carries no
  `creator_account_id` is not detected: the session is one unknown account.
- First-evidence lag: a newly configured account becomes a rival only from its
  first recorded success or interruption (D8.1), so intervals in the cycles
  before that may still be attributed to the previous sole account.
- External use of the same subscription outside OpenCode is never excluded;
  the UI discloses that attribution is an estimate.

## Open product questions (owner)

- Q1 — the owner feedback sentence "There is no …" was cut off; it was not
  interpreted and needs the owner's completion.
- Q2 — the "Current" range label change is pending owner confirmation.
- Q3 — continuity tolerance (D5) is a technical choice (2× poll interval).
  Owner may prefer a different presentation rule.

## Progress log

- A: investigation complete; plan recorded.
- D1: privacy-minimal Claude Code and Codex history parsers plus incremental
  readers added (`src/lib/{codex-history,claude-code-history,usage-import,
  claude-transcript-usage}.ts`).
- D10 part 2: settings flags, schema v2, importer scheduling after live quota cycles,
  host-native exclusion capture, Codex rate-limit series, imported activity
  query, and privacy/restart/dedupe/exclusion/pricing tests added.
- External review fixes: certified analytics activity coverage; uncertain reset
  boundaries and exact-reset axis start; explicit failed/missing polling
  evidence overrides continuity tolerance; per-session unknown Codex import
  accounts with neutral "unknown account" labels; presence-span D8 eligibility.
- Usage redesign finished against owner feedback; Mistral Vibe and Antigravity
  CLI providers added with golden row-id, visibility and notification tests.
- Budget-with-reset history, orphaned analytics temp cleanup, and per-harness
  delete of imported history merged; integrated `pnpm verify` and Windows
  platform suite run on `feat/v1.4.0`.
