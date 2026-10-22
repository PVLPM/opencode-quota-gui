[← Back to README](../../README.md)

# Manual install

Once the first public version is released, the guided installer is the easy path:

```bash
npx opencode-quota-gui init
```

It asks for the install scope (global or current project), provider selection (auto-detect or choose manually), and whether quota percentages show used or remaining. It previews the exact files and asks before writing. It adds the plugin to the plural `plugins` list in OpenCode 2's config and writes quota settings; it never installs the upstream `@slkiser/opencode-quota` package.

Use this page if you want to edit OpenCode files yourself, or to install a pre-release tarball you built locally.

## OpenCode 2 config and locations

- **Global:** `~/.config/opencode/opencode.json` or `opencode.jsonc`. When `XDG_CONFIG_HOME` is set, OpenCode uses `$XDG_CONFIG_HOME/opencode`; `OPENCODE_CONFIG_DIR` replaces the global config folder.
- **Project:** `opencode.json` or `opencode.jsonc` at the repository root, or `.opencode/opencode.json(c)`. OpenCode merges discovered configs; a `.opencode` config overrides a direct config.
- **Plugin key:** OpenCode 2 uses the plural `plugins` array. Keep your other entries; the installer preserves them and their order.
- **Discovered plugin directories:** `~/.config/opencode/plugins/` and project `.opencode/plugins/`. OpenCode loads direct `.ts`/`.js` files and immediate plugin package directories there. A `plugins/` folder beside a project-root `opencode.json(c)` is not discovered automatically; configure its files explicitly or move it under `.opencode/`.

Use `.jsonc` if you want comments, or `.json` if another tool needs strict JSON (no comments, no trailing commas). Restart OpenCode after changing the plugin entry, a local plugin path, or a built checkout. Watched config directories may reload, but a restart is the reliable check.

## Pre-release / local build

Build and pack the checkout you want to test, then point the optional `OPENCODE_QUOTA_PLUGIN_SPEC` override at the tarball. Keep it an absolute `file:` URL: a relative spec would resolve from the OpenCode config folder, not your checkout.

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

## Local checkout (development)

To load the plugin straight from a checkout — useful while changing it — build once, then point `plugins` at the repository directory with an absolute `file:` URL:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-quota-gui"],
}
```

OpenCode resolves a directory plugin entry through its `server` entry first, so this checkout's root `server.ts` is what loads, and the `tui.ts` beside it provides the TUI entry. To load only the server entry, point at the file instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-quota-gui/server.ts"],
}
```

A relative path under `plugins` resolves from the config file that contains the entry, so a relative checkout path only works when the checkout sits at that relative location. Prefer an absolute `file:` URL. You can also place a direct `.ts`/`.js` entry or an immediate plugin package directory under `~/.config/opencode/plugins/` or project `.opencode/plugins/`; OpenCode discovers those without a config entry.

Both forms need the built output first:

```bash
pnpm install
pnpm run build
```

The root `server.ts` re-exports `dist/index.js`, so it cannot load before the first build. After changing `src/`, rerun `pnpm run build` and restart OpenCode to load the updated plugin; otherwise it keeps using the previous build. OpenCode never rebuilds the checkout for you. Local checkouts are for development only: release installs use the `opencode-quota-gui` package spec or a tarball `file:` URL shown above.

## Requirements

- OpenCode `2.0.16` or newer. This build does not support OpenCode 1; its last supported line is the upstream `npx @slkiser/opencode-quota@4 init` (historical upstream package, not this one).
- Node.js `22.13+` (or `23.4+` on Node 23), whether you run the package with `npx` or from a local checkout.

## 1. Add the plugin

Add OpenCode Quota to the `plugins` array in `~/.config/opencode/opencode.json(c)` or your project config, and keep your other plugins. This one entry loads the server, the TUI, and the dashboard; no `tui.json` entry is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-quota-gui"],
}
```

For a pre-release tarball, use its absolute `file:` URL instead — the same value `init` writes when `OPENCODE_QUOTA_PLUGIN_SPEC` is set:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-quota-gui-<version>.tgz"],
}
```

