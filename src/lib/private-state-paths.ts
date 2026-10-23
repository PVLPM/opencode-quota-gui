/**
 * The GUI product's private writable namespace. Every cache, state file and lock
 * owned by this product lives under `opencode-quota-gui` and never shares a path
 * with the upstream `opencode-quota` plugin, so both products can run side by side.
 */
import { join } from "node:path";

import { getOpencodeRuntimeDirs, type OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export const GUI_PRIVATE_NAMESPACE = "opencode-quota-gui";

export function getGuiPrivateCacheDir(
  runtimeDirs: OpencodeRuntimeDirs = getOpencodeRuntimeDirs(),
): string {
  return join(runtimeDirs.cacheDir, GUI_PRIVATE_NAMESPACE);
}

export function getGuiPrivateStateDir(
  runtimeDirs: OpencodeRuntimeDirs = getOpencodeRuntimeDirs(),
): string {
  return join(runtimeDirs.stateDir, GUI_PRIVATE_NAMESPACE);
}

export function getGuiPrivateCachePath(...segments: string[]): string {
  return join(getGuiPrivateCacheDir(), ...segments);
}

export function getGuiPrivateStatePath(...segments: string[]): string {
  return join(getGuiPrivateStateDir(), ...segments);
}

export function getQuotaResetNotificationsStatePath(): string {
  return getGuiPrivateStatePath("quota-reset-notifications.json");
}

/** Daily Home-notice claim state; the lock-free equivalent of a read marker. */
export function getMaintainerAnnouncementsHomeStatePath(): string {
  return getGuiPrivateStatePath("maintainer-announcements-home.json");
}
