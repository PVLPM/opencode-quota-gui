[← Back to README](../../README.md)

# Configuration

The dashboard has one canonical settings file. Defaults fill anything it leaves unset, and the dashboard does not read inherited legacy layers at runtime.

## Where the dashboard reads settings

```text
~/.config/opencode/opencode-quota-gui/config.jsonc
```

`$XDG_CONFIG_HOME/opencode` replaces `~/.config/opencode` when `XDG_CONFIG_HOME` is set, and `OPENCODE_CONFIG_DIR` replaces the global OpenCode config folder. Use JSONC for comments and trailing commas. A sibling `opencode-quota-gui/config.json` is not read, converted, or imported implicitly; it is preserved unchanged.

Behavior settings are always global. A project install selects only the project OpenCode plugin entry; it does not create project behavior settings. This is true whether OpenCode uses `opencode.json` or `opencode.jsonc`.

The Settings page writes only this canonical file. A project or workspace setting does not become effective by being present in an OpenCode config file: only the canonical file and defaults are read by the dashboard.

Settings values, provenance, the dashboard port, and visibility lists come only from the canonical file and defaults. The web dashboard switch is stored in the same file as `dashboard.enabled`: an absent value follows the OpenCode host version (on below 2.2.1, including 2.2.0; off at 2.2.1 and newer), and a valid explicit `true` or `false` always wins. A missing or unparseable host version fails closed if the switch is absent. When on, it serves the fixed loopback port. The separate import preview is the only path that reads inherited legacy values.

Provider credential sidecars are separate files in the same GUI namespace. For example, Xiaomi MiMo may use `opencode-quota-gui/mimo.json`; that file supplies only a provider cookie and is not part of the canonical behavior config. No sidecar is merged into `config.jsonc`.

## Settings page

In OpenCode Desktop 2.2.x, open the plugin's page in OpenCode Settings. Alternatively, when the web dashboard is enabled, open <http://localhost:4144/settings>. The page groups the supported controls:

| Group | What it changes |
| --- | --- |
| Wait for quota reset | `waitForQuotaReset`; holds a request when a used-up quota window has a known reset. `autoResumeOnQuotaRecovery`; after a quota-limited session stops, sends one `continue` when the failed route's window resets (off by default). |
| Display | `percentDisplayMode` (remaining or used) and `percentLabelStyle` (full or bare). |
| Advanced | Provider selection, minimum refresh interval, Claude Agent polling interval, request timeout, and accounting detail. |
| Temporal pricing | Shows or hides live peak and off-peak status per provider. Presentation only. |
| Visibility | Shows or hides cards and rows, and reorders cards. Presentation only. |
| Dashboard | Read-only address, the canonical file path, configuration issues, and build details. |

