import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  type ConfigFileFormat,
  findGitWorktreeRoot,
  isVerifiedQuotaPluginSpec,
  resolveExistingConfigPath,
} from "./config-file-utils.js";
import {
  assertSameConfigWriteTarget,
  ConfigWriteTargetError,
  type ConfigWriteTargetSnapshot,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "./config-write-target.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { resolveExplicitQuotaPluginSpec } from "./init-installer.js";
import { editConfigDocumentPaths, parseConfigDocument } from "./opencode-config-editor.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { detectOpenCodeMajor, type OpenCodeMajor } from "./opencode-version.js";
import {
  auditObsoleteUpdateSources,
  discoverExistingScopedUpdateMigrationCandidates,
  inspectLegacyDisplayDocument,
  resolveScopedUpdateMigrationBoundary,
  type ScopedUpdateManualFinding,
  type ScopedUpdateMigrationBoundary,
  type ScopedUpdateSafeAction,
  sortScopedUpdateManualFindings,
  sortScopedUpdateSafeActions,
} from "./scoped-update-migration.js";

export const QUOTA_PACKAGE_NAME = "opencode-quota-gui";
export const LEGACY_QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
export const QUOTA_LATEST_SPEC = `${QUOTA_PACKAGE_NAME}@latest`;
const QUOTA_NEXT_SPEC = `${QUOTA_PACKAGE_NAME}@next`;
export const QUOTA_V4_SPEC = `${LEGACY_QUOTA_PACKAGE_NAME}@4`;
/** Moving specs that update keeps as written; OpenCode re-resolves them after the cache cleanup. */
const QUOTA_MOVING_SPECS: ReadonlySet<string> = new Set([
  QUOTA_LATEST_SPEC,
  QUOTA_NEXT_SPEC,
  QUOTA_V4_SPEC,
  `${LEGACY_QUOTA_PACKAGE_NAME}@latest`,
  `${LEGACY_QUOTA_PACKAGE_NAME}@next`,
]);
const GITHUB_REPO_URL = "https://github.com/PVLPM/opencode-quota-gui";

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type ScopedUpdateConfigRole = "package-authority" | "package-edit" | "display-migration";

export interface ScopedUpdateConfigEdit {
  path: string;
  original: string;
  originalBytes: Buffer;
  updated: string;
  replacements: number;
  displayMigrations: number;
  pluginChanges?: string[];
}

export interface ScopedUpdateConfigSnapshot {
  path: string;
  originalBytes: Buffer;
  expectedBytes: Buffer;
  updated: string;
  changed: boolean;
  roles: ScopedUpdateConfigRole[];
  writeTarget: ConfigWriteTargetSnapshot;
  migrationBoundary?: ScopedUpdateMigrationBoundary;
}

export interface ScopedUpdatePlan {
  configEdits: ScopedUpdateConfigEdit[];
  configSnapshots: ScopedUpdateConfigSnapshot[];
  configPaths: string[];
  foundSpecs: string[];
  cacheCandidates: string[];
  authoritativeLatest: boolean;
  openCodeMajor: OpenCodeMajor | undefined;
  safeActions: ScopedUpdateSafeAction[];
  manualFindings: ScopedUpdateManualFinding[];
}

export interface ScopedUpdateResult {
  writtenPaths: string[];
  removedCachePaths: string[];
  skippedCachePaths: string[];
}

export class ScopedUpdateError extends Error {
  constructor(
    message: string,
    readonly details?: { writtenPaths?: string[]; path?: string },
  ) {
    super(message);
    this.name = "ScopedUpdateError";
  }
}

function hasExactSemverSuffix(spec: string, packageName: string): boolean {
  const prefix = `${packageName}@`;
  return spec.startsWith(prefix) && EXACT_SEMVER.test(spec.slice(prefix.length));
}

/** Recognizes both this project's package identity and legacy `@slkiser/opencode-quota` specs. */
export function isCanonicalQuotaUpdateSpec(spec: string): boolean {
  if (spec === QUOTA_PACKAGE_NAME || spec === LEGACY_QUOTA_PACKAGE_NAME) return true;
  if (QUOTA_MOVING_SPECS.has(spec)) return true;
  return (
    hasExactSemverSuffix(spec, QUOTA_PACKAGE_NAME) ||
    hasExactSemverSuffix(spec, LEGACY_QUOTA_PACKAGE_NAME)
  );
}

export function sanitizeOpenCodePackageSpec(
  spec: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return spec;
  return Array.from(spec, (char) =>
    new Set(["<", ">", ":", '"', "|", "?", "*"]).has(char) || char.charCodeAt(0) < 32 ? "_" : char,
  ).join("");
}

function selectedConfigPaths(root: string): string[] {
  const path = resolveExistingConfigPath(root, "opencode");
  return path ? [path] : [];
}

async function dedupeByRealPath(paths: string[]): Promise<string[]> {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const resolved = await realpath(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push(path);
  }
  return output;
}

/** OpenCode 2 native `plugins` entry: `{ "package": "...", "options": { ... } }`. */
function isPackageEntry(entry: unknown): entry is { package: string } {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { package?: unknown }).package === "string"
  );
}

