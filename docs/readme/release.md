# Releasing (maintainers)

Releases are manual. Nothing publishes on a GitHub Release, a tag push, a schedule, or a
branch push. The only entry point is the **Publish to npm (manual tag dispatch)** workflow
(`.github/workflows/publish-npm.yml`), started by a maintainer with
`workflow_dispatch`.

## Dispatch inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `tag` | yes | — | An existing tag in this repository whose commit already has the matching `package.json` version. The workflow never creates or moves a tag. |
| `publish` | yes | `false` | Explicit publication confirmation. The `publish` job also requires the repository variable `NPM_PUBLISH_ENABLED` to be exactly `true`. |

Leaving `publish` at its default runs a publish-free rehearsal: verify, pack once, smoke.

## What each stage does

1. `release-package` — checks out `refs/tags/<tag>`, asserts the checked-out commit is the
   tag's commit and that `verify:release-version` matches the tag, then runs the canonical
   `pnpm verify`, packs the release artifact once on Node 24
   (`pack:release-package`) and uploads that exact tarball together with its
   `release-artifact.json` SHA-256 manifest. The version assertion always runs for the
   dispatched tag: it is never conditional or advisory, and a blank tag input fails the
   job instead of silently skipping the check.
2. `runtime-smoke` — installs and imports the uploaded tarball on Node 22 and Node 24.
3. `publish` (guarded by both switches) — verifies the received tarball against its
   SHA-256 manifest, chooses `next` for prerelease versions and `latest` otherwise, and
   publishes that exact file with npm provenance (`--provenance`) over OIDC
   (`id-token: write`). It never rebuilds or repacks.

No job writes to the repository: there is no version-sync commit, no automatic tag, no
npm dist-tag bookkeeping step, and no `git push`. Branch and tag state is read-only, so
the release cannot mutate what it verifies.

## Before dispatching

- Decide the version and set it in the commit to release; the workflow refuses a
  tag/version mismatch. No tooling rewrites `package.json` for you.
- Run the canonical release check locally: `pnpm run release:check`
  (`pnpm verify && pnpm run verify:release-version`). The `prepublishOnly` hook runs the
  same check and never calls back into `npm publish`, `pnpm publish`, or packing, so it
  cannot recurse.
- Optionally pack and smoke the artifact end-to-end: `pnpm run verify:release-package`.

## Additional analyzers are advisory

Biome remains the blocking formatter/linter in `pnpm verify`.

- `pnpm run lint:oxlint` stays strict and runnable: it invokes the real Oxlint binary and
  propagates its exit code. It is intentionally **not** part of the blocking `verify`
  chain; CI runs it as an advisory step whose outcome is annotated (`::warning`) and
  never fails the job. `pnpm run lint:oxlint:upstream` sweeps the whole tree
  advisory-only.
- `pnpm run knip` still runs advisory in CI (`continue-on-error`) and never fixes or
  deletes anything.
- Measured residual snapshot (2026-10-19, strict new paths): **150 errors + 4 warnings**.
  Findings are reported, not suppressed, and no baseline or cleanup campaign is added.
  These counts are a point-in-time measurement of a worktree that other stabilization
  lanes were still editing, not a gate.
