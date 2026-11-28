/**
 * Antigravity official CLI (`agy`) usage reader.
 *
 * The CLI exposes its own `/usage` slash command without starting an agent turn,
 * so this module runs exactly one supported read:
 *
 *     agy --output-format json -p "/usage"
 *
 * `--disable-slash-commands` must never be added: it turns `/usage` into a real
 * model prompt, which starts an agent turn and spends quota. A `--version` probe
 * gates the read, because versions before 1.1.11 have no `/usage` command.
 *
 * The CLI reports no account identity in this output. A local
 * `~/.gemini/google_accounts.json` "active" field exists, but nothing proves agy
 * uses that account, so this source is never linked to another card.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { ProviderFailureCategory } from "../contracts/provider-failure.js";

/** First release with the machine-readable `/usage` command. */
export const AGY_MINIMUM_VERSION = "1.1.11";

/** A `/usage` read normally returns in a few seconds; the CLI may start slowly. */
export const AGY_USAGE_TIMEOUT_MS = 30_000;
/** A version probe is local and must never hold the quota cycle. */
export const AGY_VERSION_TIMEOUT_MS = 5_000;

/**
 * The exact supported argv. Order matters only for readability; the flags are
 * the documented machine-readable form of the slash command.
 */
export const AGY_USAGE_ARGS = ["--output-format", "json", "-p", "/usage"] as const;
export const AGY_VERSION_ARGS = ["--version"] as const;

const EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const ERROR_TEXT_MAX_LENGTH = 200;

/**
 * Fixed failure text for every known outcome.
 *
 * `agy` diagnostics quote the signed-in account email, private paths and
 * occasionally a credential fragment, and a provider error reaches both the
 * quota status report and the persisted state cache. Raw stdout and stderr
 * therefore never appear in an error, a diagnostic or a log: each known failure
 * maps to one stable message here, and the process facts worth keeping stay
 * typed (`exitCode`, `version`) instead of being copied out of that text.
 */
export const AGY_FAILURE_MESSAGES = {
  versionProbeTimeout: "Antigravity CLI version probe timed out.",
  versionProbeFailed:
    "Antigravity CLI version probe failed. Run agy --version to check the installation.",
  versionUnparsable: "Antigravity CLI printed a version this provider cannot parse.",
  spawnFailed: "Antigravity CLI could not be started. Check the agy installation.",
  usageEnvelopeFailed:
    "Antigravity CLI reported a failing status for its usage output. Run agy to see the full message.",
  usageDifferentCommand: "Antigravity CLI ran a command other than its usage command.",
  usageNoCommand: "Antigravity CLI returned no command name for its usage output.",
  usageModelTurn:
    "Antigravity CLI started a model turn instead of running the usage command, which may have spent quota. Update agy and retry.",
  usageUnparsable: "Antigravity CLI returned unparsable output.",
  usageFailed:
    "Antigravity CLI failed while reading usage (exit 1). Run agy to see the full message.",
  usagePartial: "Antigravity CLI stopped after partial output (exit 3).",
} as const;

export interface AgyProcessRequest {
  file: string;
  args: readonly string[];
  timeoutMs: number;
}

export interface AgyProcessResult {
  /** Process exit code, or null when the process could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Exec/spawn failure code such as `ENOENT`; never a stderr body. */
  spawnErrorCode?: string;
}

export type AgyProcessRunner = (request: AgyProcessRequest) => Promise<AgyProcessResult>;

/** Node reports a child killed by the runner's own timeout through code, killed or message. */
const timedOutByRunner = (error: {
  code?: number | string;
  killed?: boolean;
  message: string;
}): boolean =>
  error.code === "ETIMEDOUT" ||
  error.killed === true ||
  error.message.toLowerCase().includes("timed out");

/**
 * Default runner. `shell: false` and `windowsHide: true` keep the child a real
 * process with no console flash, and the timeout terminates it.
 */
