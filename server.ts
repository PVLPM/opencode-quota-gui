/**
 * Explicit local OpenCode plugin entry for this checkout.
 *
 * Build first (`pnpm run build`), then point an absolute `file:` URL at this
 * file in OpenCode's plural `plugins` list and restart. Loading this file
 * directly re-exports only the built server plugin default from `dist/index.js`.
 *
 * The loader reads the module's `default` export; a wildcard re-export would
 * hand it the package's utility exports too.
 *
 * See docs/readme/manual-install.md.
 */
export { default } from "./dist/index.js";
