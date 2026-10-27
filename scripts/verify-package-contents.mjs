import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageManagerInvocation } from "./lib/release-artifact.mjs";
import { extensionOf, UI_PACKAGED_ASSET_EXTENSIONS } from "./lib/ui-bundle-checks.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manifestPath = process.argv[2];

function parsePackManifest(raw) {
  const jsonStart = Math.min(
    ...["{", "["].map((token) => {
      const index = raw.indexOf(token);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );

  if (!Number.isFinite(jsonStart)) throw new Error("pnpm pack did not return JSON.");
  const parsed = JSON.parse(raw.slice(jsonStart));
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("pnpm pack JSON is missing its files list.");
  }

  return manifest;
}

let rawManifest;
if (manifestPath) {
  rawManifest = await readFile(path.resolve(repoRoot, manifestPath), "utf8");
} else {
  const pnpm = resolvePackageManagerInvocation("pnpm");
  const result = spawnSync(
    pnpm.command,
    [...pnpm.args, "--config.ignore-scripts=true", "pack", "--json", "--dry-run"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  rawManifest = result.stdout;
}

const manifest = parsePackManifest(rawManifest);
const files = manifest.files.map((entry) => entry.path).sort();
const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
const unexpected = files.filter((file) => !allowedRootFiles.has(file) && !file.startsWith("dist/"));

if (unexpected.length > 0) {
  console.error("npm package contains files outside the strict allowlist:");
  for (const file of unexpected) console.error(`- ${file}`);
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const providerManifest = JSON.parse(
  await readFile(path.join(repoRoot, "src/ui/assets/provider-logos/manifest.json"), "utf8"),
);
const localOverrides = JSON.parse(
  await readFile(path.join(repoRoot, "src/ui/assets/provider-logos/local-overrides.json"), "utf8"),
);
const requiredFiles = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "dist/data/modelsdev-pricing.min.json",
  // The dashboard server serves this entry and the assets beside it (spec §5.3, §9).
  "dist/ui/index.html",
  "dist/provider-logos/UPSTREAM-MIT.txt",
  "dist/provider-logos/NOTICE.md",
]);

function addManifestPath(value) {
  if (typeof value === "string" && value.startsWith("./dist/")) {
    requiredFiles.add(value.slice(2));
  }
}

addManifestPath(packageJson.main);
addManifestPath(packageJson.types);
for (const value of Object.values(packageJson.bin ?? {})) addManifestPath(value);
for (const target of Object.values(packageJson.exports ?? {})) {
  if (typeof target === "string") {
    addManifestPath(target);
    continue;
  }
  for (const value of Object.values(target ?? {})) addManifestPath(value);
}

const missing = [...requiredFiles].filter((file) => !files.includes(file)).sort();
if (missing.length > 0) {
  console.error("npm package is missing required release output:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

// The shipped product is dashboard-only: inherited TUI source and build support stay in
// the repository, but no public TUI export or compiled TUI entry may reach the artifact.
const forbiddenFiles = [
  "dist/tui.js",
  "dist/tui.js.map",
  "dist/tui.d.ts",
  "dist/tui.d.ts.map",
  "dist/tui-v2.jsx",
  "dist/tui-v2.jsx.map",
  "dist/tui-v2.d.ts",
  "dist/tui-v2.d.ts.map",
];
const shippedForbidden = forbiddenFiles.filter((file) => files.includes(file));
if (Object.hasOwn(packageJson.exports ?? {}, "./tui")) {
  shippedForbidden.push('exports["./tui"]');
}
if (shippedForbidden.length > 0) {
  console.error("npm package exposes a disabled terminal/TUI surface:");
  for (const file of shippedForbidden) console.error(`- ${file}`);
  process.exit(1);
}

// The browser bundle ships inside dist/ui under the local packaged-asset
// allowlist (spec §9): the entry point, a script and a stylesheet are required,
// and every UI file must be a served asset type — including any packaged font.
const uiFiles = files.filter((file) => file.startsWith("dist/ui/"));
const uiProblems = [];
for (const required of [
  { suffix: ".js", prefix: "dist/ui/assets/" },
  { suffix: ".css", prefix: "dist/ui/assets/" },
]) {
  if (!uiFiles.some((file) => file.startsWith(required.prefix) && file.endsWith(required.suffix))) {
    uiProblems.push(`no ${required.suffix} asset under ${required.prefix}`);
  }
}
for (const file of uiFiles) {
  if (file.split("/").includes("..")) uiProblems.push(`${file}: path traversal segment`);
  const extension = extensionOf(file);
  if (!UI_PACKAGED_ASSET_EXTENSIONS.includes(extension)) {
    uiProblems.push(`${file}: extension ${extension || "(none)"} is not a packaged UI asset type`);
  }
  // Build provenance stays out of the artifact: the module graph is build-only
  // evidence and never ships, and neither do source maps or their references.
  if (extension === ".map") uiProblems.push(`${file}: source maps must not ship`);
  if (/(^|\/)(ui-graph\.json|.*\.js\.map)$/.test(file)) {
    uiProblems.push(`${file}: build-only evidence must not ship`);
  }
}
if (uiProblems.length > 0) {
  console.error("npm package UI assets are incomplete or unexpected:");
  for (const problem of uiProblems) console.error(`- ${problem}`);
  process.exit(1);
}

const providerLogos = uiFiles.filter(
  (file) => file.startsWith("dist/ui/assets/providers/") && file.endsWith(".svg"),
);
const localLogoFiles = Object.keys(localOverrides.logos ?? {}).map(
  (id) => `dist/ui/assets/providers/${id}.svg`,
);
const opencodeNoticeFiles = [
  "dist/provider-logos/OPENCODE-MIT.txt",
  "dist/provider-logos/OPENCODE-NOTICE.md",
];
const shippedUpstreamLogos = providerLogos.filter((file) => !localLogoFiles.includes(file));
const expectedProviderLogos = providerManifest.logoCount + 1;
const providerProblems = [];
if (localLogoFiles.length === 0) {
  providerProblems.push("the source local override manifest declares no provider logos");
}
if (shippedUpstreamLogos.length !== expectedProviderLogos) {
  providerProblems.push(
    `expected ${expectedProviderLogos} upstream provider logos, found ${shippedUpstreamLogos.length}`,
  );
}
if (!providerLogos.includes("dist/ui/assets/providers/generic.svg")) {
  providerProblems.push("the local generic provider fallback is missing");
}
for (const id of Object.keys(providerManifest.logos)) {
  const file = `dist/ui/assets/providers/${id}.svg`;
  if (!providerLogos.includes(file)) providerProblems.push(`${file} is missing`);
}
for (const file of localLogoFiles) {
  if (!providerLogos.includes(file)) providerProblems.push(`${file} is missing`);
}
for (const file of opencodeNoticeFiles) {
  if (!files.includes(file)) providerProblems.push(`${file} is missing`);
}
if (providerProblems.length > 0) {
  console.error("npm package provider logo assets are incomplete:");
  for (const problem of providerProblems) console.error(`- ${problem}`);
  process.exit(1);
}

const distCount = files.filter((file) => file.startsWith("dist/")).length;
console.log(
  `npm contents verified: ${files.length} files (${distCount} dist files plus package.json, README.md, and LICENSE), including ${files.filter((file) => file.startsWith("dist/ui/")).length} UI assets with ${providerLogos.length} provider logos, with no build-only graph metadata and no source maps.`,
);
