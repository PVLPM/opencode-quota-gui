import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { OpencodeRuntimeDirs } from "../../src/lib/opencode-runtime-paths.js";

type ConfigLoaderWorkspaceOptions = {
  nestedPath?: string[];
};

export type ConfigLoaderWorkspace = {
  tempDir: string;
  workspaceDir: string;
  nestedDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  xdgStateHome: string;
  opencodeConfigDir: string;
  runtimeDirs: OpencodeRuntimeDirs;
  cleanup: () => void;
};

/** Runtime dirs under `root/unused-runtime`, which tests never create. */
export function createUnusedRuntimeDirs(root: string): OpencodeRuntimeDirs {
  const base = join(root, "unused-runtime");
  return {
    dataDir: join(base, "data"),
    configDir: join(base, "config"),
    cacheDir: join(base, "cache"),
    stateDir: join(base, "state"),
  };
}

export function createConfigLoaderWorkspace(
  prefix: string,
  options: ConfigLoaderWorkspaceOptions = {},
): ConfigLoaderWorkspace {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const workspaceDir = join(tempDir, "workspace");
  const nestedDir = options.nestedPath?.length
    ? join(workspaceDir, ...options.nestedPath)
    : workspaceDir;
  const xdgConfigHome = join(tempDir, "xdg-config");
  const xdgDataHome = join(tempDir, "xdg-data");
  const xdgCacheHome = join(tempDir, "xdg-cache");
  const xdgStateHome = join(tempDir, "xdg-state");
  const opencodeConfigDir = join(xdgConfigHome, "opencode");

  mkdirSync(nestedDir, { recursive: true });
  mkdirSync(opencodeConfigDir, { recursive: true });

  return {
    tempDir,
    workspaceDir,
    nestedDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    opencodeConfigDir,
    runtimeDirs: {
      dataDir: join(xdgDataHome, "opencode"),
      configDir: opencodeConfigDir,
      cacheDir: join(xdgCacheHome, "opencode"),
      stateDir: join(xdgStateHome, "opencode"),
    },
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function createConfigLoaderEnv(
  workspace: ConfigLoaderWorkspace,
  options: { home?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: workspace.xdgConfigHome,
    XDG_DATA_HOME: workspace.xdgDataHome,
    XDG_CACHE_HOME: workspace.xdgCacheHome,
    XDG_STATE_HOME: workspace.xdgStateHome,
  };

  if (options.home !== undefined) {
    env.HOME = options.home;
  }

  return env;
}

export interface GuiConfigWorkspace {
  tempDir: string;
  /** Global OpenCode config dir (`OPENCODE_CONFIG_DIR` equivalent). */
  configDir: string;
  /** Project/workspace config root. */
  workspaceRoot: string;
  guiConfigDir: string;
  guiConfigPath: string;
  guiConfigJsonPath: string;
  cleanup: () => void;
}

/**
 * Real filesystem workspace for the canonical dashboard config: a global config
 * dir plus a project workspace root. The `opencode-quota-gui` dir stays absent
 * until a test writes to it, so first-write behaviour is exercised for real.
 */
export function createGuiConfigWorkspace(prefix: string): GuiConfigWorkspace {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const configDir = join(tempDir, "config");
  const workspaceRoot = join(tempDir, "workspace");
  const guiConfigDir = join(configDir, "opencode-quota-gui");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });

  return {
    tempDir,
    configDir,
    workspaceRoot,
    guiConfigDir,
    guiConfigPath: join(guiConfigDir, "config.jsonc"),
    guiConfigJsonPath: join(guiConfigDir, "config.json"),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

/** Writes the canonical dashboard file (object → JSON, string → verbatim JSONC). */
export function writeGuiCanonicalConfig(
  workspace: GuiConfigWorkspace,
  data: Record<string, unknown> | string,
): string {
  mkdirSync(workspace.guiConfigDir, { recursive: true });
  writeFileSync(
    workspace.guiConfigPath,
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
  return workspace.guiConfigPath;
}

export function quotaConfigSource(dir: string): string {
  return join(dir, "opencode.json") + " (experimental.quotaToast)";
}

export function quotaSidecarConfigSource(dir: string): string {
  return join(dir, "opencode-quota", "quota-toast.json") + " (opencode-quota/quota-toast.json)";
}

export function writeQuotaSidecarConfig(dir: string, quotaToast: Record<string, unknown>): string {
  const configDir = join(dir, "opencode-quota");
  const path = join(configDir, "quota-toast.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, JSON.stringify(quotaToast), "utf8");
  return path;
}

export function writeQuotaToastConfig(dir: string, quotaToast: Record<string, unknown>): string {
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify({
      experimental: {
        quotaToast,
      },
    }),
    "utf8",
  );
  return path;
}