/** OpenCode 2 reads both the legacy `plugin` array and the native `plugins` array. */
function pluginArrays(config: unknown): Array<{ path: (string | number)[]; entries: unknown[] }> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const root = config as Record<string, unknown>;
  const arrays: Array<{ path: (string | number)[]; entries: unknown[] }> = [];
  if (Array.isArray(root.plugin)) arrays.push({ path: ["plugin"], entries: root.plugin });
  if (Array.isArray(root.plugins)) arrays.push({ path: ["plugins"], entries: root.plugins });
  return arrays;
}

/**
 * OpenCode Quota 5 needs OpenCode 2. On OpenCode 2 update rewrites every recognized non-moving
 * spec — this package's bare/exact specs and the legacy `@slkiser/opencode-quota` ones — to the
 * canonical `opencode-quota-gui` release spec, keeps moving specs as written, and honors an
 * explicit package-spec override. On OpenCode 1 it leaves specs as written and never pins them
 * to the upstream package.
 */
function quotaUpdateTarget(
  openCodeMajor: OpenCodeMajor | undefined,
  env: NodeJS.ProcessEnv,
): QuotaUpdateTarget {
  const explicit = resolveExplicitQuotaPluginSpec({ env });
  return {
    keptSpecs: explicit && openCodeMajor !== 1 ? new Set([explicit]) : QUOTA_MOVING_SPECS,
    explicit: explicit !== null,
    replacementSpec: openCodeMajor === 1 ? null : (explicit ?? QUOTA_LATEST_SPEC),
  };
}

interface QuotaUpdateTarget {
  explicit: boolean;
  keptSpecs: ReadonlySet<string>;
  replacementSpec: string | null;
}

function updateTargetUnavailableMessage(path: string): string {
  return `Cannot update ${path}: you're on OpenCode 1 and opencode-quota-gui requires OpenCode 2, so update will not pin plugin specs to the upstream @slkiser/opencode-quota package. Keep the existing specs, or move to OpenCode 2 before updating.`;
}

function quotaUpdateSpecFromEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  if (isPackageEntry(entry)) return entry.package;
  return null;
}

function parseUpdateConfig(raw: string, path: string): Record<string, unknown> {
  const format: ConfigFileFormat = path.endsWith(".jsonc") ? "jsonc" : "json";
  try {
    return parseConfigDocument(raw, format, path);
  } catch {
    throw new ScopedUpdateError(`Cannot update unparseable config: ${path}`, { path });
  }
}

/** Collects recognized quota specs without editing or refusing; used by the pre-cache authority check. */
function collectQuotaUpdateSpecs(raw: string, path: string): string[] {
  const parsed = parseUpdateConfig(raw, path);
  const specs: string[] = [];
  for (const array of pluginArrays(parsed)) {
    for (const entry of array.entries) {
      const spec = quotaUpdateSpecFromEntry(entry);
      if (spec !== null && isCanonicalQuotaUpdateSpec(spec)) specs.push(spec);
    }
  }
  return specs;
}

