import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { REQUEST_TIMEOUT_MS } from "./types.js";

export const ALIBABA_CODING_PLAN_COMMAND = "bl";
export const ALIBABA_CODING_PLAN_ARGS = ["usage", "coding-plan", "--output", "json"] as const;
export const ALIBABA_CODING_PLAN_STDOUT_LIMIT_BYTES = 256 * 1024;
export const ALIBABA_CODING_PLAN_STDERR_LIMIT_BYTES = 16 * 1024;
export const ALIBABA_CODING_PLAN_KILL_GRACE_MS = 250;
export const ALIBABA_CODING_PLAN_AUTH_EXIT_CODE = 3;

const MAX_CLI_TIMEOUT_MS = 15_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);
const SHELL_LAUNCHER_NAMES = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const SHELL_LAUNCHER_EXTENSIONS = new Set([".bash", ".bat", ".cmd", ".ps1", ".sh", ".zsh"]);
const WINDOWS_SHIM_UNSAFE_PATH = /[%!^&|<>"\r\n]/u;

export type AlibabaCodingPlanErrorKind =
  | "unsupported_platform"
  | "executable_not_found"
  | "workspace_path_rejected"
  | "shell_launcher_rejected"
  | "spawn_failed"
  | "timeout"
  | "output_truncated"
  | "not_authenticated"
  | "nonzero_exit"
  | "invalid_json"
  | "invalid_schema"
  | "no_quota_data";

export interface AlibabaCodingPlanError {
  kind: AlibabaCodingPlanErrorKind;
  message: string;
  retryable?: boolean;
}

export interface AlibabaCodingPlanUsageWindow {
  used?: number;
  total?: number;
  /** Provider-reported ratio of used quota to total quota, in [0, 1]. */
  percentage?: number;
  resetTimeIso?: string;
}

export interface AlibabaCodingPlanUsage {
  instanceType?: string;
  fiveHour?: AlibabaCodingPlanUsageWindow;
  weekly?: AlibabaCodingPlanUsageWindow;
  monthly?: AlibabaCodingPlanUsageWindow;
}

export type AlibabaCodingPlanQuotaResult =
  | { state: "success"; usage: AlibabaCodingPlanUsage }
  | { state: "no-subscription" }
  | { state: "error"; error: AlibabaCodingPlanError };

export interface AlibabaCodingPlanSpawnRequest {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  stdin: "ignore";
  shell: false;
  platform: NodeJS.Platform;
  killGraceMs: number;
}

export interface AlibabaCodingPlanSpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  spawnErrorCode?: string;
}

export interface AlibabaCodingPlanRuntime {
  platform?: NodeJS.Platform;
  cwd?: string;
  pathEnv?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  tmpdir?: string;
  spawn?: (request: AlibabaCodingPlanSpawnRequest) => Promise<AlibabaCodingPlanSpawnResult>;
}

type ExecutableResolution =
  | { ok: true; file: string; kind: "native" | "windows-shim" }
  | { ok: false; error: AlibabaCodingPlanError };

const ERROR_MESSAGES: Record<AlibabaCodingPlanErrorKind, string> = {
  unsupported_platform: "Alibaba Coding Plan usage is not supported on this platform.",
  executable_not_found: 'Bailian CLI ("bl") was not found on the trusted PATH.',
  workspace_path_rejected: "Bailian CLI from the project workspace was refused.",
  shell_launcher_rejected: "Bailian CLI shell launcher could not be started safely.",
  spawn_failed: "Unable to start the Bailian CLI Coding Plan usage command.",
  timeout: "Bailian CLI Coding Plan usage timed out.",
  output_truncated: "Bailian CLI Coding Plan usage output exceeded the allowed size.",
  not_authenticated:
    'Bailian CLI is not signed in to a Console account; run "bl auth login --console".',
  nonzero_exit: "Bailian CLI Coding Plan usage command failed.",
  invalid_json: "Bailian CLI returned invalid Coding Plan usage JSON.",
  invalid_schema: "Bailian CLI returned malformed Coding Plan usage data.",
  no_quota_data: "Bailian CLI returned no usable Coding Plan quota data.",
};

