[← Back to README](../../README.md)

# Troubleshooting

## First checks

1. Confirm the `opencode-quota-gui` entry is in the `plugins` list of `~/.config/opencode/opencode.json(c)`, or in a project `opencode.json(c)` / `.opencode/opencode.json(c)`.
2. Restart OpenCode after changing the plugin entry, a login, or the canonical settings file.
3. Open <http://localhost:4144/quota>. If the page is blank or stale, reload it and check the connection state in the top bar.
4. Open <http://localhost:4144/settings> and read the configuration issues and the Version, Build, and Contract in the About block.
5. Find the failing provider card and read its card-local error. One card failing does not hide the others.

If every provider is missing, check the plugin entry first. The plugin must load in OpenCode before the dashboard can start. Dashboard log lines use the `[opencode-quota-gui]` prefix and are scrubbed of credentials and absolute paths.

## Dashboard

| Problem | Try this |
| --- | --- |
| Dashboard does not open | Confirm OpenCode loaded the plugin and restart it. Check that nothing else uses the configured port. The server does not choose a fallback port. |
| `dashboard server unavailable` in the log | Another process owns the port. Stop it, or change `dashboard.port` in the canonical file and restart OpenCode. |
| Page says `Data may be stale` or `Reconnecting…` | The browser lost the local event stream. Reload the page; if it persists, restart OpenCode. |
| Settings will not save | The canonical file changed elsewhere, or the file is malformed. Reopen Settings, review the reported issue, and save again. |
| `Build mismatch` or contract mismatch | The server and browser page came from different builds. Restart OpenCode, then reload the dashboard. Reinstall the same package or tarball if it persists. |
| Settings changed but the dashboard did not | Settings writes the global canonical file. A legacy or project config does not take effect until it is imported or copied into the canonical file. Restart OpenCode after editing the file by hand. |
| No sessions or token history | Start OpenCode once so it creates `opencode.db`, then use a model so completed steps are recorded. |
| Pricing looks old | Restart OpenCode. The bundled pricing snapshot updates with the package; a runtime snapshot follows `pricingSnapshot.autoRefresh`. |
| Page is visible to another machine | It should not be. The server binds to `127.0.0.1` only. Check for a local proxy or tunnel that exposes it. |

## Logins

The dashboard asks OpenCode 2 for logins; it does not read `auth.json` directly. OpenCode 2 copies `auth.json` only once, the first time it starts.

- If a provider is missing, log in to it again in OpenCode 2 (`/connect`, or `opencode auth login <provider>`).
- If a card says a sign-in could not be refreshed, remove that login and sign in again. `opencode auth list` shows the saved labels.
- Session and token history comes from `opencode.db`. `OPENCODE_DB` and `XDG_DATA_HOME` can change its path; custom OpenCode builds may use an `opencode-<channel>.db` file.

## Service environment

The dashboard runs inside OpenCode's background service. That service takes `PATH` and environment variables from whatever started it first, not from the terminal you use now, and it runs in your home folder.

- **`claude` or `bl` not found, or an API-key variable ignored:** in a terminal where they work, run `opencode service restart`. To keep that `PATH` for every later start, run `opencode service set env PATH "$PATH"` (it stops the service; open OpenCode again). For Claude you can instead set `anthropicBinaryPath`.
- Cursor's plugin-entry check reads `opencode.json` in your global config folder and your home folder, not in the project folder.

## Provider fixes

Setup steps and API-key variable names are in [Providers](providers.md). The dashboard reports safe card errors and does not print URLs, credentials, raw response bodies, or request details.

<details>
<summary><strong>Custom providers</strong></summary>

