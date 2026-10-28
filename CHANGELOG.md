# Changelog

User-facing release notes for OpenCode Quota GUI.

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
