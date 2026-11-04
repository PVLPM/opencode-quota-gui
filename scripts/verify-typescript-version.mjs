import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";
// The Desktop GUI builds against the SDK that ships the GUI/Vite API; the
// server peer is bounded by packed-package host evidence: 2.0.16, 2.1.4,
// 2.2.0, and 2.2.5 passed under Bun, so the range stops before the next
// unverified minor line.
const EXPECTED_PLUGIN_SDK_VERSION = "2.2.0";
const EXPECTED_PLUGIN_PEER_VERSION = ">=2.0.16 <2.3.0";
const PLUGIN_PACKAGE = "@opencode/plugin";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const lockfile = parse(await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"));
const workspace = parse(await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function findPeerSuppressions(value, location, suppressions = []) {
  if (!value || typeof value !== "object") return suppressions;

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedLocation = `${location}.${key}`;
    if (key === "peerDependencyRules" || key === "allowedVersions" || key === "ignoreMissing") {
      suppressions.push(nestedLocation);
    }
    if (key === "strictPeerDependencies" && nestedValue === false) {
      suppressions.push(nestedLocation);
    }
    findPeerSuppressions(nestedValue, nestedLocation, suppressions);
  }

  return suppressions;
}

function hasTypeScriptOverride(value) {
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(([key, nestedValue]) => {
    if (/typescript/i.test(key)) return true;
    if (typeof nestedValue === "string" && /typescript/i.test(nestedValue)) {
      return true;
    }
    return hasTypeScriptOverride(nestedValue);
  });
}

const configuredTypeScript = packageJson.devDependencies?.typescript;
const configuredPlugin = packageJson.devDependencies?.[PLUGIN_PACKAGE];
const configuredPluginPeer = packageJson.peerDependencies?.[PLUGIN_PACKAGE];
if (configuredTypeScript !== EXPECTED_TYPESCRIPT_VERSION) {
  fail(
    `TypeScript must be pinned exactly to ${EXPECTED_TYPESCRIPT_VERSION}; package.json has ${String(configuredTypeScript)}.`,
  );
}
if (configuredPlugin !== EXPECTED_PLUGIN_SDK_VERSION) {
  fail(
    `${PLUGIN_PACKAGE} dev dependency must be pinned exactly to ${EXPECTED_PLUGIN_SDK_VERSION}; package.json has ${String(configuredPlugin)}.`,
  );
}
if (configuredPluginPeer !== EXPECTED_PLUGIN_PEER_VERSION) {
  fail(
    `${PLUGIN_PACKAGE} peer must stay at the evidence-bounded range ${EXPECTED_PLUGIN_PEER_VERSION} for the server runtime; package.json has ${String(configuredPluginPeer)}.`,
  );
}
const suppressions = [
  ...findPeerSuppressions(packageJson, "package.json"),
  ...findPeerSuppressions(workspace, "pnpm-workspace.yaml"),
];
if (suppressions.length > 0) {
  fail(`TypeScript peer suppression is not allowed: ${suppressions.join(", ")}.`);
}

const overrideSections = [
  packageJson.overrides,
  packageJson.pnpm?.overrides,
  packageJson.pnpm?.packageExtensions,
  workspace?.overrides,
  workspace?.packageExtensions,
];
if (overrideSections.some(hasTypeScriptOverride)) {
  fail("TypeScript must not be hidden behind an override or package extension.");
}

const rootImporter = lockfile?.importers?.["."];
if (!rootImporter) {
  fail("Unable to find the root importer in pnpm-lock.yaml.");
}

function verifyImporterDependency(name, expectedVersion) {
  const dependency = rootImporter.devDependencies?.[name];
  if (dependency?.specifier !== expectedVersion || dependency?.version !== expectedVersion) {
    fail(
      `${name} lock mismatch: expected specifier and version ${expectedVersion}, found ${String(dependency?.specifier)} and ${String(dependency?.version)}.`,
    );
  }
}

verifyImporterDependency("typescript", EXPECTED_TYPESCRIPT_VERSION);

const lockedPlugin = rootImporter.devDependencies?.[PLUGIN_PACKAGE];
if (
  lockedPlugin?.specifier !== EXPECTED_PLUGIN_SDK_VERSION ||
  (lockedPlugin?.version !== EXPECTED_PLUGIN_SDK_VERSION &&
    !lockedPlugin?.version?.startsWith(`${EXPECTED_PLUGIN_SDK_VERSION}(`))
) {
  fail(
    `${PLUGIN_PACKAGE} lock mismatch: expected ${EXPECTED_PLUGIN_SDK_VERSION}, found ${String(lockedPlugin?.specifier)} and ${String(lockedPlugin?.version)}.`,
  );
}

const packageKeys = Object.keys(lockfile.packages ?? {});
const snapshotKeys = Object.keys(lockfile.snapshots ?? {});
const expectedTypeScriptKey = `typescript@${EXPECTED_TYPESCRIPT_VERSION}`;
const expectedPluginKey = `${PLUGIN_PACKAGE}@${EXPECTED_PLUGIN_SDK_VERSION}`;

if (!packageKeys.includes(expectedTypeScriptKey) || !snapshotKeys.includes(expectedTypeScriptKey)) {
  fail(`pnpm-lock.yaml must contain package and snapshot entries for ${expectedTypeScriptKey}.`);
}
if (
  !packageKeys.includes(expectedPluginKey) ||
  !snapshotKeys.some((key) => key === expectedPluginKey || key.startsWith(`${expectedPluginKey}(`))
) {
  fail(`pnpm-lock.yaml must contain package and snapshot entries for ${expectedPluginKey}.`);
}

const typeScriptPackageKeys = packageKeys.filter((key) => key.startsWith("typescript@"));
const typeScriptSnapshotKeys = snapshotKeys.filter((key) => key.startsWith("typescript@"));
if (
  typeScriptPackageKeys.some((key) => key !== expectedTypeScriptKey) ||
  typeScriptSnapshotKeys.some((key) => key !== expectedTypeScriptKey)
) {
  fail(
    `Unexpected additional TypeScript lock entries: ${[
      ...typeScriptPackageKeys,
      ...typeScriptSnapshotKeys,
    ].join(", ")}.`,
  );
}

console.log(
  `TypeScript ${EXPECTED_TYPESCRIPT_VERSION} and ${PLUGIN_PACKAGE} ${EXPECTED_PLUGIN_SDK_VERSION} (peer ${EXPECTED_PLUGIN_PEER_VERSION}) lock entries verified.`,
);
