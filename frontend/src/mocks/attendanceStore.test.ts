import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import * as store from './attendanceStore'

/**
 * The store stands in for the backend until there is one, so what matters is
 * that it refuses - and DOESN'T refuse - exactly what the contract says.
 *
 * The double check-in is the case worth the most care. It is not an error: the
 * contract has the backend return the EXISTING open record with a 200, having
 * created nothing. A UI that treats any 200 as "checked in just now" will tell
 * someone they arrived at 14:03 when the record says 08:12, so this behaviour
 * has to be pinned here rather than discovered against a real server.
 */

/* Index 7 of the shared roster deliberately has no card, so it cannot be
   checked in at all - the route is keyed on RFID. */
const KNOWN_CARD = 'RFID-001'
const NO_SUCH_CARD = 'RFID-999'

beforeEach(() => {
  store.resetAttendanceStore()
})

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof ApiError ? error.status : undefined
  }
  return undefined
}

describe('historyFor', () => {
  it('returns records most recent first', () => {
    const employeeId = 'e1000000-0000-4000-8000-000000000001'
    const rows = store.historyFor(employeeId)

    expect(rows.length).toBeGreaterThan(0)
    const times = rows.map((r) => new Date(r.check_in).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('only returns that employee', () => {
    const employeeId = 'e1000000-0000-4000-8000-000000000001'
    expect(store.historyFor(employeeId).every((r) => r.employee_id === employeeId)).toBe(true)
  })

  it('is a 404 for an employee who does not exist', () => {
    expect(statusOf(() => store.historyFor('nope'))).toBe(404)
  })
})

describe('checkIn', () => {
  it('creates an open record', () => {
    const record = store.checkIn({ employee_rfid: KNOWN_CARD })

    expect(record.check_out).toBeNull()
    expect(record.employee_name).toBeTruthy()
  })

  it('honours an explicit timestamp', () => {
    const when = '2026-08-18T07:45:00.000Z'
    expect(store.checkIn({ employee_rfid: KNOWN_CARD, timestamp: when }).check_in).toBe(when)
  })

  /* The behaviour this whole file exists for. */
  it('returns the EXISTING record when already checked in, and creates nothing', () => {
    const first = store.checkIn({
      employee_rfid: KNOWN_CARD,
      timestamp: '2026-08-18T08:12:00.000Z',
    })
    const before = store.historyFor(first.employee_id).length

    const second = store.checkIn({ employee_rfid: KNOWN_CARD })

    expect(second.id).toBe(first.id)
    expect(second.check_in).toBe(first.check_in)
    expect(store.historyFor(first.employee_id)).toHaveLength(before)
  })

  it('is a 404 for a card no active employee holds', () => {
    expect(statusOf(() => store.checkIn({ employee_rfid: NO_SUCH_CARD }))).toBe(404)
  })

  it('matches the card case-insensitively and ignores surrounding space', () => {
    // Typed by hand into a form, so it will not always arrive clean.
    expect(store.checkIn({ employee_rfid: '  rfid-001 ' }).check_out).toBeNull()
  })
})

describe('checkOut', () => {
  it('closes the open record', () => {
    const opened = store.checkIn({ employee_rfid: KNOWN_CARD })
    const closed = store.checkOut({ employee_rfid: KNOWN_CARD })

    expect(closed.id).toBe(opened.id)
    expect(closed.check_out).not.toBeNull()
  })

  /* Unlike check-in, this one does refuse - the ordinary case of checking out
     somebody who never checked in. */
  it('is a 409 when there is no open record', () => {
    expect(statusOf(() => store.checkOut({ employee_rfid: KNOWN_CARD }))).toBe(409)
  })

  it('is a 409 again once already checked out', () => {
    store.checkIn({ employee_rfid: KNOWN_CARD })
    store.checkOut({ employee_rfid: KNOWN_CARD })
    expect(statusOf(() => store.checkOut({ employee_rfid: KNOWN_CARD }))).toBe(409)
  })

  it('is a 404 for a card no active employee holds', () => {
    expect(statusOf(() => store.checkOut({ employee_rfid: NO_SUCH_CARD }))).toBe(404)
  })

  it('puts the closed record into the history', () => {
    const opened = store.checkIn({ employee_rfid: KNOWN_CARD })
    store.checkOut({ employee_rfid: KNOWN_CARD })

    const latest = store.historyFor(opened.employee_id)[0]
    expect(latest.id).toBe(opened.id)
    expect(latest.check_out).not.toBeNull()
  })
})
