import { DEFAULT_RANGE_KEY, type RangeKey } from "../contracts/ranges";
import { type Location, parseLocation } from "../ui/routing";

/**
 * Internal navigation for the Desktop panel.
 *
 * Native has no address bar and keeps no history: a route is window-local
 * presentation state. Paths are still parsed with the shared routing contract so
 * the same links, breadcrumbs and range rules as the browser remain meaningful;
 * only the storage step differs.
 */

export function initialNativeLocation(): Location {
  return { route: { name: "home" }, range: DEFAULT_RANGE_KEY };
}

/**
 * Resolves an app path against the current range. A malformed or unknown path
 * returns `undefined` and leaves the caller on its current view.
 */
export function navigateNative(current: Location, path: string): Location | undefined {
  const next = parseLocation(path, current.range);
  return next.route.name === "not-found" ? undefined : next;
}

/** Range changes keep the route and just replace the query state. */
export function setNativeRange(current: Location, range: RangeKey): Location {
  return { route: current.route, range };
}

/** Grouping is view state on Models; it replaces the dimension, not the page. */
export function replaceModelsDimension(
  current: Location,
  dimension: "model" | "provider",
): Location {
  return current.route.name === "models"
    ? { ...current, route: { name: "models", dimension } }
    : current;
}
