# Contributing to OpenCode Quota GUI

Thanks for contributing. Please read this before you open an issue or pull request.

## Issues first

- Open an issue before a feature, fix, refactor, or behavior change. Opening the issue and PR together is fine.
- Link it in the PR with `Fixes #<issue>` or `Refs #<issue>`. No issue? Explain the reason and scope in the PR.
- Use an issue form (bug, feature, or provider request). Write a short, specific title; the form adds the label, so skip `[bug]`-style prefixes.
- Very short or mostly empty issues get the `needs info` label. Adding the details removes it. `needs info` issues close after 21 days without activity; nothing else auto-closes.

## Setup

Node.js `^22.13.0 || >=23.4.0` and pnpm 11:

```sh
corepack enable
corepack prepare pnpm@11.0.0 --activate
pnpm install
```

`pnpm install` also installs the Git hooks: pre-commit formats staged files with Biome; pre-push runs `pnpm verify`.

## Checks

Run `pnpm verify` before opening a PR. It runs lint and formatting, typecheck, build, all tests, the supported cross-surface contract test, and package checks. CI runs the same command, then installs the packed package on Node 22 and 24 as a smoke test.

Upstream plugin snapshots are reviewed by hand. `pnpm run upstream:check` reports drift against `references/upstream-plugins/lock.json` without writing. `pnpm run upstream:prepare-review` rewrites the snapshots and lock before building the review handoff, so run it only for a deliberate snapshot update. No scheduled workflow opens or closes upstream update issues; commit snapshots only after that review.

For quick iteration: `pnpm run test:watch`.

## Rules the code must keep

- **No AI calls.** Never send a request to an AI model to produce anything the plugin shows. Calling a provider's quota or billing API is fine.
- **OpenCode 2 only.** No OpenCode 1 code, APIs, or tables.
- **Dashboard-only activation.** The server plugin starts the dashboard and keeps the credential and reset-retry lifecycle working. It does not register slash commands, tools, RPC methods, report hooks, TUI surfaces, toasts, terminal quota interfaces, or terminal reports. The separate `init` and `update` CLI commands are maintenance only, not a quota surface. This release has no TUI entry or artifact, and no TUI surface is a supported product path.
- **Canonical settings.** Runtime code reads the global canonical GUI config plus defaults. Legacy settings are available only through the explicit read-only import preview. Do not add a runtime fallback to upstream private state.
- **Private namespace.** GUI caches, state, locks, and reset observations stay under the GUI-owned `opencode-quota-gui` namespace. Never read, copy, overwrite, or delete upstream `opencode-quota` private state.
- **Credentials.** Read OpenCode logins only through `ctx.integration` in `src/lib/opencode-auth.ts`. Do not read `auth.json`, a project secret, or an upstream credential cache.
- **Money.** Show amounts with the provider's ISO code through the shared formatter (e.g. `USD 12.50`). No symbols, conversions, or adding up different currencies.
- **Visibility IDs.** Opaque card, row, and provider IDs are a persistence contract. Do not rename, re-derive, or migrate them; hiding is presentation state only.
- Keep these boundary tests passing and up to date: `tests/plugin.gui-only.test.ts`, `tests/gui.config-canonical.test.ts`, `tests/lib.config.runtime-canonical.test.ts`, `tests/lib.private-state-namespace.test.ts`, `tests/package-manifest.test.ts`, and `tests/quota-provider-boundary.test.ts`.

## Provider changes

**Built-in providers** are considered only when:

- the provider is on [models.dev](https://models.dev/),
- at least two independent users asked for it (your own request, repeat comments, and requests from the provider's own company don't count),
- it has a documented API (no login cookies or website scraping), and
- the PR links that evidence and explains why a custom provider isn't enough.

Even then, it needs a reasonable maintenance cost.

**Pick the right path:**

| You want to… | Use |
| --- | --- |
| Use an OpenAI-compatible model service OpenCode doesn't include | an OpenCode custom provider |
| Track quota for a provider OpenCode already exposes (request estimates or one fixed quota endpoint) | a `quotaProviders` definition in the canonical GUI config; its `providerId` must match OpenCode's |
| Anything the custom path can't do, and the policy above is met | a built-in provider |

**Building one:** for API-key or token providers, start from `contributing/provider-template/` (see its README), replace every example name, and add tests for every auth source. Use the README setup label that matches reality: `Automatic` or `Needs setup`.

**Every row** carries `AccountingMetadata`. Pick `resultType` by what the number means (`quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, `status`), not by what's easiest to draw, and name the real source in `authority`. `user_configured` is only for a basis fact such as a user-set limit, never a row.

Rich providers (more than a percentage) also:

- send numbers as typed `quantity` rows or percentage `basis` facts, and booleans as `boolean` rows; never pre-formatted money strings;
- set `semantic` with an explicit `primary` or `supplementary` prominence;
- keep `used`, `limit`, and `remaining` literal;
- keep labels short: the concept only, no values, units, or reset text;
- format through the shared accounting formatter.

A simple percentage-only provider may keep the plain percent row, with accurate `AccountingMetadata`.

## Fixes

Make the smallest safe fix for the root cause. Match current OpenCode behavior instead of adding extra hook layers. Test against the current released OpenCode version and name it in the PR.

## Before-and-after screenshots (required)

Every PR that changes the dashboard must include before-and-after screenshots taken with the same config, model, theme, and window size. Cover the affected Quota, Analytics, and Settings routes and say which routes you didn't test. Keep credentials, account identifiers, and private paths hidden. Tests don't replace screenshots, and screenshots don't replace tests. No visible change? Write `Not applicable` and explain why.

## PR checklist

- [ ] Linked issue, or a short reason there is none
- [ ] `pnpm verify` passes
- [ ] Tested on the current released OpenCode; version noted
- [ ] Before-and-after dashboard screenshots and route results, or `Not applicable`
- [ ] Docs updated if commands, config, or workflow changed (usually `README.md`)
- [ ] New built-in provider: models.dev link, two independent requests, why custom isn't enough
- [ ] New API-key/token provider: started from the provider template, or explained why not
