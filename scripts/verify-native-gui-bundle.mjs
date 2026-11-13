import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const bundlePath = path.resolve(repoRoot, process.argv[2] ?? "dist/gui-experimental.cjs");

let source;
try {
  source = readFileSync(bundlePath, "utf8");
} catch (error) {
  console.error(`Cannot read Native GUI bundle ${bundlePath}: ${error.message}`);
  process.exit(1);
}

const requiredBuiltins = new Set();
for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
  const specifier = match[1];
  if (specifier !== undefined && isBuiltin(specifier)) requiredBuiltins.add(specifier);
}

if (requiredBuiltins.size > 0) {
  console.error(
    `Native GUI bundle contains prohibited Node built-in requires: ${[...requiredBuiltins].sort().join(", ")}`,
  );
  process.exit(1);
}

console.log("Native GUI bundle verified: no Node built-in requires.");
