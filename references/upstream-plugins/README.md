# Upstream Plugin References

This directory stores committed local copies of selected published npm packages for reference, pricing/reference tests, sync, and review tooling. The copies are not an upstream sync target and are not refreshed automatically.

Tracked packages:

- `cursor-opencode-provider` (npm `latest`)
- `opencode-gemini-auth` (npm `latest`, the OpenCode 2 line since 2.x)
- `@anthonyhaussman/opencode-agy-auth` (npm `alpha`, the OpenCode 2 build; tracked internally under `references/upstream-plugins/opencode-agy-auth/`)

Each package follows the npm dist-tag set in `scripts/lib/upstream-plugin-specs.mjs`.

Companion identities are verified against npm package metadata and their canonical GitHub repositories.

## Maintenance policy

Fixes from upstream [`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) are ported selectively. Carry over a change only when it fixes a shared root cause, and preserve GUI-specific divergence (dashboard-only activation, canonical GUI settings, and the `opencode-quota-gui` private namespace). Do not replace the GUI tree with upstream.

Update these snapshots only for a concrete reason, such as a pricing-data change the GUI consumes or a companion plugin release the GUI needs. Keep the matching `references/upstream-plugins/lock.json` change in the same reviewed update, and edit the scripts rather than the copied package files.

`pnpm run upstream:check` is read-only: it compares tracked versions in `lock.json` with the published npm dist-tags and prints the result. It never opens or closes GitHub issues.

`pnpm run upstream:prepare-review` is a write operation. It runs the same sync path as `upstream:sync`, which rewrites the snapshots and lock, then prints a review handoff and runs tests and typecheck. Run it only when you deliberately intend to update snapshots; it is not a read-only check.

`pnpm run upstream:sync` also rewrites the snapshots and lock. Do not run either command routinely or as an automatic maintenance step. There is no scheduled workflow that opens or closes upstream update issues; the maintainer decides when to check and review.

Known embedded credentials from upstream packages are deterministically redacted during sync before the snapshots are committed. Update checks still come from `references/upstream-plugins/lock.json` version comparisons, not from sanitized file contents.
