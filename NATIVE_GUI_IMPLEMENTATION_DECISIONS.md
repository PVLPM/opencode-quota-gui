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

## D07 — GUI build and narrow native seams

Stage: 4
Status: provisional
Problem: Desktop requires a host-loaded GUI bundle; it does not supply the
browser-only `@opencode/ui` imports or the Web provider-logo asset route.
Evidence: The official GUI Vite preset emits a single CJS bundle and limits
host-provided modules. The existing Quota and temporal components are Solid/DOM.
Options considered: Separate package or duplicate Quota; reuse shared views and
replace the existing UI and logo seams only for the GUI bundle.
Decision: Build one `./gui-experimental` export with SDK 2.2.0 and reuse shared
Quota/temporal views with a small native primitive and bundled-logo adapter.
Why: This keeps the product implementation and backend shared without relying
on localhost or adding a cross-host framework.
Trade-offs: Inline logos increase bundle size; native popover placement and
host styling require real Desktop verification.
Product impact: Experimental Desktop Quota slice; Analytics and Settings
remain later stages rather than being represented as complete.
Compatibility impact: GUI requires Desktop 2.2.0+; see D09 for the server
peer range and the limits of the packed-host evidence.
Test evidence: `pnpm verify` passed: 4,736 tests passed, 50 skipped, plus five
cross-surface tests. Native bundle and shared-view tests passed; live Desktop
geometry, interaction and host loading remain unverified.
Reversible: Yes.
Owner review: review recommended

## D09 — Bounded OpenCode SDK peer range

Stage: compatibility verification
Status: provisional
Problem: The exact 2.0.16 plugin peer rejects strict installations with newer
OpenCode SDKs, including those required by the experimental Desktop GUI.
Evidence: The packed server plugin completed setup, health and settings RPC,
and cleanup in isolated Bun SDK hosts 2.0.16, 2.1.4, 2.2.0 and 2.2.5 with Web
off. The original exact peer failed strict npm resolution on the newer versions.
Options considered: Keep the exact peer; raise the minimum to 2.2.0; permit
the tested 2.0–2.2 minor lines while excluding the next unverified minor.
Decision: Declare `>=2.0.16 <2.3.0`; retain the exact 2.2.0 build SDK and the
separate Desktop 2.2.0 minimum.
Why: Preserve the tested legacy server path while allowing strict installation
alongside the tested newer SDKs.
Trade-offs: The range includes patch releases not individually exercised; a
future minor requires new compatibility evidence. Node's direct CJS import of
the GUI bundle is not a Desktop loader test, and real Desktop loading remains
unverified. Forced dependency trees can duplicate OpenCode internals; use
normal peer resolution instead.
Test evidence: Isolated host probes passed at the four specified versions;
strict peer resolution on an isolated staged package passed those versions and
rejected the adjacent bounds. `pnpm verify` passed: 4,778 tests passed, 50
skipped, plus five cross-surface tests.
Reversible: Yes.
Owner review: review recommended

## D08 — Share route containers and Settings form

Stage: 5
Status: provisional
Problem: Native requires the complete existing dashboard hierarchy and
revision-safe Settings without duplicating feature logic.
Evidence: Web route containers already compose the existing views, charts,
visibility catalog and canonical settings form.
Options considered: Reimplement each Native feature; extract and reuse the
existing route containers with a small host navigation and SettingsPage shell.
Decision: Share the route containers and settings form; retain native-local
navigation and host lifecycle only. Show the Web switch in Native Settings.
Why: One feature implementation preserves product semantics across transports.
Trade-offs: Host-specific layout, focus and popup behavior still need Desktop
verification; the settings page uses a separate viewer of the same runtime.
Product impact: Native navigation and Settings target existing capabilities;
unavailable settings are reported rather than showing hidden cards by default.
Compatibility impact: Uses the experimental OpenCode SettingsPage API.
Test evidence: Independent re-review found the addressed Settings and
visibility issues resolved. `pnpm verify` passed: 4,778 tests passed, 50
skipped, plus five cross-surface tests. Real Desktop testing remains pending.
Reversible: Yes.
Owner review: review recommended

## D06 — RPC viewers and setup-scoped registrations

Stage: 3
Status: accepted
Problem: Native and Web need the same snapshots and viewer-driven pollers, while
multiple plugin setups may share a host but have distinct SDK cleanup scopes.
Evidence: OpenCode's RPC registration is scoped to its originating setup; its
registry supports multiple same-ID registrations and routes to the latest.
Options considered: Share one registration across SDK scopes; register per
setup while sharing the snapshot invalidation subscription.
Decision: Register per setup, share the runtime/subscription, and hold a scoped
viewer for the duration of an abortable RPC watch. Combine Native viewer scopes
with existing Web interest rather than adding independent polling.
Why: A registration shared across SDK scopes can disappear when its creator
unloads; per-setup registration keeps a surviving setup callable.
Trade-offs: Correct watch cleanup depends on host cancellation behavior; real
Desktop disconnect/reconnect behavior remains to be verified. Existing Web
tabs retain their legacy shared scope semantics.
Product impact: Native and Web receive the same data and settings invalidations.
Compatibility impact: Uses the official RPC API available in SDK 2.0.16.
Test evidence: Scoped-finalizer, workspace routing, reconnect and lifecycle
regressions passed; independent re-review passed. `pnpm verify`: 4,684 passed,
50 skipped, plus five cross-surface tests; Windows symlink cases were skipped.
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

## D05 — Native RPC trust boundary

Stage: 3
Status: accepted
Problem: The official plugin RPC does not supply caller identity for a
per-method authorization check, while dashboard settings include writes.
Evidence: OpenCode 2.0.16 and 2.2.5 route RPC through server-wide authorization;
the normal CLI binds loopback and uses a generated password. Authenticated
remote callers can invoke registered methods, and custom passwordless embedded
servers rely on the embedder's access control. RPC handler context exposes no
documented caller identity. See the official server authorization middleware
and RPC handlers in the corresponding OpenCode source tags.
Options considered: Depend on host authorization; invent an independent
credential system; omit required Native settings operations.
Decision: Use the supported host authorization boundary and expose only the
explicit, validated dashboard operations; omit credentials and internal paths.
The existing settings-path display remains an exception already exposed by Web.
Why: This is the documented server transport and preserves the shared backend
without inventing an unsupported authentication system or removing settings.
Trade-offs: An authenticated OpenCode server client can invoke the registered
methods; a passwordless embedder must provide its own access control.
Product impact: Native and Web use the same settings model.
Compatibility impact: Depends on OpenCode's server security configuration.
Test evidence: Contract/security review and focused tests passed; real host
authorization and Desktop integration were not exercised in this workspace.
Reversible: Yes.
Owner review: review recommended
