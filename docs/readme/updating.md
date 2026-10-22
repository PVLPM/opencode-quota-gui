[← Back to README](../../README.md)

# Updating safely

## Preview, apply, and restart

1. Back up the OpenCode config files you use, especially if you might roll back (older versions do not understand every newer setting).
2. Close OpenCode.
3. Preview. This changes nothing:

   ```bash
   npx opencode-quota-gui update --dry-run
   ```

4. Read the preview. If it looks right, apply it:

   ```bash
   npx opencode-quota-gui update
   ```

   It asks once before changing anything. For scripts, `update --yes` skips the question. It still prints the full preview and applies only the safe config edits and verified cache cleanup, never secret changes.

5. Restart OpenCode, then run `/quota_status` (or `npx opencode-quota-gui status`).

Good to know:

- `npx` runs the published CLI without a global install; if you installed the package, `opencode-quota-gui update ...` runs the same commands. For a pre-release local tarball, build and pack it and set the optional `OPENCODE_QUOTA_PLUGIN_SPEC` override to its absolute `file:` URL first (see the [README quick start](../../README.md#quick-start)); `update` then targets that tarball instead of the npm package. The "preview first" promise covers what the updater changes: OpenCode config files and OpenCode Quota package caches.
- The updater builds one plan, prints all of it, then either stops or applies that same plan.
- Recognized quota plugin specs are tracked under both identities: this package's `opencode-quota-gui` and the legacy `@slkiser/opencode-quota`. Legacy entries, config, and package caches remain migration sources. No package spec changes without appearing in the preview, and a run without an explicit spec never renames a moving legacy spec to this package's identity.

## Moving to OpenCode 2

This independent package, `opencode-quota-gui` `1.0.0`, runs only on OpenCode `2.0.16` or newer.

1. Install OpenCode 2 ([OpenCode v2 docs](https://opencode.ai/v2/docs/)) and start it once. On first start it copies your old `auth.json` logins into its database, `opencode.db`. It does this only once.
2. Run the update steps above.
3. Run `/quota_status`. If a provider is missing, log in to it again in OpenCode 2 (`/connect`, or `opencode auth login <provider>`).

What changed in the upstream OpenCode Quota `5.0.0` line (inherited history):

- **OpenCode 1 is no longer supported.** `init` detects it and stops without changing anything (upstream 4.x is the historical line for OpenCode 1). See [OpenCode 1](#opencode-1).
- **Logins come only from OpenCode 2.** Inside OpenCode, logins come through OpenCode 2's plugin API; the terminal command reads `opencode.db` read-only. Neither reads `auth.json`.
- **Quota runs in OpenCode's background service.** Inside OpenCode, `PATH`, environment variables, and the working folder (your home folder) come from the service, not your terminal. See [Service environment](troubleshooting.md#service-environment).
- **Web and Desktop get slash commands, but no toasts or panels,** because OpenCode 2 gives plugins no Web UI hooks. See [Web and Desktop notes](manual-install.md#web-and-desktop-notes).
- **One plugin entry.** Add one entry to the `plugins` list in the OpenCode 2 config (`~/.config/opencode/opencode.json` or `opencode.jsonc`, or a project config); it loads the server, the TUI, and the dashboard, so no `tui.json` entry is needed.
- **TUI reports open in a popup** and leave no chat message. `tuiCommandDisplay` now defaults to `"dialog"`; set `"inline"` to keep them in the chat.
- **OpenCode Zen uses your OpenCode Console sign-in.** See [OpenCode Zen findings](#opencode-zen-findings).
- **Removed setting:** `tuiCompactStatus.suppressWhenNativeProviderQuota`. The old key is ignored.

## OpenCode 1

`init` and `update` run `opencode --version` first:

| OpenCode found | What happens |
| --- | --- |
| OpenCode 2 | Everything works as described on this page. |
| OpenCode 1 | This build does not support OpenCode 1. `init` stops without changing anything. The upstream `npx @slkiser/opencode-quota@4 init` is the historical OpenCode 1 line, not this package. `update` never migrates an OpenCode 1 setup to this build. |
| Unknown (for example, `opencode` is not on your `PATH`) | `init` asks which OpenCode you use. `update` assumes OpenCode 2 and prints a note; on OpenCode 1, set its historical singular `"plugin": ["@slkiser/opencode-quota@4"]` yourself (upstream historical line). |

## Read the preview

The preview has up to three sections (empty ones are hidden):

- **Safe changes this command can make:** package-spec edits (in the legacy `plugin` and current OpenCode 2 `plugins` entries; plugin options are kept) and known display-setting moves.
- **Manual actions — this command will not change these sources:** credential findings or config that needs your review.
- **Package-cache candidates:** folders it may remove, only after current config and the package manifest check out.

Exit codes:

- `0`: applied, already current, dry-run, manual-only findings, or cancelled. Manual findings do not fail the command, but they stay your job.
- `1`: bad arguments, incomplete planning, a config race, a write failure, or a failed check after writing.

## What can change automatically

- On OpenCode 2 without an explicit spec, `update` rewrites recognized **non-moving** quota specs to `opencode-quota-gui@latest`: bare package names and exact versions of either package, such as `opencode-quota-gui@1.0.0`, `@slkiser/opencode-quota`, or `@slkiser/opencode-quota@3.11.1`. Each entry keeps its plugin options. **Moving** specs stay exactly as written so OpenCode re-resolves them: `opencode-quota-gui@latest`, `opencode-quota-gui@next`, `@slkiser/opencode-quota@latest`, `@slkiser/opencode-quota@next`, and `@slkiser/opencode-quota@4`. A moving upstream spec is therefore not silently renamed to `opencode-quota-gui`.
- With `OPENCODE_QUOTA_PLUGIN_SPEC` set, that exact spec is the target for recognized entries instead; the preview lists every rewrite, and plugin options are kept. Duplicate quota entries with identical options are collapsed to one, and differing options stop the run before any write. `update` never adds a quota plugin entry that was not already configured.
- Package-cache folders are removed only if they pass path, symlink, containment, and exact package-manifest checks.
- The removed `opencodeZenDisplay` setting is migrated in known config files: `"default"` becomes root `accountingDetail: "summary"`, and `"detailed"` becomes `accountingDetail: "detailed"`. If a valid `accountingDetail` already exists, it wins and the old key is removed.

Edits keep your other settings, plugins, comments, trailing commas, and plugin options. A supported config symlink stays a symlink; the updater writes the real file behind it.

Left alone for you to fix by hand: unsupported or invalid display values, duplicate keys, unclear structures, broken files, unsupported folders, and newly found symlinks. For these, use root `accountingDetail: "summary"` or `"detailed"`, and do not share the rejected value. SDK-only config is reported but never edited, because there is no file to edit.

## What stays manual

Credential findings are report-only. The updater spots old credential sources by variable name or file path only. It never reads, prints, copies, or deletes secret values, and never edits environment settings, shell startup files, `opencode.db`, or credential files. Never paste credential values into output, issues, or support messages.

### OpenCode Go findings

OpenCode Go now uses a Console sign-in or an official API key. Set up a supported source (see [OpenCode Go](providers.md#opencode-go) for the order), for example:

```bash
opencode auth login opencode-go
```

Check it with `/quota_status` or `npx opencode-quota-gui status`. Only then remove the old `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` declarations and any global `opencode-quota/opencode-go.json` file. Workspace/cookie values cannot be turned into an API key.

### OpenCode Zen findings

OpenCode Zen now uses your OpenCode Console sign-in: run `opencode auth login opencode` (and `opencode auth switch opencode` to pick a saved organization), then check `/quota_status`. See [OpenCode Zen](providers.md#opencode-zen).

Leftovers from the old workspace/cookie setup are reported, never read or moved:

- A global `opencode-quota/opencode.json` file: no longer read. Remove it after Zen works.
- `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE`: ignored now. They may also belong to OpenCode's workspace feature, so remove them only if they held Zen credentials.

## Cancelling, failures, and reruns

- Cancelling the prompt or running `--dry-run` changes nothing.
- Rerunning is safe: a finished migration is not repeated. Manual findings stay until you fix their source.
- Every planned file is checked again right before writing, and each file is written atomically.
- Symlinked config: the updater checks the link chain while planning and again just before writing. It stops on dangling links, loops, chains longer than 40 hops, non-regular targets, permission errors, retargeted links, file changes in between, and JSON-to-JSONC conversions that would delete a symlink.
- Several files are not one transaction, and there is no automatic rollback over your own edits. If a later file changed or a write failed, the error lists the files already changed and no package cache is deleted. Fix the cause, check those files, and run `update --dry-run` again for a fresh plan.
