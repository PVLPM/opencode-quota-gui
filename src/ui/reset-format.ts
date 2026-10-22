/**
 * Browser-safe reset-countdown formatting.
 *
 * The browser layer may import only `src/ui`, contracts and browser libraries,
 * so it cannot reuse the Node-side formatter in `src/lib/format-utils.ts`.
 * This keeps the same compact, minute-precise wording for reset tooltips:
 * `2d 4h 18m`, `4h 18m`, or `18m`; past or invalid times return `reset`.
 */
export function formatResetCountdown(iso: string, nowMs = Date.now()): string {
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return "reset";
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return "reset";

  // Round up partial minutes so the countdown never understates the time left.
  const diffMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
