/**
 * Ambient declarations for the native typecheck only.
 *
 * The native program still parses `src/ui/opencode-ui.ts` because shared
 * feature modules import it. The native build never loads that file — the Vite
 * alias resolves the same specifier to `src/native/ui.tsx` — but its library
 * stylesheet subpaths ship CSS without type declarations.
 */
declare module "@opencode/ui/styles";
declare module "@opencode/ui/styles/tokens";