**Replacing an existing entry.** Older installs used `@slkiser/opencode-quota` (or another quota package spec). Plain `init` recognizes that entry, retains its existing package spec as written, and moves a recognized legacy singular entry into the plural `plugins` list; it does not add a second `opencode-quota-gui` entry beside it. To switch identity, run `init` or `update` with an explicit `OPENCODE_QUOTA_PLUGIN_SPEC` (previewed before writing), or replace the entry in `plugins` with `opencode-quota-gui` (or the local tarball URL) yourself, then restart OpenCode. Removing the old entry uninstalls only the old plugin reference; your quota settings files are untouched.

## 2. Add quota settings

Create `opencode-quota/quota-toast.jsonc` next to that OpenCode config, or let `init` write it. A fresh GUI-first setup keeps the automatic TUI surfaces off; opt in below only if you want them:

```jsonc
{
  // Find providers from your OpenCode config and logins.
  "enabledProviders": "auto",

  // Show used or remaining quota percentages in the dashboard and reports.
  "percentDisplayMode": "remaining",

  // A fresh GUI-first setup keeps the automatic TUI surfaces off.
  "enableToast": false,
  "tuiSidebarPanel": { "enabled": false },
  "tuiCompactStatus": { "enabled": false },
  "maintainerAnnouncements": { "enabled": false },
}
```

Restart OpenCode, then open <http://localhost:4144/quota>. The dashboard is the primary v1 interface. `/quota` and `/quota_status` remain available in the TUI; `/quota_status` shows the exact files OpenCode Quota loaded.

Dashboard Settings writes the global canonical `~/.config/opencode/opencode-quota-gui/config.jsonc`; for a key it sets, it wins over the global legacy `quota-toast.jsonc`, but a project/workspace `quota-toast.jsonc` still wins for the same key.

## Choose what appears in the TUI

These are TUI-only opt-ins; the dashboard does not use them.

| You want                   | Setting                                   |
| -------------------------- | ----------------------------------------- |
| Sidebar panel              | `tuiSidebarPanel.enabled: true`           |
| Popup quota notifications  | `enableToast: true`                       |
| Compact quota line         | `tuiCompactStatus.enabled: true`          |
| Quota bar under the prompt | `tuiPromptBar.enabled: true`              |
| Slash commands only        | Turn off sidebar, toast, and compact line |

Web and Desktop show none of these. See [Configuration](configuration.md) for every setting.

## Dashboard

After restart, open <http://localhost:4144/quota>. The canonical routes are `/quota`, `/analytics?range=7d`, `/project/<id>?range=30d`, `/session/<id>`, and `/settings`; reload and back/forward work. The dashboard listens on `127.0.0.1` only. Settings → About reports Version, Build, and Contract. Changing the plugin, config, or port needs an OpenCode restart.

## Web and Desktop notes

- Slash commands work in the TUI, Web, and Desktop. Add arguments after the command, like `/tokens_between 2026-09-01 2026-09-25`.
- **TUI:** a slash command opens the report in a popup and leaves no chat message (default `tuiCommandDisplay: "dialog"`). Set `"inline"` to keep it in the chat. The command palette runs the same commands, always in a popup, and asks for missing dates.
- **Web and Desktop:** `/quota` posts the report in the chat as your message. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`, which also keeps it out of compaction summaries.
- Web uses a proportional font, so columns may not line up. Use the TUI, or `npx opencode-quota-gui show`, for aligned columns.
- If the AI is busy, the report appears after it finishes. A new session whose first message is a report keeps its default title.
- The AI can call the `quota_status` tool to check your setup.
- The dashboard runs at <http://localhost:4144/quota> while the plugin is loaded; see [Dashboard](../../README.md#dashboard).

To update later, see [Updating safely](updating.md).