Custom definitions live in the canonical `quotaProviders` array. See [Configuration](configuration.md#custom-providers).

| Symptom | Fix |
| --- | --- |
| Definition is rejected | Keep `quotaProviders` global, remove unknown fields, duplicate IDs or request identities, and overlapping model coverage. |
| Definition does not appear | With a manual provider list, include `quota-providers`. Confirm OpenCode reports the exact `providerId`. |
| Missing credential | Set the `apiKeyEnv` variable, trusted global `provider.<providerId>.options.apiKey`, or an API-key login saved in OpenCode 2 for that provider id. |
| HTTP, timeout, or response error | Check the endpoint and its documented response format. The dashboard intentionally hides URLs, request and response contents, raw errors, and secret material. |
| One definition fails but others show | Expected. Working definitions stay visible; the failed one stays an error card. |
| Local estimate stays at zero | Make sure the current model matches `modelIds`, and that OpenCode has completed requests for it. |

</details>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

| Symptom | Fix |
| --- | --- |
| `claude` not found | Install Claude Code. The plugin tries `claude` on the [service `PATH`](#service-environment), then `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). |
| Claude is installed at a custom path | Set `anthropicBinaryPath` in the canonical config file. |
| Not signed in | Run `claude auth login`, then check `claude auth status`. |
| Signed in but no quota rows | Sign in to Claude again if the OAuth credential fallback is missing or stale. |
| Provider not detected | Make sure OpenCode uses the `anthropic` provider. |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

| Symptom | Fix |
| --- | --- |
| Copilot works in OpenCode but no personal quota | Log in to Copilot again if the token or its saved GHE.com host is invalid. |
| Organization or enterprise accounting is missing | Create `copilot-quota-token.json` as in [GitHub Copilot setup](providers.md#github-copilot). |
| GHE.com host is rejected | Use the enterprise hostname (for example `acme.ghe.com`) or a host-only HTTPS URL. No `api.`, path, query, fragment, port, userinfo, wildcard, HTTP, IP/localhost, or other domain. |
| Personal report is forbidden | Use a fine-grained PAT with **Plan: read** or a GitHub App user token. An installation token cannot read a personal report. |
| Organization report or budget is forbidden | Use an organization admin/billing-manager credential. Fine-grained PATs and GitHub App tokens need **Organization administration: read**. Usage can still show with a budget warning when only budget access fails. |
| Enterprise report is forbidden | Use a classic PAT held by an enterprise admin or billing manager. |
| Usage shows without a percentage | Expected when GitHub gives usage but no allowance or budget. The plugin never invents a percentage. |
| Legacy PRU config is rejected | Use `"billingModel": "legacy_premium_requests"` only for an annual Pro or Pro+ plan that stayed on legacy billing after June 1, 2026. |
| Rate-limit error | Wait for GitHub's API rate limit to reset, then reload the dashboard. |

</details>

<details>
<summary><strong>OpenAI and xAI</strong></summary>

| Symptom | Fix |
| --- | --- |
| OpenAI quota missing | Sign in with a Codex login: `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. **Sign in with ChatGPT** has no ChatGPT quota. |
| `ChatGPT quota unavailable for Sign in with ChatGPT` | OpenAI doesn't share ChatGPT usage with this login. Sign in with a Codex login instead. |
| `OpenAI sign-in could not be refreshed` | If the error names an `opencode auth logout …` command, run it to remove the broken login, then `opencode auth login openai`; signing in again alone can leave a broken login with another label in place. For xAI, run `opencode auth login xai`. |
| Provider not detected | Make sure OpenCode uses the `openai` provider or a compatible OpenAI login. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

| Symptom | Fix |
| --- | --- |
| Cursor not detected | Put `cursor-opencode-provider/plugin/opencode2` before the OpenCode Quota GUI plugin entry in the `plugins` list of `opencode.json(c)`. |
| Cursor login missing | Run `/connect` → **Cursor** in OpenCode, or set `CURSOR_API_KEY`. |
| Quota shows but no remaining percentage | Set `cursorPlan` or `cursorIncludedApiUsd` in the canonical config file. |
| Billing cycle looks wrong | Set `cursorBillingCycleStartDay` to your billing day. |
| Unknown Cursor pricing | Restart OpenCode after updating the package. Cursor `auto`, `composer*`, and `grok-4.5`–`grok-4.7` use bundled Cursor pricing. |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

| Symptom | Fix |
| --- | --- |
| API key not detected | See [API keys](providers.md#api-keys). Repo-local provider secrets are ignored. |
| Limits need tuning | Define a local estimate with the reserved `alibaba-coding-plan` id in the canonical `quotaProviders` array. |
| Counters do not move | Make sure the current model is `alibaba/*` or `alibaba-cn/*`. |
| Quota seems stale | Check the state path under `~/.local/state/opencode/opencode-quota-gui/quota-providers/` and restart OpenCode. |

</details>

<details>
<summary><strong>Alibaba Personal Token Plan</strong></summary>

| Symptom | Fix |
| --- | --- |
| CLI not detected | Install `bailian-cli` so `bl` is in an absolute folder on the [service `PATH`](#service-environment), outside the project folder (for example `/opt/homebrew/bin`, `~/.local/bin`, or an nvm folder). On Windows, use WSL. See [setup](providers.md#alibaba-personal-token-plan). |
| Console session expired | Run `bl auth login --console`. A Coding Plan API key cannot sign in to this provider. |
| Weekly row only | The official CLI may leave out the five-hour window. The plugin does not invent it. |

</details>

<details>
<summary><strong>API-key providers (MiniMax, Kimi, Chutes AI, Synthetic, Z.ai, Zhipu, NanoGPT, DeepSeek, OpenRouter)</strong></summary>

- Put keys in environment variables or trusted user/global config, never in the project's `opencode.json`. Variable names and rules: [API keys](providers.md#api-keys).
- Kimi keys go only to their own region's host: see [Kimi Code](providers.md#kimi-code).
- Synthetic returning `Synthetic returned no quota data for this account.` means the quota endpoint returned HTTP 200 `{}`. This is not a bad API key or a Clerk/browser problem, and no 5-hour or Weekly rows are invented.
- An HTTP 401 or 403 means the provider rejected the key. Update the source or sign in again, then restart OpenCode.

</details>

<details>
<summary><strong>Google AGY</strong></summary>

| Symptom | Fix |
| --- | --- |
| Companion missing | Put `@anthonyhaussman/opencode-agy-auth` before the OpenCode Quota GUI plugin entry in the `plugins` list of `opencode.json(c)`. |
| Provider not enabled in manual mode | Include `google-agy` in `enabledProviders`. |
| Login missing | Run `opencode auth login google-agy`. |
| Project missing | Set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`. |
| No rows | Restart OpenCode and check the companion plugin's own login state. |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal accounts on 2026-06-18, so personal Google users should use [Google AGY](providers.md#google-agy-quick-setup) instead.

| Symptom | Fix |
| --- | --- |
| Companion missing | Put `opencode-gemini-auth` before the OpenCode Quota GUI plugin entry in the `plugins` list of `opencode.json(c)`. |
| Provider not enabled in manual mode | Include `google-gemini-cli` in `enabledProviders`. |
| Login missing | Run `opencode auth login google`. |
| Project missing | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>Xiaomi MiMo</strong></summary>

| Symptom | Fix |
| --- | --- |
| Config not detected | Set `MIMO_USAGE_COOKIE` or create trusted user/global `opencode-quota-gui/mimo.json`, then restart OpenCode. The plugin does not read upstream `opencode-quota/mimo.json`. |
| Config is invalid | Fix or remove the reported higher-priority source; an invalid source blocks fallback on purpose. |
| Provider not enabled in manual mode | Include `xiaomi` in `enabledProviders`. |
| Monthly quota missing | Make sure the plan is active. Expired plans are hidden. |
| Balance or plan details missing | The requests fail independently, so other rows can still show. |
| Session expired | Sign in again at `platform.xiaomimimo.com`, copy a fresh Cookie header ([how](providers.md#xiaomi-mimo)), and update the same source. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

| Symptom | Fix |
| --- | --- |
| Provider not detected | Run `opencode auth login opencode`, or set an API key ([order](providers.md#opencode-go)). |
| Sign-in is invalid or broken | Run `opencode auth login opencode-go`. A broken `opencode-go` login blocks the legacy `opencode` fallback. |
| `OpenCode Console sign-in failed` | Shown only when no API key is set. Run `opencode auth login opencode`, or set an API key. |
| No Go quota | The Console request failed and no API key is set. Retry, or set an API key. |
| API returns 401 or 403 | The usage API rejected the key. Update the source and restart OpenCode. |
| Invalid API response | 5-hour, Weekly, and Monthly must all be valid; one bad window rejects the whole response. |
| Request times out or fails | Make sure `https://opencode.ai/zen/go/v1/usage` is reachable, then retry. Raise `requestTimeoutMs` only for timeouts. |
| Expected window is not shown | Update `opencodeGoWindows` (`rolling`, `weekly`, `monthly`). |
| Provider missing in manual mode | Include `opencode-go` in `enabledProviders`. |

</details>

<details>
<summary><strong>OpenCode Zen</strong></summary>

| Symptom | Fix |
| --- | --- |
| Zen does not appear | Run `opencode auth login opencode` and sign in to the Console. An API key alone is not a Console sign-in. To see a hint instead of nothing, include `opencode` in `enabledProviders`. |
| `OpenCode Console sign-in failed` or `session expired or invalid` | Run `opencode auth login opencode` again. |
| Wrong organization | Run `opencode auth switch opencode`, or sign in again and pick the organization. |
| `OpenCode Console <route> error 403` | Your sign-in cannot read that route for this organization. Zen still shows the other rows, unless the route is `billing/status` (the balance). |

</details>
