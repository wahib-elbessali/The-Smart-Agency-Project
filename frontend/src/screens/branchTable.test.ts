import { describe, expect, it } from 'vitest'
import type { BranchOverview } from '@/api/types'
import { COLUMNS, DEFAULT_SORT, minutes, nextSort, sortBranches } from './branchTable'

function row(
  name: string,
  over: Partial<{
    waiting: number
    wait: number | null
    positive: number | null
    critical: number
  }> = {},
): BranchOverview {
  return {
    agency_id: name,
    name,
    is_active: true,
    overview: {
      alerts: {
        open_by_severity: { CRITICAL: over.critical ?? 0 },
        open_total: over.critical ?? 0,
      },
      tickets: {
        waiting: over.waiting ?? 0,
        in_service: 0,
        completed_today: 0,
        cancelled_today: 0,
      },
      satisfaction: {
        window_hours: 24,
        total_samples: 0,
        counts_by_emotion: {},
        positive_pct: over.positive ?? null,
        neutral_pct: null,
        negative_pct: null,
      },
      wait_times: {
        window_hours: 24,
        sample_count: 0,
        avg_queue_wait_seconds: over.wait ?? null,
        avg_walk_over_seconds: null,
        avg_service_duration_seconds: null,
        avg_total_seconds: null,
      },
      visitor_recognition: {
        window_days: 30,
        new_visitors: 0,
        returning_visitors: 0,
        returning_pct: null,
        avg_days_between_visits: null,
      },
      service_satisfaction: {
        window_hours: 24,
        tickets_with_coverage: 0,
        total_samples: 0,
        counts_by_emotion: {},
        positive_pct: null,
        neutral_pct: null,
        negative_pct: null,
      },
    },
  }
}

const names = (rows: BranchOverview[]) => rows.map((r) => r.name)

describe('sortBranches', () => {
  const rows = [
    row('Casa', { waiting: 4 }),
    row('Agadir', { waiting: 9 }),
    row('Rabat', { waiting: 1 }),
  ]

  it('sorts numbers both ways without touching the original list', () => {
    expect(names(sortBranches(rows, { key: 'waiting', direction: 'desc' }))).toEqual([
      'Agadir',
      'Casa',
      'Rabat',
    ])
    expect(names(sortBranches(rows, { key: 'waiting', direction: 'asc' }))).toEqual([
      'Rabat',
      'Casa',
      'Agadir',
    ])
    expect(names(rows)).toEqual(['Casa', 'Agadir', 'Rabat'])
  })

  it('sorts names alphabetically, ignoring case', () => {
    const mixed = [row('rabat'), row('Casa'), row('agadir')]
    expect(names(sortBranches(mixed, DEFAULT_SORT))).toEqual(['agadir', 'Casa', 'rabat'])
  })

  /* "No data" is not the smallest value: sorting it to the top of a descending
     list would put empty branches above busy ones. */
  it('puts branches with no value last, in either direction', () => {
    const data = [
      row('A', { wait: null }),
      row('B', { wait: 600 }),
      row('C', { wait: 60 }),
      row('D', { wait: null }),
    ]
    expect(names(sortBranches(data, { key: 'avg_queue_wait', direction: 'desc' }))).toEqual([
      'B',
      'C',
      'A',
      'D',
    ])
    expect(names(sortBranches(data, { key: 'avg_queue_wait', direction: 'asc' }))).toEqual([
      'C',
      'B',
      'A',
      'D',
    ])
  })

  it('treats a real zero as a value, not as missing', () => {
    const data = [
      row('A', { positive: null }),
      row('B', { positive: 0 }),
      row('C', { positive: 50 }),
    ]
    expect(names(sortBranches(data, { key: 'positive', direction: 'asc' }))).toEqual([
      'B',
      'C',
      'A',
    ])
  })

  it('keeps the incoming order for ties, so equal rows do not jump around', () => {
    const tied = [row('B', { waiting: 3 }), row('A', { waiting: 3 }), row('C', { waiting: 3 })]
    expect(names(sortBranches(tied, { key: 'waiting', direction: 'desc' }))).toEqual([
      'B',
      'A',
      'C',
    ])
    expect(names(sortBranches(tied, { key: 'waiting', direction: 'asc' }))).toEqual(['B', 'A', 'C'])
  })

  it('reads the critical alert count from the severity breakdown', () => {
    const data = [row('A', { critical: 1 }), row('B', { critical: 5 })]
    expect(names(sortBranches(data, { key: 'critical_alerts', direction: 'desc' }))).toEqual([
      'B',
      'A',
    ])
  })
})

describe('nextSort', () => {
  it('flips the column that is already sorted', () => {
    expect(nextSort({ key: 'waiting', direction: 'desc' }, 'waiting')).toEqual({
      key: 'waiting',
      direction: 'asc',
    })
    expect(nextSort({ key: 'waiting', direction: 'asc' }, 'waiting')).toEqual({
      key: 'waiting',
      direction: 'desc',
    })
  })

  it('starts a new column descending for numbers and ascending for the name', () => {
    expect(nextSort(DEFAULT_SORT, 'waiting')).toEqual({ key: 'waiting', direction: 'desc' })
    expect(nextSort({ key: 'waiting', direction: 'desc' }, 'name')).toEqual({
      key: 'name',
      direction: 'asc',
    })
  })
})

describe('formatting', () => {
  it('shows no data as a dash and rounds minutes the way the overview does', () => {
    expect(minutes(null)).toBe('—')
    expect(minutes(0)).toBe('0m')
    expect(minutes(95)).toBe('2m')
    const waiting = COLUMNS.find((c) => c.key === 'waiting')
    expect(waiting?.format(null)).toBe('—')
    expect(waiting?.format(0)).toBe('0')
    expect(COLUMNS.find((c) => c.key === 'positive')?.format(66.6)).toBe('67%')
  })

  it('gives every column a hint, so no header is a mystery', () => {
    expect(COLUMNS.every((c) => c.hint.length > 5)).toBe(true)
  })
})
