/**
 * Local dashboard HTTP host (design spec §4.3, §5.3, §9; R8).
 *
 * Loopback-only (`127.0.0.1`), Host/Origin/Sec-Fetch-Site hardening, no CORS,
 * JSON writes behind a streamed 64 KiB cap, static assets contained to
 * `dist/ui` under the packaged extension allowlist, SSE on `/api/v1/events`,
 * and one scrubbed log line per failure. `createDashboardServer` is the
 * injectable seam: tests pass in-memory sources/stores and `port: 0`, while the
 * production lifecycle factory wires the P3 source and P2 settings store and
 * the default `4144` port.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_IDENTITY } from "../contracts/build-identity.js";

import {
  DASHBOARD_CONTRACT_VERSION,
  type DashboardHealth,
  type GuiSettingsStore,
  type JsonValue,
} from "../contracts/dashboard.js";
import { DEFAULT_RANGE_KEY, isRangeKey, type RangeKey } from "../contracts/ranges.js";
import { GuiSettingsError } from "./config.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import { createSnapshotService, type SnapshotSource } from "./snapshot-service.js";
import { createSseHub } from "./sse.js";

export interface DashboardServerOptions {
  /** `0` binds an ephemeral port (tests); production passes the configured port. */
  port: number;
  source: SnapshotSource;
  settings: GuiSettingsStore;
  /** Static root; defaults to `<package>/dist/ui` derived from this module. */
  assetRoot?: string;
  /**
   * Existing quota poll interval (positive config value, no new floor) or a
   * getter re-read on settings changes. Analytics has its own interval below.
   */
  minIntervalMs?: number | (() => number);
  /** Explicit quota interval; wins over `minIntervalMs`. */
  quotaIntervalMs?: number | (() => number);
  /** Analytics poll interval; defaults to 600000ms. */
  analyticsIntervalMs?: number | (() => number);
  /** SSE heartbeat override (test seam; default 20 s). */
  heartbeatMs?: number;
  logger?: GuiLogger;
  /**
   * Lifecycle-owned restart coordinator. Absent for a transport that is not
   * part of a managed host, in which case the restart route answers 503.
   */
  restart?: DashboardRestartController;
  /** Generation token advertised by a replacement listener. */
  restartId?: string;
}

export interface DashboardServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** One acknowledged restart's reserved generation. */
export interface DashboardRestartTicket {
  readonly restartId: string;
  /** Runs only after the 202 response finished; the coordinator owns failures. */
  run(): Promise<void> | void;
  /** Releases the reservation if the response never finished. */
  cancel(): void;
}

export type DashboardRestartBegin =
  | { readonly ok: true; readonly ticket: DashboardRestartTicket }
  | {
      readonly ok: false;
      readonly code: "restart-in-progress" | "restart-unavailable";
    };

/**
 * The lifecycle host's restart seam. `begin` is synchronous so a reservation
 * exists before the acknowledgement is serialized; duplicate requests while a
 * restart is in flight are rejected instead of starting a second replacement.
 */
export interface DashboardRestartController {
  begin(): DashboardRestartBegin;
}

export type DashboardErrorCode =
  | "bad-request"
  | "bad-host"
  | "bad-origin"
  | "unsupported-media-type"
  | "body-too-large"
  | "method-not-allowed"
  | "not-found"
  | "config-read-error"
  | "config-changed"
  | "config-target-error"
  | "config-write-error"
  | "unknown-setting"
  | "invalid-setting"
  | "project-not-found"
  | "session-not-found"
  | "restart-in-progress"
  | "restart-unavailable"
  | "internal";

export interface DashboardErrorDetails {
  reason?: string;
  key?: string;
}

/** Status mapping from spec §5.3. */
export const DASHBOARD_ERROR_STATUS: Readonly<Record<DashboardErrorCode, number>> = {
  "bad-request": 400,
  "bad-host": 403,
  "bad-origin": 403,
  "unsupported-media-type": 415,
  "body-too-large": 413,
  "method-not-allowed": 405,
  "not-found": 404,
  "config-read-error": 409,
  "config-changed": 409,
  "config-target-error": 409,
  "config-write-error": 500,
  "unknown-setting": 422,
  "invalid-setting": 422,
  "project-not-found": 404,
  "session-not-found": 404,
  "restart-in-progress": 409,
  "restart-unavailable": 503,
  internal: 500,
};

