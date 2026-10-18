<p align="center">
  <a href="https://github.com/PVLPM/opencode-quota-gui">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility in OpenCode and your terminal.</p>
<p align="center"><code>opencode-quota-gui</code> — an independent continuation of <a href="https://github.com/slkiser/opencode-quota">slkiser/opencode-quota</a> (MIT). Not published to npm yet; once the first public version is released, install it with <code>npx opencode-quota-gui init</code> (see <a href="#quick-start">Quick start</a>).</p>
<p align="center">
  <a href="https://www.npmjs.com/package/opencode-quota-gui"><img alt="npm" src="https://img.shields.io/npm/v/opencode-quota-gui?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-quota-gui"><img alt="npm downloads" src="https://img.shields.io/npm/dm/opencode-quota-gui?style=flat-square" /></a>
  <a href="https://github.com/PVLPM/opencode-quota-gui/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/PVLPM/opencode-quota-gui/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/issues/38281"><img alt="Help us get listed: opencode#38281" src="https://img.shields.io/badge/%F0%9F%91%8D_help_us_get_listed-opencode%2338281-blue?style=flat-square" /></a>
</p>

[![OpenCode Quota sidebar](https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp)](https://github.com/PVLPM/opencode-quota-gui)

---

## Quick start

This project is not published on npm yet. Once the first public version is released, one command installs it:

```bash
npx opencode-quota-gui init
```

Then restart OpenCode and type `/quota`. The plugin also starts the local [dashboard](#dashboard) at http://localhost:4144.

**Pre-release build (local tarball).** Until that release — or to test a specific checkout — install the same plugin from a tarball you build yourself. The optional `OPENCODE_QUOTA_PLUGIN_SPEC` override points `init` at the local file instead of the npm package:

POSIX (macOS, Linux, Git Bash):

```bash
git clone https://github.com/PVLPM/opencode-quota-gui.git
cd opencode-quota-gui
pnpm install
pnpm run build
pnpm pack
export OPENCODE_QUOTA_PLUGIN_SPEC="$(node -e "console.log(require('url').pathToFileURL(require('path').resolve('opencode-quota-gui-<version>.tgz')).href)")"
node dist/bin/opencode-quota-gui.js init
```

PowerShell:

```powershell
git clone https://github.com/PVLPM/opencode-quota-gui.git
cd opencode-quota-gui
pnpm install
pnpm run build
pnpm pack
$env:OPENCODE_QUOTA_PLUGIN_SPEC = node -e "console.log(require('url').pathToFileURL(require('path').resolve('opencode-quota-gui-<version>.tgz')).href)"
node dist/bin/opencode-quota-gui.js init
```

Keep that override absolute, as in the two forms above: a relative spec would resolve from the OpenCode config folder, not your checkout. `init` asks before writing, prints the exact file it changed, and never installs the upstream `@slkiser/opencode-quota` package.

**Coming from an upstream install?** `init` and `update` recognize legacy `@slkiser/opencode-quota` entries, config, and cache files for an explicit migration only — they are never rewired silently. Replace or remove the old entry yourself when you switch to this build (see [Manual install](docs/readme/manual-install.md)).

> [!IMPORTANT]
> You need OpenCode `2.0.16+` and Node.js `22.13+` or `23.4+`. This build does not support OpenCode 1; its last supported plugin line is the upstream `npx @slkiser/opencode-quota@4 init` (historical upstream package, not this one).

Upgrading from 4.x? Read [what changed in 5.0](#breaking-changes-in-500).

> Maintainers: the first public version is published manually, after the version is decided and its tarball is verified: `npm publish './opencode-quota-gui-<VERSION>.tgz' --access public`. Automated publishing is not enabled.

## What you get

<table>
  <tr>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp" alt="OpenCode Quota TUI sidebar panel" /><br /><strong>Sidebar panel</strong></td>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-toast.webp" alt="OpenCode Quota popup toast" /><br /><strong>Popup toast</strong></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-statusbar.webp" alt="OpenCode Quota TUI status line" /><br /><strong>Status line</strong></td>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-tokens-command.webp" alt="OpenCode Quota token report" /><br /><strong>Token reports</strong></td>
  </tr>
</table>

Also:

- **Dashboard:** a local web UI at http://localhost:4144 with quota cards, range-scoped usage charts, projects, session trees, and settings. See [Dashboard](#dashboard).
- **Terminal:** `npx opencode-quota-gui show` works even with OpenCode closed. If you installed the package, the short `opencode-quota-gui show` works too.
- **Web and Desktop:** slash commands post the report in the chat.
- **Scripts and status bars:** JSON, an export file, and metrics. See [External integration](docs/readme/external-integration.md).
- **Your look:** used or left, reset style, a runs-out estimate, and more. See [Configuration](docs/readme/configuration.md).
- **Retry at the reset:** when a request hits a limit and that provider's quota shows a used-up window, OpenCode retries after it resets. Turn off with `waitForQuotaReset: false`.

## Dashboard

The plugin also serves a local dashboard. It listens on `127.0.0.1` only — nothing on your network can reach it:

- **Home:** quota cards for every discovered provider account, token usage over the selected range (`24h`, `7d`, `30d`, `lifetime`), then project activity. Tokens are the primary number; the API-equivalent cost is a small secondary figure and is never a provider bill.
- **Projects and sessions:** project activity with root sessions and worktree labels (`title normal | worktree muted | tokens`), then the opened session plus all of its descendants, with compaction markers and per-step context and total tokens. Session detail counts every physical completed step in the opened tree.
- **Settings:** the same keys as the config file, percent display as `used` or `remaining`, and eye toggles that hide a card or row from the dashboard only — hiding is presentation state and never changes stored data or other surfaces.
- **Import:** copy settings from legacy config files (global or project) into the canonical dashboard file; the legacy files are left byte-for-byte untouched.

How it starts and where it writes:

- The dashboard starts with the plugin at <http://localhost:4144>. The port is `dashboard.port` in the canonical `~/.config/opencode/opencode-quota-gui/config.jsonc` (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set, or the folder named by `OPENCODE_CONFIG_DIR`). Changing the port needs an OpenCode restart, and the port is read-only in the web UI.
- If the port is already taken, the dashboard does not try another port: you get one `dashboard server unavailable` log line, and the TUI, slash commands, toasts, and tools keep working.
- Settings and import write only the global canonical file above. For any key that file sets, it wins even over project files — a deliberate deviation, because dashboard settings are global; the settings page shows the winning source for every key, and legacy config files keep applying to keys the canonical file does not set. `formatStyle` still affects the legacy TUI and terminal surfaces only, never the dashboard.

v1 notes: the dashboard ships with the plugin; no dashboard CLI aliases, no durable-resume and no native notifications, and Web/Desktop still get slash commands only. Until the first public npm release, install from the local tarball shown above.

## Updating

Once the package is published, update it as usual:

```bash
npx opencode-quota-gui update --dry-run
npx opencode-quota-gui update
```

For a pre-release local tarball, build and pack the new version first and point the optional `OPENCODE_QUOTA_PLUGIN_SPEC` override at it (absolute spec, as in [Quick start](#quick-start)); `update` then targets that tarball instead of the npm package. Restart OpenCode. The updater never moves or deletes secrets. See [Updating safely](docs/readme/updating.md).

### Breaking changes in 5.0.0

> [!WARNING]
> - This package does not support OpenCode 1. The upstream 4.x line (`@slkiser/opencode-quota@4`) is a historical compatibility reference, not an installation or update target of this package.
> - Logins come from OpenCode 2, never from `auth.json`. If a provider is missing, log in again.
> - Web and Desktop get the slash commands, but no toasts or panels.
> - TUI reports open in a popup. To keep them in the chat, set `tuiCommandDisplay: "inline"`.
> - OpenCode Zen uses your OpenCode Console sign-in: `opencode auth login opencode`.

Full list: [Moving to OpenCode 2](docs/readme/updating.md#moving-to-opencode-2).

## Commands

### Slash commands

Type these in OpenCode. Add dates after the command, like `/tokens_between 2026-09-01 2026-09-25`.

| Command                                 | What it shows                                        |
| --------------------------------------- | ---------------------------------------------------- |
| `/quota`                                | Current quota                                        |
| `/quota_status`                         | Setup check: logins, providers, pricing, and notices |
| `/quota_announcements`                  | Maintainer notices                                   |
| `/pricing_refresh`                      | Refreshes token pricing from `models.dev`            |
| `/tokens_today`                         | Tokens used today                                    |
| `/tokens_daily`                         | Tokens used in the last 24 hours                     |
| `/tokens_weekly`                        | Tokens used in the last 7 days                       |
| `/tokens_monthly`                       | Tokens used in the last 30 days, with pricing        |
| `/tokens_all`                           | Tokens used across all local history                 |
| `/tokens_session`                       | Tokens used in this session                          |
| `/tokens_session_all`                   | This session plus its subagent sessions              |
| `/tokens_between YYYY-MM-DD YYYY-MM-DD` | Tokens used between two dates                        |

### CLI commands

`npx` runs the published CLI without installing it globally:

| Command                               | What it does                      |
| ------------------------------------- | --------------------------------- |
| `npx opencode-quota-gui init`         | Set up OpenCode Quota             |
| `npx opencode-quota-gui provider add` | Add or update a custom provider   |
| `npx opencode-quota-gui show`         | Show current quota                |
| `npx opencode-quota-gui status`       | Check setup and provider problems |
| `npx opencode-quota-gui update`       | Update to the newest release      |

If you installed the package, the short `opencode-quota-gui <command>` form runs the same commands; from a checkout (pre-release), use `node dist/bin/opencode-quota-gui.js <command>`.

`show` and `status` work with OpenCode closed ([how they differ](docs/readme/troubleshooting.md#terminal-commands)). Add `--help` to see all options.

## Providers

Most providers work automatically once you log in through OpenCode. **Needs setup** links show the extra step.
OpenAI ChatGPT quota needs a Codex login (`/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**). OpenAI doesn't share ChatGPT usage with **Sign in with ChatGPT** logins or API keys, so those show a "ChatGPT quota unavailable" row without a ChatGPT request.

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

Track a provider that is not listed, from its quota API or from a local estimate:

```bash
npx opencode-quota-gui provider add
```

It previews the change before saving. See the [custom-provider guide](docs/readme/providers.md#custom-providers).

## Troubleshooting

1. Run `/quota_status` in OpenCode, or `npx opencode-quota-gui status` in a terminal.
2. Provider missing? Log in to it again in OpenCode 2.
3. Using a companion plugin (Cursor, Google)? List it **before** the OpenCode Quota plugin entry in `opencode.json`.
4. `claude` or `bl` not found? See [Service environment](docs/readme/troubleshooting.md#service-environment).
5. Token reports empty? Start OpenCode once, then use a model.

More fixes: [Troubleshooting](docs/readme/troubleshooting.md).

## Reference

Guides: [Manual install](docs/readme/manual-install.md) · [Configuration](docs/readme/configuration.md) · [Providers](docs/readme/providers.md) · [Troubleshooting](docs/readme/troubleshooting.md) · [External integration](docs/readme/external-integration.md) · [Updating safely](docs/readme/updating.md)

Outside links: [OpenCode docs](https://opencode.ai/docs/) · [OpenCode config](https://opencode.ai/docs/config/) · [OpenCode plugins](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev pricing data](https://models.dev/) · [Node.js downloads](https://nodejs.org/en/download)

## Contributors

Thanks to everyone who has contributed to OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## License

MIT. OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

`opencode-quota-gui` is derived from the upstream [opencode-quota](https://github.com/slkiser/opencode-quota) project (MIT); upstream history, copyright, and license are preserved.

[![Star History Chart](https://api.star-history.com/svg?repos=slkiser/opencode-quota&type=date&legend=top-left)](https://www.star-history.com/#slkiser/opencode-quota&Date)
