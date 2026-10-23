# OpenCode Quota GUI

A local dashboard for your OpenCode quota, token usage, projects, and sessions. It runs beside OpenCode, listens only on loopback, and keeps its settings and cached data in this product's own namespace.

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-quota-gui"><img alt="npm" src="https://img.shields.io/npm/v/opencode-quota-gui?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-quota-gui"><img alt="npm downloads" src="https://img.shields.io/npm/dm/opencode-quota-gui?style=flat-square" /></a>
  <a href="https://github.com/PVLPM/opencode-quota-gui/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/PVLPM/opencode-quota-gui/ci.yml?style=flat-square&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/issues/38281"><img alt="Help us get listed: opencode#38281" src="https://img.shields.io/badge/%F0%9F%91%8D_help_us_get_listed-opencode%2338281-blue?style=flat-square" /></a>
</p>

## Features

- **Quota dashboard:** one card per provider account, with quota and rate-limit windows, reset countdowns, balance or spend where the provider reports it, and OpenAI banked resets and credits when available.
- **Usage analytics:** token usage over `24h`, `7d`, `30d`, or `lifetime`, plus project activity and root-session drill-down.
- **Session detail:** the opened session tree, every physical completed step, and separate own-context and cumulative tree totals.
- **Local settings:** display preferences, provider selection, refresh and timeout controls, and presentation-only visibility toggles.
- **Reset-aware retries:** when a request hits a provider limit and that provider's quota shows a used-up window, OpenCode can retry after the window resets. Turn this off with `waitForQuotaReset: false`.
- **Local-first operation:** the dashboard binds to `127.0.0.1`, has no cloud account or hosted sync, and reads OpenCode data on the same machine.

## Quick start

Install the plugin through OpenCode:

```bash
opencode plugin add opencode-quota-gui
```

