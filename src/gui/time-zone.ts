/**
 * Host timezone resolution.
 *
 * The Node host that serves the dashboard is the single source of truth. The
 * browser never resolves its own zone, so a remote browser in a different zone
 * still receives and renders the host's calendar.
 */

import { isValidTimeZone } from "../contracts/time-zone.js";

/** IANA zone of the machine hosting the plugin; `"UTC"` only if Intl is unusable. */
export function resolveHostTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(zone)) return zone;
  } catch {
    // An Intl failure must not break analytics; UTC is the last-resort tie-break.
  }
  return "UTC";
}
