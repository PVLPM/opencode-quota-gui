/** The single browser/server v1 legacy-import allowlist; not a writable-key list. */
export const LEGACY_IMPORT_KEYS = [
  "percentDisplayMode",
  "percentLabelStyle",
  "enabledProviders",
  "minIntervalMs",
  "requestTimeoutMs",
  "accountingDetail",
  "waitForQuotaReset",
] as const;

export function isLegacyImportKey(key: string): boolean {
  return LEGACY_IMPORT_KEYS.some((candidate) => candidate === key);
}
