export interface ModelStripFit {
  visibleCount: number;
  overflowCount: number;
}

/**
 * Fits complete model identities before one overflow bubble. Entry widths are
 * measured from the rendered font, and the bubble's own width and separator
 * are reserved, so the strip never overflows and never counts itself into a
 * different result.
 */
export function fitModelIdentities(params: {
  availableWidth: number;
  entryWidths: readonly number[];
  separatorWidth: number;
  overflowWidth: number;
}): ModelStripFit {
  const total = params.entryWidths.length;
  if (total === 0) return { visibleCount: 0, overflowCount: 0 };
  const available = Number.isFinite(params.availableWidth) ? Math.max(0, params.availableWidth) : 0;
  let used = 0;
  let visibleCount = 0;
  for (let index = 0; index < total; index += 1) {
    const entry = params.entryWidths[index] ?? 0;
    const needed = used + (index === 0 ? 0 : params.separatorWidth) + entry;
    const overflowCount = total - (index + 1);
    const reserved = overflowCount > 0 ? params.separatorWidth + params.overflowWidth : 0;
    if (needed + reserved > available) break;
    used = needed;
    visibleCount = index + 1;
  }
  return { visibleCount, overflowCount: total - visibleCount };
}
