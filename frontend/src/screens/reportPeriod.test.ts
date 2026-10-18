import { describe, expect, it } from 'vitest'
import {
  MAX_REPORT_DAYS,
  dayCount,
  describeRange,
  matchingPreset,
  presetRange,
  validateRange,
} from './reportPeriod'

const NOW = new Date('2026-10-02T15:30:00Z')

describe('presetRange', () => {
  it('this month runs from the 1st to today', () => {
    expect(presetRange('this_month', NOW)).toEqual({ start: '2026-10-01', end: '2026-10-02' })
  })

  it('last month is the whole previous month, whatever its length', () => {
    expect(presetRange('last_month', NOW)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(presetRange('last_month', new Date('2026-03-15T00:00:00Z'))).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    })
    expect(presetRange('last_month', new Date('2028-03-15T00:00:00Z'))).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    })
  })

  it('last month crosses the year boundary', () => {
    expect(presetRange('last_month', new Date('2026-01-10T00:00:00Z'))).toEqual({
      start: '2025-12-01',
      end: '2025-12-31',
    })
  })

  it('the last 30 days is exactly 30 days ending today', () => {
    const range = presetRange('last_30', NOW)
    expect(range).toEqual({ start: '2026-09-03', end: '2026-10-02' })
    expect(dayCount(range)).toBe(30)
  })

  it('uses the UTC day, not the viewer clock, near midnight', () => {
    expect(presetRange('this_month', new Date('2026-10-31T23:59:59Z')).end).toBe('2026-10-31')
    expect(presetRange('this_month', new Date('2026-11-01T00:00:00Z'))).toEqual({
      start: '2026-11-01',
      end: '2026-11-01',
    })
  })
})

describe('matchingPreset', () => {
  it('finds the preset a range equals, or none for a custom one', () => {
    expect(matchingPreset({ start: '2026-09-01', end: '2026-09-30' }, NOW)).toBe('last_month')
    expect(matchingPreset({ start: '2026-10-01', end: '2026-10-02' }, NOW)).toBe('this_month')
    expect(matchingPreset({ start: '2026-09-05', end: '2026-09-20' }, NOW)).toBeNull()
  })
})

describe('dayCount', () => {
  it('counts both ends', () => {
    expect(dayCount({ start: '2026-09-10', end: '2026-09-10' })).toBe(1)
    expect(dayCount({ start: '2026-09-01', end: '2026-09-30' })).toBe(30)
  })

  it('counts a spring-forward month correctly (no daylight-saving drift)', () => {
    expect(dayCount({ start: '2026-03-01', end: '2026-03-31' })).toBe(31)
    expect(dayCount({ start: '2026-10-01', end: '2026-10-31' })).toBe(31)
  })
})

describe('validateRange', () => {
  it('accepts a normal range, a single day, and today as the end', () => {
    expect(validateRange({ start: '2026-09-01', end: '2026-09-30' }, NOW)).toBeNull()
    expect(validateRange({ start: '2026-09-10', end: '2026-09-10' }, NOW)).toBeNull()
    expect(validateRange({ start: '2026-10-01', end: '2026-10-02' }, NOW)).toBeNull()
  })

  it('says what is wrong, in plain words', () => {
    expect(validateRange({ start: '', end: '2026-09-30' }, NOW)).toMatch(/both a start and an end/i)
    expect(validateRange({ start: '2026-09-30', end: '2026-09-01' }, NOW)).toMatch(
      /before the start/i,
    )
    expect(validateRange({ start: '2026-10-01', end: '2026-10-03' }, NOW)).toMatch(/future/i)
    expect(validateRange({ start: '2025-01-01', end: '2026-09-30' }, NOW)).toMatch(
      new RegExp(`${MAX_REPORT_DAYS} days`),
    )
    expect(validateRange({ start: '2026-13-45', end: '2026-09-30' }, NOW)).toMatch(/not valid/i)
  })

  it('allows exactly the maximum span', () => {
    expect(dayCount({ start: '2025-09-30', end: '2026-09-30' })).toBe(366)
    expect(validateRange({ start: '2025-09-30', end: '2026-09-30' }, NOW)).toBeNull()
    expect(validateRange({ start: '2025-09-29', end: '2026-09-30' }, NOW)).not.toBeNull()
  })
})

describe('describeRange', () => {
  it('reads like a label', () => {
    expect(describeRange({ start: '2026-09-01', end: '2026-09-30' })).toBe(
      '1 Sept - 30 Sept 2026 (30 days)',
    )
    expect(describeRange({ start: '2026-09-10', end: '2026-09-10' })).toBe(
      '10 Sept - 10 Sept 2026 (1 day)',
    )
  })

  it('shows both years when the range crosses one', () => {
    expect(describeRange({ start: '2025-12-20', end: '2026-01-10' })).toBe(
      '20 Dec 2025 - 10 Jan 2026 (22 days)',
    )
  })
})
