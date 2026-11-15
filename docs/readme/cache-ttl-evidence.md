# Cache TTL evidence

The Native Cache observation pill shows two independent facts:

- **Cache share and `Hit` / `Miss` / `Unknown`** come from the host's own usage report for the last completed primary call: `cacheRead / (fresh + cacheRead + cacheWrite)`. A positive cache-read count is `Hit` (even at 7%), a reliably reported zero is `Miss`, and missing or ambiguous counters are `Unknown`. There is no percentage threshold.
- **`TTL ~…`** is an estimate: the request-start time of that call plus a route retention policy. The `~` is dropped only for an authoritative, applicable expiration timestamp. No supported host exposes one, so every countdown carries `~`.

The tooltip names the basis of the estimate: `configured`, `documented`, `empirical` (owner-approved observed retention), or `fallback` (generic 5 minutes).

## Evidence hierarchy

1. Authoritative expiration timestamp — not exposed by any supported route.
2. Observed cache-write TTL tied to a known invocation — not reachable (see below).
3. Confirmed request or host configuration — the model accepts a `cache.ttl` of 5 minutes or 1 hour for direct Anthropic and Kimi, but live calls deliberately do not read it: host settings are mutable and not tied to an invocation, so the observer uses the route default instead of guessing (covered by an existing regression test).
4. Documented or empirical route policy — what the pill uses today.

## Route findings (OpenCode CLI 2.2.5 inspected; `@opencode/plugin` 2.2.1 typings; peer range `>=2.0.16 <2.3.0`)

Findings come from source/typings inspection and vendor documentation, plus counts-only inspection of local transcript files. They are not live per-route experiments.

**Claude Agent (`claude-agent`).** The Claude Agent SDK reports `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` per message, and OpenCode starts the SDK with persistence enabled, so transcripts appear under `~/.claude/projects`. They cannot be used reliably:

- OpenCode's `session.step.ended` carries only aggregate `tokens.cache.read/write`; the 5m/1h split is not forwarded to plugins.
- The link from an SDK session to an OpenCode session lives in host-private storage (`claudeSessionID`). No documented plugin API or event field exposes an SDK session or message id, so a transcript record cannot be attributed to an OpenCode session, model, or request without a global transcript scanner or host-private reads. Both are out of scope.
- Local transcripts repeat streamed records with the same `message.id`; any future reader must de-duplicate by it, and a write TTL alone would still not prove current cache residency.

The existing estimate is kept. If OpenCode later forwards the `cache_creation` split and the SDK session id on `session.step.ended`, an observed-write source could be added.

**OpenAI ChatGPT OAuth.** The host sends TTL options but drops the response's cache-write and TTL breakdown (cache-write is hard-coded unset); only cached-read tokens reach plugins. The only other source would be an HTTP response hook, which this project does not use. The owner-approved estimate for GPT-5.6+ sign-ins (30 minutes, based on the active connection, not per-request proof) is unchanged, and the countdown is shown with `~`.

**Direct Anthropic and Kimi** keep the documented 5-minute default or the host-configured `cache.ttl` handling described above. **DeepSeek direct** (24 h) and **OpenCode Go / DeepSeek V4.1 Flash** (60 min) keep their owner-approved empirical policies. Unknown routes use the generic 5-minute fallback.

## Privacy

The observer reads no message content, prompts, headers, credentials, or transcript files, makes no provider requests, and transmits nothing.
