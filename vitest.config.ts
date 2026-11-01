import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { configDefaults, defineConfig } from "vitest/config";

const DOM_TESTS = [
  "tests/gui.native-session-header-dom.test.ts",
  "tests/gui.native-session-header-measure-dom.test.ts",
  "tests/gui.native-session-header-mount-dom.test.ts",
];
const SOLID_DEV = fileURLToPath(new URL("./node_modules/solid-js/dist/dev.js", import.meta.url));
const SOLID_WEB_DEV = fileURLToPath(
  new URL("./node_modules/solid-js/web/dist/dev.js", import.meta.url),
);

/**
 * A DOM test has to share one Solid instance between the test, the controller
 * and the compiled component. Without this, Vitest can externalize `solid-js`
 * for the test while Vite resolves the browser build for the component, and
 * signals created in one copy are invisible to effects in the other.
 */
const solidAliases = [
  { find: /^solid-js$/u, replacement: SOLID_DEV },
  { find: /^solid-js\/web$/u, replacement: SOLID_WEB_DEV },
];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...DOM_TESTS],
          setupFiles: ["tests/setup.ts"],
          // Tests that run git, build, or open SQLite take 7-11 s on the Windows CI runner and on a
          // busy machine, past Vitest's 5 s default. A test that really hangs still fails.
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        // Only the native header's presentational modules need the Solid DOM
        // compiler and browser condition; the rest of the suite keeps the Node
        // runtime and the TUI's own JSX transform.
        plugins: [solid({ include: [/src\/native\/.*\.tsx$/, /src\/ui\/.*\.tsx$/] })],
        resolve: { conditions: ["browser", "development"], alias: solidAliases },
        test: {
          name: "native-header-dom",
          environment: "happy-dom",
          include: DOM_TESTS,
          setupFiles: ["tests/setup.ts"],
          testTimeout: 30_000,
          // `inline` wins over `external` in Vitest. The external entry is
          // present only so vite-plugin-solid does not replace this block with
          // its own external-only default and pull in a second Solid copy.
          server: { deps: { inline: [/solid-js/], external: [/solid-js/] } },
        },
      },
    ],
  },
});
