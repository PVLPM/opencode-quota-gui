/**
 * Passive Anthropic API rate-limit observations.
 *
 * A host `http.response` hook offers the response to real OpenCode Messages traffic; nothing here
 * issues a request. Only first-party Messages responses to API-key (`x-api-key`) requests are
 * kept, only the allowlisted rate-limit headers are read, and bodies and request content are never
 * touched. Observations live in memory, keyed by a sha256 digest of the request's key so a key
 * change never shows the previous key's limits; the digest is never persisted or displayed.
 */

import { createHash } from "node:crypto";

export interface AnthropicRateLimitMeter {
  limit?: number;
  remaining?: number;
  resetAtIso?: string;
}

export const ANTHROPIC_RATE_LIMIT_METERS = [
  ["requests", "requests"],
  ["tokens", "tokens"],
  ["input-tokens", "inputTokens"],
  ["output-tokens", "outputTokens"],
] as const;

type MeterName = (typeof ANTHROPIC_RATE_LIMIT_METERS)[number][1];

export interface AnthropicApiObservation {
  observedAtMs: number;
  status: number;
  meters: Partial<Record<MeterName, AnthropicRateLimitMeter>>;
  /** Seconds from a `retry-after` header, as sent with the observed response. */
  retryAfterSeconds?: number;
}

const STATE_KEY = Symbol.for("opencode-quota-gui.anthropic-api-rate-limits.v1");

function observations(): Map<string, AnthropicApiObservation> {
  const holder = globalThis as unknown as Record<PropertyKey, Map<string, AnthropicApiObservation>>;
  holder[STATE_KEY] ??= new Map();
  return holder[STATE_KEY];
}

export function digestAnthropicApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function readAnthropicApiObservation(
  keyDigest: string,
): AnthropicApiObservation | undefined {
  return observations().get(keyDigest);
}

export function clearAnthropicApiObservations(): void {
  observations().clear();
}

function nonNegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isoTimestamp(value: string | null): string | undefined {
  if (value === null) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isMessagesRequest(url: URL): boolean {
  // `count_tokens` has its own limit and is not a Messages meter.
  return (
    url.protocol === "https:" &&
    url.hostname === "api.anthropic.com" &&
    url.pathname === "/v1/messages"
  );
}

/**
 * Offer one finished host request/response. Never throws, never awaits, never alters either side.
 * Returns whether an observation was recorded.
 */
export function observeAnthropicApiResponse(event: {
  request: { url: string; headers: { get(name: string): string | null } };
  response: { status: number; headers: { get(name: string): string | null } };
  nowMs?: number;
}): boolean {
  try {
    if (!isMessagesRequest(new URL(event.request.url))) return false;
    // Presence decides: Claude subscription (OAuth) traffic carries a bearer token instead.
    const apiKey = event.request.headers.get("x-api-key");
    if (apiKey === null || apiKey.trim() === "") return false;

    const meters: AnthropicApiObservation["meters"] = {};
    for (const [header, name] of ANTHROPIC_RATE_LIMIT_METERS) {
      const read = (suffix: string) =>
        event.response.headers.get(`anthropic-ratelimit-${header}-${suffix}`);
      const limit = nonNegativeInteger(read("limit"));
      const remaining = nonNegativeInteger(read("remaining"));
      const resetAtIso = isoTimestamp(read("reset"));
      if (limit === undefined && remaining === undefined && resetAtIso === undefined) continue;
      meters[name] = {
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(resetAtIso !== undefined ? { resetAtIso } : {}),
      };
    }
    const retryAfterSeconds = nonNegativeInteger(event.response.headers.get("retry-after"));
    // A response without any rate-limit header keeps the previous observation rather than erasing it.
    if (Object.keys(meters).length === 0 && retryAfterSeconds === undefined) return false;

    observations().set(digestAnthropicApiKey(apiKey.trim()), {
      observedAtMs: event.nowMs ?? Date.now(),
      status: event.response.status,
      meters,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
