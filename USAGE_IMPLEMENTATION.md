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
| B | Observation store + polling capture | pending |
| C | Effort on owned steps + interval activity query + attribution | pending |
| D | Claude Code / Codex opt-in import + dedupe | part 1: privacy-minimal parsers/readers; settings + store wiring pending |
| E | Usage navigation, charts, inspection, breakdown (browser + native) | pending |
| F | Integration, benchmarks, review, screenshots, draft PR | pending |

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
provider/account display labels (local display data already present in the
existing caches; never tokens). Unchanged consecutive samples of a series in
the same epoch extend one `run` row (`first_at`, `last_at`, `sample_count`)
instead of inserting a row per poll — lossless for every derived quantity
(flat interval, endpoints, sample count) and bounded by change frequency, not
poll frequency. A run is only extended across a continuous link (D5).

### D4 Epoch / reset semantics (pure, `src/gui/usage-intervals.ts`)
Reuses the proven-reset rule of `src/lib/quota-reset-notifications.ts`
(`updateObservation`): a scheduled reset is proven when the later observation
is at/after the earlier observation's `resetAt` and the new `resetAt` is later.
- remaining non-increasing, reset not passed → same epoch (reset-time jitter of
  offset-derived providers does not split an epoch).
- remaining increased without a proven reset → `replenished` boundary
  (refill, banked/manual reset, correction) — never negative burn.
- unit / capacity / limit change → `identity-change` boundary.
- no reset information and value increased → `uncertain` boundary.
- duplicates (same sample) ignored; out-of-order samples ordered by
  `measuredAtMs`; a sample inside an existing run of different value is kept
  as its own point and the run is split (no data dropped).
Reset marker time: the earlier observation's `resetAt` when the provider
supplied it as an absolute timestamp; otherwise "reset between observations".

### D5 Continuity (solid vs dashed)
Consecutive samples are a continuously observed interval when the same
collector run recorded them as consecutive attempts for that card with no
intervening failure/cooldown/retained cycle **and** the elapsed time is at most
twice the collector's configured poll interval at that time (timer/sleep
tolerance). Otherwise the interval is unobserved: dashed connector when both
endpoints are in the same epoch, disconnected when a boundary intervenes.
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

### D8 Account eligibility
OpenCode serves a provider through one credential at a time and records no
per-message account. Activity through provider P is attributable to account A
only when A is the **only** account of P with observations overlapping the
interval. Multiple concurrent accounts → `ambiguous-account`. External use of
the same subscription can never be excluded; the UI always discloses this.

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

### D11 No new traffic
Capture hooks into the existing `createDelegatingSource.quota` observation
path next to the notification observer. No provider request is added, and
Usage reads never trigger provider polling.

## Provider capability matrix

(Filled from investigation; see section maintained in workstream B.)

## Open product questions (owner)

- Q1 — none blocking yet.
- Q3 — continuity tolerance (D5) is a technical choice (2× poll interval).
  Owner may prefer a different presentation rule.

## Progress log

- A: investigation complete; plan recorded.
- D1: privacy-minimal Claude Code and Codex history parsers plus incremental
  readers added (`src/lib/{codex-history,claude-code-history,usage-import,
  claude-transcript-usage}.ts`). Settings flags, store writes and cross-harness
  exclusion wiring remain with the integration lane.
