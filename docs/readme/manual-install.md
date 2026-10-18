[← Back to README](../../README.md)

# Manual install

Once the first public version is released, the guided installer is the easy path:

```bash
npx opencode-quota-gui init
```

It asks before writing and never installs the upstream `@slkiser/opencode-quota` package.

Use this page if you want to edit OpenCode files yourself, or to install a pre-release tarball you built locally.

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

## Requirements

- OpenCode `2.0.16` or newer. This build does not support OpenCode 1; its last supported line is the upstream `npx @slkiser/opencode-quota@4 init` (historical upstream package, not this one).
- Node.js `22.13+` (or `23.4+` on Node 23), whether you run the package with `npx` or from a local checkout.

## Choose where to install

- **Global:** works in every project. Files live in `~/.config/opencode` on every OS (`$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set).
- **Project:** works only in the current repo or worktree.
- **Custom:** if `OPENCODE_CONFIG_DIR` is set, OpenCode uses that folder instead of the global one.

Use `.jsonc` files if you want comments, or `.json` if another tool needs strict JSON (no comments, no trailing commas).

## 1. Add the plugin

Add OpenCode Quota to `opencode.jsonc` or `opencode.json`, and keep your other plugins. This one entry loads the server, the TUI, and the dashboard; no `tui.json` entry is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-quota-gui"],
}
```

For a pre-release tarball, use its absolute `file:` URL instead — the same value `init` writes when `OPENCODE_QUOTA_PLUGIN_SPEC` is set:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-quota-gui-<version>.tgz"],
}
```

**Replacing an existing entry.** Older installs used `@slkiser/opencode-quota` (or another quota package spec). `init` and `update` recognize legacy entries, config, and cache files for an explicit migration only — nothing is rewired silently, and legacy upstream paths stay untouched until you migrate. To run this build, replace that entry with `opencode-quota-gui` (or the local tarball URL) yourself — or remove it before running `init` — then restart OpenCode. Removing the entry uninstalls only the old plugin reference; your quota settings files are untouched.

## 2. Add quota settings

Create `opencode-quota/quota-toast.jsonc` next to that OpenCode config:

```jsonc
{
  // Find providers from your OpenCode config and logins.
  "enabledProviders": "auto",

  // Show the Quota panel in the TUI sidebar.
  "tuiSidebarPanel": { "enabled": true },

  // Keep the other automatic TUI displays off.
  "enableToast": false,
  "tuiCompactStatus": { "enabled": false },

  // Show the count of maintainer notices on Home, once a day for 10 minutes.
  "maintainerAnnouncements": { "enabled": true, "home": true },
}
```

Restart OpenCode, then run `/quota` and `/quota_status` in the TUI. `/quota_status` shows the exact files OpenCode Quota loaded.

## Choose what appears in the TUI

| You want                   | Setting                                   |
| -------------------------- | ----------------------------------------- |
| Sidebar panel              | `tuiSidebarPanel.enabled: true`           |
| Popup quota notifications  | `enableToast: true`                       |
| Compact quota line         | `tuiCompactStatus.enabled: true`          |
| Quota bar under the prompt | `tuiPromptBar.enabled: true`              |
| Slash commands only        | Turn off sidebar, toast, and compact line |

Web and Desktop show none of these. See [Configuration](configuration.md) for every setting.

## Web and Desktop notes

- Slash commands work in the TUI, Web, and Desktop. Add arguments after the command, like `/tokens_between 2026-09-01 2026-09-25`.
- **TUI:** a slash command opens the report in a popup and leaves no chat message (default `tuiCommandDisplay: "dialog"`). Set `"inline"` to keep it in the chat. The command palette runs the same commands, always in a popup, and asks for missing dates.
- **Web and Desktop:** `/quota` posts the report in the chat as your message. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`, which also keeps it out of compaction summaries.
- Web uses a proportional font, so columns may not line up. Use the TUI, or `npx opencode-quota-gui show`, for aligned columns.
- If the AI is busy, the report appears after it finishes. A new session whose first message is a report keeps its default title.
- The AI can call the `quota_status` tool to check your setup.
- The dashboard runs at <http://localhost:4144> while the plugin is loaded; see [Dashboard](../../README.md#dashboard).

To update later, see [Updating safely](updating.md).
