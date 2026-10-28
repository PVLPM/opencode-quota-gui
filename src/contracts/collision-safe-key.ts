/**
 * Collision-safe composite keys for raw identities.
 *
 * Every part is self-describing: `u` for missing, `n` for null, and
 * `s<length>:<value>` for a known string. Because values carry their length,
 * no identity can forge a separator or another tuple. This matters at both the
 * pricing-cache and rollup boundaries, where raw provider/model ids may contain
 * any character and a missing id must stay distinct from an empty one.
 *
 * Lives in the contract layer so browser-safe contracts (and the analytics
 * entity codec) never reach into `src/lib`.
 */
export function encodeIdentityKey(parts: readonly (string | null | undefined)[]): string {
  let key = "";
  for (const part of parts) {
    if (part === undefined) {
      key += "u;";
    } else if (part === null) {
      key += "n;";
    } else {
      key += `s${part.length}:${part};`;
    }
  }
  return key;
}
