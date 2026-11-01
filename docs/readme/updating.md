[← Back to README](../../README.md)

# Updating safely

## Update the plugin

The normal update is the same OpenCode entry:

1. Let OpenCode resolve `opencode-quota-gui` again from your `plugins` list.
2. Restart OpenCode.
3. If web access is enabled, reload <http://localhost:4144/quota> and check Settings → About for the new Version and Build.

If you pinned a version or a tarball URL in `plugins`, update that value explicitly. OpenCode installs the configured npm plugin; this package does not run a background updater.

Use a full OpenCode process restart when changing package versions. A cross-version in-process plugin reload is not enough to guarantee old web listeners stop: the previous module graph owns its own lifecycle registry and listener, and the new version intentionally does not adopt that record. The old listener can keep the fixed port until the process exits.

## Web dashboard after upgrade

Browser access is off by default for every user, including upgrades from `1.2.0` or earlier where no `dashboard.enabled` value exists. The plugin, retry handling, credentials, and shared dashboard runtime still load; only the HTTP/SSE/static web transport stays off.

To restore browser access by editing canonical JSONC manually:

1. Open `~/.config/opencode/opencode-quota-gui/config.jsonc` (or the path selected by `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`).
2. Add or update:
   ```jsonc
   {
     "dashboard": {
       "enabled": true,
       "port": 4144
     }
   }
   ```
3. Restart OpenCode. The setting is read when the dashboard lifecycle starts and is not hot-reloaded.
4. Open <http://localhost:4144/quota>. The server binds `127.0.0.1` only and does not choose a fallback port.

## Optional maintenance CLI

The package also ships a previewing maintenance CLI. It is optional:

```bash
npx opencode-quota-gui update --dry-run
npx opencode-quota-gui update
```

- `update` prints one complete plan and asks before applying it. `--yes` skips the question for scripts.
- It can rewrite recognized `opencode-quota-gui` package specs, keep plugin options, and remove package-cache folders that pass path, symlink, containment, and package-manifest checks.
- It does not read, print, copy, or delete credential values, does not edit `opencode.db`, and does not install or upgrade the npm package.
- A moving spec such as `opencode-quota-gui@latest` stays as written so OpenCode can re-resolve it.
- `OPENCODE_QUOTA_PLUGIN_SPEC` overrides the spec used for recognized entries. The preview lists every change before writing.

`update` never moves upstream `@slkiser/opencode-quota` entries or their state. This package and the upstream package are independent; see [OpenCode and upstream compatibility](../../README.md#opencode-and-upstream-compatibility).

## Settings and legacy import

The dashboard reads only `~/.config/opencode/opencode-quota-gui/config.jsonc` at runtime, plus defaults. It does not apply a project `opencode-quota/quota-toast.json(c)` or `experimental.quotaToast` layer at runtime. Settings shows canonical values only; a global legacy source appears only when it is available as a separate import preview. Behavior settings are always global, including after a project plugin install; the installer preview states this. An existing sibling GUI `config.json` is preserved unchanged and is not converted or imported implicitly.

1. Back up the OpenCode config files you use.
2. Restart OpenCode after the package update.
3. If web access is enabled, open <http://localhost:4144/settings>. If an eligible global legacy source exists, preview the import and apply it.
4. Review configuration issues in Settings. The import copies only seven compatible keys; `quotaProviders` definitions must be added to the canonical file manually.

The import leaves source files byte-for-byte untouched. It does not migrate or delete upstream private state, credentials, logs, or caches.

## Port changes

`dashboard.port` defaults to `4144` and is read-only in the web UI. To change it, set `dashboard.enabled` to `true`, edit the port, and restart OpenCode:

1. Set `dashboard.enabled` to `true` and edit `dashboard.port` in the canonical config file.
2. Restart OpenCode.
3. Open the new `http://localhost:<port>/quota` URL.

The server does not fall back to another port if the configured one is busy.

## OpenCode 1

This package requires OpenCode `>= 2.0.16 < 2.3.0`. It does not install, update, or load on OpenCode 1. Use the upstream `@slkiser/opencode-quota` project for that historical line.

## Rolling back

1. Restore the previous package spec or tarball URL in `plugins`.
2. Restore the previous canonical settings file if the newer version changed settings.
3. Restart OpenCode.

If a maintenance command changed a config file and you need to undo it, restore your backup. Settings and visibility writes use atomic file replacement and preserve symlinks; a failed write leaves the original file in place. Do not hand-edit opaque visibility IDs; use Settings → Visibility.

## Troubleshooting an update

- **The plugin does not load:** confirm the `plugins` entry and restart OpenCode. Check that the package spec resolves to the version you intended.
- **The dashboard shows a build or contract mismatch:** the server and browser page are from different builds. Restart OpenCode, then reload the dashboard. Reinstall the same package or tarball if it persists.
- **Your old settings disappeared:** they may still be in a legacy file. Use the explicit import in Settings; runtime loading intentionally ignores those layers.
- **The canonical file is malformed:** lower layers do not silently replace it in the dashboard. Fix the file or restore a backup, then reload Settings.

See [Troubleshooting](troubleshooting.md) for dashboard, login, and provider-specific fixes.
