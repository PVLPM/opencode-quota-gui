[← Back to README](../../README.md)

# Use quota data in other tools

OpenCode Quota can share its cached quota data with scripts, status bars, CI, and monitoring tools. None of these options make extra provider requests.

| What you need | Use |
| --- | --- |
| Run a command and get JSON | `npx opencode-quota-gui show --json` |
| Read the same JSON often | Export file |
| Send numbers to a monitoring system | OpenTelemetry metrics |

## 1. Get JSON from a command

Use this for scripts and CI:

```bash
npx opencode-quota-gui show --json
```

It works with OpenCode closed and reads cached data only. It runs with your terminal's settings; see [Terminal commands](troubleshooting.md#terminal-commands).

```bash
# Only Copilot
npx opencode-quota-gui show --json --provider copilot

# Exit with an error when comparable quota is below 5% (for example in CI)
npx opencode-quota-gui show --json --threshold 5
```

`--threshold` exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Quota is available and above the threshold |
| `1` | At least one comparable cached percentage is below the threshold |
| `2` | Results were incomplete or no comparable percentage was found |

### Read Copilot's percentage with `jq`

Some Copilot rows are values, not percentages, so select a percentage row instead of taking the first one:

```bash
npx opencode-quota-gui show --json --provider copilot \
  | jq -r '(.providers.copilot.entries? // []) | map(select(.renderType == "percent" and .percentRemaining != null)) | first | .percentRemaining // empty'
```

## 2. Read an export file

Use this for a status bar or another tool that checks quota often. Add this to `opencode-quota/quota-toast.json`:

```jsonc
{ "export": { "enabled": true } }
```

- The file is `~/.cache/opencode/quota-export.json` (or `$XDG_CACHE_HOME/opencode/quota-export.json` when `XDG_CACHE_HOME` is set). `export.path` changes it.
- OpenCode's background service rewrites it about once a minute while the TUI Home screen is open, and it keeps its last contents when OpenCode stops.
- A write error is logged but never breaks the TUI.

### tmux example (add to your tmux config)

```bash
set -g status-interval 30
set -g status-right '#(jq -r "[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" | \")" ~/.cache/opencode/quota-export.json 2>/dev/null)'
```

### Starship example (add to `starship.toml`)

```toml
[custom.quota]
command = "jq -r '[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" \")' ~/.cache/opencode/quota-export.json 2>/dev/null"
when = "true"
interval = 60
```

## 3. Send OpenTelemetry metrics

Use this only when OpenCode's server process (normally the background service) already has an OpenTelemetry metrics provider and exporter. OpenCode Quota does not create or configure them. Add this to `opencode-quota/quota-toast.json`:

```jsonc
{ "telemetry": { "enabled": true } }
```

OpenCode Quota then publishes two gauges:

| Metric | Meaning |
| --- | --- |
| `opencode.quota.consumed` | Used quota from `0` to `1` |
| `opencode.quota.cache.age` | Age of cached data in seconds |

It reads results already in memory and never starts its own refresh loop. If the host has no global metrics provider, nothing is sent and OpenCode Quota keeps working normally.

<details>
<summary><strong>Metric fields and privacy</strong></summary>

`opencode.quota.consumed` uses percentage rows only. Its value is `(100 - percentRemaining) / 100`, limited to the range `0` to `1`. Quantity, boolean, legacy value, percentage-basis, and supplementary metadata do not create consumed gauges.

| Metric | Labels |
| --- | --- |
| `opencode.quota.consumed` | `quota.provider`, `quota.result_type`, `quota.window` |
| `opencode.quota.cache.age` | `quota.provider` |

Label values stay limited:

- `quota.provider` is a maintained provider ID, `custom`, or `other`.
- `quota.result_type` is `quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, or `status`.
- `quota.window` is `rpm`, `five_hour`, `hour`, `day`, `week`, `month`, `year`, `mcp`, `code_review`, or `unknown`.

When several rows map to the same safe labels, OpenCode Quota reports the highest consumed ratio or oldest cache age. Display names, account IDs, configured source IDs, credentials, URLs, paths, errors, and raw responses are never labels.

</details>

<details>
<summary><strong>Minimal host setup example</strong></summary>

Register the provider before OpenCode loads OpenCode Quota. Replace the console exporter with your real exporter.

```javascript
import { metrics } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const reader = new PeriodicExportingMetricReader({
  exporter: new ConsoleMetricExporter(),
  exportIntervalMillis: 60_000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

export async function shutdownMetrics() {
  await provider.shutdown();
}
```

</details>

## JSON basics

The command and export file both use JSON schema version `2`. Every provider has a `status`, and the other fields depend on it:

| Status | Meaning | Fields |
| --- | --- | --- |
| `ok` | Data is available | `fetchedAt`, `entries` |
| `partial` | Some data worked and some failed | `fetchedAt`, `entries`, `errors` |
| `error` | The provider failed | `fetchedAt`, a safe `error` message |
| `unavailable` | No matching cached data exists | none required |

A percentage entry uses `renderType: "percent"` and `percentRemaining`. A value entry uses `renderType: "value"` and `value`. Internally typed quantities flatten into formatted value strings (for example, `USD 12.50`), and booleans flatten to `Enabled` or `Disabled`.

- Scripts must not assume the first row is a percentage or that a provider has only one row. Select `renderType`, `resultType`, and any other field you need.
- Display settings (`accountingDetail`, `formatStyle`, `percentDisplayMode`) never change JSON. The export uses the full cached snapshot, so supplementary rows can add more value entries.
- Version 2 does not expose internal metrics, row prominence, used/limit/remaining basis facts, or per-fact authority.
- Threshold checks use percentage rows only.

Optional entry fields include `window`, `resetAt`, `observedAt`, and `sourceId`. A provider can also include `rawDetails`: curated, safe provider facts that stay out of normal quota displays. Custom `quotaProviders` rows include `sourceId`, and the `quota-providers` result has a `sources` list so tools can match each row to its definition. Treat `status: "partial"` as incomplete.

Secrets, credentials, URLs, checked paths, and raw provider responses remain excluded from public JSON. Use `/quota_status` for live diagnostics.

<details>
<summary><strong>Configured source details</strong></summary>

Rows from a configured `quotaProviders` definition appear under `providers["quota-providers"]` and keep their stable `sourceId`:

```json
{
  "sourceId": "openrouter-primary",
  "renderType": "percent",
  "percentRemaining": 40
}
```

The provider also includes a summary for every configured source:

```json
"sources": [
  {
    "id": "openrouter-primary",
    "providerId": "openrouter",
    "status": "ok",
    "entryCount": 1
  }
]
```

Each summary is exactly `id`, effective `providerId`, coarse `status`, and `entryCount`. A source can be `ok` after producing valid rows while failed mapping candidates can still make the aggregate provider `partial`.

</details>

<details>
<summary><strong>Small JSON example</strong></summary>

```json
{
  "version": 2,
  "exportedAt": 1748736000,
  "fromCache": true,
  "cacheAgeSeconds": 42,
  "providers": {
    "copilot": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "Premium Requests",
          "resultType": "quota",
          "acquisitionMethod": "remote_api",
          "ownership": "maintained",
          "authority": "provider_reported",
          "renderType": "percent",
          "percentRemaining": 62.3
        }
      ]
    }
  }
}
```

</details>
