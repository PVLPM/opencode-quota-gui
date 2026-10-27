# Provider logo attribution and brand notice

Provider logo assets in this directory are vendored from [models.dev](https://github.com/anomalyco/models.dev), pinned to commit `30a8b13a5a5507979ddbf8d339c7746cf7e4f442`.

- **Upstream license:** MIT. The copyright and permission notice is preserved verbatim in `UPSTREAM-MIT.txt`.
- **Source path:** `providers/<provider-id>/logo.svg` in the pinned models.dev archive.
- **Normalization:** each SVG is stored as UTF-8 with XML/DTD declarations removed, trailing horizontal whitespace outside whitespace-sensitive text content stripped, and a final newline added; the artwork itself is unchanged.
- **Local use:** 222 upstream provider logos plus the local neutral `generic.svg` fallback are copied into the package at build time and served from same-origin `/assets/providers/`. The dashboard never hotlinks a remote logo.
- **OpenCode aliases:** the upstream `opencode` and `opencode-go` provider entries are distinct identities that use the same logo artwork. The presentation catalog also maps the internal `opencode-zen` id to the OpenCode artwork; raw analytics identities are never rewritten.
- **Brand rights:** the MIT license covers the models.dev repository and the assets as distributed there. It does not establish or grant rights in any provider's name, logo, or other trademark, and individual brand-use terms may still apply. The logos identify the corresponding providers in a local dashboard; no affiliation or endorsement is implied.
- **Mask-incompatible marks:** a small number of upstream marks use an opaque raster or full-bleed background and would collapse to a solid block under a one-colour mask. The catalog shows the local neutral fallback for those while keeping the vendored file and attribution.
- **Fallback:** providers with no specific upstream logo or no catalog entry use the local neutral fallback, not an upstream placeholder mark.
