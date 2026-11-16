# Repository agent policy

## Scope and product decisions

- User and orchestrator tasks define approved scope. Agents may make technical decisions that preserve existing contracts; only the owner approves new product behavior, defaults, thresholds, limits, fallbacks, or UX requirements.
- Isolate genuine ambiguities and continue independent approved work. Prefer the smallest complete implementation; avoid speculative abstractions and unrelated refactoring.

## Understand the current checkout

- Check the current branch, HEAD, applicable instructions, callers, contracts, and tests before changing code.
- Prefer CodeGraph for architecture exploration if already available; otherwise use LSP and repository search. Never assume another worktree's index describes this checkout. Refresh CodeGraph after substantial structural changes when using it.
- Never commit generated indexes, caches, or logs.

## Reuse before creating

- Before adding reusable logic, search existing implementations by behavior, symbols, and call sites. Reuse code when contracts and lifecycle match.
- Avoid duplicate parsers, validators, mappers, adapters, caches, retry mechanisms, services, and helpers. Inspect the diff for duplication and check the combined result again after integrating parallel worktrees.
- Do not merge code merely because it looks similar when responsibilities or contracts differ. Do not introduce abstractions solely to silence duplication tools.

## Optional tools

- CodeGraph and jscpd MCP are optional developer tools. If unavailable, use existing alternatives and continue independent work. When installation materially benefits the task, explain the benefit and ask permission first.
- Do not silently install global packages, MCP servers, or skills, or change user-wide configuration. Repository-required verification commands are not optional.
- Memory tools may assist navigation, but current source and requirements take precedence over their outputs.

## Commits and collaboration

- Make cohesive, independently reviewable commits after completed, validated workstreams. Stage exact files or hunks; never use blanket staging, `git commit -a`, or bypass hooks.
- Preserve user files, active worktrees, and unrelated changes. Keep parallel agent workstreams in separate approved scopes.
- Do not rewrite history, force-push, merge, tag, release, or publish without authorization.

## Verification and review

- Run focused tests during implementation and `pnpm verify` for relevant completed changes. Run Windows-specific checks when required by the change or task.
- Diagnose failures rather than weakening tests without evidence. Independently review substantial or high-risk changes.
- Report confirmed defects, risks, and optional improvements separately. Never claim verification that was not performed.

## Security and privacy

- Never commit credentials or private local configuration. Protect account data, tokens, raw prompts, private paths, and other sensitive information; sanitize logs, diagnostics, and tool outputs appropriately.
- Preserve existing security and compatibility contracts.
