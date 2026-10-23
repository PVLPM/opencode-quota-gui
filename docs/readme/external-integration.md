[← Back to README](../../README.md)

# External integration

This release is dashboard-only. There is no supported API, file format, metrics endpoint, or command for another tool to read quota data from this package.

## Supported integration surface

- **The dashboard:** open <http://localhost:4144/quota> in a browser on the same machine. This is the product surface, and it is the only supported way to view the data in this release.
- **OpenCode:** configure the `opencode-quota-gui` entry in the plural `plugins` list. OpenCode loads the server plugin, starts the dashboard, and manages provider logins. See [Manual install](manual-install.md).
- **Companion provider plugins:** Cursor, Google AGY, and Gemini CLI integrations require their own community plugins, listed before the quota entry. See [Providers](providers.md).

No public API is exposed. The dashboard page uses `/api/v1` routes and an event stream internally; those are private transport details, not a supported integration surface.

## No public API

The local server exposes `/api/v1` HTTP routes and an event stream for the dashboard page. Those routes are internal transport, not a public API: they are not versioned for third parties, they reject non-loopback hosts and origins, they send no CORS headers, and they may change without an external compatibility promise. Do not build status bars, CI checks, monitoring exporters, or other automation against them.

No supported export file, JSON command, CLI report, slash command, tool, or RPC method is registered by this package. No report message, report marker, or report metadata contract is produced for another surface. The inherited source for some of those features is not a supported interface in this GUI-only release. There is no announced external API and no temporary preview contract.

## Optional OpenTelemetry (advanced, host-owned)

Telemetry is off by default. When the canonical `~/.config/opencode/opencode-quota-gui/config.jsonc` contains `"telemetry": { "enabled": true }`, the plugin publishes two OpenTelemetry observable gauges from the GUI quota reads it already performs:

| Metric | Unit | Meaning |
| --- | --- | --- |
| `opencode.quota.consumed` | `1` | Normalized quota consumed, where 1 is 100% consumed. |
| `opencode.quota.cache.age` | `s` | Age of the cached normalized quota observation. |

```jsonc
{
  "telemetry": {
    "enabled": true
  }
}
```

The host owns this integration. The OpenCode host process, or another package loaded into it, must configure a global OpenTelemetry `MeterProvider` and exporter. This package uses the `@opentelemetry/api` package only; if no global provider is configured, the gauges are registered with the API's no-op meter and produce no output. This package does not create a `MeterProvider`, exporter, collector, or metrics endpoint, does not send metrics anywhere by itself, and does not make extra provider requests for telemetry. Values come from quota reads that already happened.

Metric names, attributes, and the enabled mode are implementation details, not a public API or compatibility promise. Export files, JSON commands, CLI reports, slash commands, tools, and RPC methods remain unsupported.

If you need automation today, use the provider's own API or its OpenCode integration directly. This project does not proxy those credentials or publish a quota feed.

## Privacy boundary

Data stays on the local machine. The dashboard reads OpenCode configuration and login data through OpenCode, reads local session history for usage views, and sends provider quota requests only to the selected providers. There is no cloud account, hosted dashboard, or remote data store. See [Settings and privacy](../../README.md#settings-and-privacy).

## Related documentation

- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Updating safely](updating.md)