Saving Settings writes to the canonical file atomically. If the file changed elsewhere, the save returns a conflict and keeps your draft. The Desktop Settings page includes the web dashboard switch; changing it requires an OpenCode restart. You can also use the manual recovery edit under [Web dashboard](#web-dashboard).

### Auto-resume on quota recovery

`autoResumeOnQuotaRecovery` is off by default. When enabled, a session that terminally fails on a genuine provider quota limit is resumed once, without a native continue API:

1. The failure must be a quota-shaped error (a typed provider rate-limit or quota error, or HTTP 429), or a known Claude Agent subscription-limit message that OpenCode 2.4.1 exposes without a type. The plugin must then observe a used-up primary provider quota or rate-limit window for the failed route, with a known future reset. Only primary route windows count: supplementary, budget, value, named, Code Review and MCP rows are not evidence, except that the Claude Agent `Fable weekly` row is evidence only for a Fable model. The rows must be bound to one verified identity: the same active OpenCode account, or—for a single-source route such as Claude Agent—the same stable credential identity that the provider cache reports when arming and at every recovery check.
2. Recovery uses the same reset transition as reset notifications: a later observation of that window, for the same identity, with a newer future reset and more availability than the used-up observation. A positive percentage alone is not enough. The first recovery check runs at the expected reset; after confirmed recovery the plugin allows two minutes of inactivity.
3. Only if the session is still failed, idle, on the same model and identity, it sends one `continue` prompt with `opencode-quota-gui-autoresume` metadata. That prompt appears in the transcript as a user message; no tool action is replayed. One resume is consumed per user-initiated execution: if that `continue` run fails on quota again, auto-resume waits for a fresh user prompt.

A user prompt, interruption, model switch, credential change, session deletion, another execution or turning the setting off cancels the pending continuation. Temporary gaps in evidence do not: a failed quota check, a provider cooldown, an RPC timeout, a missing row or an unreadable session keeps the continuation pending and is checked again a minute later. Missing evidence never authorizes a continuation, so if a reset happens entirely while evidence is unavailable, that cycle is not resumed. A route whose provider registration has no auto-resume contract is permanent, not temporary: it is rejected before the live quota probe, never resumes, and is not polled again. Native retry and provider cooldown policies still decide first. The wait is in-process only: a plugin or OpenCode restart drops a pending resume, and the next terminal quota failure starts a new cycle.

**Claude Agent subscription limits:** OpenCode 2.4.1 can report a Claude Agent five-hour or weekly subscription limit as an untyped `provider.unknown` error with only a message (no status, retry time or quota type; [anomalyco/opencode#63189](https://github.com/anomalyco/opencode/issues/63189)). Auto-resume recognizes only the known Claude Agent message shapes, and only on the `claude-agent` or `claude-code` route. A recognized message alone never authorizes a continuation: the same verified Claude identity must independently report the applicable `five_hour` or `week` window exhausted with a future reset, or the `Fable weekly` row for a Fable model. If that evidence is unavailable, the continuation stays pending and is checked again a minute later. Native retry is not changed and still keeps OpenCode's own timing for these untyped messages.

Eligibility follows the evidence the failed route can bind, and the route's provider registration decides it before the live probe:

- **Account-bound:** Copilot, OpenAI, xAI, OpenCode Go and OpenCode Zen resume only when the failed route's active OpenCode credential row is available. OpenCode Zen also needs its primary monthly budget window and reset; Copilot's managed usage or budget-only rows cannot arm.
- **Single-source:** Claude Agent's verified Claude CLI login binds through its Claude identity scope (protected `rai1_`, or the in-memory `rai1p_` identity on Windows). Synthetic, Chutes, NanoGPT and Ollama Cloud bind through the same provider cache scope where that stable identity exists. On Windows, a key-only route without a protected key identity is not resumed; Claude Agent still binds through its in-memory identity.
- **Account or key:** MiniMax Token Plan, MiniMax Token Plan (CN), Z.ai and Zhipu bind to the active OpenCode credential row when one is reported; with no rows they use the single-source cache scope when available.
- **Never:** Anthropic (per-minute API value rows), OpenRouter (key-limit/budget and spend rows without a primary route window or reset), Kilo Gateway (credit and balance components), Cursor (named API rows), Gemini CLI and Google AGY (bucket rows without primary window semantics), Kimi Code and Kimi Code (CN) (named rows without primary window semantics), DeepSeek (balance components), Xiaomi MiMo (monthly window without a reset), Alibaba Coding Plan and Alibaba Personal Token Plan (no route identity scope), and custom `quotaProviders` (no typed primary route window). These routes are rejected before the live probe, never auto-resume, and an inferred account row cannot make them eligible.

### Visibility identifiers

Use **Settings → Visibility** to hide individual cards and rows, and drag a card's or row's grip or press Alt+Up/Down from it to reorder. Each Visibility card represents one Home card, including separate accounts under the same provider. Hiding cards or rows never disables quota polling or deletes data.

New card-eye actions store exact opaque card ids in `dashboard.hiddenCards`; row eyes use `dashboard.hiddenRows`. Reordering writes opaque card ids to `dashboard.cardOrder` and opaque row ids per card to `dashboard.rowOrder`. Do not construct these ids from labels or copy them between accounts. A non-empty card order lists preferred cards first; new or unlisted cards append in backend order. A non-empty row order lists preferred rows first; new or unlisted rows append in provider emission order. The legacy `dashboard.providerOrder` still contains provider ids, is preserved unchanged, and applies when card order is absent or empty.

Older `dashboard.hiddenCards` lists had no semantics marker, so a full provider-scope card id there meant a provider-wide hide. On read, those ids are automatically normalized to the plain provider id, and the next hidden-card save records `dashboard.hiddenCardsVersion: 2`. That marker is read-only metadata; version 2 lists keep exact card ids, so hiding a provider-scope card no longer hides its sibling account cards. Plain provider ids and legacy bare provider-scope hashes remain provider-wide group hides. Their card eyes stay enabled: **Show** removes those group markers from the draft and stores exact hides for every other card the current Visibility catalog knows for that provider, keeping the selected card visible. Unknown ids and other providers are preserved. Row eyes remain independent.

### Temporal pricing status

**Settings → Temporal pricing** lists every provider with time-based pricing rules and toggles its live peak and off-peak status in the Quota header. Choices are stored sparsely in `dashboard.temporalProviderOverrides` as provider ids mapped to booleans. A provider with a discovered account is shown by default; an explicit `true` or `false` overrides that default. The setting changes presentation only: it does not change polling, quota values, or recorded usage.

For absolute price rules, status compares each rule with the base rates captured from the same source policy, so an unrelated live or derived API price cannot turn a known schedule into **Unknown**. A route whose schedule cannot be verified stays **Unknown** instead of being guessed. The dated schedule preview projects at most three days ahead; its end is a display horizon, not an expiry or validity window.

### Web dashboard

The browser dashboard default follows the OpenCode host version. On supported hosts below 2.2.1, including 2.2.0, it is on by default, including after an upgrade from `1.2.0` or earlier, because the full Native panel requires 2.2.1 or newer. At 2.2.1 and newer it is off by default. A valid explicit `dashboard.enabled: true` or `false` always wins. If the host version is missing or unparseable and the switch is absent, web access fails closed. A malformed canonical file or invalid `dashboard.enabled` also fails closed. When on, it starts the optional HTTP/SSE/static transport; when off, none starts.

To force it on (or off), edit the canonical file and restart OpenCode:

```jsonc
{
  "dashboard": {
    "enabled": true,
    "port": 4144
  }
}
```

Then open <http://localhost:4144/quota>. This manual JSONC edit is also the recovery path when the dashboard is unavailable and no GUI is reachable. The plugin reads `dashboard.enabled` when its dashboard lifecycle starts; the setting is not hot-reloaded while OpenCode is running.

The plugin's retry handling, credential integration, and shared dashboard runtime keep running whether the browser transport is off or on. Disabling the web transport starts no HTTP listener, SSE stream, or static file server. Quota is collected on demand through the shared runtime, and no background quota or analytics poller starts until a transport has a viewer.

### Port

`dashboard.port` defaults to `4144` and is read-only in the web UI. To change it, edit `dashboard.port` in the canonical file and restart OpenCode. Set `dashboard.enabled` explicitly only if you also want to pin web access on or off:

```jsonc
{
  "dashboard": {
    "port": 4144
  }
}
```

The server binds to `127.0.0.1` only. It does not choose a fallback port when the configured port is unavailable.

## Legacy settings import

Existing global legacy OpenCode Quota settings are read only for the explicit import preview. The Settings page can copy these seven keys into the canonical file:

- `percentDisplayMode`
- `percentLabelStyle`
- `enabledProviders`
- `minIntervalMs`
- `requestTimeoutMs`
- `accountingDetail`
- `waitForQuotaReset`

The import never edits, moves, or deletes the source files; they stay byte-for-byte untouched. Definitions are not imported: `quotaProviders` must be defined in the canonical file. Legacy layers include a global `opencode-quota/quota-toast.json(c)` and `experimental.quotaToast` in an OpenCode config file. They remain readable as import sources, not as runtime settings.

## Common settings

```jsonc
{
  // Automatic provider discovery, or a manual list of provider ids.
  "enabledProviders": ["copilot", "openai", "google-agy"],

  // Show what is left, or what has been used.
  "percentDisplayMode": "remaining",

  // Full adds "used"/"remaining" beside the percentage; bare shows only the number.
  "percentLabelStyle": "full",

  // Keep OpenCode's normal retry timing when false.
  "waitForQuotaReset": true,

  // After a quota-limited session stops, send one continue when its window resets. Off by default.
  "autoResumeOnQuotaRecovery": false,

  // Minimum time between provider refreshes, and each provider request timeout.
  "minIntervalMs": 60000,
  "requestTimeoutMs": 5000,

  // Minimum spacing between Claude Agent usage requests, shared by every OpenCode
  // process. Defaults to 180000; values below 60000 are raised to 60000.
  "claudeAgentPollIntervalMs": 180000,

  // "summary" keeps main rows; "detailed" adds supplementary rows.
  "accountingDetail": "summary"
}
```

`enabledProviders: "auto"` discovers providers from OpenCode. A manual list must include `quota-providers` when you use custom definitions, plus every built-in provider you still want.

The legacy `claude` alias now selects `claude-agent`; use `anthropic` explicitly for the Anthropic API route. Anthropic reports only passive API rate limits, and Claude subscription quota requires the Claude Agent CLI login.

## Optional OpenTelemetry

`telemetry.enabled` defaults to `false`. Set it in the canonical file; the Settings page does not expose this control. When enabled, the plugin publishes `opencode.quota.consumed` and `opencode.quota.cache.age` through the global `@opentelemetry/api` meter provider supplied by the host. The package does not create a provider, exporter, collector, or metrics endpoint, and it makes no extra provider requests. Host-owned setup and the limits of this integration are in [External integration](external-integration.md#optional-opentelemetry-advanced-host-owned).

```jsonc
{
  "telemetry": {
    "enabled": true
  }
}
```

## Advanced provider settings

These keys live in the canonical file. They are provider-specific and optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `anthropicBinaryPath` | `"claude"` | Claude CLI command or path. With `"claude"`, OpenCode's `PATH` is tried first, then the usual install folders (not on Windows). |
| `opencodeGoWindows` | `["rolling", "weekly", "monthly"]` | Which OpenCode Go windows appear: five-hour, weekly, and monthly. |
| `opencodeMonthlyLimit` | unset | Override the OpenCode Zen monthly budget in USD. |
| `cursorPlan` | `"none"` | Cursor included API budget: `none`, `pro`, `pro-plus`, or `ultra`. |
| `cursorIncludedApiUsd` | unset | Override Cursor's monthly included API budget in USD. |
| `cursorBillingCycleStartDay` | unset | Billing day `1`–`28`. Unset uses the local calendar month. |
| `pricingSnapshot.source` | `"auto"` | Token pricing source: `auto`, `bundled`, or `runtime`. |
| `pricingSnapshot.autoRefresh` | `1` | Refresh the runtime pricing snapshot after this many days. Automatic `models.dev` requests share a rolling 24-hour budget of 10. |

## Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status. They are defined in the canonical file. The Settings page has no provider-definition editor. We never ask for or store a secret here.

- **Remote API:** a fixed authenticated `GET` to a supported quota endpoint. Formats are `quota-v1`, `json-v1`, and `openrouter-key-v1`.
- **Local estimate:** counts matching completed OpenCode requests in 1–16 UTC-day or rolling windows, with an optional USD budget.
- **Credentials:** the variable named by `apiKeyEnv`, then trusted global `provider.<providerId>.options.apiKey`, then an API-key login saved in OpenCode 2 (`opencode.db`). Project-local secrets are not read.
- **Selection:** with `enabledProviders: "auto"`, definitions run automatically. A manual list must include `quota-providers`.
- **Model coverage:** `modelIds` affects only `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- **Pricing:** `pricingModelMap` is a fallback only. A successful automatic models.dev match cannot be overridden by `pricingModelMap`.
- **State:** local estimates keep counters under `~/.local/state/opencode/opencode-quota-gui/quota-providers/`.
- **Failures:** if any counted request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.

Definitions are not imported from legacy configuration. Add them directly to the canonical file.

A complete remote example:

```jsonc
{
  // Find built-in providers automatically.
  "enabledProviders": "auto",

  "quotaProviders": [
    {
      "id": "openrouter-primary",
      "providerId": "openrouter",
      "label": "OpenRouter Primary",
      "mode": "remote-api",
      "url": "https://openrouter.ai/api/v1/key",
      "format": "openrouter-key-v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  ]
}
```

A local estimate:

```jsonc
{
  "enabledProviders": ["quota-providers"],
  "quotaProviders": [
    {
      "id": "private-gateway",
      "label": "Private Gateway Estimate",
      "mode": "local-estimate",
      "modelIds": ["model-a"],
      "windows": [
        {
          "id": "daily",
          "label": "Daily",
          "type": "utc-day",
          "requestLimit": 1000,
          "usdBudget": 25
        }
      ]
    }
  ]
}
```

Rules and limits:

- `quotaProviders` is global-only and keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- Remote APIs use a fixed authenticated `GET`. URLs must use HTTPS except for loopback testing; credentials, queries, fragments, and redirects are rejected.
- `json-v1` needs an `adapter` with 1–16 mappings and literal own-property path segments, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Every window needs `requestLimit`; `usdBudget` is optional.
- A custom model provider still needs its normal OpenCode `provider`/`providers` block so OpenCode can use the model.
- Do not duplicate a definition in a second file, and do not use project-local definitions or secrets.
- Not accepted: scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, or automatic endpoint discovery.

Provider-specific setup and adapter details are in [Providers](providers.md). For raw/private status details, the dashboard shows safe card errors and Settings reports configuration issues; it never prints credential values or raw provider responses.
