/**
 * Local OpenCode plugin entry for this checkout.
 *
 * OpenCode resolves a local plugin directory through its `server` entry first
 * (`server.ts` is preferred over `server.js`), so pointing a config `plugin`
 * entry at this repository needs this file. It re-exports only the default from
 * the built server plugin: the loader reads the module's `default` export, and a
 * wildcard re-export would hand it the package's utility exports too.
 *
 * Build first (`pnpm run build`), then point OpenCode at this directory and
 * restart. See docs/readme/manual-install.md.
 */
export { default } from "./dist/index.js";
