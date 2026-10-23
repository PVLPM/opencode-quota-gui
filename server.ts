/**
 * Explicit local OpenCode plugin entry for this checkout.
 *
 * Build first (`pnpm run build`), then point an absolute `file:` URL at this
 * file in OpenCode's plural `plugins` list and restart. Loading this file
 * directly re-exports only the built server plugin default from `dist/index.js`.
 *
 * Do not point the plugin entry at the repository directory for GUI-only
 * development: local directory resolution also discovers the retained root
 * `tui.ts` (inherited TUI source), so a directory entry is not server-only and
 * is not recommended here.
 *
 * The loader reads the module's `default` export; a wildcard re-export would
 * hand it the package's utility exports too.
 *
 * See docs/readme/manual-install.md.
 */
export { default } from "./dist/index.js";
