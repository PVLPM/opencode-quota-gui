/**
 * One-line scrubbed logging for the GUI host (design spec §9, R51).
 *
 * A log line is `[opencode-quota-gui] <level>: <event>[: <reason>]`. The reason
 * is always passed through credential scrubbing and absolute-path redaction so
 * a caller can never leak tokens, internal ids, or filesystem paths by accident.
 * Raw exception messages are never the reason: callers pass controlled codes.
 */

import { scrubCredentialErrorText } from "../lib/opencode-auth.js";

export type GuiLogLevel = "info" | "warn" | "error";

export interface GuiLogger {
  info(event: string, reason?: string): void;
  warn(event: string, reason?: string): void;
  error(event: string, reason?: string): void;
}

export interface GuiLoggerOptions {
  /** Test seam: captures the emitted line instead of the default sink. */
  sink?: (line: string) => void;
}

export const GUI_LOG_PREFIX = "[opencode-quota-gui]";

const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"']*/g;
const UNC_PATH_RE = /\\\\[^\s"']+/g;
const POSIX_PATH_RE = /(^|[\s(])\/(?:[^\s/]+\/)+[^\s"')]*/g;

/** Absolute paths never belong in a log line (spec §9): rewrite them. */
function redactAbsolutePaths(text: string): string {
  return text
    .replace(WINDOWS_PATH_RE, "[path]")
    .replace(UNC_PATH_RE, "[path]")
    .replace(POSIX_PATH_RE, "$1[path]");
}

/** Credential-scrubbed, path-redacted, one-line reason text (defense in depth). */
export function scrubLogReason(reason: string): string {
  return redactAbsolutePaths(scrubCredentialErrorText(reason)).slice(0, 160);
}

export function createGuiLogger(options: GuiLoggerOptions = {}): GuiLogger {
  const sink = options.sink ?? ((line: string) => console.warn(line));

  function emit(level: GuiLogLevel, event: string, reason?: string): void {
    const detail = reason === undefined ? "" : `: ${scrubLogReason(reason)}`;
    sink(`${GUI_LOG_PREFIX} ${level}: ${event}${detail}`);
  }

  return {
    info: (event, reason) => emit("info", event, reason),
    warn: (event, reason) => emit("warn", event, reason),
    error: (event, reason) => emit("error", event, reason),
  };
}
