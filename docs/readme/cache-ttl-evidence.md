# Cache TTL evidence

The Native Cache observation pill shows two independent facts:

- **Cache share and `Hit` / `Unknown`** come from the host's own usage report for the last completed primary call: `cacheRead / (fresh + cacheRead + cacheWrite)`. A positive cache-read count is `Hit` (even at 7%). Everything else is `Unknown`, including a reported zero: OpenCode's `SessionUsage.tokens()` (v2.2.5, `core/src/session/usage.ts`) maps a missing cache-read count to 0, and nothing a plugin receives distinguishes "not reported" from a real 0, so a confirmed `Miss` cannot be shown. There is no percentage threshold.
- **`TTL ~…`** is an estimate: the request-start time of that call plus a route retention policy. The `~` is dropped only for an authoritative, applicable expiration timestamp. No supported host exposes one, so every countdown carries `~`.

The tooltip names the basis of the estimate: `configured`, `documented`, `empirical` (owner-approved observed retention), `observed` (Claude Agent 1-hour cache writes read from the session record, see below), or `fallback` (generic 5 minutes).

## Evidence hierarchy

1. Authoritative expiration timestamp — not exposed by any supported route.
2. Observed cache-write TTL tied to a known invocation — used only for Claude Agent, and only for 1-hour-only writes that match the step exactly (see below).
3. Confirmed request or host configuration — the model accepts a `cache.ttl` of 5 minutes or 1 hour for direct Anthropic and Kimi, but live calls deliberately do not read it: host settings are mutable and not tied to an invocation, so the observer uses the route default instead of guessing (covered by an existing regression test).
4. Documented or empirical route policy — what the pill uses today.

## Route findings (OpenCode CLI 2.2.5 inspected; `@opencode/plugin` 2.2.1 typings; peer range `>=2.0.16 <2.3.0`)

Findings come from source/typings inspection, vendor documentation, counts-only inspection of local transcript files, and the limited Claude Agent experiment described below.

**Claude Agent (`claude-agent`).** The Claude Agent SDK reports `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` per message, and OpenCode starts the SDK with persistence enabled, so transcripts appear under `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`). OpenCode's `session.step.ended` carries only aggregate `tokens.cache.read/write`; the 5m/1h split is not forwarded to plugins.

In one controlled OpenCode 2.2.5 tool-using run, a third-party plugin observed the SDK session ID and assistant transcript UUID in `session.tool.called.data.native`; the session ID named the transcript file and the UUID matched exactly one record's `uuid` (not `message.id`). In one text-only run, `session.text.ended` carried the same identifiers. `session.step.ended` carries none, and one OpenCode step can span several API messages while OpenCode reports usage for the last message only.

The observer therefore upgrades the estimate to **60 minutes** (basis `observed`) for one completed invocation only when all of these hold; otherwise the existing 5-minute estimate is unchanged:

- the last native IDs seen for that step name one transcript file at a single computed path (project directory encoded by replacing non-alphanumeric characters with `-`; no directory listing; encoded names over 200 characters are not attempted);
- the record with that `uuid` exists, and its `message.id` group (records repeat it per content block; the maximum of each counter is taken) has `input`, `cache_read` and `cache_creation` counters exactly equal to the step's reported tokens;
- that group's cache writes are 1-hour-only (`ephemeral_1h_input_tokens > 0`, `ephemeral_5m_input_tokens = 0`).

The reader opens that one file, reads at most its last 256 KB, ignores a partial trailing line, retries at most once on the session's next event (the SDK may not have flushed yet), and emits only a minimal `session.cache.ttl` message (session ID, assistant message ID, `3600000`). The SDK's long-path naming and the equality of the OpenCode session directory with the SDK working directory are unverified; either mismatch only means no evidence. Steps without native IDs (for example thinking-only steps) keep the estimate. A write TTL does not prove current cache residency, so the countdown keeps `~`. Upstream forwarding of the `cache_creation` split would remove the need for any file read.

**OpenAI ChatGPT OAuth.** The host sends TTL options but drops the response's cache-write and TTL breakdown (cache-write is hard-coded unset); only cached-read tokens reach plugins. The only other source would be an HTTP response hook, which this project does not use. The owner-approved estimate for GPT-5.6+ sign-ins (30 minutes, based on the active connection, not per-request proof) is unchanged, and the countdown is shown with `~`.

**Direct Anthropic and Kimi** keep the documented 5-minute default or the host-configured `cache.ttl` handling described above. **DeepSeek direct** (24 h) and **OpenCode Go / DeepSeek V4.1 Flash** (60 min) keep their owner-approved empirical policies. Unknown routes use the generic 5-minute fallback.

## Privacy

The observer reads no message content, prompts, headers, or credentials, makes no provider requests, and transmits nothing. The single exception is the Claude Agent 1-hour check above: it opens one session-scoped transcript file, parses it in memory, keeps only a few numeric cache counters, and never stores, logs, displays or transmits transcript content, paths or SDK identifiers.
