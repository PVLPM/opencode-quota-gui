import type { QuotaSnapshot, SettingsSnapshot } from "../contracts/dashboard.js";
import {
  formatNativeSettingsCopyDiagnostics,
  projectNativeSettingsCopyDiagnostics,
} from "./settings-copy-diagnostics.js";

/** Derive only aggregates from the snapshots already loaded by the page. */
export function settingsDiagnosticsFromSnapshots(
  quota: QuotaSnapshot | undefined,
  settings: SettingsSnapshot | undefined,
  stale: boolean,
): string {
  return formatNativeSettingsCopyDiagnostics(
    projectNativeSettingsCopyDiagnostics({
      quota: quota && {
        stale: stale || quota.stale,
        cardCount: quota.providers.cards.length,
        errorCount: quota.providers.cards.reduce((count, card) => count + card.errors.length, 0),
      },
      configuration: settings && {
        status: settings.issues.length > 0 ? "issues" : "ready",
        issueCount: settings.issues.length,
      },
      temporal: quota?.temporal && {
        providers: quota.temporal.providers.map((provider) => ({
          discovered: provider.discovered,
          phase: provider.phase,
        })),
      },
    }),
  );
}

export async function copySettingsDiagnostics(
  makeText: () => string,
  writeText: ((text: string) => Promise<void>) | undefined,
  notify: (tone: "success" | "error", message: string) => void,
): Promise<void> {
  try {
    if (!writeText) throw new Error("Clipboard unavailable");
    await writeText(makeText());
    notify("success", "Diagnostics copied to clipboard.");
  } catch {
    notify("error", "Could not copy diagnostics. Check clipboard permissions and try again.");
  }
}