async function updateConfig(
  raw: string,
  path: string,
  target: QuotaUpdateTarget,
  openCodeMajor: OpenCodeMajor | undefined,
): Promise<{
  updated: string;
  replacements: number;
  specs: string[];
  pluginChanges: string[];
}> {
  const format: ConfigFileFormat = path.endsWith(".jsonc") ? "jsonc" : "json";
  const parsed = parseUpdateConfig(raw, path);

  const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
  let replacements = 0;
  const specs: string[] = [];
  const pluginChanges: string[] = [];
  if (target.explicit && target.replacementSpec !== null) {
    const candidates: Array<{ entry: unknown; spec: string; path: (string | number)[] }> = [];
    for (const array of pluginArrays(parsed)) {
      for (let index = 0; index < array.entries.length; index++) {
        const entry = array.entries[index];
        const spec = quotaUpdateSpecFromEntry(entry);
        if (
          spec !== null &&
          (spec === target.replacementSpec ||
            (await isVerifiedQuotaPluginSpec(spec, dirname(path))))
        ) {
          candidates.push({ entry, spec, path: [...array.path, index] });
        }
      }
    }
    const options = new Set(
      candidates.map(({ entry }) =>
        JSON.stringify(
          typeof entry === "string"
            ? null
            : Array.isArray(entry)
              ? entry.slice(1)
              : Object.fromEntries(
                  Object.entries(entry as Record<string, unknown>).filter(
                    ([key]) => key !== "package",
                  ),
                ),
        ),
      ),
    );
    if (options.size > 1) {
      throw new ScopedUpdateError(
        "Multiple quota plugin entries have different options; review them manually before replacing the plugin spec.",
        { path },
      );
    }
    const retained =
      candidates.find(({ spec }) => spec === target.replacementSpec) ?? candidates[0];
    for (const candidate of candidates.reverse()) {
      specs.push(candidate.spec);
      if (candidate !== retained) {
        edits.push({ path: candidate.path, value: undefined });
        pluginChanges.push(
          `remove duplicate quota plugin ${JSON.stringify(candidate.spec)}; keep ${JSON.stringify(target.replacementSpec)}`,
        );
        replacements++;
      } else if (candidate.spec !== target.replacementSpec) {
        const specPath =
          typeof candidate.entry === "string"
            ? candidate.path
            : [...candidate.path, Array.isArray(candidate.entry) ? 0 : "package"];
        edits.push({ path: specPath, value: target.replacementSpec });
        pluginChanges.push(
          `${JSON.stringify(candidate.spec)} -> ${JSON.stringify(target.replacementSpec)}`,
        );
        replacements++;
      }
    }
    return {
      updated: editConfigDocumentPaths({ raw, format, path, edits }),
      replacements,
      specs,
      pluginChanges,
    };
  }
  for (const array of pluginArrays(parsed)) {
    for (let index = array.entries.length - 1; index >= 0; index--) {
      const entry = array.entries[index];
      const spec = quotaUpdateSpecFromEntry(entry);
      if (
        spec === null ||
        !(
          isCanonicalQuotaUpdateSpec(spec) ||
          (target.explicit &&
            (spec === target.replacementSpec ||
              (await isVerifiedQuotaPluginSpec(spec, dirname(path)))))
        )
      )
        continue;
      specs.push(spec);
      if (target.keptSpecs.has(spec)) continue;
      if (target.replacementSpec === null) {
        throw new ScopedUpdateError(updateTargetUnavailableMessage(path), { path });
      }
      // Replace only the package spec; keep the entry's plugin options.
      const targetPath =
        typeof entry === "string"
          ? [...array.path, index]
          : Array.isArray(entry)
            ? [...array.path, index, 0]
            : [...array.path, index, "package"];
      edits.push({ path: targetPath, value: target.replacementSpec });
      pluginChanges.push(`${JSON.stringify(spec)} -> ${JSON.stringify(target.replacementSpec)}`);
      replacements++;
    }
  }
  const updated = editConfigDocumentPaths({ raw, format, path, edits });
  return { updated, replacements, specs, pluginChanges };
}

interface ScopedUpdateWorkingDocument {
  path: string;
  original: string;
  originalBytes: Buffer;
  updated: string;
  replacements: number;
  displayMigrations: number;
  pluginChanges?: string[];
  roles: Set<ScopedUpdateConfigRole>;
  migrationBoundary?: ScopedUpdateMigrationBoundary;
}

const CONFIG_ROLE_ORDER: ScopedUpdateConfigRole[] = [
  "package-authority",
  "package-edit",
  "display-migration",
];

