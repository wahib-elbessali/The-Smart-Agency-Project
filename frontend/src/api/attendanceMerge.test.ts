import { describe, expect, it } from 'vitest'
import {
  entryFromEvent,
  identityOf,
  isLate,
  sortEntries,
  totalsOf,
  upsertEntry,
  type AttendanceEntry,
} from './attendanceMerge'
import type { AttendanceEvent } from './types'

function entry(over: Partial<AttendanceEntry> = {}): AttendanceEntry {
  return {
    id: 'att-1',
    employee_id: 'emp-1',
    employee_name: 'Hamza Benali',
    agency_id: 'agency-1',
    check_in: '2026-08-05T08:30:00Z',
    check_out: null,
    method: 'RFID',
    ...over,
  }
}

function event(over: Partial<AttendanceEvent> = {}): AttendanceEvent {
  return {
    type: 'attendance_updated',
    event: 'check_in',
    employee_id: 'emp-1',
    employee_name: 'Hamza Benali',
    agency_id: 'agency-1',
    check_in: '2026-08-05T08:30:00Z',
    check_out: null,
    method: 'RFID',
    device_id: 'device-1',
    ...over,
  }
}

describe('identityOf', () => {
  it('separates two visits by the same employee on the same day', () => {
    const morning = entry({ check_in: '2026-08-05T08:30:00Z' })
    const afternoon = entry({ check_in: '2026-08-05T14:00:00Z' })
    expect(identityOf(morning)).not.toBe(identityOf(afternoon))
  })
})

describe('upsertEntry', () => {
  it('adds an unseen visit', () => {
    expect(upsertEntry([], entry())).toHaveLength(1)
  })

  /* The reconnect case: the backend replays a frame we already folded in. */
  it('does not duplicate a repeated event', () => {
    const list = upsertEntry([], entryFromEvent(event()))
    expect(upsertEntry(list, entryFromEvent(event()))).toHaveLength(1)
  })

  it('applies a check-out to the matching visit', () => {
    const list = upsertEntry([], entry())
    const closed = upsertEntry(
      list,
      entryFromEvent(event({ event: 'check_out', check_out: '2026-08-05T16:30:00Z' })),
    )
    expect(closed).toHaveLength(1)
    expect(closed[0].check_out).toBe('2026-08-05T16:30:00Z')
  })

  /* The dangerous direction: a stale check_in frame arriving after the
     check_out must not put someone who has gone home back in the building. */
  it('does not resurrect a departed employee from a replayed check-in', () => {
    let list = upsertEntry([], entry())
    list = upsertEntry(list, entryFromEvent(event({ check_out: '2026-08-05T16:30:00Z' })))
    list = upsertEntry(list, entryFromEvent(event({ check_out: null })))

    expect(list[0].check_out).toBe('2026-08-05T16:30:00Z')
  })

  it('keeps the REST id when a socket frame updates the row', () => {
    const list = upsertEntry([], entry({ id: 'att-99' }))
    const updated = upsertEntry(list, entryFromEvent(event({ check_out: '2026-08-05T17:00:00Z' })))
    expect(updated[0].id).toBe('att-99')
  })

  it('does not mutate the list it was given', () => {
    const original = [entry()]
    upsertEntry(original, entry({ employee_id: 'emp-2' }))
    expect(original).toHaveLength(1)
  })
})

describe('sortEntries', () => {
  it('puts people still in the building first, then newest arrival', () => {
    const list = [
      entry({
        employee_id: 'a',
        check_in: '2026-08-05T08:00:00Z',
        check_out: '2026-08-05T12:00:00Z',
      }),
      entry({ employee_id: 'b', check_in: '2026-08-05T09:00:00Z' }),
      entry({ employee_id: 'c', check_in: '2026-08-05T10:00:00Z' }),
    ]
    expect(sortEntries(list).map((e) => e.employee_id)).toEqual(['c', 'b', 'a'])
  })
})

describe('totalsOf', () => {
  it('counts present and departed', () => {
    const totals = totalsOf([
      entry({ employee_id: 'a' }),
      entry({ employee_id: 'b', check_out: 'x' }),
    ])
    expect(totals).toEqual({ present: 1, departed: 1, total: 2 })
  })
})

describe('isLate', () => {
  it('returns null when the agency opening time is unknown', () => {
    expect(isLate('2026-08-05T09:00:00Z', undefined)).toBeNull()
  })

  it('compares the arrival against the opening time in the viewer timezone', () => {
    const opening = '08:30:00'
    const early = new Date()
    early.setHours(8, 0, 0, 0)
    const late = new Date()
    late.setHours(9, 0, 0, 0)

    expect(isLate(early.toISOString(), opening)).toBe(false)
    expect(isLate(late.toISOString(), opening)).toBe(true)
  })

  it('returns null rather than false for an unparseable timestamp', () => {
    expect(isLate('not-a-date', '08:30:00')).toBeNull()
  })
})