function fail(kind: AlibabaCodingPlanErrorKind, retryable = false): AlibabaCodingPlanQuotaResult {
  return {
    state: "error",
    error: {
      kind,
      message: ERROR_MESSAGES[kind],
      ...(retryable ? { retryable: true } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isPathInside(parent: string, candidate: string, paths: typeof path.posix): boolean {
  const relative = paths.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

function stripPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function listTrustedPathDirectories(params: {
  pathEnv: string | undefined;
  cwd: string;
  homedir: string;
  platform: NodeJS.Platform;
}): string[] {
  const paths = pathApi(params.platform);
  const workspace = paths.resolve(params.cwd);
  const projectFolder = workspace === paths.resolve(params.homedir) ? null : workspace;
  const trusted: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of (params.pathEnv ?? "").split(paths.delimiter)) {
    const entry = stripPathQuotes(rawEntry);
    if (!entry || entry === "." || entry === ".." || !paths.isAbsolute(entry)) continue;
    const resolved = paths.resolve(entry);
    if (projectFolder !== null && isPathInside(projectFolder, resolved, paths)) continue;
    const deduplicationKey = params.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(deduplicationKey)) continue;
    seen.add(deduplicationKey);
    trusted.push(resolved);
  }
  return trusted;
}

function isShellLauncherPath(file: string, platform: NodeJS.Platform): boolean {
  const paths = pathApi(platform);
  const extension = paths.extname(file).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) return false;
  if (SHELL_LAUNCHER_EXTENSIONS.has(extension)) return true;
  return SHELL_LAUNCHER_NAMES.has(paths.basename(file).toLowerCase());
}

async function fileLooksLikeFile(file: string): Promise<boolean> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) {
      const target = await realpath(file);
      return (await lstat(target)).isFile();
    }
    return stats.isFile();
  } catch {
    return false;
  }
}

function candidateNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? ["bl.exe", "bl.com", "bl.cmd", "bl.bat"] : ["bl"];
}

async function resolveExecutable(params: {
  pathEnv: string | undefined;
  cwd: string;
  homedir: string;
  platform: NodeJS.Platform;
}): Promise<ExecutableResolution> {
  const { platform } = params;
  if (!isSupportedPlatform(platform)) {
    return {
      ok: false,
      error: { kind: "unsupported_platform", message: ERROR_MESSAGES.unsupported_platform },
    };
  }

  const paths = pathApi(platform);
  const projectFolder =
    paths.resolve(params.cwd) === paths.resolve(params.homedir) ? null : paths.resolve(params.cwd);
  const trustedDirectories = listTrustedPathDirectories(params);
  let sawUnsafeShellLauncher = false;

  for (const directory of trustedDirectories) {
    for (const name of candidateNames(platform)) {
      const candidate = paths.join(directory, name);
      if (!(await fileLooksLikeFile(candidate))) continue;

      let resolved = candidate;
      try {
        resolved = await realpath(candidate);
      } catch {
        // The checked absolute candidate remains usable if realpath is unavailable.
      }
      const extension = paths.extname(candidate).toLowerCase();
      const windowsShim = platform === "win32" && (extension === ".cmd" || extension === ".bat");
      if (isShellLauncherPath(resolved, platform) && !windowsShim) {
        sawUnsafeShellLauncher = true;
        continue;
      }
      if (projectFolder !== null && isPathInside(projectFolder, resolved, paths)) {
        return {
          ok: false,
          error: {
            kind: "workspace_path_rejected",
            message: ERROR_MESSAGES.workspace_path_rejected,
          },
        };
      }
      return { ok: true, file: resolved, kind: windowsShim ? "windows-shim" : "native" };
    }
  }

  const kind = sawUnsafeShellLauncher ? "shell_launcher_rejected" : "executable_not_found";
  return { ok: false, error: { kind, message: ERROR_MESSAGES[kind] } };
}

/** Build the only allowed Windows shim command; the executable path is quoted and args are fixed. */
export function buildAlibabaCodingPlanWindowsShimInvocation(
  file: string,
  systemRoot: string | undefined,
): { file: string; args: readonly string[] } | null {
  if (
    !path.win32.isAbsolute(file) ||
    !systemRoot ||
    !path.win32.isAbsolute(systemRoot) ||
    WINDOWS_SHIM_UNSAFE_PATH.test(file) ||
    WINDOWS_SHIM_UNSAFE_PATH.test(systemRoot)
  ) {
    return null;
  }

  return {
    file: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", `""${file}" usage coding-plan --output json"`],
  };
}

function resolveNonWorkspaceCwd(params: {
  cwd: string;
  tmpdir: string;
  homedir: string;
  platform: NodeJS.Platform;
}): string {
  const paths = pathApi(params.platform);
  const workspace = paths.resolve(params.cwd);
  for (const candidate of [
    params.tmpdir,
    params.homedir,
    params.platform === "win32" ? "C:\\" : "/",
  ]) {
    const resolved = paths.resolve(candidate);
    if (!isPathInside(workspace, resolved, paths)) return resolved;
  }
  return params.platform === "win32" ? "C:\\" : "/";
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
): { valid: true; value?: number } | { valid: false } {
  if (!Object.hasOwn(record, key)) return { valid: true };
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? { valid: true, value }
    : { valid: false };
}

