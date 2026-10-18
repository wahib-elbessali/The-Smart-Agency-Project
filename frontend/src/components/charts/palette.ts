/**
 * The categorical series colours, in assignment order.
 *
 * Read from CSS custom properties rather than repeated as hex, so index.css
 * stays the single place a colour is defined - the same rule the rest of the
 * design system follows.
 *
 * ORDER IS THE CONTRACT. Slot 1 always goes to the first series, slot 2 to the
 * second, and so on. They are never cycled and never reassigned by rank: if a
 * filter drops a category, the survivors keep the colours they had. A legend
 * that repaints itself when the data changes is worse than no legend, because
 * the reader has already learned the old mapping.
 *
 * There are four. A fifth category folds into "Other" rather than getting a
 * generated fifth hue - see the note in index.css for why a green in
 * particular must not be added.
 */
export const DATA_COLORS = [
  'var(--color-data-1)',
  'var(--color-data-2)',
  'var(--color-data-3)',
  'var(--color-data-4)',
] as const

/** How many distinct categories can be shown before folding into "Other". */
export const MAX_SERIES = DATA_COLORS.length

export function seriesColor(index: number): string {
  return DATA_COLORS[index % DATA_COLORS.length]
}

/**
 * Collapses a long category list to the palette's capacity.
 *
 * Largest first, then everything past the limit becomes a single "Other" in a
 * neutral grey. Grey matters: "Other" is not a category, it is the absence of
 * one, and giving it a hue implies it means something.
 */
export function foldToPalette<T extends { label: string; value: number }>(
  items: T[],
  otherLabel = 'Other',
): { label: string; value: number; color: string }[] {
  const sorted = [...items].sort((a, b) => b.value - a.value)

  if (sorted.length <= MAX_SERIES) {
    return sorted.map((item, i) => ({ ...item, color: seriesColor(i) }))
  }

  const kept = sorted
    .slice(0, MAX_SERIES - 1)
    .map((item, i) => ({ ...item, color: seriesColor(i) }))
  const rest = sorted.slice(MAX_SERIES - 1).reduce((sum, item) => sum + item.value, 0)

  return [...kept, { label: otherLabel, value: rest, color: 'var(--color-line-strong)' }]
}
