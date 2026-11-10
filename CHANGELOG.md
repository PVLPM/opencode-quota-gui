# Changelog

User-facing release notes for OpenCode Quota GUI.

## 1.3.1

### Added

- **Cache observation.** The Native composer pill shows the most recent reported primary cache-read percentage and independent session observations. Retention colors are estimates based on documented assumptions, not guarantees of a future cache hit; unsupported routes remain unverified.
- **Quota alert controls.** Configure Native alerts for low quota, exhaustion, reset windows, and provider failures independently, with a master switch and shared cooldown.
- **Agent provider proposals.** Agents can inspect and propose disabled custom-provider definitions; approval, activation, and credential-bearing tests remain under user control.
- **China 2027 holidays.** Temporal pricing includes the seven official national holiday intervals without changing weekday or weekend rules.

### Improved

- **Session cache details.** A scrollable composer popover displays session activity and available agent, provider, model, and effort information. A model-selection mismatch warns before the next request without claiming that a prior cache was destroyed.
- **Runway on demand.** Eligible quota values and bars show a projected exhaustion tooltip without adding a persistent card row.
- **Provider compatibility.** Alibaba Coding Plan quota uses the official Bailian CLI, and Claude Agent routes through the existing Anthropic integration.
- **Privacy-safe diagnostics.** Copy operational diagnostics or an account-scoped quota summary without exporting credentials or session content.

### Compatibility

- OpenCode `>= 2.0.16 < 2.3.0`; the full Native integration requires OpenCode Desktop 2.2.1 or newer. Supported older hosts, including 2.2.0, retain the browser-dashboard fallback by default unless explicitly configured otherwise.
- Cache retention and future reuse cannot be verified from token counts alone; the displayed status and expiry are estimates, not proof of a physical provider cache.

## 1.3.0

The Native OpenCode Desktop release. Quota, analytics, models, and settings now live inside OpenCode Desktop, with a session-header quota slot and native notifications. The browser dashboard is now a fallback: on by default below OpenCode 2.2.0, off by default at 2.2.0 and newer.

### Added

- **Native OpenCode Desktop panel.** **Quota & Usage** opens a full side panel with Quota, Analytics, Models, and their project, session, provider, and model detail pages. No browser tab is required. The Native integration is available from **v1.3.0** and requires **OpenCode Desktop 2.2.0 or newer**.
- **Native Settings.** OpenCode Settings includes a **Quota & analytics** page for display, provider, request, temporal pricing, visibility, and card-order controls, plus the web dashboard switch and the canonical settings file.
- **Session header quota slot.** Compact rings show quota windows at a glance; open the slot for a combined preview of every visible provider and account, including reset countdowns.
- **Native notifications.** Low quota, exhausted quota, quota reset, and provider or API failures. A focused OpenCode window shows an in-app toast; a background window asks OpenCode for a system notification. The low-quota threshold and duplicate cooldown are configurable. Delivery is best effort while OpenCode Desktop is running, not exactly once.
- **Multiple providers and accounts.** Every signed-in account, seat, API key, or workspace keeps its own card.

### Improved

- **Session switching stays fast.** Moving between sessions reuses the same shared quota and analytics state instead of reloading the dashboard.
- **Quota cards, natively.** Provider marks, plan and account labels, remaining windows, reset countdowns, balance, spend, budget, and status rows use native Desktop presentation.
- **Peak and off-peak context.** The Quota header keeps its **Peak**, **Off-peak**, or **Mixed** status with the next change, and model detail pages keep their historical Peak and Off-peak split.
- **Analytics and Models.** Daily usage, projects, sessions, the session tree, provider and model breakdowns, and token and API-equivalent cost views are all available in the panel.
- **Settings layout.** Native controls and a clearer Settings layout make the shared options easier to scan and change.
- **Web dashboard default is version-gated.** Browser access stays on by default below OpenCode 2.2.0, where the Native panel does not exist. At 2.2.0 and newer it is off by default, including after an upgrade from 1.2.0 or earlier. An explicit `dashboard.enabled` in the canonical settings always wins. Web access remains loopback-only on port `4144` by default.

### Fixed

- **Smoother Native reconnect.** Recovering from a normal Desktop connection renewal no longer interrupts a healthy session or forces a full dashboard reload.
- **Quota indicators stay visible.** Header quota rings remain available across normal Desktop watch rotations instead of disappearing during routine connection maintenance.
- **Settings navigation stays connected.** Opening OpenCode Settings and returning to a session keeps the same dashboard connection, so the panel no longer shows a false `Connecting…`.

### Compatibility

- OpenCode `>= 2.0.16 < 2.3.0` and Node.js `22.13+` or `23.4+`.
- The Native Desktop integration is included from v1.3.0 and requires OpenCode Desktop 2.2.0+.
- The browser dashboard is on by default below OpenCode 2.2.0 and off by default at 2.2.0 and newer; an explicit `dashboard.enabled` value wins. It remains loopback-only.
- This package does not support OpenCode 1.

## 1.2.0

### Added

