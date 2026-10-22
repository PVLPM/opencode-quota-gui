import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { resolveBuildIdentity, validateBuildIdentity } from "./scripts/build-identity.mjs";
import {
  normalizeModuleId,
  UI_GRAPH_METADATA_PATH,
  UI_OUT_DIR,
  UI_PACKAGED_ASSET_EXTENSIONS,
} from "./scripts/lib/ui-bundle-checks.mjs";

/**
 * Browser-only UI build (design spec §11.1).
 *
 * The build runner preserves the backend chain (`clean-dist` → `tsc` →
 * `copy-data` → `prepare-tui-dist`) and stamps identity after compilation.
 * The browser build is separate
 * because `@opencode/ui` ships TSX source that the Solid compiler must process,
 * and because `tsconfig.json` compiles the backend with the OpenTUI JSX pragma.
 *
 * `root` points at `src/ui`, so the HTML entry is `src/ui/index.html`; the
 * output directory is therefore spelled absolutely — it is the repo-root
 * `dist/ui` the dashboard server serves.
 */

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const buildIdentity =
  process.env.OPENCODE_QUOTA_BUILD_IDENTITY === undefined
    ? resolveBuildIdentity(rootDir)
    : validateBuildIdentity(JSON.parse(process.env.OPENCODE_QUOTA_BUILD_IDENTITY));

/**
 * Solid JSX shipped as source: our own UI plus the public library and the
 * packages it imports. A published dependency ships `.jsx`, not compiler
 * output, so it has to go through the Solid compiler here — nothing else in the
 * pipeline can compile it. The patterns match the physical pnpm path as well,
 * so the include never depends on how the store is laid out.
 */
export const SOLID_JSX_SOURCES = [
  /src\/ui\//,
  /@opencode\/ui\//,
  /@kobalte\/core\//,
  /@kitlangton\/solid-motion\//,
];

/**
 * The UI build owns `dist/ui` and nothing else in `dist/` (`emptyOutDir: false`
 * leaves the backend output alone, so stale asset hashes would otherwise
 * accumulate between standalone `build:ui` runs and never be cleaned).
 */
function cleanUiOutDirPlugin() {
  return {
    name: "opencode-quota-gui:clean-ui-outdir",
    apply: "build",
    buildStart() {
      rmSync(path.resolve(rootDir, UI_OUT_DIR), { recursive: true, force: true });
    },
  };
}

/**
 * Records the real module graph and the emitted file list for
 * `scripts/verify-ui-bundle.mjs`, so the bundle check reads Vite's own graph
 * instead of matching arbitrary strings in the output. `writeBundle` runs after
 * every asset — including `index.html` — has been emitted.
 */
function uiGraphMetadataPlugin() {
  return {
    name: "opencode-quota-gui:ui-graph-metadata",
    apply: "build",
    writeBundle(_options, bundle) {
      const modules = new Set();
      const emittedFiles = [];
      const entryChunks = [];

      for (const output of Object.values(bundle)) {
        emittedFiles.push(output.fileName);
        if (output.type !== "chunk") continue;
        if (output.isEntry) entryChunks.push(output.fileName);
        for (const id of output.moduleIds ?? Object.keys(output.modules ?? {})) {
          modules.add(normalizeModuleId(id, rootDir));
        }
      }

      const metadata = {
        generatedAtIso: new Date().toISOString(),
        outDir: UI_OUT_DIR,
        htmlFile: "index.html",
        base: "/",
        assetExtensions: UI_PACKAGED_ASSET_EXTENSIONS,
        entryChunks: entryChunks.sort(),
        emittedFiles: emittedFiles.sort(),
        modules: [...modules].sort(),
      };

      // Build-only evidence, written outside `dist/`: it is never packaged, never
      // served, and every id in it is a normalized, machine-independent
      // identifier rather than a path from this machine.
      const target = path.resolve(rootDir, UI_GRAPH_METADATA_PATH);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    },
  };
}

export default defineConfig({
  define: { __OPENCODE_QUOTA_BUILD_IDENTITY__: JSON.stringify(buildIdentity) },
  root: path.resolve(rootDir, "src/ui"),
  base: "/",
  publicDir: false,
  plugins: [cleanUiOutDirPlugin(), solid({ include: SOLID_JSX_SOURCES }), uiGraphMetadataPlugin()],
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/meta"],
  },
  // The backend's root tsconfig uses the OpenTUI pragma, so this build preserves
  // JSX and lets the Solid compiler own it (spec §11.1).
  esbuild: { jsx: "preserve", jsxImportSource: "solid-js" },
  build: {
    outDir: path.resolve(rootDir, UI_OUT_DIR),
    emptyOutDir: false,
    assetsDir: "assets",
    modulePreload: { polyfill: false },
    target: "es2022",
    // No source maps: nothing in the release should carry a path from this
    // machine, and the verifier asserts `.map` files and `sourceMappingURL`
    // references never appear (spec §9, §11.1).
    sourcemap: false,
  },
});
