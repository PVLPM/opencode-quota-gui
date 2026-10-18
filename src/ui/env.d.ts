/**
 * Module declarations for the browser-only UI project (`tsconfig.ui.json`).
 *
 * The UI project runs with `types: []`, so no Node or bundler global types leak
 * in. Styles are the only non-TypeScript modules the UI imports.
 */

declare module "*.css";
/** `@opencode/ui/styles` is a CSS subpath export with no declaration file. */
declare module "@opencode/ui/styles";
/** Public v2 component tokens are also a CSS-only subpath. */
declare module "@opencode/ui/styles/tokens";