export async function planScopedUpdate(
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    openCodeMajor?: OpenCodeMajor;
  } = {},
): Promise<ScopedUpdatePlan> {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const projectRoot = findGitWorktreeRoot(cwd) ?? cwd;
  const runtime = getOpencodeRuntimeDirs({ env, homeDir: params.homeDir });
  const configPaths = await dedupeByRealPath([
    ...selectedConfigPaths(projectRoot),
    ...selectedConfigPaths(runtime.configDir),
  ]);

  const workingDocuments = new Map<string, ScopedUpdateWorkingDocument>();
  const foundSpecs: string[] = [];
  const safeActions: ScopedUpdateSafeAction[] = [];
  const manualFindings: ScopedUpdateManualFinding[] = [];
  const updateTarget = quotaUpdateTarget(params.openCodeMajor, env);

  for (const path of configPaths) {
    const canonicalPath = await realpath(path);
    const originalBytes = await readFile(path);
    const original = originalBytes.toString("utf8");
    const planned = await updateConfig(original, path, updateTarget, params.openCodeMajor);
    foundSpecs.push(...planned.specs);
    const roles = new Set<ScopedUpdateConfigRole>(["package-authority"]);
    if (planned.replacements > 0) {
      roles.add("package-edit");
      safeActions.push({
        kind: "package-spec",
        path,
        replacements: planned.replacements,
      });
    }
    workingDocuments.set(canonicalPath, {
      path,
      original,
      originalBytes,
      updated: planned.updated,
      replacements: planned.replacements,
      pluginChanges: planned.pluginChanges,
      displayMigrations: 0,
      roles,
    });
  }

  const migrationDiscovery = await discoverExistingScopedUpdateMigrationCandidates({
    globalRoot: runtime.configDir,
    workspaceRoot: projectRoot,
    selectedPackagePaths: configPaths,
  });
  manualFindings.push(...migrationDiscovery.manualFindings);

  for (const candidate of migrationDiscovery.candidates) {
    const existingDocument = workingDocuments.get(candidate.realPath);
    if (existingDocument) {
      existingDocument.roles.add("display-migration");
      existingDocument.migrationBoundary = candidate;
      const inspection = inspectLegacyDisplayDocument({
        path: existingDocument.path,
        format: existingDocument.path.endsWith(".jsonc") ? "jsonc" : "json",
        raw: existingDocument.updated,
        container: candidate.container,
      });
      existingDocument.updated = inspection.updated;
      existingDocument.displayMigrations += inspection.safeActions.length;
      safeActions.push(...inspection.safeActions);
      manualFindings.push(...inspection.manualFindings);
      continue;
    }

    let originalBytes: Buffer;
    try {
      originalBytes = await readFile(candidate.path);
    } catch {
      throw new ScopedUpdateError(`Failed reading update migration config: ${candidate.path}`, {
        path: candidate.path,
      });
    }
    const original = originalBytes.toString("utf8");
    const inspection = inspectLegacyDisplayDocument({
      path: candidate.path,
      format: candidate.format,
      raw: original,
      container: candidate.container,
    });
    safeActions.push(...inspection.safeActions);
    manualFindings.push(...inspection.manualFindings);
    if (
      inspection.manualFindings.some((finding) => finding.kind === "migration-file-uninspectable")
    ) {
      continue;
    }

    workingDocuments.set(candidate.realPath, {
      path: candidate.path,
      original,
      originalBytes,
      updated: inspection.updated,
      replacements: 0,
      displayMigrations: inspection.safeActions.length,
      roles: new Set(["display-migration"]),
      migrationBoundary: candidate,
    });
  }

  manualFindings.push(
    ...(await auditObsoleteUpdateSources({
      env,
      configDir: runtime.configDir,
    })),
  );

  const configEdits: ScopedUpdateConfigEdit[] = [];
  const configSnapshots: ScopedUpdateConfigSnapshot[] = [];
  for (const document of workingDocuments.values()) {
    const changed = document.updated !== document.original;
    let writeTarget: ConfigWriteTargetSnapshot;
    try {
      writeTarget = await resolveConfigWriteTarget(document.path);
    } catch (error) {
      if (error instanceof ConfigWriteTargetError) {
        throw new ScopedUpdateError(error.message, { path: document.path });
      }
      throw error;
    }
    configSnapshots.push({
      path: document.path,
      originalBytes: document.originalBytes,
      expectedBytes: changed ? Buffer.from(document.updated, "utf8") : document.originalBytes,
      updated: document.updated,
      changed,
      roles: CONFIG_ROLE_ORDER.filter((role) => document.roles.has(role)),
      writeTarget,
      ...(document.migrationBoundary ? { migrationBoundary: document.migrationBoundary } : {}),
    });
    if (changed) {
      configEdits.push({
        path: document.path,
        original: document.original,
        originalBytes: document.originalBytes,
        updated: document.updated,
        replacements: document.replacements,
        displayMigrations: document.displayMigrations,
        pluginChanges: document.pluginChanges,
      });
    }
  }

  const uniqueSpecs = [...new Set(foundSpecs)];
  const cacheSpecs = [
    ...new Set([...uniqueSpecs.filter(isCanonicalQuotaUpdateSpec), QUOTA_LATEST_SPEC]),
  ];
  const cacheCandidates = cacheSpecs.map((spec) =>
    join(runtime.cacheDir, "packages", sanitizeOpenCodePackageSpec(spec, params.platform)),
  );

  return {
    configEdits,
    configSnapshots,
    configPaths,
    foundSpecs: uniqueSpecs,
    cacheCandidates: [...new Set(cacheCandidates)],
    authoritativeLatest: uniqueSpecs.length > 0,
    openCodeMajor: params.openCodeMajor,
    safeActions: sortScopedUpdateSafeActions(safeActions),
    manualFindings: sortScopedUpdateManualFindings(manualFindings),
  };
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Package-cache manifests that can verify a cache directory: independent and legacy layouts. */
const VERIFIED_CACHE_MANIFESTS: ReadonlyArray<{ path: readonly string[]; name: string }> = [
  { path: ["@slkiser", "opencode-quota", "package.json"], name: LEGACY_QUOTA_PACKAGE_NAME },
  { path: ["opencode-quota-gui", "package.json"], name: QUOTA_PACKAGE_NAME },
];

async function removeVerifiedCacheCandidate(path: string): Promise<"removed" | "skipped"> {
  const packagesPath = dirname(dirname(path));
  try {
    const packagesStat = await lstat(packagesPath);
    const ownerStat = await lstat(dirname(path));
    if (packagesStat.isSymbolicLink() || ownerStat.isSymbolicLink()) return "skipped";
    const packagesReal = await realpath(packagesPath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "skipped";
    const candidateReal = await realpath(path);
    if (!containedBy(packagesReal, candidateReal) || candidateReal === packagesReal)
      return "skipped";

    let verified = false;
    for (const expected of VERIFIED_CACHE_MANIFESTS) {
      try {
        const manifestPath = join(candidateReal, "node_modules", ...expected.path);
        const manifestStat = await lstat(manifestPath);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) continue;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
        if (manifest.name === expected.name) {
          verified = true;
          break;
        }
      } catch {}
    }
    if (!verified) return "skipped";

    await rm(candidateReal, { recursive: true, force: false });
    return "removed";
  } catch {
    return "skipped";
  }
}

function displayUpdatePath(path: string): string {
  return sanitizeSingleLineDisplayText(path);
}

function formatSafeAction(action: ScopedUpdateSafeAction): string {
  const path = displayUpdatePath(action.path);
  if (action.kind === "package-spec") {
    const noun = action.replacements === 1 ? "replacement" : "replacements";
    return `  edit ${path} (${action.replacements} package ${noun})`;
  }

  switch (action.outcome) {
    case "set-and-remove-old":
      return `  edit ${path}: map opencodeZenDisplay: ${action.from} to accountingDetail: ${action.to}`;
    case "remove-redundant-old":
      return `  edit ${path}: remove redundant opencodeZenDisplay: ${action.from}; keep accountingDetail: ${action.to}`;
    case "keep-current-and-remove-old":
      return `  edit ${path}: keep current accountingDetail; remove obsolete ignored opencodeZenDisplay: ${action.from}`;
  }
}

const OBSOLETE_GO_GUIDANCE =
  "OpenCode Go no longer uses this workspace/cookie source, and it cannot be converted into the official API key. Configure OPENCODE_API_KEY, trusted global provider.opencode-go.options.apiKey, fallback provider.opencode.options.apiKey, or run opencode auth login opencode-go. This updater will not read, copy, or delete credentials; remove the old variable/file manually after the supported key works.";

const ZEN_CONSOLE_GUIDANCE =
  "OpenCode Zen now uses the OpenCode Console sign-in: run opencode auth login opencode (and opencode auth switch opencode to pick a saved organization), then verify with opencode-quota-gui status.";

function formatManualFinding(finding: ScopedUpdateManualFinding): string {
  switch (finding.kind) {
    case "obsolete-go-env":
      return `  ${finding.name}: ${OBSOLETE_GO_GUIDANCE}`;
    case "obsolete-go-file":
      return `  ${displayUpdatePath(finding.path)}: ${OBSOLETE_GO_GUIDANCE}`;
    case "ambiguous-zen-env":
      return `  ${finding.names.join(" and ")}: These environment names may be from an older OpenCode Zen setup, but they may also belong to OpenCode's workspace feature. Current quota code ignores them. ${ZEN_CONSOLE_GUIDANCE} If they held Zen credentials, remove them manually after Zen works; if they belong to OpenCode's workspace feature, leave them. This updater will not read, print, or move their values.`;
    case "obsolete-zen-file":
      return `  ${displayUpdatePath(finding.path)}: OpenCode Zen no longer reads this workspace/cookie file. ${ZEN_CONSOLE_GUIDANCE} This updater will not read, copy, or delete credentials; remove the old file manually after Zen works.`;
    case "display-migration-manual": {
      const path = displayUpdatePath(finding.path);
      switch (finding.reason) {
        case "unsupported-legacy-value":
          return `  ${path}: opencodeZenDisplay has no supported equivalent; review it manually without exposing its value.`;
        case "invalid-accounting-detail":
          return `  ${path}: accountingDetail is invalid; fix it, then remove opencodeZenDisplay manually.`;
        case "duplicate-key":
          return `  ${path}: duplicate display keys require manual review.`;
        case "unsupported-structure":
          return `  ${path}: experimental.quotaToast is structurally ambiguous and requires manual review.`;
      }
      throw new Error("Unknown display migration finding");
    }
    case "migration-file-uninspectable": {
      const path = displayUpdatePath(finding.path);
      switch (finding.reason) {
        case "invalid-json":
          return `  ${path}: the migration file contains invalid JSON/JSONC and could not be inspected.`;
        case "unsupported-root":
          return `  ${path}: the migration file root is not an object and requires manual review.`;
        case "symlink":
          return `  ${path}: the migration path is a symlink and will not be changed automatically.`;
      }
      throw new Error("Unknown migration file finding");
    }
  }
}

export function formatScopedUpdatePreview(plan: ScopedUpdatePlan): string[] {
  const lines = ["Responsible OpenCode Quota update preview"];

  if (plan.openCodeMajor === 1) {
    lines.push(
      "",
      "You're on OpenCode 1. opencode-quota-gui requires OpenCode 2, so update leaves plugin specs as written and never pins them to the upstream @slkiser/opencode-quota package.",
    );
  } else if (plan.openCodeMajor === undefined) {
    lines.push(
      "",
      "Could not detect your OpenCode version; assuming OpenCode 2 (opencode-quota-gui requires OpenCode 2).",
    );
  }

  if (plan.safeActions.length > 0) {
    lines.push("", "Safe changes this command can make:");
    lines.push(...plan.safeActions.map(formatSafeAction));
    for (const edit of plan.configEdits) {
      if (edit.replacements === 0) continue;
      if (edit.pluginChanges) {
        lines.push(...edit.pluginChanges.map((change) => `  ${change}`));
        continue;
      }
      const before = pluginArrays(parseUpdateConfig(edit.original, edit.path));
      const after = pluginArrays(parseUpdateConfig(edit.updated, edit.path));
      for (const array of before) {
        const updated = after.find((candidate) => candidate.path[0] === array.path[0]);
        for (let index = 0; index < array.entries.length; index++) {
          const oldSpec = quotaUpdateSpecFromEntry(array.entries[index]);
          const newSpec = quotaUpdateSpecFromEntry(updated?.entries[index]);
          if (oldSpec !== null && newSpec !== null && oldSpec !== newSpec) {
            lines.push(`  ${JSON.stringify(oldSpec)} -> ${JSON.stringify(newSpec)}`);
          }
        }
      }
    }
  }

  if (plan.manualFindings.length > 0) {
    lines.push("", "Manual actions — this command will not change these sources:");
    lines.push(...plan.manualFindings.map(formatManualFinding));
  }

  if (plan.authoritativeLatest && plan.cacheCandidates.length > 0) {
    lines.push("", "Package-cache candidates (removed only after verification):");
    lines.push(...plan.cacheCandidates.map((path) => `  ${displayUpdatePath(path)}`));
  }

  lines.push("", "No configuration or package-cache changes have been made yet.");
  return lines;
}

export async function applyScopedUpdatePlan(
  plan: ScopedUpdatePlan,
  options: {
    dryRun?: boolean;
    readBytes?: (path: string) => Promise<Buffer>;
    writeText?: (path: string, content: string) => Promise<void>;
    beforeCacheDeletion?: () => Promise<void>;
  } = {},
): Promise<ScopedUpdateResult> {
  if (options.dryRun) {
    return { writtenPaths: [], removedCachePaths: [], skippedCachePaths: [] };
  }

  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const writeText = options.writeText;
  const writtenPaths: string[] = [];
  const failure = (action: string, path: string): ScopedUpdateError => {
    const changed =
      writtenPaths.length > 0
        ? ` Changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}.`
        : "";
    return new ScopedUpdateError(
      `${action} ${displayUpdatePath(path)}; no cache was deleted.${changed}`,
      {
        path,
        writtenPaths: [...writtenPaths],
      },
    );
  };

  for (const snapshot of plan.configSnapshots) {
    try {
      assertSameConfigWriteTarget(
        snapshot.writeTarget,
        await resolveConfigWriteTarget(snapshot.path),
      );
    } catch (error) {
      if (error instanceof ConfigWriteTargetError) {
        throw failure("Config write target changed since preview:", snapshot.path);
      }
      throw error;
    }
    let current: Buffer;
    try {
      current = await readBytes(snapshot.writeTarget.writePath);
    } catch {
      throw failure("Failed reading", snapshot.path);
    }
    if (!current.equals(snapshot.originalBytes)) {
      throw failure("Config changed since preview:", snapshot.path);
    }
  }

  for (const snapshot of plan.configSnapshots) {
    if (!snapshot.changed) continue;
    let currentTarget: ConfigWriteTargetSnapshot;
    try {
      currentTarget = await resolveConfigWriteTarget(snapshot.path);
      assertSameConfigWriteTarget(snapshot.writeTarget, currentTarget);
    } catch (error) {
      if (error instanceof ConfigWriteTargetError) {
        throw failure("Config write target changed since preview:", snapshot.path);
      }
      throw error;
    }
    let current: Buffer;
    try {
      current = await readBytes(currentTarget.writePath);
    } catch {
      throw failure("Failed re-reading before write", snapshot.path);
    }
    if (!current.equals(snapshot.originalBytes)) {
      throw failure("Config changed since preview:", snapshot.path);
    }
    if (snapshot.migrationBoundary) {
      let boundary: ScopedUpdateMigrationBoundary | null;
      try {
        boundary = await resolveScopedUpdateMigrationBoundary({
          path: snapshot.migrationBoundary.path,
          rootDir: snapshot.migrationBoundary.rootDir,
          expectedRealPath: snapshot.migrationBoundary.realPath,
          expectedRealRoot: snapshot.migrationBoundary.realRoot,
          writePath: currentTarget.writePath,
        });
      } catch {
        throw failure("Failed revalidating migration boundary for", snapshot.path);
      }
      if (boundary === null) {
        throw failure("Migration boundary changed before writing", snapshot.path);
      }
    }
    try {
      if (writeText) {
        await writeText(currentTarget.writePath, snapshot.updated);
      } else {
        await writeResolvedConfigText(currentTarget, snapshot.updated);
      }
      writtenPaths.push(snapshot.path);
    } catch {
      throw failure("Failed writing", snapshot.path);
    }
  }

  try {
    await options.beforeCacheDeletion?.();
  } catch {
    const changed =
      writtenPaths.length > 0
        ? ` Changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}.`
        : "";
    throw new ScopedUpdateError(`Failed before cache deletion; no cache was deleted.${changed}`, {
      writtenPaths: [...writtenPaths],
    });
  }

  let authoritativeLatest = false;
  for (const snapshot of plan.configSnapshots) {
    let current: Buffer;
    try {
      current = await readBytes(snapshot.writeTarget.writePath);
    } catch {
      throw failure("Failed re-reading", snapshot.path);
    }
    if (!current.equals(snapshot.expectedBytes)) {
      throw failure("Config changed before cache deletion:", snapshot.path);
    }
    if (!snapshot.roles.includes("package-authority")) continue;
    const currentSpecs = collectQuotaUpdateSpecs(current.toString("utf8"), snapshot.path);
    if (currentSpecs.some((spec) => QUOTA_MOVING_SPECS.has(spec))) authoritativeLatest = true;
  }

  const removedCachePaths: string[] = [];
  const skippedCachePaths: string[] = [];
  if (authoritativeLatest) {
    for (const candidate of plan.cacheCandidates) {
      const result = await removeVerifiedCacheCandidate(candidate);
      (result === "removed" ? removedCachePaths : skippedCachePaths).push(candidate);
    }
  }
  return { writtenPaths, removedCachePaths, skippedCachePaths };
}

export async function runScopedUpdateCommand(
  params: {
    argv?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    confirm?: (message: string) => Promise<boolean>;
    log?: (message: string) => void;
  } = {},
): Promise<number> {
  const argv = params.argv ?? [];
  const unknown = argv.filter((arg) => arg !== "--dry-run" && arg !== "--yes");
  if (unknown.length > 0) return 1;

  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const log = params.log ?? console.log;
  try {
    const plan = await planScopedUpdate({
      ...params,
      openCodeMajor: await detectOpenCodeMajor(),
    });
    for (const line of formatScopedUpdatePreview(plan)) log(line);

    const hasConfigChanges = plan.configSnapshots.some((snapshot) => snapshot.changed);
    const hasAutomaticWork = hasConfigChanges || plan.authoritativeLatest;

    if (dryRun) {
      log(
        "Responsible update preview complete — no configuration or package-cache changes were made.",
      );
      return 0;
    }

    if (!hasAutomaticWork) {
      if (plan.manualFindings.length > 0) {
        log(
          "No automatic changes are available. Complete the manual actions above, then rerun update.",
        );
      } else {
        log("OpenCode Quota update is already current. No files changed.");
        log(`If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`);
      }
      return 0;
    }

    if (!yes) {
      const confirm =
        params.confirm ??
        (async (message: string) => {
          const prompts = await import("@clack/prompts");
          const answer = await prompts.confirm({ message });
          return !prompts.isCancel(answer) && answer === true;
        });
      if (
        !(await confirm(
          "Apply the safe config changes above and remove only manifest-verified package-cache directories?",
        ))
      ) {
        log("OpenCode Quota update cancelled — no files changed.");
        return 0;
      }
    }

    const result = await applyScopedUpdatePlan(plan);
    for (const path of result.writtenPaths) log(`Updated ${displayUpdatePath(path)}`);
    for (const path of result.removedCachePaths) log(`Removed ${displayUpdatePath(path)}`);
    for (const path of result.skippedCachePaths) {
      log(`Skipped unverified cache candidate ${displayUpdatePath(path)}`);
    }
    log("OpenCode Quota update complete.");
    if (plan.configPaths.length > 0) {
      log(`Configured paths: ${plan.configPaths.map(displayUpdatePath).join(", ")}`);
    }
    log("Restart OpenCode and run /quota.");
    log(`If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`);
    return 0;
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    const reason = sanitizeSingleLineDisplayText(rawReason) || "Unknown update failure";
    log(`OpenCode Quota update failed: ${reason}`);
    const writtenPaths =
      error instanceof ScopedUpdateError ? (error.details?.writtenPaths ?? []) : [];
    log(
      writtenPaths.length > 0
        ? `Files changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}. Fix the reason above, then rerun update.`
        : "No files changed. Fix the reason above, then rerun update.",
    );
    return 1;
  }
}
