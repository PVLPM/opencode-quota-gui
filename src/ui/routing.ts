import { DEFAULT_RANGE_KEY, isRangeKey, type RangeKey } from "../contracts/ranges";

/**
 * Hash routing and range persistence (design spec §10, R35).
 *
 * Routes: `#/`, `#/project/<id>?range=`, `#/session/<id>?range=`,
 * `#/settings`. The range lives in the URL and in `localStorage`; both agree
 * after any change, and a URL range wins on load so a shared link is honest.
 */

export const RANGE_STORAGE_KEY = "opencode-quota-gui.range";

export type Route =
  | { name: "home" }
  | { name: "project"; projectId: string }
  | { name: "session"; sessionId: string }
  | { name: "settings" }
  | { name: "not-found"; path: string };

export interface Location {
  route: Route;
  range: RangeKey;
}

/** Ranges are persisted per browser; a corrupt or absent value falls back to the default. */
export function readStoredRange(storage: Pick<Storage, "getItem"> | undefined): RangeKey {
  if (!storage) return DEFAULT_RANGE_KEY;
  try {
    const value = storage.getItem(RANGE_STORAGE_KEY);
    return isRangeKey(value) ? value : DEFAULT_RANGE_KEY;
  } catch {
    return DEFAULT_RANGE_KEY;
  }
}

export function writeStoredRange(
  storage: Pick<Storage, "setItem"> | undefined,
  range: RangeKey,
): void {
  if (!storage) return;
  try {
    storage.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    // A blocked storage area costs persistence, never the session.
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parses a location hash. `fallbackRange` is the remembered range: the session
 * route ignores its `?range=` for data but keeps it in the URL, so it is
 * echoed back rather than dropped.
 */
export function parseLocation(hash: string, fallbackRange: RangeKey): Location {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const requested = params.get("range");
  const range: RangeKey = isRangeKey(requested) ? requested : fallbackRange;

  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { route: { name: "home" }, range };
  if (segments.length === 1 && segments[0] === "settings") {
    return { route: { name: "settings" }, range };
  }
  if (segments.length === 2 && segments[0] === "project") {
    return { route: { name: "project", projectId: decodeSegment(segments[1] ?? "") }, range };
  }
  if (segments.length === 2 && segments[0] === "session") {
    return { route: { name: "session", sessionId: decodeSegment(segments[1] ?? "") }, range };
  }
  return { route: { name: "not-found", path }, range };
}

/** Builds the hash for a route; the range travels with every route. */
export function formatHash(route: Route, range: RangeKey): string {
  const suffix = `?range=${range}`;
  switch (route.name) {
    case "home":
      return `#/${suffix}`;
    case "project":
      return `#/project/${encodeURIComponent(route.projectId)}${suffix}`;
    case "session":
      return `#/session/${encodeURIComponent(route.sessionId)}${suffix}`;
    case "settings":
      return `#/settings${suffix}`;
    default:
      return `#/${suffix}`;
  }
}

/** True for routes whose data is range-scoped, so a range change refetches only those. */
export function routeUsesRange(route: Route): boolean {
  return route.name === "home" || route.name === "project";
}

/**
 * The session page is deliberately range-free (R25–R27): it always shows the
 * opened session and every descendant, so the selector is hidden and a range
 * change never touches session queries.
 */
export function routeShowsRangeSelector(route: Route): boolean {
  return route.name !== "session" && route.name !== "settings";
}