- **Live peak and off-peak status.** On the Quota page, providers whose published pricing has time-based rules now show a compact **Peak**, **Off-peak**, or **Mixed** status with the time of the next change. Open a status to see that provider's models grouped by their exact pricing policy, the upcoming windows or recurring weekly schedule in your local time zone, the current or next public-holiday exception, and whether the period raises, lowers, or leaves the API price unchanged. Z.ai plan schedules are described as quota points, never as a dollar price.
- **Historical peak and off-peak breakdown.** A model's detail page now splits each provider route's recorded tokens and API-equivalent cost into **Peak** and **Off-peak** rows for the selected range.
- **Temporal pricing controls.** Settings has a new **Temporal pricing** section that lists every provider with time-based pricing. A provider with a discovered account starts on; each switch keeps an explicit on or off choice.

### Improved

- **Estimates follow the price in effect at completion.** Recorded steps are priced with the peak or off-peak rate that applied when each step completed, instead of one current rate. Cached estimates are invalidated when the bundled pricing snapshot changes.
- **Pricing data ships with the package.** Time-based rules come from a pinned, validated `models.dev` snapshot inside the package, so status and historical estimates need no runtime network request.
- **Honest pricing labels.** A window that changes different token types by different multipliers is described as varying by token type instead of being shown as one multiplier.
- **Dollar values use `$`.** Monetary rows on quota cards render `$50.27` instead of `50.27 USD`. Other currencies keep their ISO code.

### Fixed

- **Settings rows stay aligned.** Labels, controls, and eye buttons keep their columns at narrow window widths instead of drifting out of alignment.
- **Hidden cards look hidden.** Cards turned off in Settings → Visibility are visibly subdued while editing.

### About peak and off-peak status

Peak and off-peak status appears only for providers whose published pricing defines time-based rules. A provider is **Mixed** when its models are in different states at the same moment, and **Unknown** when the applicable rule cannot be resolved; the dashboard does not guess a phase. Z.ai plan schedules that adjust quota points are kept separate from API price changes and are never presented as a dollar amount.

Historical peak and off-peak usage uses the completion time recorded for each step and the rule covering that instant. Steps that fall outside a known schedule, or on a route without a supported rule, stay out of the split instead of being assigned to one phase.

## 1.1.0

### Added

- **Models analytics.** A new Models view groups token usage by **Provider** or **Model**, with Provider listed first and used as the default. Its stacked chart ranks series by token volume and shows the five largest plus **Other**; the breakdown still lists every model or provider. Hover, keyboard focus, and click-to-pin emphasize the matching bars, legend entries, and rows.
- **Model and provider drilldowns.** Opening a model or provider row shows a detail page for that exact identity, charted against the opposite grouping. Breadcrumbs return to the Models grouping and range you came from.
- **API-equivalent cost estimates.** Analytics, Models, and project views now show a dollar estimate based on list prices, including a cost line over grouped charts and per-model, per-provider, and per-project totals. Each estimate has an explanation and calls out tokens that could not be priced.

### Improved

- **Clearer provider and model identity.** Recognized providers show their proper names and logos across cards, charts, lists, and detail headers. When two providers share a display name, their raw provider IDs are shown so they remain distinguishable; unknown and empty identities stay explicit instead of being merged silently.
- **Automatic workspace names.** OpenCode Console workspace display names now refresh automatically, so a renamed workspace no longer keeps its old label.
- **Honest cost status.** `Free` now appears only when every token in a total has a known zero price. Usage with no usable price is `Unpriced`; a mix of priced and excluded usage is `Partial estimate`; an empty total shows `—`. Unknown and unpriced token counts are excluded and reported rather than guessed.
- **Filtered Lifetime views.** Lifetime ranges now start from the earliest relevant activity: the first matching step for a filtered model or provider view, and the project's own first activity for a project view, instead of unrelated older history.
- **More readable charts.** Grouped charts support hover, keyboard focus, and click-to-pin emphasis with exact token and cost tooltips.

### Fixed

- **Quota card order updates immediately.** A saved card order applies to the quota data already on screen as soon as settings change, without waiting for or triggering another quota read.
- **Hide and unhide keeps position.** Hiding a card leaves the remaining cards in their saved order; unhiding restores the card at its saved rank without a quota re-read.
- **Authoritatively known Free routes keep historical estimates.** Historical usage on a provider/model route that is authoritatively known to have been Free keeps its `Free` estimate after the route is retired or drops out of the price catalog, instead of becoming `Unpriced`. This does not assign zero prices to other retired models; those remain `Unpriced` when no usable price is known.
- **Pricing refreshes keep unrelated prices.** Refreshing prices for one set of providers no longer discards prices for other providers and models.
- **Dense Session charts keep readable step labels.** Sessions with many steps always show the first and last step labels and reduce intermediate labels to avoid collisions. Every step remains plotted.
- **Provider grouping is listed first.** The Models grouping control now reads **Provider | Model**, matching the default view.

### About the cost estimate

The API-equivalent estimate multiplies recorded token usage by publicly listed model prices. It is **not** your subscription charge, invoice, or actual billed spend: plan pricing, credits, discounts, taxes, and provider billing adjustments are not included.

The estimate also depends on recorded model identity and available list prices. Prices can change over time and may be unavailable for some models; tokens without a usable identity or price are excluded, so a total can be partial even when it shows a dollar value.

### About historical attribution

Historical provider and model attribution depends on the raw provider and model identities stored by OpenCode for each usage record. When an identity is missing, usage stays explicitly unknown rather than being assigned to a guessed provider or model.
