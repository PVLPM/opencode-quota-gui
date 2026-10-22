import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ConfigFileKind = "opencode";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  sourcePath: string;
  format: ConfigFileFormat;
  existed: boolean;
  removeSourcePath?: string;
}

export interface RuntimeContextRootHints {
  workspaceRoot?: string | null;
  worktreeRoot?: string | null;
  activeDirectory?: string | null;
  configRoot?: string | null;
  fallbackDirectory: string;
}

export interface RuntimeContextRoots {
  workspaceRoot: string;
  configRoot: string;
}

export function dedupeNonEmptyStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function pickFirstNonEmptyString(items: Array<string | null | undefined>): string | null {
  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export function resolveRuntimeContextRoots(params: RuntimeContextRootHints): RuntimeContextRoots {
  const workspaceRoot =
    pickFirstNonEmptyString([
      params.workspaceRoot,
      params.worktreeRoot,
      params.activeDirectory,
      params.fallbackDirectory,
    ]) ?? params.fallbackDirectory;
  const explicitConfigRoot = pickFirstNonEmptyString([params.configRoot]);
  const computedConfigRoot =
    pickFirstNonEmptyString([workspaceRoot, params.activeDirectory]) ?? workspaceRoot;
  const configRoot = explicitConfigRoot ?? computedConfigRoot;

  return { workspaceRoot, configRoot };
}

export function findGitWorktreeRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Roots for an OpenCode location, shared by the server plugin and the TUI so both
 * read the same project config: the enclosing Git worktree, else the location directory.
 */
export function resolveOpenCodeLocationRoots(
  directory: string,
): RuntimeContextRoots & { fallbackDirectory: string } {
  const workspaceRoot = findGitWorktreeRoot(directory) ?? directory;
  return { workspaceRoot, configRoot: workspaceRoot, fallbackDirectory: directory };
}

export function getConfigFileCandidatePaths(dir: string, kind: ConfigFileKind): string[] {
  return [join(dir, `${kind}.jsonc`), join(dir, `${kind}.json`)];
}

export function resolveExistingConfigPath(dir: string, kind: ConfigFileKind): string | null {
  return getConfigFileCandidatePaths(dir, kind).find((path) => existsSync(path)) ?? null;
}

export function resolveEditableConfigPath(params: {
  dir: string;
  kind: ConfigFileKind;
  preferredFormat?: ConfigFileFormat;
  convertJsonToJsonc?: boolean;
}): EditableConfigPath {
  const jsoncPath = join(params.dir, `${params.kind}.jsonc`);
  if (existsSync(jsoncPath)) {
    return {
      path: jsoncPath,
      sourcePath: jsoncPath,
      format: "jsonc",
      existed: true,
    };
  }

  const jsonPath = join(params.dir, `${params.kind}.json`);
  if (existsSync(jsonPath)) {
    if (params.preferredFormat === "jsonc" && params.convertJsonToJsonc) {
      return {
        path: jsoncPath,
        sourcePath: jsonPath,
        format: "jsonc",
        existed: true,
        removeSourcePath: jsonPath,
      };
    }

    return {
      path: jsonPath,
      sourcePath: jsonPath,
      format: "json",
      existed: true,
    };
  }

  const format = params.preferredFormat ?? "jsonc";
  const path = join(params.dir, `${params.kind}.${format}`);
  return {
    path,
    sourcePath: path,
    format,
    existed: false,
  };
}

/** Reads the package spec from a legacy `plugin` entry or an OpenCode 2 native `plugins` entry. */
export function getPluginSpecFromEntry(entry: unknown): string | null {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { package?: unknown }).package === "string"
          ? (entry as { package: string }).package
          : null;

  if (typeof spec !== "string") {
    return null;
  }

  const trimmed = spec.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractPluginSpecsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const pluginEntries: unknown[] = [];

  if (Array.isArray(root.plugin)) {
    pluginEntries.push(...root.plugin);
  }

  if (Array.isArray(root.plugins)) {
    pluginEntries.push(...root.plugins);
  }

  if (root.tui && typeof root.tui === "object" && !Array.isArray(root.tui)) {
    const tuiRoot = root.tui as Record<string, unknown>;
    if (Array.isArray(tuiRoot.plugin)) {
      pluginEntries.push(...tuiRoot.plugin);
    }
  }

  return dedupeNonEmptyStrings(
    pluginEntries
      .map((entry) => getPluginSpecFromEntry(entry))
      .filter((entry): entry is string => typeof entry === "string"),
  );
}

export function extractProviderIdsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  // OpenCode 2 reads both the legacy `provider` map and the native `providers` map.
  const root = parsed as Record<string, unknown>;
  const providerIds: string[] = [];
  for (const providerMap of [root.provider, root.providers]) {
    if (providerMap && typeof providerMap === "object" && !Array.isArray(providerMap)) {
      providerIds.push(...Object.keys(providerMap));
    }
  }

  return dedupeNonEmptyStrings(providerIds);
}

export function isQuotaPluginSpec(spec: string): boolean {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("@slkiser/opencode-quota")) {
    return true;
  }

  if (normalized.includes("/opencode-quota") && !normalized.includes("/opencode-quota/dist/")) {
    return true;
  }

  return normalized.includes("opencode-quota/dist/index.js");
}

/** Installer/update identity checks must not infer ownership from a path containing “quota”. */
export async function isVerifiedQuotaPluginSpec(spec: string, configDir: string): Promise<boolean> {
  if (/^(?:opencode-quota-gui|@slkiser\/opencode-quota)(?:@[^/\\\s]+)?$/.test(spec)) {
    return true;
  }
  if (!/^(?:file:|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(spec)) return false;
  let path: string;
  try {
    path = spec.startsWith("file://")
      ? fileURLToPath(spec)
      : resolve(configDir, spec.replace(/^file:/, ""));
  } catch {
    return false;
  }
  const normalized = path.replace(/\\/g, "/");
  if (/\/dist\//.test(normalized) && !normalized.endsWith("/dist/index.js")) return false;
  const packageDir = normalized.endsWith("/dist/index.js")
    ? dirname(dirname(path))
    : normalized.endsWith("/server.ts")
      ? dirname(path)
      : path;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    return (
      !!manifest &&
      typeof manifest === "object" &&
      "name" in manifest &&
      (manifest.name === "opencode-quota-gui" || manifest.name === "@slkiser/opencode-quota")
    );
  } catch {
    return false;
  }
}