That adds this entry to your OpenCode configuration, keeping the other plugins that are already there:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-quota-gui"],
}
```

OpenCode installs the configured npm plugin itself; you do not need a separate `npm install`. If you prefer to edit the config manually, add the same `opencode-quota-gui` entry to the plural `plugins` array in `~/.config/opencode/opencode.json(c)` or a project `opencode.json(c)`.

Restart OpenCode, then open <http://localhost:4144/quota>. The first page may show an empty dashboard until OpenCode has loaded the plugin and discovered a provider account.

Requirements: OpenCode `2.0.16` or newer and Node.js `22.13+` or `23.4+`. This package does not support OpenCode 1.

## Dashboard

The dashboard starts with the plugin and is served on `127.0.0.1` only. It does not listen on network interfaces, and there is no cloud component. Local port forwarding, proxy configuration, or another process running on the same machine is outside this guarantee.

- **Quota:** cards for discovered provider accounts, ordered and grouped by provider. Each card shows the rows that provider reports, a compact percentage bar for percentage rows, reset countdowns, and card-local errors. OpenAI cards can include banked resets and credits.
- **Analytics:** token usage over the selected range, projects ordered by activity or tokens, and a project page with root sessions and worktree labels.
- **Session:** the opened session and its descendants, with per-step detail and compaction markers. Own-context and cumulative tree consumption are shown separately.
- **Settings:** display, provider, request, and visibility controls, plus the canonical settings file, any reported configuration issues, and build information.

The routes are real URLs, so reload and browser back/forward work:

- `/quota` — provider cards
- `/analytics?range=7d` — usage and projects
- `/project/<id>?range=30d` — one project
- `/session/<id>` — one session tree
- `/settings` — dashboard settings

OpenCode 2 currently has no stable native frontend extension surface suitable for rendering this dashboard inside the host UI. It therefore runs in your browser, and the plugin exposes only the local HTTP and event stream needed by that page. If a stable host extension API emerges, this integration may evolve; no such API or timeline is announced.

## Providers

Most providers work automatically once you log in through OpenCode. A **Needs setup** link points to the extra step. Provider data is collected by the plugin inside the OpenCode host; the dashboard does not run a separate polling service.

### Pre-configured American providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider           | Auth/setup                                                     | Data from          | Reports            |
| ------------------ | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude) | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI          | Automatic                                                      | Remote API         | Quota              |
| Cursor             | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| GitHub Copilot     | Automatic                                                      | Remote API         | Budget and usage   |
| Google AGY         | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| Kilo Gateway       | Automatic                                                      | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                                                      | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                                                      | Remote API         | Quota and balance  |
| OpenAI             | Automatic                                                      | Remote API         | Quota              |
| OpenCode Go        | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen       | Automatic                                                      | Remote API         | Budget and balance |
| OpenRouter         | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic          | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok      | Automatic                                                      | Remote API         | Quota              |

</details>

<details>
<summary><strong>Business / Enterprise</strong></summary>

| Provider                | Auth/setup                                                     | Data from          | Reports            |
| ----------------------- | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)      | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI               | Automatic                                                      | Remote API         | Quota              |
| Cursor                  | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| Gemini CLI              | [Needs setup](docs/readme/providers.md#gemini-cli)             | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](docs/readme/providers.md#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| NanoGPT                 | Automatic                                                      | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen            | Automatic                                                      | Remote API         | Budget and balance |
| OpenRouter              | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic               | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok           | Automatic                                                      | Remote API         | Quota              |

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Personal Google users should use Google AGY.

</details>

### Pre-configured Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                      | Auth/setup                                                                   | Data from      | Reports            |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan           | Automatic                                                                    | Local estimate | Quota              |
| Alibaba Personal Token Plan   | [Needs setup](docs/readme/providers.md#alibaba-personal-token-plan)          | Official CLI   | Quota              |
| DeepSeek                      | Automatic                                                                    | Remote API     | Balance and status |
| Kimi Code                     | Automatic                                                                    | Remote API     | Quota              |
| Kimi Code (CN)                | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan            | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan (CN)       | Automatic                                                                    | Remote API     | Quota              |
| Xiaomi MiMo                   | [Needs setup](docs/readme/providers.md#xiaomi-mimo)                          | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan              | Automatic                                                                    | Remote API     | Quota              |
| Zhipu Coding Plan             | Automatic                                                                    | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| Kimi Code (CN)           | Automatic  | Remote API | Quota   |
| MiniMax Token Plan       | Automatic  | Remote API | Quota   |
| MiniMax Token Plan (CN)  | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These show only your own member API key's usage, not the whole organization's.

</details>

### Custom providers

A custom provider can read a supported quota API or estimate usage from your local OpenCode history. Define it in the global canonical settings file under `quotaProviders`; see the [custom-provider guide](docs/readme/providers.md#custom-providers) for the complete schema, adapter rules, and security limits. The dashboard Settings page does not create provider definitions.

## Settings and privacy

The dashboard reads only the canonical file at runtime:

```text
~/.config/opencode/opencode-quota-gui/config.jsonc
```

`$XDG_CONFIG_HOME/opencode` replaces `~/.config/opencode` when `XDG_CONFIG_HOME` is set, and `OPENCODE_CONFIG_DIR` replaces the global OpenCode config folder. The sibling `config.json` is not read, converted, or imported; it is preserved unchanged. Changes made in `Settings` write to this canonical file. Settings values, source labels, the port, and visibility lists come only from the canonical file and defaults, regardless of whether OpenCode uses `opencode.json` or `opencode.jsonc`. Selecting a project install in `init` adds only the project OpenCode plugin entry; behavior settings remain global. Inherited legacy values are available only through the separate import preview.

- **Legacy import:** when a global legacy OpenCode Quota source exists, Settings can preview and copy seven compatible keys: `percentDisplayMode`, `percentLabelStyle`, `enabledProviders`, `minIntervalMs`, `requestTimeoutMs`, `accountingDetail`, and `waitForQuotaReset`. The import is read-only for the source; files stay byte-for-byte untouched. Custom provider definitions are not imported, so copy `quotaProviders` into the canonical file yourself.
- **Visibility:** hiding a provider or row is presentation only and never changes polling or provider data. Opaque card and row IDs in `dashboard.hiddenCards` and `dashboard.hiddenRows` are internal identifiers: use **Settings → Visibility** to manage them instead of editing or deriving IDs by hand.
- **Port:** `dashboard.port` is read-only in the web UI. Edit the canonical file and restart OpenCode to change it; the default is `4144`.
- **Browser storage:** the dashboard uses browser-local storage for display state such as the selected range and a visibility-catalog cache. It does not use cross-site cookies.
- **Local data:** the plugin reads OpenCode's local configuration and login data through OpenCode, plus OpenCode's local session database for usage and session views. Provider quota checks use the provider's API or the documented local CLI or companion plugin. Token pricing can come from the bundled snapshot or `models.dev` at runtime.
- **OpenTelemetry (optional):** off by default. Set `"telemetry": { "enabled": true }` in the canonical file to publish two gauges, `opencode.quota.consumed` and `opencode.quota.cache.age`, through the `@opentelemetry/api` global `MeterProvider` that your host process configures. The plugin does not create a `MeterProvider`, exporter, collector, or metrics endpoint, sends no metrics by itself, and makes no extra provider requests for telemetry. Metric names and attributes are not a public API. See [External integration](docs/readme/external-integration.md#optional-opentelemetry-advanced-host-owned).
- **No hosted service:** this project has no cloud account, hosted dashboard, or remote usage store. The local server permits only loopback hosts and origins and sends no CORS headers.
- **Build details:** Settings → About reports the embedded Version, Build, and Contract. A build or contract mismatch means the browser page and server plugin are from different builds; restart and reinstall the same package if it persists.

See [Configuration](docs/readme/configuration.md) for every supported settings key and the custom-provider rules.

## Installing and updating

The normal install is the [Quick start](#quick-start) plugin entry. To update, let OpenCode resolve the same `opencode-quota-gui` entry again, then restart OpenCode. If you pin a version in `plugins`, update that version explicitly.

Optional maintenance commands are available for people who want a previewed config or cache cleanup:

```bash
npx opencode-quota-gui init --dry-run
npx opencode-quota-gui update --dry-run
npx opencode-quota-gui update --yes
```

`init` and `update` are maintenance only: `init` is a guided setup for the plugin entry, canonical GUI settings, and the OpenCode config location, and it is not required. `update` previews safe plugin-entry and package-cache maintenance; it does not install or upgrade the npm package for you. Neither command queries providers, displays quota, or produces a report, and neither reads or prints credential values.

For a local build or release candidate, build the checkout and point the optional `OPENCODE_QUOTA_PLUGIN_SPEC` override at the absolute `file:` URL of the packed artifact before running `init`. Local plugin entries and release tarballs are documented in [Manual install](docs/readme/manual-install.md). Update behavior and rollback notes are in [Updating safely](docs/readme/updating.md).

## OpenCode and upstream compatibility

This release is GUI-only: it has no TUI. It does not register or provide a TUI panel, terminal quota interface or reports, slash command, tool, RPC method, report hook, toast, or status line, and it produces no report message, marker, or metadata contract. The `init` and `update` commands described above are maintenance only, not a quota interface. The only product activation is the OpenCode server plugin that starts the dashboard and keeps the credential and reset-retry lifecycle working.

It is independent of the upstream `@slkiser/opencode-quota` package. The two packages may be configured at the same time, and there is no dependency or conflict guard between them. Each owns its configuration and private state; this package writes under the `opencode-quota-gui` namespace and does not migrate, rewrite, or delete upstream configuration, cache, or credential files.

Use the upstream project if you want its terminal surfaces. Use this project if you want the local dashboard. See [Updating safely](docs/readme/updating.md) for migration and coexistence details.

## Support

- [Manual install](docs/readme/manual-install.md)
- [Configuration](docs/readme/configuration.md)
- [Providers](docs/readme/providers.md)
- [Troubleshooting](docs/readme/troubleshooting.md)
- [External integration](docs/readme/external-integration.md)
- [Updating safely](docs/readme/updating.md)
- [Open a bug or feature request](https://github.com/PVLPM/opencode-quota-gui/issues)

When reporting a problem, include your OpenCode version and the Version, Build, and Contract shown in Settings → About. Do not paste credentials, tokens, private paths, or raw provider responses.

Outside references: [OpenCode v2 docs](https://opencode.ai/v2/docs/) · [OpenCode v2 config](https://opencode.ai/v2/docs/config/) · [OpenCode v2 plugins](https://opencode.ai/v2/docs/plugins/) · [models.dev pricing data](https://models.dev/) · [Node.js downloads](https://nodejs.org/en/download)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. In short: open an issue first, run `pnpm verify`, keep the fix focused, and include before-and-after dashboard screenshots for any visible change. Credentials, account identifiers, and private paths must be redacted.

## Acknowledgements and license

This project is MIT-licensed and is derived from the upstream [opencode-quota](https://github.com/slkiser/opencode-quota) project (MIT). Upstream history, copyright, and license notices are preserved. It is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

Provider names and plan names belong to their owners. Pricing data is provided by [models.dev](https://models.dev/). See [LICENSE](LICENSE) for the full text.

## Contributors

Thanks to everyone who has contributed to this repository.

<a href="https://github.com/PVLPM/opencode-quota-gui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=PVLPM/opencode-quota-gui" alt="Contributors to PVLPM/opencode-quota-gui" />
</a>

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=PVLPM/opencode-quota-gui&type=date&legend=top-left)](https://www.star-history.com/#PVLPM/opencode-quota-gui&Date)
