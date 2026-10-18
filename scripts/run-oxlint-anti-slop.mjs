#!/usr/bin/env node
/**
 * Strict and advisory Oxlint sweeps for the vendored anti-slop plugin
 * (design spec §11.2, R40/R41).
 *
 * Why a compile step: the vendored plugin is TypeScript, and loading `.ts`
 * directly through Oxlint relies on Node >= 22.18 type stripping while this
 * repository supports Node 22.13. The plugin is compiled instead with the
 * existing TypeScript 7 (`tsconfig.oxlint.json`) into the git-ignored
 * `node_modules/.cache/oxlint-anti-slop/` output, and `oxlint.json` loads the
 * emitted ESM JavaScript. No loader, no environment-variable shim, no Node
 * floor change.
 *
 * Modes:
 * - strict (default): new dashboard paths only (`src/contracts`, `src/gui`,
 *   `src/ui`, the new GUI tests, the UI build config, and this tooling's own
 *   scripts). Blocking: Oxlint's exit code is propagated, so any finding fails
 *   `pnpm run lint:oxlint`.
 * - `--upstream`: the same rules over the whole tree, advisory. Legacy findings
 *   are printed but never fail the command (no baseline dump is committed).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(rootDir, "node_modules", ".cache", "oxlint-anti-slop");
const oxlintBin = path.join(rootDir, "node_modules", "oxlint", "bin", "oxlint");
const typescriptBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const upstreamMode = process.argv.includes("--upstream");

/**
 * Strict new-path set from spec §11.2. Legacy upstream paths are never listed
 * here; a finding is addressed by fixing the code, never by widening this list
 * or muting a rule.
 */
const strictPaths = [
  "src/contracts",
  "src/gui",
  "src/ui",
  "tests/fixtures/gui-ui-fixtures.ts",
  "tests/plugin.gui-isolation.test.ts",
  "vite.ui.config.mjs",
  "scripts/fixtures/synthetic-gui-dashboard.mjs",
  "scripts/lib/ui-bundle-checks.mjs",
  "scripts/run-oxlint-anti-slop.mjs",
  "scripts/smoke-gui.mjs",
  "scripts/verify-ui-bundle.mjs",
];

/**
 * GUI tests are picked by their bounded `gui.` name prefix in `tests/`, so new
 * GUI test files enter the strict sweep automatically while legacy upstream
 * tests stay out of it.
 */
function guiTestPaths() {
  const testsDir = path.join(rootDir, "tests");
  return readdirSync(testsDir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isFile() && entry.name.startsWith("gui.") && entry.name.endsWith(".test.ts")
        ? [`tests/${entry.name}`]
        : [],
    )
    .sort();
}

function existingPaths(candidates) {
  const present = [];
  const absent = [];
  for (const candidate of candidates) {
    if (existsSync(path.join(rootDir, candidate))) present.push(candidate);
    else absent.push(candidate);
  }
  if (absent.length > 0) {
    console.log(`[lint:oxlint] not created yet, skipping: ${absent.join(", ")}`);
  }
  return present;
}

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { cwd: rootDir, stdio: "inherit" });
  if (result.error) {
    console.error(`[lint:oxlint] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

function compileVendoredPlugin() {
  rmSync(cacheDir, { recursive: true, force: true });
  const status = run(process.execPath, [typescriptBin, "-p", "tsconfig.oxlint.json"]);
  if (status !== 0) {
    console.error("[lint:oxlint] TypeScript failed to compile the vendored anti-slop plugin.");
    process.exit(status);
  }
  // The emitted files sit under node_modules, outside the repository's
  // `"type": "module"` package scope; mark the cache directory as ESM so Node
  // loads the compiled `.js` exactly as the source `.ts` intended.
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

compileVendoredPlugin();

const oxlintArguments = upstreamMode
  ? ["--config", "oxlint.json", "."]
  : ["--config", "oxlint.json", ...existingPaths([...strictPaths, ...guiTestPaths()])];
const status = run(process.execPath, [oxlintBin, ...oxlintArguments]);

if (upstreamMode) {
  console.log(
    status === 0
      ? "[lint:oxlint] upstream sweep: no findings."
      : `[lint:oxlint] upstream sweep finished with findings (oxlint exit code ${status}); advisory only.`,
  );
  process.exit(0);
}

process.exit(status);
