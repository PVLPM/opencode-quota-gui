# Native GUI implementation decisions

This log records material implementation decisions against the owner-approved
`docs/research/native-gui-migration-architecture.md` baseline. The research
report is intentionally ignored and remains unchanged.

## D01 — Isolate Git-backed verification fixtures

Stage: Preflight
Status: accepted
Problem: A full verification run can execute Git-backed tests from a Git hook.
Evidence: `tests/refresh-modelsdev-temporal-script.test.ts` invokes mutating Git
commands in a temporary directory without removing inherited `GIT_*` variables;
such variables can redirect Git away from that directory. The repository already
has `tests/helpers/isolated-git-env.ts` for this risk. The prior incident's exact
cause is not established.
Options considered: Run full verification unchanged; avoid all verification;
isolate the affected fixture and test against a disposable hostile Git target.
Decision: Isolate the affected fixture before relying on full verification.
Why: This contains a concrete test-safety risk without changing product behavior.
Trade-offs: A narrowly scoped test-only fix precedes migration verification.
Product impact: None.
Compatibility impact: None intended.
Test evidence: `npx vitest run tests/refresh-modelsdev-temporal-script.test.ts`
passed 32 tests, including a disposable hostile Git-environment regression;
the focused test also passed with inherited hostile variables targeting a
disposable repository whose HEAD and index remained unchanged. Biome passed.
Reversible: Yes.
Owner review: routine technical decision

## D02 — Host-owned snapshots and explicit transport injection

Stage: 1
Status: accepted
Problem: The HTTP server currently owns the snapshot cache and viewer-driven
pollers, making an independent Native transport impossible.
Evidence: `createDashboardServer` constructed and closed `SnapshotService`;
the existing lifecycle registry already shares one host among leases.
Options considered: Keep ownership in HTTP and create a second service; move
the existing service into the shared host and inject it into the Web transport.
Decision: Make the shared lifecycle host own the service and let HTTP attach to
it; adapt direct test and benchmark callers to own their injected service.
Why: This retains one backend and preserves the existing transport boundaries.
Trade-offs: Internal direct-server callers must provide and close a service.
Product impact: Web behavior is intended to remain unchanged.
Compatibility impact: Internal server-construction interface changes only.
Test evidence: Focused GUI suite passed 184 tests; `pnpm verify` passed with
4,623 tests passed and 50 skipped, plus five cross-surface tests. Windows
symlink-dependent cases were among the skips. Independent re-review passed.
Reversible: Yes.
Owner review: routine technical decision

## D03 — Invalidate snapshots across source-owner handoff

Stage: 1
Status: accepted
Problem: A surviving lease can otherwise receive fresh-looking cached data or
late results from the disposed source owner.
Evidence: The pre-existing cache is shared across leases; session snapshots do
not have a stale field. The host registry record also changed shape.
Options considered: Keep old cache fresh; clear everything; preserve markable
last-good data as stale while rejecting unmarkable old-generation results.
Decision: Track source generations, mark compatible old results stale, reject
unmarkable session results, and version the process-global host registry to v3.
Why: Avoid presenting old-owner data as current without changing DTO contracts.
Trade-offs: A session request crossing handoff can fail; an old v2 host still
holding the port can temporarily block a new v3 host rather than be adopted.
Product impact: Handoff-triggered refetch and explicit errors replace misleading
fresh data; normal operation remains unchanged.
Compatibility impact: A mixed-version in-process reload can require the old
host to release its configured port; no alternate port is selected.
Test evidence: Focused lifecycle and snapshot regressions passed, including
late in-flight results, fallback errors, and legacy registry isolation;
independent re-review found both reported issues addressed.
Reversible: Yes.
Owner review: review recommended

## D04 — Canonical opt-in Web transport

Stage: 2
Status: accepted
Problem: Web must be optional without disabling the shared runtime or making
GUI-independent recovery depend on Native functionality.
Evidence: Runtime settings already use revision-checked canonical JSONC, and
the lifecycle reads its fixed port at plugin startup.
Options considered: An automatic mode or recovery CLI; an explicit canonical
boolean with a full OpenCode restart after editing.
Decision: Use `dashboard.enabled`, default `false` for absent, invalid and
upgrade configurations; keep the runtime alive when Web is off or fails to bind.
Why: This implements the approved policy with the existing configuration and
ownership machinery and no additional process or recovery command.
Trade-offs: Web users must opt in and restart OpenCode; enabling it does not
change a running host until restart. Mixed-version in-process reloads may leave
an older listener alive, so recovery instructions require a full restart.
Product impact: Web is no longer available by default, including on upgrade.
Compatibility impact: Existing configured `dashboard.port` remains effective
when Web is explicitly enabled; Native Settings integration follows later.
Test evidence: `pnpm verify` passed: 4,636 tests passed, 50 skipped, plus five
cross-surface tests; Windows symlink-dependent cases were among the skips.
Reversible: Yes.
Owner review: important but reversible
