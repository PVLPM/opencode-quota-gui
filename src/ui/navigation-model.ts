import type { ActiveViewScope } from "./dashboard-client";
import type { Route } from "./routing";

/**
 * Route presentation shared by the browser shell and the native panel.
 *
 * These helpers answer which section a route belongs to and whether an href is
 * an internal dashboard path. They never touch `window.history`, storage or a
 * transport; each shell decides how a route change is applied.
 */

/** The Analytics | Models peer tab a route belongs to, if any. */
export function analyticsTabForRoute(route: Route): "analytics" | "models" | undefined {
  const name = route.name;
  if (name === "models" || name === "model" || name === "provider") return "models";
  if (name === "analytics" || name === "project" || name === "session") return "analytics";
  return undefined;
}

/** The snapshot scope a route needs while it is on screen. */
export function viewScopeForRoute(route: Route): ActiveViewScope {
  return analyticsTabForRoute(route) === undefined ? "quota" : "analytics";
}

/**
 * An app path the shell should handle itself. External URLs, protocol-relative
 * URLs and bare fragments never qualify; a malformed app path is rejected later
 * by `parseLocation`.
 */
export function isInternalDashboardHref(href: string | null | undefined): href is string {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}
