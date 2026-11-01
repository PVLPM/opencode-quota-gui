[← Back to README](../../README.md)

# Manual install

The normal install is one OpenCode command. It adds the plugin entry for you:

```bash
opencode plugin add opencode-quota-gui
```

OpenCode installs the npm plugin named in the config. You do not need a separate `npm install`.

## Config locations

- **Global:** `~/.config/opencode/opencode.json` or `opencode.jsonc`. When `XDG_CONFIG_HOME` is set, OpenCode uses `$XDG_CONFIG_HOME/opencode`; `OPENCODE_CONFIG_DIR` replaces the global config folder.
- **Project:** `opencode.json` or `opencode.jsonc` at the repository root, or `.opencode/opencode.json(c)`. A `.opencode` config overrides a direct config.
- **Plugin key:** OpenCode 2 uses the plural `plugins` array. Keep your other entries and their order.
- **Discovered plugin directories:** `~/.config/opencode/plugins/` and project `.opencode/plugins/`. OpenCode loads direct `.ts`/`.js` files and immediate plugin package directories there. A `plugins/` folder beside a project-root `opencode.json(c)` is not discovered automatically; configure its files explicitly or move it under `.opencode/`.

Use `.jsonc` if you want comments, or `.json` if another tool needs strict JSON (no comments, no trailing commas). Restart OpenCode after changing the plugin entry or a local plugin path.

## Add the plugin manually

Add this entry to the global or project `plugins` list:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-quota-gui"],
}
```

Keep any existing plugins. If a companion provider plugin is involved, put its entry **before** `opencode-quota-gui`:

```jsonc
{
  "plugins": ["cursor-opencode-provider/plugin/opencode2", "opencode-quota-gui"],
}
```

Alternatively, let the optional guided installer preview the edit:

```bash
npx opencode-quota-gui init --dry-run
npx opencode-quota-gui init
```

`init` is not required for the normal install. It previews the plugin entry, the global canonical GUI settings, and the OpenCode config location before writing. Choosing a project install selects only the project OpenCode plugin entry; behavior settings remain in the global `opencode-quota-gui/config.jsonc`. The preview states this, and an existing sibling GUI `config.json` is preserved unchanged, not converted or imported implicitly.

Web access is off by default. Add `"dashboard": { "enabled": true }` to the canonical file above, restart OpenCode, then open <http://localhost:4144/quota>. The dashboard is the product surface; there is no separate TUI entry to add. See [Web dashboard](configuration.md#web-dashboard) for the recovery edit and fixed-port behavior.

## First settings

The dashboard reads its canonical settings from:

```text
~/.config/opencode/opencode-quota-gui/config.jsonc
```

A fresh setup works with defaults, but the browser dashboard stays off until that file contains `"dashboard": { "enabled": true }` and OpenCode restarts. Open the [Configuration](configuration.md) guide to set provider selection, display mode, accounting detail, web access, or a custom provider. Settings changes write only this canonical file; see [Settings and privacy](../../README.md#settings-and-privacy). Behavior settings are always global, even when the plugin entry is project-local.

## Requirements

- OpenCode `2.0.16` or newer. The experimental Desktop panel requires OpenCode Desktop `2.2.0` or newer. This package does not support OpenCode 1.
- Node.js `22.13+` (or `23.4+` on Node 23), whether you run the package with `npx` or from a local checkout.

## Local checkout (development)

Build once, then point `plugins` at the explicit server file with an absolute `file:` URL:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-quota-gui/server.ts"],
}
```

`server.ts` re-exports the built server plugin default from `dist/index.js`. This explicit file entry loads only the server; it does not discover the Desktop GUI export. For Desktop GUI development, use the built package directory entry so OpenCode can resolve both the server and `./gui-experimental` exports.

Build before loading:

```bash
pnpm install
pnpm run build
```

A relative path under `plugins` resolves from the config file that contains the entry, so a relative checkout path only works when the checkout sits at that relative location. Prefer an absolute `file:` URL. After changing `src/`, rerun `pnpm run build` and restart OpenCode; OpenCode never rebuilds the checkout for you.

## Pre-release tarball

Build and pack the checkout, then point the optional `OPENCODE_QUOTA_PLUGIN_SPEC` override at the tarball. Keep it an absolute `file:` URL: a relative spec resolves from the OpenCode config folder, not your checkout.

```bash
pnpm install
pnpm run build
pnpm pack
export OPENCODE_QUOTA_PLUGIN_SPEC="file:///absolute/path/to/opencode-quota-gui-<version>.tgz"
node dist/bin/opencode-quota-gui.js init
```

On PowerShell, set the same value with `$env:OPENCODE_QUOTA_PLUGIN_SPEC = "file:///..."`. The installer previews the plugin entry before writing. Release installs use the npm package; local checkouts and tarballs are for development and testing.

To update later, see [Updating safely](updating.md).
