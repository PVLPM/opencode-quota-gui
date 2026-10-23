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

Settings values, provenance, the dashboard port, and visibility lists come only from the canonical file and defaults. The separate import preview is the only path that reads inherited legacy values.

Provider credential sidecars are separate files in the same GUI namespace. For example, Xiaomi MiMo may use `opencode-quota-gui/mimo.json`; that file supplies only a provider cookie and is not part of the canonical behavior config. No sidecar is merged into `config.jsonc`.

## Settings page

Open <http://localhost:4144/settings>. The page groups the supported controls:

| Group | What it changes |
| --- | --- |
| Wait for quota reset | `waitForQuotaReset`; holds a request when a used-up quota window has a known reset. |
| Display | `percentDisplayMode` (remaining or used) and `percentLabelStyle` (full or bare). |
| Advanced | Provider selection, minimum refresh interval, request timeout, and accounting detail. |
| Visibility | Shows or hides provider cards and rows, and reorders provider cards. Presentation only. |
| Dashboard | Read-only address, the canonical file path, configuration issues, and build details. |

Saving Settings writes to the canonical file atomically. If the file changed elsewhere, the save returns a conflict and keeps your draft.

### Visibility identifiers

`dashboard.hiddenCards`, `dashboard.hiddenRows`, and `dashboard.providerOrder` contain opaque internal identifiers. Do not construct, derive, rename, or copy them between accounts. Use **Settings → Visibility**, where each provider card and row has an eye toggle and each provider has a drag or keyboard reorder handle. Hiding a provider or row never disables polling or deletes data.

### Port

`dashboard.port` defaults to `4144` and is read-only in the web UI. To change it, edit the canonical file and restart OpenCode:

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

  // Minimum time between provider refreshes, and each provider request timeout.
  "minIntervalMs": 60000,
  "requestTimeoutMs": 5000,

  // "summary" keeps main rows; "detailed" adds supplementary rows.
  "accountingDetail": "summary"
}
```

`enabledProviders: "auto"` discovers providers from OpenCode. A manual list must include `quota-providers` when you use custom definitions, plus every built-in provider you still want.

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
| `pricingSnapshot.autoRefresh` | `7` | Refresh the runtime pricing snapshot after this many days. |

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
