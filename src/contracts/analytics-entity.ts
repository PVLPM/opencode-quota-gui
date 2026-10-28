/**
 * Reversible, tagged, URL-safe tokens for exact model/provider identities.
 *
 * A known identity is `k.` plus the base64url encoding of its UTF-16 code
 * units; the explicit `u` token is the missing identity. UTF-16 (not UTF-8)
 * keeps every JavaScript string reversible, including lone surrogates, NUL,
 * whitespace, slashes, percent signs, hashes and delimiter-shaped ids. A known
 * empty id is `k.` and therefore never aliases `u`.
 *
 * Validation is confined to this token grammar: it deliberately does not reuse
 * filesystem-oriented resource-id rules, because raw identities may contain any
 * character.
 */

import { encodeIdentityKey } from "./collision-safe-key.js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupQuery,
} from "./dashboard.js";
import { isRangeKey } from "./ranges.js";

/** The only token that means "this identity is missing". */
export const UNKNOWN_ANALYTICS_ENTITY_TOKEN = "u";

const KNOWN_TAG = "k.";
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const UTF16_CODE_UNITS_PER_BYTE = 2;

function isAnalyticsDimension(value: unknown): value is AnalyticsDimension {
  return value === "model" || value === "provider";
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array | undefined {
  if (!BASE64URL_RE.test(token)) return undefined;
  const standard = token.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (standard.length % 4)) % 4;
  let binary: string;
  try {
    binary = atob(`${standard}${"=".repeat(padding)}`);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Encodes one exact identity; the result is a single URL path/query-safe token. */
export function encodeAnalyticsEntityToken(identity: AnalyticsEntityIdentity): string {
  if (identity.kind === "unknown") return UNKNOWN_ANALYTICS_ENTITY_TOKEN;
  const { id } = identity;
  const bytes = new Uint8Array(id.length * UTF16_CODE_UNITS_PER_BYTE);
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }
  return `${KNOWN_TAG}${toBase64Url(bytes)}`;
}

/**
 * Decodes one token, or `undefined` for a malformed token. Only the canonical
 * encoding is accepted, so two byte sequences cannot stand for one identity.
 */
export function decodeAnalyticsEntityToken(token: string): AnalyticsEntityIdentity | undefined {
  if (token === UNKNOWN_ANALYTICS_ENTITY_TOKEN) return { kind: "unknown" };
  if (!token.startsWith(KNOWN_TAG)) return undefined;
  const payload = token.slice(KNOWN_TAG.length);
  const bytes = fromBase64Url(payload);
  if (bytes === undefined || bytes.length % UTF16_CODE_UNITS_PER_BYTE !== 0) return undefined;
  let id = "";
  for (let index = 0; index < bytes.length; index += 2) {
    const low = bytes[index] ?? 0;
    const high = bytes[index + 1] ?? 0;
    id += String.fromCharCode(low | (high << 8));
  }
  const identity: AnalyticsEntityIdentity = { kind: "known", id };
  return encodeAnalyticsEntityToken(identity) === token ? identity : undefined;
}

/** True for a structurally valid grouped query; raw id contents are unconstrained. */
export function isAnalyticsGroupQuery(value: unknown): value is AnalyticsGroupQuery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isRangeKey(record.range) || !isAnalyticsDimension(record.dimension)) return false;
  const filter = record.filter;
  if (filter === undefined) return true;
  if (typeof filter !== "object" || filter === null) return false;
  const filterRecord = filter as Record<string, unknown>;
  if (!isAnalyticsDimension(filterRecord.dimension)) return false;
  const identity = filterRecord.identity;
  if (typeof identity !== "object" || identity === null) return false;
  const identityRecord = identity as Record<string, unknown>;
  if (identityRecord.kind === "unknown") return true;
  return identityRecord.kind === "known" && typeof identityRecord.id === "string";
}

/**
 * Collision-safe cache/coalescing key for one grouped query. Length-prefixed
 * parts keep raw ids containing delimiters, empty strings and missing values
 * distinct without a visible-label sentinel.
 */
export function encodeAnalyticsGroupQueryKey(query: AnalyticsGroupQuery): string {
  const filter = query.filter;
  return encodeIdentityKey([
    query.dimension,
    query.range,
    filter?.dimension ?? null,
    filter?.identity.kind ?? null,
    filter?.identity.kind === "known" ? filter.identity.id : null,
  ]);
}
