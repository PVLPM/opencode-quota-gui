import path from "node:path";
import { fileURLToPath } from "node:url";
import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";
import { resolveBuildIdentity, validateBuildIdentity } from "./scripts/build-identity.mjs";

/**
 * Native Desktop GUI build (Stage 4).
 *
 * The host's `gui()` preset owns the shape: one CommonJS file, every dynamic
 * import inlined, and the Solid/OpenCode/Electron modules the app provides kept
 * external. Two product modules are swapped for native equivalents because the
 * host cannot supply them:
 *
 * - `@opencode/ui` is not a module the app provides, so the single
 *   replaceability seam (`src/ui/opencode-ui.ts`) resolves to the native
 *   primitives in `src/native/ui.tsx`;
 * - provider marks are served from `/assets/providers/` on the web, a path that
 *   does not exist in the Desktop process, so the logo component resolves them
 *   from bundled raw SVG instead.
 *
 * Everything else is imported directly from `src/ui`, unchanged.
 */

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const buildIdentity =
  process.env.OPENCODE_QUOTA_BUILD_IDENTITY === undefined
    ? resolveBuildIdentity(rootDir)
    : validateBuildIdentity(JSON.parse(process.env.OPENCODE_QUOTA_BUILD_IDENTITY));

export default defineConfig({
  define: { __OPENCODE_QUOTA_BUILD_IDENTITY__: JSON.stringify(buildIdentity) },
  plugins: [gui({ entry: "src/native/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
    alias: [
      {
        find: /^\.\.?\/opencode-ui$/,
        replacement: path.resolve(rootDir, "src/native/ui.tsx"),
      },
      {
        find: /^\.\.?\/provider-logo$/,
        replacement: path.resolve(rootDir, "src/native/provider-logo.tsx"),
      },
      {
        find: /^\.\.\/components\/provider-logo$/,
        replacement: path.resolve(rootDir, "src/native/provider-logo.tsx"),
      },
    ],
  },
  build: {
    // The release must not carry a path from this machine.
    sourcemap: false,
  },
});