export const runAgyProcess: AgyProcessRunner = async (request) =>
  await new Promise<AgyProcessResult>((resolveResult) => {
    try {
      execFile(
        request.file,
        [...request.args],
        {
          encoding: "utf8",
          timeout: request.timeoutMs,
          maxBuffer: EXEC_MAX_BUFFER_BYTES,
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const stdoutText = typeof stdout === "string" ? stdout : String(stdout ?? "");
          const stderrText = typeof stderr === "string" ? stderr : String(stderr ?? "");
          if (!error) {
            resolveResult({ code: 0, stdout: stdoutText, stderr: stderrText, timedOut: false });
            return;
          }
          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolveResult({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: timedOutByRunner(execError),
            ...(typeof execError.code === "string" ? { spawnErrorCode: execError.code } : {}),
          });
        },
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      resolveResult({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...(code === undefined ? {} : { spawnErrorCode: code }),
      });
    }
  });

/** One reported usage bucket, already normalized for row mapping. */
export interface AgyUsageBucket {
  /** Group name from the CLI payload, used only as a display group. */
  groupName: string;
  /** Stable provider bucket id (`gemini-weekly`, `3p-5h`); the only row identity. */
  bucketId: string;
  /** Display label derived from the reported window. */
  label: string;
  /** Typed window token exactly as the CLI reports it (`weekly`, `5h`). */
  window?: string;
  percentRemaining: number;
  /** Absent when the CLI scheduled no reset (`1970-01-01T00:00:00Z`) or printed none. */
  resetTimeIso?: string;
}

export type AgyUsageReadResult =
  | { state: "ok"; buckets: AgyUsageBucket[]; observedAtIso: string }
  /** The CLI ran but reports no account quota (exit 2, e.g. API-key mode). */
  | { state: "no-quota" }
  | { state: "unsupported-version"; version: string }
  | { state: "not-installed" }
  | {
      state: "error";
      message: string;
      failureCategory?: ProviderFailureCategory;
      /** Exit code of the failed read, when the CLI ran. */
      exitCode?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeLine(text: string): string {
  // Keep one readable line; the CLI may print a stack or ANSI-coloured text.
  const single = text.replace(/\s+/gu, " ").trim();
  return single.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export interface AgyVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the bare semver `agy --version` prints (`1.5.18`).
 *
 * A `v` prefix and a prerelease/build suffix are tolerated; anything without a
 * complete `major.minor.patch` is not a version we can gate on.
 */
export function parseAgyVersion(text: string): AgyVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(text.trim());
  if (!match) return undefined;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** Compare two parsed versions: negative when `left` is older. */
export function compareAgyVersions(left: AgyVersion, right: AgyVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function formatAgyVersion(version: AgyVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the `agy` executable without a shell.
 *
 * Every absolute `PATH` directory is checked for the platform's executable name,
 * then the Windows installer location `%LOCALAPPDATA%\agy\bin\agy.exe` is checked
 * because an already-running shell may predate the installer's PATH entry. An
 * empty or relative `PATH` entry is skipped: it would resolve against the process
 * working directory, which is not where the CLI was installed.
 */
export async function resolveAgyBinaryPath(
  params: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    isFile?: (path: string) => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const exists = params.isFile ?? isFile;
  const paths = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? ["agy.exe"] : ["agy"];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const rawEntry of (env.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
    const entry = rawEntry
      .trim()
      .replace(/^"(.*)"$/u, "$1")
      .trim();
    if (!entry || !paths.isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = paths.resolve(entry, name);
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  const localAppData = env.LOCALAPPDATA?.trim();
  if (platform === "win32" && localAppData) {
    candidates.push(paths.join(localAppData, "agy", "bin", "agy.exe"));
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** `1970-01-01T00:00:00Z` means "no reset scheduled", never a past reset. */
export function parseAgyResetTimeIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return new Date(parsed).toISOString();
}

/** Display label for a reported window token; unknown tokens stay verbatim. */
function windowLabel(window: string | undefined): string {
  switch (window) {
    case "weekly":
      return "Weekly";
    case "5h":
      return "5h";
    case "daily":
      return "Daily";
    case "monthly":
      return "Monthly";
    default:
      return window ? sanitizeLine(window) : "Usage";
  }
}

/** Clamp the reported remaining fraction into a percent value. */
function fractionToPercent(fraction: number): number {
  return Math.min(100, Math.max(0, fraction * 100));
}

function readBuckets(usageData: unknown): AgyUsageBucket[] {
  const data = isRecord(usageData) ? usageData : {};
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const buckets: AgyUsageBucket[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const groupName =
      typeof group.name === "string" && group.name.trim()
        ? sanitizeLine(group.name)
        : "Antigravity";
    const groupBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of groupBuckets) {
      if (!isRecord(bucket)) continue;
      // A bucket with no remaining fraction reports nothing to display.
      if (
        typeof bucket.remaining_fraction !== "number" ||
        !Number.isFinite(bucket.remaining_fraction)
      ) {
        continue;
      }
      // Row identity is the provider bucket id; a bucket without one cannot be
      // identified stably, so it is skipped instead of keyed by its label.
      const bucketId =
        typeof bucket.id === "string" && bucket.id.trim() ? sanitizeLine(bucket.id) : undefined;
      if (!bucketId) continue;
      const window =
        typeof bucket.window === "string" && bucket.window.trim()
          ? sanitizeLine(bucket.window)
          : undefined;
      const resetTimeIso = parseAgyResetTimeIso(bucket.reset_time);
      buckets.push({
        groupName,
        bucketId,
        label: windowLabel(window),
        ...(window ? { window } : {}),
        percentRemaining: fractionToPercent(bucket.remaining_fraction),
        ...(resetTimeIso ? { resetTimeIso } : {}),
      });
    }
  }
  return buckets;
}

/** A timeout reports its configured bound only; nothing from the CLI is echoed. */
function usageTimeoutMessage(timeoutMs: number): string {
  return `Antigravity CLI usage read timed out after ${Math.round(timeoutMs / 1000)}s.`;
}

/** An exit code is a bounded process fact; every other part of this message is fixed. */
function unexpectedExitMessage(code: number): string {
  return `Antigravity CLI exited with code ${code}.`;
}

/**
 * Read and validate one `/usage` envelope.
 *
 * Trust requires `status === "SUCCESS"` and `command.name === "usage"`. A missing
 * command name together with `num_turns > 0` or a `conversation_id` proves the
 * CLI ran a model turn instead of the slash command, which may have spent quota;
 * that is reported as an error and never as usage.
 *
 * Every failing branch reports fixed text: the envelope's own `status`, `error`
 * and `command.name` strings are CLI output and are inspected, never echoed.
 */
function readEnvelope(payload: unknown, observedAtMs: number): AgyUsageReadResult {
  if (!isRecord(payload)) {
    return { state: "error", message: AGY_FAILURE_MESSAGES.usageUnparsable };
  }

  const command = isRecord(payload.command) ? payload.command : undefined;
  const commandName = typeof command?.name === "string" ? command.name.trim() : undefined;

  if (payload.status !== "SUCCESS") {
    return {
      state: "error",
      message:
        commandName && commandName !== "usage"
          ? AGY_FAILURE_MESSAGES.usageDifferentCommand
          : AGY_FAILURE_MESSAGES.usageEnvelopeFailed,
    };
  }

  if (!commandName) {
    const numTurns = typeof payload.num_turns === "number" ? payload.num_turns : 0;
    if (numTurns > 0 || typeof payload.conversation_id === "string") {
      return {
        state: "error",
        message: AGY_FAILURE_MESSAGES.usageModelTurn,
      };
    }
    return {
      state: "error",
      message: AGY_FAILURE_MESSAGES.usageNoCommand,
    };
  }

  if (commandName !== "usage") {
    return {
      state: "error",
      message: AGY_FAILURE_MESSAGES.usageDifferentCommand,
    };
  }

  const buckets = readBuckets(command?.data);
  if (buckets.length === 0) return { state: "no-quota" };
  return { state: "ok", buckets, observedAtIso: new Date(observedAtMs).toISOString() };
}

/**
 * Run the gated read: resolve the binary, check its version, then read usage.
 *
 * Exit codes: `0` success, `1` error (the JSON `.error` explains it to the CLI
 * user, never to this reader), `2` no account quota (for example API-key mode),
 * `3` output that failed partway.
 */
export async function readAgyUsage(
  params: {
    runner?: AgyProcessRunner;
    binaryPath?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    isFile?: (path: string) => Promise<boolean>;
    usageTimeoutMs?: number;
    versionTimeoutMs?: number;
    nowMs?: number;
  } = {},
): Promise<AgyUsageReadResult> {
  const runner = params.runner ?? runAgyProcess;
  const binaryPath =
    params.binaryPath ??
    (await resolveAgyBinaryPath({
      ...(params.platform === undefined ? {} : { platform: params.platform }),
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.isFile === undefined ? {} : { isFile: params.isFile }),
    }));
  if (!binaryPath) return { state: "not-installed" };

  const versionResult = await runner({
    file: binaryPath,
    args: AGY_VERSION_ARGS,
    timeoutMs: params.versionTimeoutMs ?? AGY_VERSION_TIMEOUT_MS,
  });
  if (versionResult.timedOut) {
    return {
      state: "error",
      message: AGY_FAILURE_MESSAGES.versionProbeTimeout,
      failureCategory: "local",
    };
  }
  if (versionResult.code !== 0) {
    return {
      state: "error",
      // The probe's stderr and the spawn errno are process output; neither is
      // copied into the message.
      message: AGY_FAILURE_MESSAGES.versionProbeFailed,
      failureCategory: "local",
    };
  }

  const version = parseAgyVersion(versionResult.stdout);
  if (!version) {
    return {
      state: "error",
      message: AGY_FAILURE_MESSAGES.versionUnparsable,
      failureCategory: "local",
    };
  }
  const minimum = parseAgyVersion(AGY_MINIMUM_VERSION);
  if (minimum && compareAgyVersions(version, minimum) < 0) {
    return { state: "unsupported-version", version: formatAgyVersion(version) };
  }

  const usageResult = await runner({
    file: binaryPath,
    args: AGY_USAGE_ARGS,
    timeoutMs: params.usageTimeoutMs ?? AGY_USAGE_TIMEOUT_MS,
  });
  if (usageResult.timedOut) {
    return {
      state: "error",
      message: usageTimeoutMessage(params.usageTimeoutMs ?? AGY_USAGE_TIMEOUT_MS),
      failureCategory: "local",
    };
  }

  const payload = parseJson(usageResult.stdout);
  switch (usageResult.code) {
    case 0:
      return readEnvelope(payload, params.nowMs ?? Date.now());
    case 2:
      return { state: "no-quota" };
    case 1:
      return {
        state: "error",
        message: AGY_FAILURE_MESSAGES.usageFailed,
        failureCategory: "provider_api",
        exitCode: 1,
      };
    case 3:
      return {
        state: "error",
        message: AGY_FAILURE_MESSAGES.usagePartial,
        failureCategory: "provider_api",
        exitCode: 3,
      };
    case null:
      // No exit code means the child never started, so there is no CLI output
      // to report at all.
      return {
        state: "error",
        message: AGY_FAILURE_MESSAGES.spawnFailed,
        failureCategory: "local",
      };
    default:
      return {
        state: "error",
        message: unexpectedExitMessage(usageResult.code),
        failureCategory: "local",
        exitCode: usageResult.code,
      };
  }
}
