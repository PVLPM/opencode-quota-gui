import {
  decodeAnalyticsEntityToken,
  encodeAnalyticsEntityToken,
} from "../contracts/analytics-entity";
import type { AnalyticsDimension, AnalyticsEntityIdentity } from "../contracts/dashboard";
import { DEFAULT_RANGE_KEY, isRangeKey, type RangeKey } from "../contracts/ranges";

/**
 * History routing and range persistence. Analytics, Models, both group details
 * and Project carry a range query; Session stays deliberately range-free. An
 * explicit URL range wins over the remembered browser range.
 */

export const RANGE_STORAGE_KEY = "opencode-quota-gui.range";

export type Route =
  | { name: "home" }
  | { name: "analytics" }
  | { name: "models"; dimension: AnalyticsDimension }
  | { name: "model"; identity: AnalyticsEntityIdentity; modelsGroup?: AnalyticsDimension }
  | { name: "provider"; identity: AnalyticsEntityIdentity; modelsGroup?: AnalyticsDimension }
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

function decodeTokenSegment(segment: string): AnalyticsEntityIdentity | undefined {
  try {
    return decodeAnalyticsEntityToken(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

/** An absent or invalid group falls back to the default Models dimension. */
function readModelsGroup(value: string | null): AnalyticsDimension | undefined {
  return value === "model" || value === "provider" ? value : undefined;
}

function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      decoded.length === 0 ||
      decoded.length > 256 ||
      decoded.includes("\\") ||
      [...decoded].some((char) => (char.codePointAt(0) ?? 0) < 32 || char === "\u007f") ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      /\.(?:html|css|js|map|svg|woff2?|ttf)\/*$/i.test(decoded)
    )
      return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/**
 * Parses a clean path. A legacy session range can be remembered during startup
 * migration, but is never emitted in a canonical session URL or used for data.
 */
export function parseLocation(pathWithQuery: string, fallbackRange: RangeKey): Location {
  const [path = "", query = ""] = pathWithQuery.split("?");
  const params = new URLSearchParams(query);
  const requested = params.get("range");
  const range: RangeKey = isRangeKey(requested) ? requested : fallbackRange;
  const modelsGroup = readModelsGroup(params.get("group"));

  if (path === "/" || path === "/quota") return { route: { name: "home" }, range };
  if (path === "/analytics") {
    return { route: { name: "analytics" }, range };
  }
  if (path === "/models") {
    return { route: { name: "models", dimension: modelsGroup ?? "model" }, range };
  }
  if (path === "/settings") {
    return { route: { name: "settings" }, range };
  }
  const entityMatch = /^\/(model|provider)\/([^/]+)$/.exec(path);
  if (entityMatch) {
    const identity = decodeTokenSegment(entityMatch[2] ?? "");
    if (identity !== undefined) {
      const origin = modelsGroup === undefined ? {} : { modelsGroup };
      return {
        route:
          entityMatch[1] === "model"
            ? { name: "model", identity, ...origin }
            : { name: "provider", identity, ...origin },
        range,
      };
    }
    return { route: { name: "not-found", path }, range };
  }
  const match = /^\/(project|session)\/([^/]+)$/.exec(path);
  const id = match ? decodeSegment(match[2] ?? "") : undefined;
  if (match && id !== undefined) {
    return {
      route:
        match[1] === "project"
          ? { name: "project", projectId: id }
          : { name: "session", sessionId: id },
      range,
    };
  }
  return { route: { name: "not-found", path }, range };
}

/** Builds a clean URL, keeping non-range-scoped routes query-free. */
export function formatPath(route: Route, range: RangeKey): string {
  const suffix = `?range=${range}`;
  const groupSuffix = (group: AnalyticsDimension | undefined): string =>
    group === "provider" ? "&group=provider" : "";
  switch (route.name) {
    case "home":
      return "/quota";
    case "analytics":
      return `/analytics${suffix}`;
    case "models":
      return `/models${suffix}${groupSuffix(route.dimension)}`;
    case "model":
      return `/model/${encodeAnalyticsEntityToken(route.identity)}${suffix}${groupSuffix(route.modelsGroup)}`;
    case "provider":
      return `/provider/${encodeAnalyticsEntityToken(route.identity)}${suffix}${groupSuffix(route.modelsGroup)}`;
    case "project":
      return `/project/${encodeURIComponent(route.projectId)}${suffix}`;
    case "session":
      return `/session/${encodeURIComponent(route.sessionId)}`;
    case "settings":
      return "/settings";
    default:
      return "/quota";
  }
}

/** Pure startup migration; the shell applies the result with replaceState once. */
export function canonicalizeLocation(
  browser: Pick<globalThis.Location, "pathname" | "search" | "hash">,
  fallbackRange: RangeKey,
): { location: Location; path: string } {
  const input =
    browser.pathname === "/" && browser.hash.startsWith("#/")
      ? browser.hash.slice(1)
      : browser.pathname + browser.search;
  const location = parseLocation(input, fallbackRange);
  return {
    location,
    path:
      location.route.name === "not-found"
        ? browser.pathname + browser.search
        : formatPath(location.route, location.range),
  };
}

/** True for routes whose data is range-scoped, so a range change refetches only those. */
export function routeUsesRange(route: Route): boolean {
  return (
    route.name === "analytics" ||
    route.name === "models" ||
    route.name === "model" ||
    route.name === "provider" ||
    route.name === "project"
  );
}

/**
 * The session page is deliberately range-free (R25–R27): it always shows the
 * opened session and every descendant, so the selector is hidden and a range
 * change never touches session queries.
 */
export function routeShowsRangeSelector(route: Route): boolean {
  return routeUsesRange(route);
}