const DASHBOARD_ERROR_MESSAGES: Readonly<Record<DashboardErrorCode, string>> = {
  "bad-request": "Malformed request",
  "bad-host": "Requests must target the dashboard loopback address",
  "bad-origin": "Writes must originate from the dashboard page",
  "unsupported-media-type": "Writes require application/json",
  "body-too-large": "Request body exceeds the 64 KiB limit",
  "method-not-allowed": "Method not allowed",
  "not-found": "Not found",
  "config-read-error": "The dashboard config file is not valid JSONC",
  "config-changed": "Config changed since the last revision",
  "config-target-error": "The dashboard config path is not writable",
  "config-write-error": "Config write failed",
  "unknown-setting": "Unknown setting",
  "invalid-setting": "Invalid setting",
  "project-not-found": "Project not found",
  "session-not-found": "Session not found",
  "restart-in-progress": "A dashboard restart is already in progress",
  "restart-unavailable": "Dashboard restart is not available",
  internal: "Internal dashboard error",
};

/** A controlled condition the source or a store wants surfaced verbatim-ish. */
export class DashboardHttpError extends Error {
  readonly code: DashboardErrorCode;

  constructor(code: DashboardErrorCode) {
    super(DASHBOARD_ERROR_MESSAGES[code]);
    this.name = "DashboardHttpError";
    this.code = code;
  }
}

/** Structured bind failure: terminal, no alternate port is ever attempted. */
export class DashboardBindError extends Error {
  readonly code = "unavailable";
  readonly port: number;
  readonly reason: string | undefined;

  constructor(port: number, reason?: string) {
    super(`Dashboard server unavailable on 127.0.0.1:${port}${reason ? ` (${reason})` : ""}`);
    this.name = "DashboardBindError";
    this.port = port;
    this.reason = reason;
  }
}

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const BODY_LIMIT_BYTES = 64 * 1024;

const ASSET_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

const SOURCE_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad-request",
  "project-not-found",
  "session-not-found",
]);

/** The set above is the vocabulary; trust it as the membership proof. */
function isSourceErrorCode(value: string): value is DashboardErrorCode {
  return SOURCE_ERROR_CODES.has(value);
}

const TARGET_REASONS: ReadonlySet<string> = new Set([
  "dangling",
  "loop",
  "depth",
  "non-regular",
  "permission",
]);

const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

const MAX_RESOURCE_ID_LENGTH = 256;

interface MappedError {
  status: number;
  code: DashboardErrorCode;
  body: {
    error: { code: DashboardErrorCode; message: string; details?: DashboardErrorDetails };
  };
}

function envelope(code: DashboardErrorCode, details?: DashboardErrorDetails): MappedError {
  const error: MappedError["body"]["error"] = {
    code,
    message: DASHBOARD_ERROR_MESSAGES[code],
  };
  if (details) error.details = details;
  return {
    status: DASHBOARD_ERROR_STATUS[code],
    code,
    body: { error },
  };
}

function sanitizedDetails(
  code: DashboardErrorCode,
  input:
    | {
        reason?: string;
        key?: string;
      }
    | undefined,
): DashboardErrorDetails | undefined {
  if (!input) return undefined;
  const details: DashboardErrorDetails = {};
  // `details.reason` is forwarded for `config-target-error` only, and only from
  // the allowlisted target-reason vocabulary; other codes never carry it.
  if (
    code === "config-target-error" &&
    input.reason !== undefined &&
    TARGET_REASONS.has(input.reason)
  ) {
    details.reason = input.reason;
  }
  if (input.key !== undefined && input.key.length <= 64 && SETTING_KEY_RE.test(input.key)) {
    details.key = input.key;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function structuralSourceCode(error: unknown): DashboardErrorCode | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "string" || !isSourceErrorCode(code)) return undefined;
  return code;
}

/**
 * Raw exceptions never reach the wire: known controlled errors keep their code,
 * everything else is a generic 500. GuiSettingsError messages are not
 * serialized (the controlled message per code is).
 */
function mapError(error: unknown): MappedError {
  if (error instanceof GuiSettingsError) {
    return envelope(error.code, sanitizedDetails(error.code, error.details));
  }
  if (error instanceof DashboardHttpError) {
    return envelope(error.code, undefined);
  }
  const sourceCode = structuralSourceCode(error);
  if (sourceCode) return envelope(sourceCode, undefined);
  return envelope("internal", undefined);
}

