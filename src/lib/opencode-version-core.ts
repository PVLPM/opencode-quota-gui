export type OpenCodeMajor = 1 | 2;

/** Numeric host version; a prerelease/build suffix is ignored. */
export interface OpenCodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** The numeric core of `1.18.32`, `opencode v2.2.0`, or `2.2.1-beta.1`. */
const OPENCODE_VERSION_PATTERN = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/;

/** Parses the numeric version core; a prerelease or build suffix is ignored. */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | undefined {
  const match = OPENCODE_VERSION_PATTERN.exec(output.trim());
  if (!match) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return undefined;
  return { major, minor, patch };
}

/** OpenCode 1 prints a bare `1.18.32`; OpenCode 2 prints `opencode v2.0.16`. */
export function parseOpenCodeMajor(output: string): OpenCodeMajor | undefined {
  const version = parseOpenCodeVersion(output);
  if (version?.major === 1) return 1;
  if (version?.major === 2) return 2;
  return undefined;
}

/** Compares the numeric parts only; a prerelease suffix never lowers the result. */
function isAtLeast(version: OpenCodeVersion, major: number, minor: number, patch: number): boolean {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

/**
 * Whether the host has the full Native GUI baseline (2.2.1+). Missing or
 * unparseable versions are not assumed capable.
 */
export function supportsNativeGui(version: string | OpenCodeVersion | undefined): boolean {
  const parsed = typeof version === "string" ? parseOpenCodeVersion(version) : version;
  return parsed !== undefined && isAtLeast(parsed, 2, 2, 1);
}

/**
 * Whether the host predates the Native GUI and therefore keeps the compatibility
 * web dashboard on by default. Only a parseable version below 2.2.1 qualifies;
 * missing or unparseable versions fail closed.
 */
export function isPreNativeGuiVersion(version: string | OpenCodeVersion | undefined): boolean {
  const parsed = typeof version === "string" ? parseOpenCodeVersion(version) : version;
  return parsed !== undefined && !isAtLeast(parsed, 2, 2, 1);
}
