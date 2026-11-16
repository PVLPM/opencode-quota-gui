# OpenCode provider artwork attribution

The local OpenCode Go mark in `opencode-go-g.svg` is extracted from the public OpenCode provider icon sprite.

- **Repository:** [anomalyco/opencode](https://github.com/anomalyco/opencode)
- **Commit:** `86976449c40d48f2731553a024f74552593d1764`
- **Source file:** `packages/ui/src/components/provider-icons/sprite.svg`
- **Source symbol:** `<symbol id="opencode-go">`
- **License:** MIT; copyright `Copyright (c) 2025 opencode`. The full upstream text is preserved verbatim in `OPENCODE-MIT.txt`.
- **Extraction:** only the single `<path>` inside the `opencode-go` symbol is included in that asset, wrapped in a standalone SVG with `viewBox="0 0 24 24"` and `fill="currentColor"`.
- **Upstream separation:** models.dev's upstream `opencode-go` O mark remains vendored unchanged in `opencode-go.svg`; the local G mark is a presentation override for OpenCode Go only. `opencode` and OpenCode Zen continue to use the models.dev O mark.
- **Claude Agent:** `claude-agent.svg` extracts only the `<symbol id="claude-agent">` path from the same sprite at commit `850504188198976c668bd3b514c3e8de21b9e0e2` (sprite SHA-256 `9f17db4e21f4450b000c2e105ad137c775172135eb31d8441940a45e567d0792`), wrapped as a standalone monochrome SVG retaining its viewBox.
- **Use:** the marks identify OpenCode Go and Claude Agent in this local dashboard. No affiliation or endorsement is implied, and brand rights remain with their owners.