function parseWindow(value: unknown): AlibabaCodingPlanUsageWindow | "invalid" {
  const record = asRecord(value);
  if (!record) return "invalid";

  const used = readOptionalNumber(record, "usedQuota");
  const total = readOptionalNumber(record, "totalQuota");
  const percentage = readOptionalNumber(record, "percentage");
  const resetTime = readOptionalNumber(record, "resetTime");
  if (!used.valid || !total.valid || !percentage.valid || !resetTime.valid) return "invalid";
  if (
    (used.value !== undefined && used.value < 0) ||
    (total.value !== undefined && total.value < 0) ||
    (percentage.value !== undefined && (percentage.value < 0 || percentage.value > 1)) ||
    (resetTime.value !== undefined &&
      (resetTime.value < 0 ||
        resetTime.value > MAX_DATE_MS ||
        !Number.isFinite(new Date(resetTime.value).valueOf())))
  ) {
    return "invalid";
  }

  return {
    ...(used.value !== undefined ? { used: used.value } : {}),
    ...(total.value !== undefined ? { total: total.value } : {}),
    ...(percentage.value !== undefined
      ? { percentage: percentage.value }
      : used.value !== undefined && total.value !== undefined && total.value > 0
        ? { percentage: used.value / total.value }
        : {}),
    ...(resetTime.value !== undefined
      ? { resetTimeIso: new Date(resetTime.value).toISOString() }
      : {}),
  };
}

/** Parse the flat JSON emitted by `bl usage coding-plan --output json`. */
export function parseAlibabaCodingPlanUsageJson(text: string): AlibabaCodingPlanQuotaResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }

  const record = asRecord(payload);
  if (!record) return fail("invalid_schema");
  if (Object.keys(record).length === 0) return { state: "no-subscription" };

  const instanceType = record.instanceType;
  if (instanceType !== undefined && (typeof instanceType !== "string" || !instanceType.trim())) {
    return fail("invalid_schema");
  }

  const windows = [
    ["per5Hour", "fiveHour"],
    ["perWeek", "weekly"],
    ["perBillMonth", "monthly"],
  ] as const;
  const usage: AlibabaCodingPlanUsage = {
    ...(typeof instanceType === "string" ? { instanceType: instanceType.trim() } : {}),
  };
  for (const [sourceKey, targetKey] of windows) {
    if (!Object.hasOwn(record, sourceKey)) continue;
    const window = parseWindow(record[sourceKey]);
    if (window === "invalid") return fail("invalid_schema");
    usage[targetKey] = window;
  }

  if (windows.every(([key]) => !Object.hasOwn(record, key))) return fail("invalid_schema");
  return { state: "success", usage };
}

function takeBoundedChunk(
  chunks: Buffer[],
  currentSize: number,
  chunk: Buffer,
  limit: number,
): { size: number; overflowed: boolean } {
  const remaining = limit - currentSize;
  if (remaining <= 0) return { size: currentSize, overflowed: true };
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { size: currentSize + chunk.length, overflowed: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { size: limit, overflowed: true };
}

function signalChild(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  }
}

function signalWindowsProcessTree(pid: number | undefined, onFailure: () => void): boolean {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!pid || !systemRoot || !path.win32.isAbsolute(systemRoot)) return false;

  let treeKiller: ChildProcess;
  try {
    treeKiller = nodeSpawn(
      path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
  } catch {
    return false;
  }

  let completed = false;
  const fail = () => {
    if (completed) return;
    completed = true;
    onFailure();
  };
  treeKiller.once("error", fail);
  treeKiller.once("close", (code) => {
    if (code === 0) completed = true;
    else fail();
  });
  treeKiller.unref();
  return true;
}

