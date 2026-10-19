import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GuiSettingsStore } from "../src/contracts/dashboard.js";
import { createGuiSettingsStore, GuiSettingsError } from "../src/gui/config.js";
import {
  buildSettingsOpenInvocation,
  createSettingsFileOpener,
  SETTINGS_OPEN_SPAWN_OPTIONS,
  SettingsFileOpenError,
} from "../src/gui/settings-file-opener.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";
import { symlinkOrSkip } from "./helpers/symlink-capability.js";

const WINDOWS_PATH = "C:\\Users\\A B\\config & %PATH% ^ (draft).jsonc";
const POSIX_PATH = '/tmp/a b/$HOME; rm -rf "quoted".jsonc';

const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("opencode-quota-gui-open-");
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

/** Calls the optional store method and proves it exists before use. */
async function openFromStore(store: GuiSettingsStore, extraArgument?: string): Promise<void> {
  const open = store.openSettingsFile;
  expect(open).toBeTypeOf("function");
  if (!open) return;
  // Passing a rogue path argument must not change the fixed target.
  const openIgnoringArguments: (...args: unknown[]) => Promise<void> = open;
  await openIgnoringArguments(extraArgument);
}

describe("settings file opener", () => {
  it("builds fixed per-platform invocations with the path as one argument", () => {
    expect(buildSettingsOpenInvocation("win32", WINDOWS_PATH)).toEqual({
      command: "explorer.exe",
      args: [WINDOWS_PATH],
    });
    expect(buildSettingsOpenInvocation("darwin", POSIX_PATH)).toEqual({
      command: "open",
      args: ["--", POSIX_PATH],
    });
    expect(buildSettingsOpenInvocation("linux", POSIX_PATH)).toEqual({
      command: "xdg-open",
      args: [POSIX_PATH],
    });

    // No shell is ever involved: spaces/quotes/metacharacters cannot split or
    // execute because the path stays one argv entry.
    expect(SETTINGS_OPEN_SPAWN_OPTIONS.shell).toBe(false);
    expect(SETTINGS_OPEN_SPAWN_OPTIONS.detached).toBe(true);
    expect(SETTINGS_OPEN_SPAWN_OPTIONS.stdio).toBe("ignore");
    expect(SETTINGS_OPEN_SPAWN_OPTIONS.windowsHide).toBe(true);
  });

  it("rejects an unsupported platform without launching anything", async () => {
    let launches = 0;
    const opener = createSettingsFileOpener({
      platform: "freebsd",
      launch: async () => {
        launches += 1;
      },
    });

    await expect(opener.open(join(makeWorkspace().guiConfigPath))).rejects.toMatchObject({
      code: "missing",
    });

    // A real file reaches the platform check instead.
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1000 });
    await expect(opener.open(workspace.guiConfigPath)).rejects.toMatchObject({
      code: "unsupported-platform",
    });
    expect(launches).toBe(0);
  });

  it("reports a missing file without creating it or launching", async () => {
    const workspace = makeWorkspace();
    let launches = 0;
    const opener = createSettingsFileOpener({
      platform: "linux",
      launch: async () => {
        launches += 1;
      },
    });

    await expect(opener.open(workspace.guiConfigPath)).rejects.toMatchObject({
      code: "missing",
    });
    expect(existsSync(workspace.guiConfigPath)).toBe(false);
    expect(existsSync(dirname(workspace.guiConfigPath))).toBe(false);
    expect(launches).toBe(0);
  });

  it("rejects a directory target and never launches", async () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.guiConfigPath, { recursive: true });
    let launches = 0;
    const opener = createSettingsFileOpener({
      platform: "linux",
      launch: async () => {
        launches += 1;
      },
    });

    await expect(opener.open(workspace.guiConfigPath)).rejects.toMatchObject({
      code: "unsafe-target",
      reason: "non-regular",
    });
    expect(launches).toBe(0);
  });

  it("follows a safe symlink to a regular file", async (context) => {
    const workspace = makeWorkspace();
    mkdirSync(dirname(workspace.guiConfigPath), { recursive: true });
    const realPath = join(workspace.tempDir, "real-config.jsonc");
    writeFileSync(realPath, "{}\n");
    if (!symlinkOrSkip(context, realPath, workspace.guiConfigPath, "file")) return;

    let launched: { command: string; args: string[] } | undefined;
    const opener = createSettingsFileOpener({
      platform: "darwin",
      launch: async (invocation) => {
        launched = invocation;
      },
    });

    await opener.open(workspace.guiConfigPath);
    expect(launched).toEqual({
      command: "open",
      args: ["--", realpathSync(realPath)],
    });
  });

  it("rejects a dangling symlink with a controlled unsafe-target outcome", async (context) => {
    const workspace = makeWorkspace();
    mkdirSync(dirname(workspace.guiConfigPath), { recursive: true });
    const missingTarget = join(workspace.tempDir, "missing-config.jsonc");
    if (!symlinkOrSkip(context, missingTarget, workspace.guiConfigPath, "file")) return;

    let launches = 0;
    const opener = createSettingsFileOpener({
      platform: "linux",
      launch: async () => {
        launches += 1;
      },
    });

    await expect(opener.open(workspace.guiConfigPath)).rejects.toMatchObject({
      code: "unsafe-target",
      reason: "dangling",
    });
    expect(launches).toBe(0);
    expect(existsSync(missingTarget)).toBe(false);
  });

  it("turns an opener launch failure into a path-free controlled error", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1000 });
    const opener = createSettingsFileOpener({
      platform: "win32",
      launch: async () => {
        throw new Error(`editor exploded at ${workspace.tempDir}`);
      },
    });

    await expect(opener.open(workspace.guiConfigPath)).rejects.toMatchObject({
      code: "launch-failed",
    });
  });

  it("opens only the fixed canonical path and ignores caller arguments", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 1000 });
    const opened: string[] = [];
    const store = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
      settingsFileOpener: {
        open: async (path) => {
          opened.push(path);
        },
      },
    });

    const snapshot = await store.settings();
    expect(snapshot.pathLabel).toBe(workspace.guiConfigPath);
    expect(isAbsolute(snapshot.pathLabel)).toBe(true);

    await openFromStore(store);
    await openFromStore(store, "C:\\Windows\\System32\\calc.exe");
    await openFromStore(store, "/etc/passwd");

    expect(opened).toEqual([
      workspace.guiConfigPath,
      workspace.guiConfigPath,
      workspace.guiConfigPath,
    ]);
  });

  it("maps missing/unsafe/launch failures to controlled settings errors without paths", async () => {
    const workspace = makeWorkspace();
    const missingStore = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
    });
    await expect(openFromStore(missingStore)).rejects.toMatchObject({
      code: "config-target-error",
      message: "The dashboard config file does not exist",
    });

    const unsafeStore = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
      settingsFileOpener: {
        open: async () => {
          throw new SettingsFileOpenError("unsafe-target", "dangling");
        },
      },
    });
    await expect(openFromStore(unsafeStore)).rejects.toMatchObject({
      code: "config-target-error",
      message: "The dashboard config path cannot be opened",
      details: { reason: "dangling" },
    });

    const launchStore = createGuiSettingsStore({
      configDir: workspace.configDir,
      workspaceRoot: workspace.workspaceRoot,
      settingsFileOpener: {
        open: async () => {
          throw new SettingsFileOpenError("launch-failed");
        },
      },
    });
    try {
      await openFromStore(launchStore);
      throw new Error("expected the launch failure to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(GuiSettingsError);
      expect(error).toMatchObject({
        code: "config-write-error",
        message: "Failed to open the dashboard config file",
      });
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(workspace.tempDir);
      expect(error.message).not.toContain("explorer");
    }
  });
});
