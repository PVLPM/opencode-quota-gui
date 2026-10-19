/**
 * Open the fixed canonical GUI settings file with the OS default application.
 *
 * This module never accepts a caller-selected path: the settings store passes
 * exactly `getGuiConfigPath(resolve(configDir))`. The target is first resolved
 * through the existing config-write safe target guard (symlink chains, loops,
 * non-regular targets, missing files); a missing file is an error and is never
 * created here.
 *
 * Launch uses `spawn` with `shell: false`; the resolved path is one argument,
 * so spaces and shell metacharacters have no command meaning. Platform
 * commands are intentionally fixed:
 *   - Windows: `explorer.exe <file>` (single-argument Explorer semantics)
 *   - macOS:   `open -- <file>`
 *   - Linux:   `xdg-open <file>`
 */
import { type SpawnOptions, spawn } from "node:child_process";

import {
  ConfigWriteTargetError,
  type ConfigWriteTargetReason,
  type ConfigWriteTargetSnapshot,
  resolveConfigWriteTarget,
} from "../lib/config-write-target.js";

export type SettingsOpenInvocation = {
  command: string;
  args: string[];
};

export type SettingsFileOpenErrorCode =
  | "missing"
  | "unsafe-target"
  | "unsupported-platform"
  | "launch-failed";

/** Controlled opener failure; messages/arguments/paths are never serialized. */
export class SettingsFileOpenError extends Error {
  readonly code: SettingsFileOpenErrorCode;
  readonly reason: ConfigWriteTargetReason | undefined;

  constructor(code: SettingsFileOpenErrorCode, reason?: ConfigWriteTargetReason) {
    super(code);
    this.name = "SettingsFileOpenError";
    this.code = code;
    this.reason = reason;
  }
}

/** Spawn options asserted by tests: never a shell, never inherited stdio. */
export const SETTINGS_OPEN_SPAWN_OPTIONS = {
  shell: false,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
} as const satisfies SpawnOptions;

export interface SettingsFileOpener {
  /** Opens exactly the supplied canonical path (the store fixes it). */
  open(path: string): Promise<void>;
}

export interface SettingsFileOpenerOptions {
  /** Test/embedding seam; production defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test/embedding seam; receives an already-resolved target and no shell. */
  launch?: (invocation: SettingsOpenInvocation) => Promise<void>;
  /** Test/embedding seam for the safe-target guard. */
  resolveTarget?: (path: string) => Promise<ConfigWriteTargetSnapshot>;
}

export function buildSettingsOpenInvocation(
  platform: string,
  target: string,
): SettingsOpenInvocation {
  switch (platform) {
    case "win32":
      // Explorer opens the file with its registered default application. Its
      // exit code is unreliable (often 1 after success), so only spawn
      // failure is treated as an error.
      return { command: "explorer.exe", args: [target] };
    case "darwin":
      return { command: "open", args: ["--", target] };
    case "linux":
      return { command: "xdg-open", args: [target] };
    default:
      throw new SettingsFileOpenError("unsupported-platform");
  }
}

function launchWithDefaultApplication(invocation: SettingsOpenInvocation): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, { ...SETTINGS_OPEN_SPAWN_OPTIONS });
    } catch {
      reject(new SettingsFileOpenError("launch-failed"));
      return;
    }

    let settled = false;
    child.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new SettingsFileOpenError("launch-failed"));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

export function createSettingsFileOpener(
  options: SettingsFileOpenerOptions = {},
): SettingsFileOpener {
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? launchWithDefaultApplication;
  const resolveTarget = options.resolveTarget ?? resolveConfigWriteTarget;

  return {
    async open(path) {
      let target: ConfigWriteTargetSnapshot;
      try {
        target = await resolveTarget(path);
      } catch (error) {
        if (error instanceof ConfigWriteTargetError) {
          throw new SettingsFileOpenError("unsafe-target", error.reason);
        }
        // Inspection failures are controlled and path-free too.
        throw new SettingsFileOpenError("unsafe-target");
      }

      // A missing terminal is a controlled outcome; never create the file.
      if (!target.terminalExisted) throw new SettingsFileOpenError("missing");

      const invocation = buildSettingsOpenInvocation(platform, target.writePath);
      try {
        await launch(invocation);
      } catch (error) {
        if (error instanceof SettingsFileOpenError) throw error;
        throw new SettingsFileOpenError("launch-failed");
      }
    },
  };
}