export async function runAlibabaCodingPlanProcess(
  request: AlibabaCodingPlanSpawnRequest,
): Promise<AlibabaCodingPlanSpawnResult> {
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        argv0: request.file,
        shell: false,
        windowsHide: true,
        detached: request.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const spawnErrorCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let truncated = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let escalationStarted = false;

    function clearTimers(): void {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      timeout = undefined;
      killTimer = undefined;
    }

    function escalate(): void {
      if (settled || escalationStarted) return;
      escalationStarted = true;
      const signalTerm = () => {
        if (!settled) signalChild(child, request.platform, "SIGTERM");
      };
      if (request.platform === "win32") {
        if (!signalWindowsProcessTree(child.pid, signalTerm)) signalTerm();
      } else {
        signalTerm();
      }
      if (killTimer !== undefined) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTimer = undefined;
        signalChild(child, request.platform, "SIGKILL");
        finish(null, undefined, true);
      }, request.killGraceMs);
    }

    function finish(code: number | null, spawnErrorCode?: string, destroyStreams = false): void {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (destroyStreams) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        truncated,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    }

    function onStdoutData(chunk: Buffer | string): void {
      const next = takeBoundedChunk(
        stdoutChunks,
        stdoutSize,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        request.stdoutLimitBytes,
      );
      stdoutSize = next.size;
      if (next.overflowed && !truncated) {
        truncated = true;
        escalate();
      }
    }

    function onStderrData(chunk: Buffer | string): void {
      const next = takeBoundedChunk(
        stderrChunks,
        stderrSize,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        request.stderrLimitBytes,
      );
      stderrSize = next.size;
      if (next.overflowed && !truncated) {
        truncated = true;
        escalate();
      }
    }

    function errorCode(error: unknown): string | undefined {
      return error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    }

    function onError(error: Error): void {
      finish(null, errorCode(error));
    }

    function onClose(code: number | null): void {
      finish(code);
    }

    timeout = setTimeout(() => {
      timedOut = true;
      escalate();
    }, request.timeoutMs);
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

function resultFromSpawn(result: AlibabaCodingPlanSpawnResult): AlibabaCodingPlanQuotaResult {
  if (result.truncated) return fail("output_truncated");
  if (result.timedOut) return fail("timeout", true);
  if (result.spawnErrorCode === "ENOENT") return fail("executable_not_found");
  if (result.spawnErrorCode) return fail("spawn_failed", true);
  if (result.code === ALIBABA_CODING_PLAN_AUTH_EXIT_CODE) return fail("not_authenticated");
  if (result.code !== 0) return fail("nonzero_exit", result.code === null);
  return parseAlibabaCodingPlanUsageJson(result.stdout.toString("utf8"));
}

function safeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return REQUEST_TIMEOUT_MS;
  }
  return Math.min(MAX_CLI_TIMEOUT_MS, Math.max(1, Math.trunc(value)));
}

export async function queryAlibabaCodingPlanQuota(
  options: { requestTimeoutMs?: number; runtime?: AlibabaCodingPlanRuntime } = {},
): Promise<AlibabaCodingPlanQuotaResult> {
  const runtime = options.runtime ?? {};
  const platform = runtime.platform ?? process.platform;
  if (!isSupportedPlatform(platform)) return fail("unsupported_platform");

  const paths = pathApi(platform);
  const cwd = paths.resolve(runtime.cwd ?? process.cwd());
  const home = runtime.homedir ?? homedir();
  const pathEnv = runtime.pathEnv ?? runtime.env?.PATH ?? process.env.PATH;
  const resolved = await resolveExecutable({ pathEnv, cwd, homedir: home, platform });
  if (!resolved.ok) return { state: "error", error: resolved.error };

  const trustedDirectories = listTrustedPathDirectories({
    pathEnv,
    cwd,
    homedir: home,
    platform,
  });
  const processCwd = resolveNonWorkspaceCwd({
    cwd,
    tmpdir: runtime.tmpdir ?? tmpdir(),
    homedir: home,
    platform,
  });
  const env: NodeJS.ProcessEnv = {
    ...(runtime.env ?? process.env),
    PATH: trustedDirectories.join(paths.delimiter),
  };

  let file = resolved.file;
  let args: readonly string[] = ALIBABA_CODING_PLAN_ARGS;
  if (resolved.kind === "windows-shim") {
    const invocation = buildAlibabaCodingPlanWindowsShimInvocation(
      file,
      env.SystemRoot ?? env.WINDIR,
    );
    if (!invocation) return fail("shell_launcher_rejected");
    file = invocation.file;
    args = invocation.args;
  }

  const request: AlibabaCodingPlanSpawnRequest = {
    file,
    args,
    cwd: processCwd,
    env,
    timeoutMs: safeTimeout(options.requestTimeoutMs),
    stdoutLimitBytes: ALIBABA_CODING_PLAN_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: ALIBABA_CODING_PLAN_STDERR_LIMIT_BYTES,
    stdin: "ignore",
    shell: false,
    platform,
    killGraceMs: ALIBABA_CODING_PLAN_KILL_GRACE_MS,
  };

  try {
    const result = await (runtime.spawn ?? runAlibabaCodingPlanProcess)(request);
    return resultFromSpawn(result);
  } catch {
    return fail("spawn_failed", true);
  }
}
