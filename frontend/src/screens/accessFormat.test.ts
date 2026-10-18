import { describe, expect, it } from 'vitest'
import type { DoorAccessSummary } from '@/api/types'
import { describeDoor, reasonLabel } from './accessFormat'

const door = (over: Partial<DoorAccessSummary> = {}): DoorAccessSummary => ({
  device_id: 'd1',
  name: 'Main entrance',
  failures_in_window: 5,
  failures_24h: 9,
  distinct_cards_in_window: 3,
  by_reason: { unknown_card: 5 },
  last_failure_at: '2026-10-02T10:00:00Z',
  flagged: true,
  recent: [],
  ...over,
})

describe('reasonLabel', () => {
  it('names the known reasons in plain words', () => {
    expect(reasonLabel('unknown_card')).toBe('Unknown card')
    expect(reasonLabel('employee_inactive')).toBe('Inactive employee')
    expect(reasonLabel('zone_denied')).toBe('Not allowed in this zone')
  })

  it('shows an unrecognised code as-is rather than hiding it', () => {
    expect(reasonLabel('something_new')).toBe('something_new')
  })
})

describe('describeDoor', () => {
  it('gives the evidence, not a verdict: failures, how many different cards, the 24 h total', () => {
    expect(describeDoor(door(), 10)).toBe(
      '5 failed in the last 10 min · 3 different cards · 9 in 24 h',
    )
  })

  it('says "1 card" when it is one card failing repeatedly', () => {
    expect(describeDoor(door({ distinct_cards_in_window: 1 }), 10)).toContain('1 card ·')
  })
})
