import { describe, expect, it } from 'vitest'
import { DATA_COLORS, MAX_SERIES, foldToPalette, seriesColor } from './palette'

/**
 * The colour ORDER is a contract, not a detail.
 *
 * A legend teaches the reader a mapping, and repainting the survivors when a
 * category drops out silently invalidates everything they learned. These tests
 * pin that behaviour, plus the folding rule that keeps a long tail from
 * generating hues the palette was never validated for.
 */

describe('seriesColor', () => {
  it('assigns slots in a fixed order', () => {
    expect(seriesColor(0)).toBe(DATA_COLORS[0])
    expect(seriesColor(1)).toBe(DATA_COLORS[1])
    expect(seriesColor(MAX_SERIES - 1)).toBe(DATA_COLORS[MAX_SERIES - 1])
  })

  it('never returns an unvalidated colour, even past the end', () => {
    // Wrapping is a safety net; foldToPalette is what should keep us in range.
    expect(DATA_COLORS).toContain(seriesColor(MAX_SERIES))
    expect(DATA_COLORS).toContain(seriesColor(99))
  })
})

describe('foldToPalette', () => {
  const items = (...values: number[]) => values.map((value, i) => ({ label: `cat-${i}`, value }))

  it('sorts largest first', () => {
    expect(foldToPalette(items(3, 9, 1)).map((s) => s.value)).toEqual([9, 3, 1])
  })

  it('keeps every category when it fits', () => {
    const folded = foldToPalette(items(4, 3, 2, 1))
    expect(folded).toHaveLength(4)
    expect(folded.some((s) => s.label === 'Other')).toBe(false)
  })

  it('colours by rank, in palette order', () => {
    const folded = foldToPalette(items(1, 5, 3))
    expect(folded.map((s) => s.color)).toEqual([DATA_COLORS[0], DATA_COLORS[1], DATA_COLORS[2]])
  })

  it('folds the tail into one Other once past capacity', () => {
    const folded = foldToPalette(items(10, 9, 8, 7, 6, 5))
    expect(folded).toHaveLength(MAX_SERIES)

    const other = folded.at(-1)
    expect(other?.label).toBe('Other')
    // 7 + 6 + 5 - everything the palette had no slot for.
    expect(other?.value).toBe(18)
  })

  it('gives Other a neutral, not a hue', () => {
    // "Other" is the absence of a category. A hue would imply it means something.
    const other = foldToPalette(items(5, 4, 3, 2, 1)).at(-1)
    expect(other?.color).toBe('var(--color-line-strong)')
    expect(DATA_COLORS).not.toContain(other?.color)
  })

  it('accepts a caller-supplied label for the fold', () => {
    const folded = foldToPalette(items(5, 4, 3, 2, 1), 'Everything else')
    expect(folded.at(-1)?.label).toBe('Everything else')
  })

  it('does not mutate or reorder the caller array', () => {
    const original = items(1, 9, 5)
    const snapshot = original.map((i) => i.value)
    foldToPalette(original)
    expect(original.map((i) => i.value)).toEqual(snapshot)
  })

  it('survives an empty list', () => {
    expect(foldToPalette([])).toEqual([])
  })

  it('preserves extra fields on the caller objects', () => {
    const folded = foldToPalette([{ label: 'a', value: 1, meta: 'kept' }])
    expect(folded[0]).toMatchObject({ label: 'a', value: 1, meta: 'kept' })
  })
})