/** Failures worth one scrubbed log line; client validation noise is not. */
function shouldLog(code: DashboardErrorCode): boolean {
  return (
    code.startsWith("config-") ||
    code === "project-not-found" ||
    code === "session-not-found" ||
    code === "internal"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (Number.isFinite(value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isValidResourceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RESOURCE_ID_LENGTH && !hasControlCharacters(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function sendError(res: ServerResponse, code: DashboardErrorCode): void {
  const mapped = envelope(code);
  sendJson(res, mapped.status, mapped.body);
}

/**
 * Sends the restart acknowledgement first, then schedules the reserved
 * replacement from the response `finish` event. A client that disappears before
 * the response finishes releases the reservation so a later request can retry.
 */
function sendRestartAccepted(res: ServerResponse, ticket: DashboardRestartTicket): void {
  let settled = false;
  res.once("finish", () => {
    if (settled) return;
    settled = true;
    // The coordinator contains and logs every restart failure; never leave an
    // unhandled rejection behind the already-sent 202.
    void Promise.resolve(ticket.run()).catch(() => undefined);
  });
  res.once("close", () => {
    if (settled || res.writableFinished) return;
    settled = true;
    ticket.cancel();
  });
  sendJson(res, 202, { restartId: ticket.restartId });
}

function applyCommonHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Cache-Control", "no-store");
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return (
    origin === undefined ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface BodyOutcome {
  ok: boolean;
  tooLarge: boolean;
  body: string;
}

/** Streams the body with the 64 KiB cap; never buffers more than the cap. */
function readRawBody(req: IncomingMessage): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const settle = (outcome: BodyOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge || size > BODY_LIMIT_BYTES) {
        settle({ ok: false, tooLarge: true, body: "" });
        return;
      }
      settle({ ok: true, tooLarge: false, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => settle({ ok: false, tooLarge: false, body: "" }));
    req.on("aborted", () => settle({ ok: false, tooLarge: false, body: "" }));
  });
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decodeSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const part of pathname.split("/")) {
    if (part === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (hasControlCharacters(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments;
}

/** Percent-decoded exactly once; traversal-shaped input is rejected. */
function decodeAssetRelative(rawPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (
    decoded.length === 0 ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.includes("..") ||
    decoded.startsWith("/") ||
    /^[A-Za-z]:/.test(decoded) ||
    hasControlCharacters(decoded)
  ) {
    return undefined;
  }
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
  }
  return decoded;
}

function parseRange(url: URL): RangeKey | undefined {
  const raw = url.searchParams.get("range");
  if (raw === null) return DEFAULT_RANGE_KEY;
  return isRangeKey(raw) ? raw : undefined;
}

/** Known UI paths only: never reinterpret an asset or malformed id as HTML. */
function isUiPath(pathname: string): boolean {
  if (["/", "/quota", "/analytics", "/settings"].includes(pathname)) return true;
  const match = /^\/(?:project|session)\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  let id: string;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch {
    return false;
  }
  return (
    isValidResourceId(id) &&
    !id.includes("\\") &&
    !id.split("/").some((part) => part === "." || part === "..") &&
    !/\.(?:html|css|js|map|svg|woff2?|ttf)\/*$/i.test(id)
  );
}

function isErrnoCode(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string";
}

const DEFAULT_ASSET_ROOT = fileURLToPath(new URL("../../dist/ui/", import.meta.url));

export function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const logger = options.logger ?? createGuiLogger();
  const snapshots = createSnapshotService({
    source: options.source,
    minIntervalMs: options.minIntervalMs,
    quotaIntervalMs: options.quotaIntervalMs,
    analyticsIntervalMs: options.analyticsIntervalMs,
    logger,
  });

  let releaseViewer: (() => void) | undefined;
  const sse = createSseHub({
    heartbeatMs: options.heartbeatMs,
    logger,
    onClientCountChange: (count) => {
      if (count > 0 && !releaseViewer) {
        releaseViewer = snapshots.addViewer();
      } else if (count === 0 && releaseViewer) {
        releaseViewer();
        releaseViewer = undefined;
      }
    },
  });
  const unsubscribe = snapshots.subscribe((event) => sse.broadcast(event));

  const assetRootPath = resolve(options.assetRoot ?? DEFAULT_ASSET_ROOT);
  let assetRootReal: string | undefined;

  async function resolveAssetRoot(): Promise<string | null> {
    if (assetRootReal !== undefined) return assetRootReal;
    let resolved: string;
    try {
      resolved = await realpath(assetRootPath);
    } catch {
      // Cache only a successful lookup: `dist/ui` may be built while the
      // dashboard is already running, so a missing root must be retried.
      return null;
    }
    assetRootReal = resolved;
    return resolved;
  }

  async function serveAsset(
    res: ServerResponse,
    rawRelativePath: string,
    headOnly: boolean,
  ): Promise<void> {
    const decoded = decodeAssetRelative(rawRelativePath);
    if (decoded === undefined) {
      sendError(res, "not-found");
      return;
    }

    const root = await resolveAssetRoot();
    if (root === null) {
      sendError(res, "not-found");
      return;
    }

    const target = resolve(root, decoded);
    const containedRelative = relative(root, target);
    if (containedRelative.startsWith("..") || isAbsolute(containedRelative)) {
      sendError(res, "not-found");
      return;
    }

    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch {
      sendError(res, "not-found");
      return;
    }

    const realRelative = relative(root, realTarget);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      sendError(res, "not-found");
      return;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(realTarget);
    } catch {
      sendError(res, "not-found");
      return;
    }
    if (!info.isFile()) {
      sendError(res, "not-found");
      return;
    }

    const contentType = ASSET_CONTENT_TYPES.get(extname(realTarget).toLowerCase());
    if (!contentType) {
      sendError(res, "not-found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", info.size);
    if (headOnly) {
      res.end();
      return;
    }
    try {
      res.end(await readFile(realTarget));
    } catch {
      sendError(res, "not-found");
    }
  }

  function requireMethods(
    req: IncomingMessage,
    res: ServerResponse,
    methods: readonly string[],
  ): boolean {
    if (methods.includes(req.method ?? "")) return true;
    res.setHeader("Allow", methods.join(", "));
    sendError(res, "method-not-allowed");
    return false;
  }

  function writeGuards(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isAllowedOrigin(headerValue(req.headers.origin), actualPort)) {
      sendError(res, "bad-origin");
      return false;
    }
    const site = headerValue(req.headers["sec-fetch-site"]);
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      sendError(res, "bad-origin");
      return false;
    }
    const contentType = headerValue(req.headers["content-type"]);
    if (
      contentType === undefined ||
      contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
    ) {
      sendError(res, "unsupported-media-type");
      return false;
    }
    return true;
  }

  async function readWriteJson(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    if (!writeGuards(req, res)) return { ok: false };
    const raw = await readRawBody(req);
    if (!raw.ok) {
      sendError(res, raw.tooLarge ? "body-too-large" : "bad-request");
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(raw.body) };
    } catch {
      sendError(res, "bad-request");
      return { ok: false };
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const segments = decodeSegments(url.pathname);
    if (!segments || segments[0] !== "api" || segments[1] !== "v1") {
      sendError(res, "not-found");
      return;
    }
    const rest = segments.slice(2);
    const method = req.method ?? "GET";

    if (rest.length === 1 && rest[0] === "health") {
      if (!requireMethods(req, res, ["GET", "HEAD"])) return;
      const health: DashboardHealth = {
        app: "opencode-quota-gui",
        version: BUILD_IDENTITY.version,
        build: BUILD_IDENTITY.build,
        contractVersion: DASHBOARD_CONTRACT_VERSION,
        ...(options.restartId === undefined ? {} : { restartId: options.restartId }),
      };
      sendJson(res, 200, health);
      return;
    }

    if (rest.length === 2 && rest[0] === "dashboard" && rest[1] === "restart") {
      if (!requireMethods(req, res, ["POST"])) return;
      const parsed = await readWriteJson(req, res);
      if (!parsed.ok) return;
      if (!isRecord(parsed.value) || !hasExactKeys(parsed.value, [])) {
        sendError(res, "bad-request");
        return;
      }
      const restart = options.restart;
      if (!restart) {
        sendError(res, "restart-unavailable");
        return;
      }
      const begun = restart.begin();
      if (!begun.ok) {
        sendError(res, begun.code);
        return;
      }
      sendRestartAccepted(res, begun.ticket);
      return;
    }

    if (rest.length === 1 && rest[0] === "quota") {
      if (!requireMethods(req, res, ["GET", "HEAD"])) return;
      // Inference only; an explicit PUT /api/v1/view signal wins.
      snapshots.setViewScope("quota", "request");
      sendJson(res, 200, await snapshots.quota());
      return;
    }

    if (rest.length === 1 && rest[0] === "home") {
      if (!requireMethods(req, res, ["GET", "HEAD"])) return;
      const range = parseRange(url);
      if (range === undefined) {
        sendError(res, "bad-request");
        return;
      }
      snapshots.setViewScope("analytics", "request");
      sendJson(res, 200, await snapshots.home({ range }));
      return;
    }

    if (rest.length === 2 && rest[0] === "projects") {
      if (!requireMethods(req, res, ["GET", "HEAD"])) return;
      const projectId = rest[1] ?? "";
      if (!isValidResourceId(projectId)) {
        sendError(res, "bad-request");
        return;
      }
      const range = parseRange(url);
      if (range === undefined) {
        sendError(res, "bad-request");
        return;
      }
      snapshots.setViewScope("analytics", "request");
      sendJson(res, 200, await snapshots.project({ projectId, range }));
      return;
    }

    if (rest.length === 2 && rest[0] === "sessions") {
      if (!requireMethods(req, res, ["GET", "HEAD"])) return;
      const sessionId = rest[1] ?? "";
      if (!isValidResourceId(sessionId)) {
        sendError(res, "bad-request");
        return;
      }
      snapshots.setViewScope("analytics", "request");
      sendJson(res, 200, await snapshots.session({ sessionId }));
      return;
    }

    if (rest.length === 1 && rest[0] === "settings") {
      if (!requireMethods(req, res, ["GET", "HEAD", "PUT"])) return;
      if (method === "PUT") {
        const parsed = await readWriteJson(req, res);
        if (!parsed.ok) return;
        const body = parsed.value;
        if (
          !isRecord(body) ||
          !hasExactKeys(body, ["patch", "expectedRevision"]) ||
          !isRecord(body.patch) ||
          typeof body.expectedRevision !== "string"
        ) {
          sendError(res, "bad-request");
          return;
        }
        const patch: Record<string, JsonValue> = {};
        for (const [key, value] of Object.entries(body.patch)) {
          if (!isJsonValue(value)) {
            sendError(res, "bad-request");
            return;
          }
          patch[key] = value;
        }
        const result = await options.settings.saveSettings({
          patch,
          expectedRevision: body.expectedRevision,
        });
        snapshots.notifySettingsChanged();
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 200, await options.settings.settings());
      return;
    }

    if (rest.length === 2 && rest[0] === "settings" && rest[1] === "import") {
      if (!requireMethods(req, res, ["GET", "HEAD", "POST"])) return;
      if (method === "POST") {
        const parsed = await readWriteJson(req, res);
        if (!parsed.ok) return;
        const body = parsed.value;
        if (
          !isRecord(body) ||
          !hasExactKeys(body, ["expectedRevision"]) ||
          typeof body.expectedRevision !== "string"
        ) {
          sendError(res, "bad-request");
          return;
        }
        const result = await options.settings.importApply({
          expectedRevision: body.expectedRevision,
        });
        snapshots.notifySettingsChanged();
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 200, await options.settings.importPreview());
      return;
    }

    if (rest.length === 2 && rest[0] === "settings" && rest[1] === "open") {
      if (!requireMethods(req, res, ["POST"])) return;
      const parsed = await readWriteJson(req, res);
      if (!parsed.ok) return;
      if (!isRecord(parsed.value) || !hasExactKeys(parsed.value, [])) {
        sendError(res, "bad-request");
        return;
      }
      const open = options.settings.openSettingsFile;
      if (!open) {
        throw new GuiSettingsError(
          "config-target-error",
          "Opening the settings file is not available",
        );
      }
      await open();
      sendJson(res, 200, { opened: true });
      return;
    }

    if (rest.length === 1 && rest[0] === "view") {
      if (!requireMethods(req, res, ["PUT"])) return;
      const parsed = await readWriteJson(req, res);
      if (!parsed.ok) return;
      const body = parsed.value;
      if (
        !isRecord(body) ||
        !hasExactKeys(body, ["scope"]) ||
        (body.scope !== "quota" && body.scope !== "analytics")
      ) {
        sendError(res, "bad-request");
        return;
      }
      // The UI's active-surface signal; it stops analytics refresh while the
      // quota view is open and resumes it on the analytics view.
      snapshots.setViewScope(body.scope);
      sendJson(res, 200, { scope: body.scope });
      return;
    }

    if (rest.length === 1 && rest[0] === "visibility") {
      if (!requireMethods(req, res, ["PUT"])) return;
      const parsed = await readWriteJson(req, res);
      if (!parsed.ok) return;
      const body = parsed.value;
      if (
        !isRecord(body) ||
        !hasExactKeys(body, ["hiddenCards", "hiddenRows", "expectedRevision"]) ||
        !isStringArray(body.hiddenCards) ||
        !isStringArray(body.hiddenRows) ||
        typeof body.expectedRevision !== "string"
      ) {
        sendError(res, "bad-request");
        return;
      }
      const result = await options.settings.saveVisibility({
        hiddenCards: body.hiddenCards,
        hiddenRows: body.hiddenRows,
        expectedRevision: body.expectedRevision,
      });
      snapshots.notifySettingsChanged({ scope: "visibility" });
      sendJson(res, 200, result);
      return;
    }

    if (rest.length === 1 && rest[0] === "events") {
      if (!requireMethods(req, res, ["GET"])) return;
      sse.attach(res);
      return;
    }

    sendError(res, "not-found");
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCommonHeaders(res);
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        sendError(res, "bad-request");
        return;
      }

      if (!isAllowedHost(headerValue(req.headers.host), actualPort)) {
        sendError(res, "bad-host");
        return;
      }

      const pathname = url.pathname;
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (pathname.startsWith("/assets/")) {
        if (!requireMethods(req, res, ["GET", "HEAD"])) return;
        // Serve relative to the static root so `/assets/x.js` maps to
        // `<assetRoot>/assets/x.js` — the real `dist/ui` layout.
        await serveAsset(res, pathname.slice(1), req.method === "HEAD");
        return;
      }
      // Check the raw request path too: WHATWG URL parsing normalizes dot
      // segments and backslashes, which must not turn traversal into a UI route.
      const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
      if (rawPath === pathname && isUiPath(pathname)) {
        if (!requireMethods(req, res, ["GET", "HEAD"])) return;
        await serveAsset(res, "index.html", req.method === "HEAD");
        return;
      }
      sendError(res, "not-found");
    } catch (error: unknown) {
      const mapped = mapError(error);
      if (shouldLog(mapped.code)) {
        logger.warn("dashboard request failed", `${mapped.status} ${mapped.code}`);
      }
      sendJson(res, mapped.status, mapped.body);
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  let actualPort = options.port;
  let closing: Promise<void> | undefined;
  let released: Promise<void> | undefined;

  /**
   * Stops snapshot work and closes the optional source. Used by both the final
   * server close and a terminal bind failure, so a worker/DB resource created
   * by the source is never leaked. Idempotent and never rejects.
   */
  function releaseResources(): Promise<void> {
    if (released) return released;
    try {
      snapshots.close();
      unsubscribe();
      sse.close();
    } catch (error: unknown) {
      logger.warn("dashboard release failed", isErrnoCode(error) ? error.code : "failed");
    }
    const closeSource = options.source.close;
    released = closeSource
      ? Promise.resolve()
          .then(() => closeSource())
          .catch((error: unknown) => {
            logger.warn(
              "dashboard source close failed",
              isErrnoCode(error) ? error.code : "failed",
            );
          })
      : Promise.resolve();
    return released;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      const resources = releaseResources();
      const killTimer = setTimeout(() => {
        server.closeAllConnections();
      }, 1000);
      killTimer.unref();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      clearTimeout(killTimer);
      await resources;
    })();
    return closing;
  }

  return new Promise<DashboardServerHandle>((resolve, reject) => {
    const failBind = (reason: string | undefined) => {
      logger.error("dashboard server unavailable", reason ?? "unknown");
      // Terminal: no alternate port is attempted, and source resources created
      // before the bind are released even though no handle was returned.
      try {
        server.close();
      } catch {
        // The listener never started (bind error) or was already closed.
      }
      void releaseResources();
      reject(new DashboardBindError(options.port, reason));
    };

    const onListenError = (error: unknown) => {
      failBind(isErrnoCode(error) ? error.code : undefined);
    };

    server.once("error", onListenError);
    try {
      server.listen(options.port, "127.0.0.1", () => {
        server.off("error", onListenError);
        server.on("error", (error: unknown) => {
          logger.error("dashboard server error", isErrnoCode(error) ? error.code : "unknown");
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
          failBind("listen-failed");
          return;
        }
        actualPort = address.port;
        resolve({
          port: actualPort,
          url: `http://127.0.0.1:${actualPort}`,
          close,
        });
      });
    } catch (error: unknown) {
      server.off("error", onListenError);
      failBind(isErrnoCode(error) ? error.code : undefined);
    }
  });
}
